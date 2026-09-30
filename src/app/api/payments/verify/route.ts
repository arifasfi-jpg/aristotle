import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import { runAudit } from '@/lib/ai';
import Razorpay from 'razorpay';
import { isDemoMode, razorpayConfigured, verifyRazorpaySignature } from '@/lib/payments';
import type { Scope } from '@/lib/routing';
import { getLockedFacts, getScopeRecord, payableError } from '@/lib/audit-meta';

// Tavily research + Gemini generation can take ~40s; without this, a short platform default can kill
// the function after payment and leave a paid audit with no report.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Session expired' },
        { status: 401 }
      );
    }

    const b = await req.json();

    if (!b?.auditId) {
      return NextResponse.json(
        { error: 'Missing auditId' },
        { status: 400 }
      );
    }

    const audit = await db.audit.findFirst({
      where: {
        id: b.auditId,
        userId: user.id,
      },
    });

    if (!audit) {
      return NextResponse.json(
        { error: 'Audit not found' },
        { status: 404 }
      );
    }

    // Idempotency: an already-generated paid audit is never regenerated.
    if (audit.paymentStatus === 'paid' && audit.report !== '{}') {
      return NextResponse.json({ ok: true, alreadyGenerated: true });
    }

    // Server-side scope gate: never generate for an unclassified / unconfirmed / OUT_OF_SCOPE audit.
    const scopeRec = await getScopeRecord(audit.id);
    const gate = payableError(scopeRec, audit);
    if (gate.error) {
      return NextResponse.json({ error: gate.error }, { status: 403 });
    }
    // Legacy: order created by the pre-router code → treated as the original NEW_IDEA audit.
    const scope: Scope = gate.legacy ? 'NEW_IDEA' : scopeRec!.confirmed!.scope;
    const founderFacts = gate.legacy ? [] : await getLockedFacts(audit.id);

    const alreadyPaid = audit.paymentStatus === 'paid';
    let reconciledPaymentId: string | undefined;

    if (!alreadyPaid) {
      const hasCheckoutPayload = Boolean(b.razorpay_order_id || b.razorpay_payment_id || b.razorpay_signature);
      if (!b.demo && !hasCheckoutPayload) {
        // Recovery for "paid, but the browser never reported back": ask Razorpay directly whether THIS audit's
        // order was paid. Nothing from the browser is trusted here.
        if (!razorpayConfigured() || !audit.paymentRef || !audit.paymentRef.startsWith('order_')) {
          return NextResponse.json({ error: 'No payment was found for this audit.' }, { status: 402 });
        }
        const rp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID!, key_secret: process.env.RAZORPAY_KEY_SECRET! });
        const order = await rp.orders.fetch(audit.paymentRef);
        if (order.status !== 'paid' || Number(order.amount) !== audit.pricePaise || order.receipt !== audit.id) {
          return NextResponse.json({ error: 'We have not received a successful payment for this audit yet.' }, { status: 402 });
        }
        const payments = await rp.orders.fetchPayments(audit.paymentRef);
        reconciledPaymentId = (payments.items as { id: string; status: string }[]).find((p) => p.status === 'captured')?.id;
      } else if (b.demo) {
        // Demo checkout only when DEMO_MODE=true outside production (see isDemoMode).
        if (!isDemoMode()) {
          return NextResponse.json(
            { error: 'Payment verification failed' },
            { status: 400 }
          );
        }
      } else {
        const secret = process.env.RAZORPAY_KEY_SECRET;

        if (!secret) {
          console.error('Aristotle payment verification: RAZORPAY_KEY_SECRET is missing');
          return NextResponse.json(
            { error: 'Payment configuration is incomplete' },
            { status: 500 }
          );
        }

        // The signed order must be the order created for THIS audit.
        if (!audit.paymentRef || b.razorpay_order_id !== audit.paymentRef) {
          return NextResponse.json(
            { error: 'Payment verification failed' },
            { status: 400 }
          );
        }

        if (!verifyRazorpaySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature, secret)) {
          return NextResponse.json(
            { error: 'Payment verification failed' },
            { status: 400 }
          );
        }
      }
    }

    // Claim generation atomically so concurrent/repeat verify calls cannot both run the engine.
    // A claim older than 3 minutes is treated as stale (e.g. a crashed serverless invocation).
    const claim = await db.audit.updateMany({
      where: {
        id: audit.id,
        report: '{}',
        OR: [
          { status: { not: 'generating' } },
          { updatedAt: { lt: new Date(Date.now() - 3 * 60 * 1000) } },
        ],
      },
      data: {
        status: 'generating',
        paymentStatus: 'paid',
        paymentRef: alreadyPaid ? audit.paymentRef : (reconciledPaymentId || b.razorpay_payment_id || audit.paymentRef),
      },
    });

    if (claim.count === 0) {
      const current = await db.audit.findUnique({ where: { id: audit.id } });
      if (current && current.report !== '{}') {
        return NextResponse.json({ ok: true, alreadyGenerated: true });
      }
      return NextResponse.json(
        { error: 'This audit is already being generated. Please wait a moment and refresh.' },
        { status: 409 }
      );
    }

    let result;

    try {
      result = await runAudit({
        idea: audit.idea,
        sector: audit.sector as any,
        stage: audit.stage || undefined,
        geography: audit.geography || 'India',
        language: (audit.reportLanguage as any) || 'Simple English',
        scope,
        founderFacts,
      });
    } catch (error) {
      console.error('Aristotle audit engine failed:', error);

      // Payment is recorded as paid; release the claim so generation can be retried without paying again.
      await db.audit.update({ where: { id: audit.id }, data: { status: 'failed' } }).catch(() => undefined);

      const message =
        error instanceof Error ? error.message : String(error);

      return NextResponse.json(
        {
          error: `Audit engine failed: ${message}`,
          detail: message,
        },
        { status: 502 }
      );
    }

    try {
      await db.audit.update({
        where: { id: audit.id },
        data: {
          report: JSON.stringify(result.report),
          assumptions: JSON.stringify(result.report.assumptions),
          computePaise: Math.round(result.pricing.computeInr * 100),
          marginPaise: Math.round(result.pricing.marginInr * 100),
          status: 'completed',
        },
      });

      await db.projectFile.upsert({
        where: {
          auditId_path: {
            auditId: audit.id,
            path: 'audit.json',
          },
        },
        update: {
          content: JSON.stringify(
            {
              auditId: audit.id,
              idea: audit.idea,
              sector: audit.sector,
              scope,
              founderFacts,
              report: result.report,
              pricing: result.pricing,
            },
            null,
            2
          ),
        },
        create: {
          auditId: audit.id,
          path: 'audit.json',
          content: JSON.stringify(
            {
              auditId: audit.id,
              idea: audit.idea,
              sector: audit.sector,
              scope,
              founderFacts,
              report: result.report,
              pricing: result.pricing,
            },
            null,
            2
          ),
        },
      });

      await db.projectFile.upsert({
        where: {
          auditId_path: {
            auditId: audit.id,
            path: 'README.md',
          },
        },
        update: {
          content: `# Aristotle export\n\nAudit ID: ${audit.id}\n\nPortable audit bundle. No proprietary database format is required.`,
        },
        create: {
          auditId: audit.id,
          path: 'README.md',
          content: `# Aristotle export\n\nAudit ID: ${audit.id}\n\nPortable audit bundle. No proprietary database format is required.`,
        },
      });
    } catch (error) {
      console.error('Aristotle audit persistence failed:', error);

      const message =
        error instanceof Error ? error.message : String(error);

      return NextResponse.json(
        {
          error: `Audit was generated but could not be saved: ${message}`,
          detail: message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      provider: result.provider,
    });
  } catch (error) {
    console.error('Aristotle payment verification route failed:', error);

    const message =
      error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      {
        error: `Payment verification request failed: ${message}`,
        detail: message,
      },
      { status: 500 }
    );
  }
}
