// Narrative claim provenance for the decision memo's prose fields (problem, willingness to pay, demand,
// competition, market risk). These are written by the model; they are NOT established facts unless they cite
// verified research (R#/S#) or the founder (F#). Deterministic: computed at validation and again when displayed,
// so reports stored earlier are labelled too.

export type ClaimLabel = 'SOURCED' | 'FOUNDER' | 'INFERENCE' | 'HYPOTHESIS';
export type ClaimProvenance = { label: ClaimLabel; refs: string[]; reason: string };

export const NARRATIVE_FIELDS = [
  ['customer.problem', 'Problem'],
  ['customer.willingnessToPay', 'Willingness to pay'],
  ['marketView.demandSignal', 'Demand signal'],
  ['marketView.competition', 'Competition'],
  ['marketView.marketRisk', 'Market risk'],
] as const;
export type NarrativeField = (typeof NARRATIVE_FIELDS)[number][0];

// Claims that state a measurable fact about the world. Without evidence they are hypotheses, not facts.
const STRONG: [RegExp, string][] = [
  [/\b(?:daily|every\s+day|each\s+day|weekly|every\s+week|always|constantly|regularly|frequently|often|never|all\s+the\s+time|routinely)\b/i, 'states how often something happens'],
  [/\b(?:all|most|majority|every|everyone|nobody|no\s+one|none|few|many|millions?|thousands?)\s+(?:of\s+)?(?:the\s+)?(?:parents|kids|children|customers|users|people|publishers|competitors|players|brands|businesses|schools|buyers|indians|families|students|readers)\b/i, 'generalises about a whole group'],
  [/\b(?:lacks?|lacking|do(?:es)?\s+not|don'?t|doesn'?t|fails?\s+to|cannot|can'?t|no\s+(?:one|competitor|publisher|player|brand|existing|current)|missing|absent|unaddressed|underserved|ignored|gap\s+in\s+the\s+market|white\s*space|nobody\s+offers)\b/i, 'asserts what competitors or the market do not do'],
  [/\b(?:huge|massive|enormous|biggest|largest|fastest|only|unique|first|booming|exploding|untapped)\b/i, 'uses an unmeasured size or superlative'],
  [/\d|₹|\bpercent\b|\bcrore|\blakh|\bmillion|\bbillion/i, 'contains a number'],
];

export function classifyClaim(text: string, valid: { research: Set<string>; facts: Set<string> }): ClaimProvenance {
  const refs = [...new Set(text.match(/\b[RSF]\d+\b/g) || [])].filter((r) => (r.startsWith('F') ? valid.facts.has(r) : valid.research.has(r)));
  if (refs.some((r) => !r.startsWith('F'))) return { label: 'SOURCED', refs, reason: 'Cites verified research.' };
  if (refs.length) return { label: 'FOUNDER', refs, reason: 'Cites the founder’s confirmed facts.' };
  const strong = STRONG.find(([re]) => re.test(text));
  if (strong) return { label: 'HYPOTHESIS', refs: [], reason: `Not established by research: it ${strong[1]} without evidence.` };
  return { label: 'INFERENCE', refs: [], reason: 'Aristotle’s reasoning, not a researched fact.' };
}

type ReportLike = { customer?: Record<string, unknown>; marketView?: Record<string, unknown> };
export function narrativeProvenance(report: ReportLike, valid: { research: Set<string>; facts: Set<string> }): Partial<Record<NarrativeField, ClaimProvenance>> {
  const out: Partial<Record<NarrativeField, ClaimProvenance>> = {};
  for (const [field] of NARRATIVE_FIELDS) {
    const [group, key] = field.split('.') as ['customer' | 'marketView', string];
    const text = report[group]?.[key];
    if (typeof text === 'string' && text.trim()) out[field] = classifyClaim(text, valid);
  }
  return out;
}

export const CLAIM_LABEL: Record<ClaimLabel, string> = {
  SOURCED: 'Sourced', FOUNDER: 'Founder stated', INFERENCE: 'Inference — not established by research', HYPOTHESIS: 'Hypothesis — not established by research',
};
