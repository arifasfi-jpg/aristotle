import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import Razorpay from 'razorpay';
import { isDemoMode, razorpayConfigured, verifyRazorpaySignature } from '@/lib/payments';
import { getScopeRecord, payableError } from '@/lib/audit-meta';
import { startAuditJob } from '@/lib/jobs';

// The response returns as soon as the job is durable; the bounded job run started with `after()` uses the remaining
// function lifetime (maxDuration) and later invocations continue it from its checkpoint.
export const maxDuration = 60;

export async function POST(req: Request) {
  const startedAt = Date.now();
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
    // (Scope + locked founder facts are read by the audit job itself; legacy pre-router orders run as NEW_IDEA.)

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

    // Record the verified payment. The report is the completion marker: a generated audit is never regenerated.
    const marked = await db.audit.updateMany({
      where: { id: audit.id, report: '{}' },
      data: {
        status: 'generating',
        paymentStatus: 'paid',
        paymentRef: alreadyPaid ? audit.paymentRef : (reconciledPaymentId || b.razorpay_payment_id || audit.paymentRef),
      },
    });
    if (marked.count === 0) {
      return NextResponse.json({ ok: true, alreadyGenerated: true });
    }

    // Phase 2: the audit runs as a durable job (research → decision → report, checkpointed). This request only makes
    // the job durable and starts a bounded run after the response; it never waits for the AI work. A closed browser,
    // a timed-out request or a dead worker cannot lose the paid work: the job resumes from its last checkpoint.
    // Founder retries (no new payment) re-queue a failed job from where it stopped.
    const job = await startAuditJob({ id: audit.id, userId: audit.userId, pricePaise: audit.pricePaise }, startedAt);

    return NextResponse.json({ ok: true, queued: true, jobId: job.id, status: job.status, progress: job.progress });
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
