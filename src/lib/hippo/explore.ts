// "I don't have a business idea yet." Hippoturtle proposes directions to TEST — hypotheses, never facts.
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
