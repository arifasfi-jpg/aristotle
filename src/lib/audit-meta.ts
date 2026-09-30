// ---------------------------------------------------------------------------
// Per-audit scope + founder-fact records.
//
// Stored as portable JSON files in the existing ProjectFile table (scope.json, founder-facts.json),
// so NO database schema change is needed, and the Lock-and-Barrel Export includes them automatically.
// ---------------------------------------------------------------------------
import { db } from './db';
import type { FounderFact } from './founder-facts';
import { PAYABLE_SCOPES, type ClassifierResult, type OutOfScopeCategory, type Scope } from './routing';

export const SCOPE_FILE = 'scope.json';
export const FACTS_FILE = 'founder-facts.json';

export type ScopeRecord = {
  version: 1;
  inputHash: string;
  suggestion: Scope;
  reasons: string[];
  outOfScopeCategory?: OutOfScopeCategory;
  extractedFacts: FounderFact[];      // candidates shown to the founder; NOT authoritative
  extractionNotes: string[];
  classifier?: { inputHash: string; at: string } & ({ ok: true } & ClassifierResult | { ok: false });
  confirmed?: {
    scope: Scope;
    source: 'founder';
    confirmedAt: string;
    agreedWith: 'suggestion' | 'classifier' | 'none';
    factsReviewed: boolean;
  };
};

export type FactsRecord = { version: 1; confirmedAt: string; facts: FounderFact[] };

async function readJson<T>(auditId: string, path: string): Promise<T | null> {
  const f = await db.projectFile.findUnique({ where: { auditId_path: { auditId, path } } });
  if (!f) return null;
  try { return JSON.parse(f.content) as T; } catch { return null; }
}

async function writeJson(auditId: string, path: string, value: unknown) {
  const content = JSON.stringify(value, null, 2);
  await db.projectFile.upsert({ where: { auditId_path: { auditId, path } }, update: { content }, create: { auditId, path, content } });
}

export const getScopeRecord = (auditId: string) => readJson<ScopeRecord>(auditId, SCOPE_FILE);
export const saveScopeRecord = (auditId: string, rec: ScopeRecord) => writeJson(auditId, SCOPE_FILE, rec);
export const saveFacts = (auditId: string, rec: FactsRecord) => writeJson(auditId, FACTS_FILE, rec);

/** Only founder-confirmed, locked facts. */
export async function getLockedFacts(auditId: string): Promise<FounderFact[]> {
  const rec = await readJson<FactsRecord>(auditId, FACTS_FILE);
  return (rec?.facts || []).filter((f) => f.locked && f.confirmedByFounder && f.source === 'FOUNDER_STATED');
}

/**
 * Server-side payment gate. Returns an error message, or null when the audit may be charged.
 * `legacy` covers audits whose Razorpay order was created by the pre-router code (no scope record).
 */
export function payableError(rec: ScopeRecord | null, audit: { paymentRef: string | null }): { error: string | null; legacy: boolean } {
  if (!rec) {
    if (audit.paymentRef && audit.paymentRef.startsWith('order_')) return { error: null, legacy: true };
    return { error: 'Please confirm what Aristotle should analyse before paying.', legacy: false };
  }
  if (!rec.confirmed) return { error: 'Please confirm what Aristotle should analyse before paying.', legacy: false };
  if (!PAYABLE_SCOPES.includes(rec.confirmed.scope)) return { error: 'This request is outside Aristotle’s audit scope, so no payment is needed.', legacy: false };
  return { error: null, legacy: false };
}
