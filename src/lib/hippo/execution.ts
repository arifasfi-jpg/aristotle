// AI execution of a work item, and the honest-broker quote comparison.
import type { Capability } from './capabilities';
import type { BriefData } from './mogli';
import { identityBlock } from './types';

export const EXECUTE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    markdown: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    founderInputsNeeded: { type: 'array', items: { type: 'string' } },
    professionalReviewRequired: { type: 'boolean' },
  },
  required: ['summary', 'markdown', 'assumptions', 'founderInputsNeeded', 'professionalReviewRequired'],
};

export type ExecutionOutput = { summary: string; markdown: string; assumptions: string[]; founderInputsNeeded: string[]; professionalReviewRequired: boolean };

export function executePrompt(input: { title: string; brief: BriefData; cap: Capability; mode: 'AI' | 'HYBRID'; memory: string; research: string; company?: string | null }): string {
  return `You are the ${input.cap.label} capability (${input.cap.internalName}) at Hippoturtle, executing a work item for a founder in India.
Produce the COMPLETE deliverable now — not an outline, not advice about how to do it.
${identityBlock(input.company ?? null)}

WORK: ${input.title}
OBJECTIVE: ${input.brief.objective}
DELIVERABLE: ${input.brief.deliverable}
EXPECTED OUTPUT: ${input.brief.expectedOutput}
SUCCESS CRITERIA:\n${input.brief.successCriteria.map((c) => `- ${c}`).join('\n')}
OUT OF SCOPE:\n${input.brief.outOfScope.map((c) => `- ${c}`).join('\n')}
INPUTS:\n${input.brief.inputs.map((i) => `- ${i.item}: ${i.status === 'KNOWN' ? `${i.value} (${i.source === 'RESEARCH' ? 'sourced research' : i.source === 'FOUNDER_APPROVED' ? 'founder approved' : 'founder stated'})` : i.status === 'PROPOSED' ? `${i.value} — AI-PROPOSED, NOT founder-approved: use only as a test hypothesis and label it as such` : 'NOT PROVIDED'}`).join('\n')}
CONSTRAINTS: ${Object.entries(input.brief.constraints).map(([k, v]) => `${k}: ${v}`).join(' | ')}

BUSINESS MEMORY (the only facts you may treat as true):
${input.memory}

RESEARCH (sourced findings you may cite as R#):
${input.research}

RULES:
- Never invent market statistics, prices, customer numbers or competitor facts. Where a number is needed and not in memory/research,
  write [TO CONFIRM: …] and list it under founderInputsNeeded.
- Label anything uncertain as an assumption and also list it under assumptions.
- ${input.cap.requiresProfessional || input.mode === 'HYBRID' ? 'This is a DRAFT for human review. State clearly at the top that it must be reviewed' + (input.cap.requiresProfessional ? ' and approved by a qualified professional before use. Do not present it as legal or tax advice.' : '.') : 'This should be usable by the founder today.'}
- Format markdown with clear headings, tables where useful, and concrete next actions. India context. Simple English.
- summary: 2–3 sentences on what was produced.
JSON only.`;
}

export function normaliseOutput(raw: unknown, cap: Capability, mode: 'AI' | 'HYBRID'): ExecutionOutput {
  const r = (raw || {}) as Partial<ExecutionOutput>;
  const markdown = typeof r.markdown === 'string' ? r.markdown.trim() : '';
  if (markdown.length < 200) throw new Error('EXECUTION_INVALID: the deliverable was empty or too short');
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 15) : []);
  return {
    summary: (typeof r.summary === 'string' ? r.summary : '').slice(0, 600),
    markdown: markdown.slice(0, 60_000),
    assumptions: list(r.assumptions), founderInputsNeeded: list(r.founderInputsNeeded),
    professionalReviewRequired: cap.requiresProfessional || mode === 'HYBRID' || Boolean(r.professionalReviewRequired),
  };
}

// ---------------------------------------------------------------- PROVENANCE OF AI DELIVERABLES
/** Machine-readable marker carried by every AI-generated execution deliverable. */
export const AI_PROVENANCE_MARKER = '<!-- HIPPOTURTLE_PROVENANCE: AI_GENERATED_DRAFT -->';

/**
 * Every Execution output is produced by AI (executeWork is the only writer), so it ALWAYS carries an explicit
 * "AI-generated" header — unconditionally, even when the model reports no assumptions and no founder inputs.
 * Applied when the output is stored AND whenever it is shown or downloaded, so outputs stored before this
 * existed are labelled too. Idempotent: an output that already starts with the marker is returned unchanged.
 * Model-written list items are flattened to one line so they cannot break out of the warning block.
 */
export function withAiProvenance(markdown: string, meta: { assumptions?: unknown; founderInputsNeeded?: unknown } = {}): string {
  const body = markdown || '';
  if (body.startsWith(AI_PROVENANCE_MARKER)) return body;
  const items = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, n) : []);
  const needed = items(meta.founderInputsNeeded, 15);
  const assumed = items(meta.assumptions, 5);
  return [
    AI_PROVENANCE_MARKER,
    '',
    '> **⚠ AI-generated draft — review before use in marketing, legal, or financial communications.**',
    ...(needed.length ? ['>', '> **Founder inputs needed:**', ...needed.map((x) => `> - ${x}`)] : []),
    ...(assumed.length ? ['>', '> **AI assumptions (not founder-approved):**', ...assumed.map((x) => `> - ${x}`)] : []),
    '',
    body,
  ].join('\n');
}

// ---------------------------------------------------------------- HONEST BROKER
export type QuoteComparison = {
  benchmarkLow: number | null; benchmarkHigh: number | null; deltaPct: number | null;
  position: 'BELOW' | 'WITHIN' | 'ABOVE' | 'NO_BENCHMARK';
  explanation: string; scopeGaps: string[]; extras: string[]; explainedBy: 'AI' | 'RULES';
};

/** Deterministic part: where the quote sits against Hippoturtle's own benchmark. */
export function positionQuote(amount: number, bench: { low: number; high: number } | null): Pick<QuoteComparison, 'benchmarkLow' | 'benchmarkHigh' | 'deltaPct' | 'position'> {
  if (!bench) return { benchmarkLow: null, benchmarkHigh: null, deltaPct: null, position: 'NO_BENCHMARK' };
  const mid = (bench.low + bench.high) / 2;
  const deltaPct = mid > 0 ? Math.round(((amount - mid) / mid) * 100) : null;
  const position = amount < bench.low ? 'BELOW' : amount > bench.high ? 'ABOVE' : 'WITHIN';
  return { benchmarkLow: bench.low, benchmarkHigh: bench.high, deltaPct, position };
}

export const COMPARE_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' }, scopeGaps: { type: 'array', items: { type: 'string' } }, extras: { type: 'array', items: { type: 'string' } } },
  required: ['explanation', 'scopeGaps', 'extras'],
};

export function comparePrompt(input: { brief: BriefData; quote: { provider: string; amount: number; includes: string[]; excludes: string[]; turnaroundDays: number | null; revisions: number | null }; pos: ReturnType<typeof positionQuote> }): string {
  return `You are Hippoturtle acting as an HONEST BROKER for the founder. Hippoturtle earns nothing more from any provider; your only job
is to explain why this external quote differs from Hippoturtle's benchmark, using ONLY what the brief and the quote state.

BRIEF deliverable: ${input.brief.deliverable}
Success criteria: ${input.brief.successCriteria.join('; ')}
Out of scope: ${input.brief.outOfScope.join('; ')}

QUOTE from ${input.quote.provider}: ₹${input.quote.amount.toLocaleString('en-IN')}
Includes: ${input.quote.includes.join('; ') || 'not stated'}
Excludes: ${input.quote.excludes.join('; ') || 'not stated'}
Turnaround: ${input.quote.turnaroundDays ?? 'not stated'} days | Revisions: ${input.quote.revisions ?? 'not stated'}

Benchmark: ${input.pos.position === 'NO_BENCHMARK' ? 'none available' : `₹${input.pos.benchmarkLow}–₹${input.pos.benchmarkHigh} (quote is ${input.pos.position}, ${input.pos.deltaPct}% vs midpoint)`}

Write explanation (2–4 sentences): e.g. "This quote is 35% above the benchmark because it includes 3 revision rounds and photography",
or "It is below the benchmark, but it excludes landing-page development which the brief requires".
scopeGaps: brief requirements the quote does not clearly cover. extras: things included beyond the brief.
Do not speculate about the provider's quality or motives. If the quote does not say, say "not stated". JSON only.`;
}

export function rulesExplanation(pos: ReturnType<typeof positionQuote>): string {
  if (pos.position === 'NO_BENCHMARK') return 'Hippoturtle has no benchmark for this work yet, so the quote cannot be compared.';
  const d = Math.abs(pos.deltaPct ?? 0);
  return pos.position === 'WITHIN' ? `This quote is within Hippoturtle's benchmark range (${pos.deltaPct}% vs the midpoint).`
    : `This quote is ${d}% ${pos.position === 'ABOVE' ? 'above' : 'below'} the midpoint of Hippoturtle's benchmark. Check what is included or excluded before deciding.`;
}
