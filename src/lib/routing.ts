// ---------------------------------------------------------------------------
// Scope routing.
//
//   NEW_IDEA     → ₹99 Idea Audit
//   GROWTH_PLAN  → ₹99 Growth Plan (existing business)   — same price, no separate fee
//   OUT_OF_SCOPE → free, never payable
//
// Everything here produces a SUGGESTION. The founder's explicit confirmation is the only thing
// that sets the scope. "Existing business" requires real operating history; pricing, targets,
// launch plans, estimated volumes, "would order" or "we sell" pitch-speak are NOT evidence.
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import type { UsageContext } from './ai-usage';
import { aristotleGeminiJson } from './hippo/gateway';
import type { FounderFact } from './founder-facts';

export const SCOPES = ['NEW_IDEA', 'GROWTH_PLAN', 'OUT_OF_SCOPE'] as const;
export type Scope = (typeof SCOPES)[number];
export const PAYABLE_SCOPES: readonly Scope[] = ['NEW_IDEA', 'GROWTH_PLAN'];
export const SCOPE_PRICE_PAISE: Record<Scope, number> = { NEW_IDEA: 9900, GROWTH_PLAN: 9900, OUT_OF_SCOPE: 0 };
export const SCOPE_LABEL: Record<Scope, string> = { NEW_IDEA: 'New Business / Idea', GROWTH_PLAN: 'Existing Business / Growth Plan', OUT_OF_SCOPE: 'Outside Aristotle’s audit scope' };
export const isScope = (v: unknown): v is Scope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v);

export type OutOfScopeCategory = 'personal_investment' | 'tax_filing' | 'medical_advice' | 'build_request';
export type ScopeSuggestion = { suggestion: Scope; reasons: string[]; outOfScopeCategory?: OutOfScopeCategory };

// Operating-history evidence. Deliberately short; the founder confirms anyway.
const OPERATING_HISTORY: [string, RegExp][] = [
  ['has been selling / operating', /\b(?:we've|we have|i've|i have|we've been|have been|has been|been)\s+(?:been\s+)?(?:selling|running|operating|serving|shipping|manufacturing|supplying|trading|doing business)\b/i],
  ['currently selling / operating', /\bcurrently\s+(?:selling|sell|doing|making|running|operating|serving|shipping|generating|clocking|earning|have)\b/i],
  ['states current sales / revenue', /\b(?:current|existing)\s+(?:sales|revenue|turnover|gmv)\b|\b(?:our|my)\s+(?:current|monthly|existing)\s+(?:sales|revenue|turnover)\b/i],
  ['has existing customers', /\b(?:existing|current|repeat|paying|regular)\s+(?:customers|clients|buyers|users|subscribers)\b|\bwe (?:have|serve|already have)\s+[\d,]+\+?\s*(?:customers|clients|users|stores|subscribers|buyers)\b/i],
  ['states operating history', /\b(?:since|started in|founded in|established in|operating since|running since|in business since)\s+(?:19|20)\d{2}\b|\bfor (?:the )?(?:last|past)?\s*\d+\+?\s*(?:years?|months?)\b(?=[^.]*\b(?:selling|running|operating|business|shop|store|brand))/i],
];

const OUT_OF_SCOPE_RULES: [OutOfScopeCategory, RegExp[]][] = [
  ['personal_investment', [
    /\b(?:should i|where (?:should|can) i|which|best)\b[^.?\n]{0,40}\b(?:invest|stocks?|shares?|mutual funds?|sip|crypto|bitcoin|portfolio|fixed deposits?)\b/i,
    /\binvest(?:ing)? my (?:savings|money|salary|bonus|pf)\b/i,
  ]],
  ['tax_filing', [
    /\b(?:file|filing|submit)\b[^.?\n]{0,20}\b(?:my )?(?:itr|income[- ]tax(?: return)?|tax returns?|gst returns?|gstr-?\d*)\b/i,
  ]],
  ['medical_advice', [
    /\b(?:i have|i've had|i am having|i'm having|suffering from)\b[^.?\n]{0,40}\b(?:pain|fever|diabetes|infection|symptoms?|cough|rash|headache|cancer|thyroid)\b/i,
    /\bwhat (?:medicine|tablet|drug|dose|dosage) should\b|\bshould i take\b/i,
  ]],
  ['build_request', [
    /\b(?:can you|could you|please|pls|kindly)\s+(?:build|develop|code|make|create|design)\b/i,
    /\b(?:build|develop|code|make|create|design)\s+(?:me|for me)\b/i,
  ]],
];

export const OUT_OF_SCOPE_MESSAGES: Record<OutOfScopeCategory | 'default', string> = {
  personal_investment: 'Aristotle audits businesses, not personal investments. For investment advice, please speak to a SEBI-registered investment adviser.',
  tax_filing: 'Aristotle does not file taxes or returns. A chartered accountant can help with ITR or GST filings.',
  medical_advice: 'Aristotle cannot give medical advice. Please consult a qualified doctor.',
  build_request: 'Aristotle audits business ideas and growth plans before anything is built. Describe the business you want to validate or grow.',
  default: 'This appears to be outside Aristotle’s standard audit scope.',
};

export function suggestScope(input: { idea: string; stage?: string | null; facts?: FounderFact[] }): ScopeSuggestion {
  const text = input.idea || '';
  const reasons: string[] = [];

  if (input.stage === 'Early revenue' || input.stage === 'Scaling') reasons.push(`Stage selected: ${input.stage}`);
  for (const [label, re] of OPERATING_HISTORY) if (re.test(text)) reasons.push(label);
  for (const f of input.facts || []) {
    if (f.timeframeEvidence !== 'explicit') continue;
    if (f.timeframe === 'CURRENT' && (f.concept === 'revenue' || f.concept === 'volume' || f.concept === 'customers')) reasons.push(`states current ${f.concept}: ${f.raw}`);
    if (f.concept === 'start_year') reasons.push(`operating since ${f.value}`);
  }
  if (reasons.length) return { suggestion: 'GROWTH_PLAN', reasons: [...new Set(reasons)] };

  for (const [cat, res] of OUT_OF_SCOPE_RULES) {
    if (res.some((re) => re.test(text))) return { suggestion: 'OUT_OF_SCOPE', reasons: [`matches out-of-scope rule: ${cat}`], outOfScopeCategory: cat };
  }
  return { suggestion: 'NEW_IDEA', reasons: ['no evidence of an already-operating business'] };
}

export function scopeInputHash(input: { idea: string; sector?: string | null; stage?: string | null }): string {
  return crypto.createHash('sha256').update(JSON.stringify([input.idea, input.sector ?? '', input.stage ?? ''])).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// "Not sure" — Gemini classifier. Called at most once per unchanged input (cached by the caller).
// ---------------------------------------------------------------------------
export type ClassifierResult = { scope: Scope; confidence: number; reason: string };

export async function classifyWithGemini(input: { idea: string; sector?: string | null; stage?: string | null }, usage?: UsageContext): Promise<ClassifierResult> {
  if (!process.env.GEMINI_API_KEY) throw new Error('classifier not configured');
  // Same model, prompt, schema and limits as before; now through the metered gateway (one AiUsage row per call).
  const r = await aristotleGeminiJson<{ scope?: unknown; confidence?: unknown; reason?: unknown }>('scope-classifier', {
    label: 'scope-classifier', timeoutMs: 8000, temperature: 0, maxOutputTokens: 200,
    schema: { type: 'object', properties: { scope: { type: 'string', enum: [...SCOPES] }, confidence: { type: 'number' }, reason: { type: 'string' } }, required: ['scope', 'confidence', 'reason'] },
    prompt: `Classify this request for Aristotle, an Indian venture-audit product.
NEW_IDEA: the founder has not meaningfully operated this business yet (pricing, targets, launch plans and estimates do NOT mean it operates).
GROWTH_PLAN: the business already operates — it has real sales, customers, revenue or operating history — and the founder wants to grow it.
OUT_OF_SCOPE: not a business audit (personal investment, personal tax filing, medical advice, or asking to build software).
Return JSON only. confidence is between 0 and 1.

Sector: ${input.sector || 'not given'}
Stage: ${input.stage || 'not given'}
Description: """${input.idea.slice(0, 4000)}"""`,
  }, usage);
  const parsed = r.data || {};
  if (!isScope(parsed.scope)) throw new Error('classifier returned an invalid scope');
  const c = Number(parsed.confidence);
  return { scope: parsed.scope, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0, reason: String(parsed.reason || '').slice(0, 300) };
}
