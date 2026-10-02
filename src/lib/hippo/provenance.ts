// Provenance guard for Work Brief inputs.
//
// An AI-generated proposal (an Aristotle validation experiment, a pathway, a previous work brief or output) must
// never become "Known" just because it appears in Hippoturtle's memory. Deterministic rules decide what is known:
//   KNOWN    — every number (and the wording) traces to the founder's own objective / confirmed facts / an explicit
//              founder approval, or to a verified research finding (R#).
//   PROPOSED — a value that only exists as an AI proposal: shown as "AI-proposed … — not founder-approved".
//   NEEDED   — no value yet. If the founder already stated it (e.g. the 1,000 digital-book target) it is filled from
//              the founder's facts instead of being asked again.
import { formatFactValue, type FounderFact } from '../founder-facts';

export type InputStatus = 'KNOWN' | 'PROPOSED' | 'NEEDED';
export type InputSource = 'FOUNDER' | 'FOUNDER_APPROVED' | 'RESEARCH' | 'AI';
export type BriefInput = { item: string; status: InputStatus; value: string; source?: InputSource; sourceRef?: string };

export type ProvenanceContext = {
  objectiveText: string;
  facts: FounderFact[];
  findings: { code: string; statement: string; quote: string }[];
  approvals: { item: string; value: string }[];
};

const numbersIn = (s: string) => (s.replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n)));
const STOP = new Set(['the', 'and', 'for', 'per', 'with', 'from', 'that', 'this', 'month', 'months', 'year', 'number', 'value', 'target', 'current', 'price', 'what', 'our', 'your', 'are', 'its', 'into', 'about', 'each']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
export const itemKey = (item: string) => words(item).sort().join(' ');

/** True when every number in `value` appears in `text` (₹99 is NOT in an objective that only mentions 1,000). */
function numbersTrace(value: string, text: string) {
  const want = numbersIn(value);
  if (!want.length) return false;
  const have = new Set(numbersIn(text));
  return want.every((n) => have.has(n));
}
/** Qualitative values: most meaningful words must appear in the source text. */
function wordsTrace(value: string, text: string) {
  const v = words(value); if (!v.length) return false;
  const t = new Set(words(text));
  return v.filter((w) => t.has(w)).length / v.length >= 0.6;
}
const traces = (value: string, text: string) => (numbersIn(value).length ? numbersTrace(value, text) : wordsTrace(value, text));

const PRICE = /\b(price|pricing|priced|mrp|charge|fee|subscription)\b|₹/i;
/** Display label for a value Hippoturtle proposed but the founder never stated or approved. */
export const proposedLabel = (item: string, value = '') => (PRICE.test(`${item} ${value}`) ? 'AI-proposed validation price — not founder-approved' : 'AI-proposed — not founder-approved');

/** The founder fact a brief input is asking for, if the founder already stated it. */
export function matchFounderFact(item: string, facts: FounderFact[]): FounderFact | undefined {
  const t = item.toLowerCase();
  const wantTf = /\b(target|goal|aim|reach|plan(?:ned)?|by (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/.test(t) ? 'TARGET' : /\b(current|today|now|existing|present)\b/.test(t) ? 'CURRENT' : null;
  const conceptHint = /\b(price|pricing|mrp)\b/.test(t) ? 'selling_price' : /\bcost\b/.test(t) ? 'unit_cost' : /\bmargin\b/.test(t) ? 'margin' : /\bbudget\b/.test(t) ? 'marketing_budget' : /\b(order value|aov)\b/.test(t) ? 'aov' : null;
  const itemWords = new Set(words(item));
  const scored = facts
    .filter((f) => (!wantTf || f.timeframe === wantTf) && (!conceptHint || f.concept === conceptHint))
    .map((f) => ({ f, overlap: words(`${f.raw} ${f.context}`).filter((w) => itemWords.has(w)).length + (conceptHint ? 2 : 0) }))
    .filter((x) => x.overlap > 0 && (wantTf || conceptHint))
    .sort((a, b) => b.overlap - a.overlap);
  return scored[0]?.f;
}

const factText = (f: FounderFact) => `${f.raw} ${formatFactValue(f)} ${f.context}`;

/**
 * Re-derives every input's status from provenance. Runs when a brief is written AND when it is displayed or executed,
 * so briefs stored before this rule existed (e.g. "₹99 — Known") are corrected without regenerating anything.
 */
export function classifyInputs(raw: { item?: unknown; status?: unknown; value?: unknown; sourceRef?: unknown }[], ctx: ProvenanceContext): BriefInput[] {
  const founderText = [ctx.objectiveText, ...ctx.facts.map(factText)].join('\n');
  // A price must trace to a founder-stated price, not to any number (₹1,000 is not "1,000 books").
  const founderPriceText = [...(ctx.objectiveText.match(/(?:₹|rs\.?|inr)\s?[\d,]+(?:\.\d+)?/gi) || []), ...ctx.facts.filter((f) => f.concept === 'selling_price' || f.unit.startsWith('INR')).map(factText)].join('\n');
  const factById = new Map(ctx.facts.map((f) => [f.id, f]));
  const findingById = new Map(ctx.findings.map((f) => [f.code, f]));
  const out: BriefInput[] = [];
  for (const r of raw.slice(0, 12)) {
    const item = typeof r.item === 'string' ? r.item.trim().slice(0, 200) : '';
    if (!item) continue;
    const value = typeof r.value === 'string' ? r.value.trim().slice(0, 300) : '';
    const ref = typeof r.sourceRef === 'string' ? r.sourceRef.trim() : '';
    let res: BriefInput;
    if (!value || r.status === 'NEEDED') {
      res = { item, status: 'NEEDED', value: '' };
    } else if (ctx.approvals.some((a) => itemKey(a.item) === itemKey(item) && a.value.trim() === value)) {
      res = { item, status: 'KNOWN', value, source: 'FOUNDER_APPROVED' };
    } else if (factById.has(ref) && traces(value, factText(factById.get(ref)!)) && (!PRICE.test(`${item} ${value}`) || factById.get(ref)!.concept === 'selling_price' || factById.get(ref)!.unit.startsWith('INR'))) {
      res = { item, status: 'KNOWN', value, source: 'FOUNDER', sourceRef: ref };
    } else if (findingById.has(ref) && traces(value, `${findingById.get(ref)!.statement} ${findingById.get(ref)!.quote}`)) {
      res = { item, status: 'KNOWN', value, source: 'RESEARCH', sourceRef: ref };
    } else if (PRICE.test(`${item} ${value}`) && numbersIn(value).length ? numbersTrace(value, founderPriceText) : traces(value, founderText)) {
      res = { item, status: 'KNOWN', value, source: 'FOUNDER' };
    } else {
      // Present only as an AI proposal (validation experiment, pathway, earlier brief/output, model guess).
      res = { item, status: 'PROPOSED', value, source: 'AI' };
    }
    // Never ask the founder for something they already told us.
    if (res.status === 'NEEDED') {
      const f = matchFounderFact(item, ctx.facts);
      if (f) res = { item, status: 'KNOWN', value: f.raw, source: 'FOUNDER', sourceRef: f.id };
    }
    out.push(res);
  }
  return out;
}

export const INPUT_LABEL: Record<InputSource | 'NEEDED', string> = {
  FOUNDER: 'Founder stated', FOUNDER_APPROVED: 'Founder approved', RESEARCH: 'Sourced research', AI: 'AI-proposed — not founder-approved', NEEDED: 'Needed from you',
};
