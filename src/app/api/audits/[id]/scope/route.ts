import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import { extractFounderFacts, confirmFounderFacts } from '@/lib/founder-facts';
import { classifyWithGemini, isScope, OUT_OF_SCOPE_MESSAGES, PAYABLE_SCOPES, SCOPE_PRICE_PAISE, scopeInputHash, suggestScope } from '@/lib/routing';
import { getScopeRecord, saveFacts, saveScopeRecord, type ScopeRecord } from '@/lib/audit-meta';
import { guardIp, guardUser } from '@/lib/rate-limit';

const CLASSIFIER_CONFIDENT = 0.75;

function view(rec: ScopeRecord) {
  return {
    suggestion: rec.suggestion,
    reasons: rec.reasons,
    outOfScopeMessage: rec.suggestion === 'OUT_OF_SCOPE' ? OUT_OF_SCOPE_MESSAGES[rec.outOfScopeCategory ?? 'default'] : undefined,
    facts: rec.extractedFacts,
    notes: rec.extractionNotes,
    classifier: rec.classifier
      ? rec.classifier.ok
        ? { scope: rec.classifier.scope, confidence: rec.classifier.confidence, confident: rec.classifier.confidence >= CLASSIFIER_CONFIDENT }
        : { error: 'Aristotle could not decide automatically. Please choose the option that fits.' }
      : undefined,
    confirmed: rec.confirmed ? { scope: rec.confirmed.scope, payable: PAYABLE_SCOPES.includes(rec.confirmed.scope) } : undefined,
  };
}

/**
 * POST /api/audits/[id]/scope
 *   { action: 'suggest' }                                → rule-based suggestion + extracted numbers (no AI)
 *   { action: 'classify' }                               → "Not sure": Gemini once per unchanged input (cached)
 *   { action: 'confirm', scope, facts?, factsReviewed? } → founder's authoritative choice + reviewed numbers
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    const { id } = await params;
    const audit = await db.audit.findFirst({ where: { id, userId: user.id } });
    if (!audit) return NextResponse.json({ error: 'Audit not found' }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? 'suggest';
    const frozen = audit.paymentStatus === 'paid' || Boolean(audit.paymentRef);
    const hash = scopeInputHash(audit);

    let rec = await getScopeRecord(audit.id);
    if (!rec || rec.inputHash !== hash) {
      if (frozen && rec) return NextResponse.json(view(rec));
      const { facts, notes } = extractFounderFacts(audit.idea);
      const s = suggestScope({ idea: audit.idea, stage: audit.stage, facts });
      rec = { version: 1, inputHash: hash, suggestion: s.suggestion, reasons: s.reasons, ...(s.outOfScopeCategory ? { outOfScopeCategory: s.outOfScopeCategory } : {}), extractedFacts: facts, extractionNotes: notes };
      await saveScopeRecord(audit.id, rec);
    }

    if (action === 'suggest') return NextResponse.json(view(rec));

    if (frozen) return NextResponse.json({ error: 'Payment has started for this audit, so its scope can no longer change.' }, { status: 409 });

    if (action === 'classify') {
      if (rec.classifier && rec.classifier.inputHash === hash) return NextResponse.json(view(rec)); // cached: no repeat AI call
      // An AI call before payment: rate-limited per IP and per user (new audits are free to create).
      for (const g of [await guardIp(req, 'scope-classify'), await guardUser(user.id, 'scope-classify')]) {
        if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
      }
      try {
        const r = await classifyWithGemini(audit, { userId: user.id, auditId: audit.id, parentType: 'REQUEST' });
        rec.classifier = { inputHash: hash, at: new Date().toISOString(), ok: true, ...r };
      } catch (e) {
        console.error('Aristotle scope classifier failed:', e instanceof Error ? e.message : e);
        rec.classifier = { inputHash: hash, at: new Date().toISOString(), ok: false };
      }
      await saveScopeRecord(audit.id, rec);
      return NextResponse.json(view(rec));
    }

    if (action === 'confirm') {
      if (!isScope(body.scope)) return NextResponse.json({ error: 'Please choose what Aristotle should analyse.' }, { status: 400 });
      const payable = PAYABLE_SCOPES.includes(body.scope);
      let facts = [] as ReturnType<typeof confirmFounderFacts>;
      if (payable) {
        // Founder-number review is mandatory whenever numbers were detected.
        if (rec.extractedFacts.length > 0 && body.factsReviewed !== true) {
          return NextResponse.json({ error: 'Please review and confirm the numbers Aristotle found before paying.' }, { status: 400 });
        }
        try { facts = confirmFounderFacts(body.facts ?? []); }
        catch (e) { return NextResponse.json({ error: `Please check the numbers: ${e instanceof Error ? e.message : 'invalid'}` }, { status: 400 }); }
      }
      const now = new Date().toISOString();
      const agreedWith = rec.classifier?.ok && rec.classifier.scope === body.scope ? 'classifier' : rec.suggestion === body.scope ? 'suggestion' : 'none';
      rec.confirmed = { scope: body.scope, source: 'founder', confirmedAt: now, agreedWith, factsReviewed: body.factsReviewed === true };
      await saveScopeRecord(audit.id, rec);
      if (payable) await saveFacts(audit.id, { version: 1, confirmedAt: now, facts });
      await db.audit.update({
        where: { id: audit.id },
        data: payable
          ? { pricePaise: SCOPE_PRICE_PAISE[body.scope as keyof typeof SCOPE_PRICE_PAISE], status: 'awaiting_payment', paymentStatus: 'pending' }
          : { pricePaise: 0, status: 'out_of_scope', paymentStatus: 'not_required' },
      });
      return NextResponse.json({ ...view(rec), lockedFacts: facts });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Aristotle scope route failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
