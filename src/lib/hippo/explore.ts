// "I don't have a business idea yet." Hippoturtle proposes directions to TEST — hypotheses, never facts.
import { PATHWAY_LENSES } from './types';
export const EXPLORE_SCHEMA = {
  type: 'object',
  properties: { directions: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, whoItServes: { type: 'string' }, whyYou: { type: 'string' }, firstTest: { type: 'string' }, objective: { type: 'string' },
  }, required: ['title', 'whoItServes', 'whyYou', 'firstTest', 'objective'] } } },
  required: ['directions'],
};

export type Direction = { title: string; whoItServes: string; whyYou: string; firstTest: string; objective: string };

export function explorePrompt(about: string): string {
  return `You are Hippoturtle. A person in India wants to start something but has no idea yet. Suggest 3 different business directions
that fit THEM, based only on what they wrote. These are hypotheses to test, not recommendations.
Rules: no market sizes, statistics or prices. whyYou: link to their skills/situation. firstTest: something they can do in 7 days for under ₹2,000.
objective: one sentence written as the founder ("I want to …") that they could submit to Hippoturtle.
ABOUT THEM: """${about}"""
JSON only.`;
}

export function normaliseDirections(raw: unknown): Direction[] {
  const list = Array.isArray((raw as { directions?: unknown })?.directions) ? (raw as { directions: Record<string, unknown>[] }).directions : [];
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const out = list.slice(0, 3).map((d) => ({ title: s(d.title, 120), whoItServes: s(d.whoItServes, 300), whyYou: s(d.whyYou, 400), firstTest: s(d.firstTest, 400), objective: s(d.objective, 600) })).filter((d) => d.title && d.objective);
  if (!out.length) throw new Error('EXPLORE_INVALID: no usable directions');
  return out;
}

// ---------------------------------------------------------------- "I don't know" inside the Hippo conversation (Moves)
/** Three directions + Hippo's recommendation, each with a cheap first Move that respects what the founder told us. */
export const DIRECTIONS_SCHEMA = {
  type: 'object',
  properties: {
    directions: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, whoItServes: { type: 'string' }, whyYou: { type: 'string' }, firstTest: { type: 'string' }, objective: { type: 'string' },
      firstMoveCostInr: { type: 'number' }, firstMoveDays: { type: 'number' },
    }, required: ['title', 'whoItServes', 'whyYou', 'firstTest', 'objective', 'firstMoveCostInr', 'firstMoveDays'] } },
    recommended: { type: 'integer' }, why: { type: 'string' },
  },
  required: ['directions', 'recommended', 'why'],
};
export type DirectionChoice = Direction & { firstMoveCostInr: number; firstMoveDays: number };

export function directionsPrompt(about: string, constraints: { budgetInr?: number; hoursPerWeek?: number; avoid: string[]; minor?: boolean }): string {
  return `You are Hippo. A person wants to start something but doesn't know what yet. Your job is NOT to find the theoretically best
business — it is to find the best FIRST REAL-WORLD TEST for THIS person. Based ONLY on what they told you:
1. Privately consider many possibilities, using these angles (internal only — never name them): ${PATHWAY_LENSES.map((l) => l.toLowerCase().replace(/_/g, ' ')).join(', ')}.
2. Keep only 1 to 3 genuinely different directions (do not pad to three) and recommend ONE.
Recommend by: fit with their skills, time and money; how fast a real person can respond; how cheaply it can be tested; whether they can
reach those customers; what they said they will or won't do. Prefer a direction they can start this week without spending money.
These are directions to test, not facts. No market sizes, statistics, scores or prices you can't justify. whyYou links to their skills, situation or access.
firstTest: the first real-world step, doable in ≤ 7 days${constraints.budgetInr !== undefined ? ` and costing at most ₹${Math.min(constraints.budgetInr, 2000)}` : ' for under ₹2,000'}.
firstMoveCostInr: its cost in rupees (0 if free). firstMoveDays: days to a first response from a real person.
${constraints.avoid.length ? `Never suggest anything they said they won't do: ${constraints.avoid.join('; ')}.\n` : ''}${constraints.minor ? 'They are under 18: directions must be safe and need a parent for money or strangers.\n' : ''}objective: one sentence written as the founder ("I want to …").
recommended: the index of the one you would start with. why: one plain sentence a friend would say, e.g. "you can start without spending money, it fits your evenings, and we'll know within days whether people want it".
ABOUT THEM: """${about.slice(0, 3000)}"""
JSON only.`;
}

export function normaliseDirectionChoice(raw: unknown): { directions: DirectionChoice[]; recommended: number; why: string } {
  const r = (raw ?? {}) as { directions?: Record<string, unknown>[]; recommended?: unknown; why?: unknown };
  const base = normaliseDirections(raw);
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0);
  const directions = base.map((d, i) => ({ ...d, firstMoveCostInr: num(r.directions?.[i]?.firstMoveCostInr, 1_000_000), firstMoveDays: num(r.directions?.[i]?.firstMoveDays, 90) || 7 }));
  const rec = typeof r.recommended === 'number' && Number.isInteger(r.recommended) && r.recommended >= 0 && r.recommended < directions.length ? r.recommended : 0;
  return { directions, recommended: rec, why: typeof r.why === 'string' ? r.why.trim().slice(0, 300) : '' };
}
