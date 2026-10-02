// Mogli · Chief of Staff. Turns the founder's chosen pathways into concrete work packages,
// writes structured Work Briefs and routes each piece of work to a capability.
import { enabledCapabilities, routeCapability, type Capability } from './capabilities';
import type { Pathway, Understanding, WorkPlanItem } from './types';

// ---------------------------------------------------------------- WORK GENERATION
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    work: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, description: { type: 'string' }, deliverable: { type: 'string' }, capability: { type: 'string' },
      priority: { type: 'integer' }, pathwayId: { type: 'string' }, whyNow: { type: 'string' }, aiExecutable: { type: 'boolean' },
    }, required: ['title', 'description', 'deliverable', 'capability', 'priority', 'pathwayId', 'whyNow', 'aiExecutable'] } },
  },
  required: ['headline', 'work'],
};

export function planPrompt(input: { objective: string; understanding: Understanding | null; pathways: Pathway[]; experiments: { test: string; passThreshold: string }[]; thirtyDayPlan: { week: string; objective: string }[]; memory: string }): string {
  const caps = enabledCapabilities().map((c) => `- ${c.id}: ${c.label} — ${c.description}${c.requiresProfessional ? ' (regulated: AI prepares, professional approves)' : ''}`).join('\n');
  return `You are Mogli, Chief of Staff at Hippoturtle. Convert the founder's chosen pathways into the work that must happen
between today and the FIRST VALIDATION MILESTONE (roughly the next 30 days).

OBJECTIVE: """${input.objective}"""
Target: ${input.understanding?.target || 'Not stated'} | Today: ${input.understanding?.currentState || 'Not stated'}

PATHWAYS THE FOUNDER CHOSE:
${input.pathways.map((p) => `${p.id} ${p.name}: ${p.howItWorks}\n   First experiment: ${p.firstExperiment}`).join('\n')}

VALIDATION EXPERIMENTS FROM THE DECISION MEMO:
${input.experiments.map((e, i) => `${i + 1}. ${e.test} (pass: ${e.passThreshold})`).join('\n') || 'none'}

30-DAY PLAN FROM THE DECISION MEMO:
${input.thirtyDayPlan.map((w) => `${w.week}: ${w.objective}`).join('\n') || 'none'}

BUSINESS MEMORY:
${input.memory}

CAPABILITIES YOU CAN ROUTE TO (use the id exactly):
${caps}

RULES:
- 4 to 7 work packages. Each must produce ONE concrete deliverable (a document, page, list, script, plan, checklist).
- Tie each to a chosen pathway via pathwayId (P#), or "" if it supports all.
- At least one must be fully doable by AI today (e.g. a GTM plan, outreach scripts, landing-page copy, pricing test design).
- Regulatory, legal or tax work goes to legal_regulatory / accounting_tax and is NEVER aiExecutable.
- Work that needs physical presence, calls, negotiations or signatures: aiExecutable=false.
- priority: 1 = do first … 5 = later. whyNow: one sentence linked to the validation milestone.
- headline: one sentence the founder will read ("There are N important pieces of work between here and …").
- No invented statistics or prices. Simple English. JSON only.`;
}

export function normalisePlan(raw: unknown): { headline: string; work: (WorkPlanItem & { cap: Capability })[] } {
  const r = (raw || {}) as { headline?: unknown; work?: unknown };
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const work = (Array.isArray(r.work) ? r.work : []).slice(0, 7).map((w: Record<string, unknown>) => {
    const cap = routeCapability(s(w.capability, 40));
    const priority = Math.min(5, Math.max(1, Math.round(Number(w.priority) || 3)));
    const pathwayId = /^P\d+$/.test(s(w.pathwayId, 5)) ? s(w.pathwayId, 5) : undefined;
    return { title: s(w.title, 140), description: s(w.description, 1200), deliverable: s(w.deliverable, 600), capability: cap.id, cap, priority, pathwayId, whyNow: s(w.whyNow, 400), aiExecutable: Boolean(w.aiExecutable) && cap.aiExecutable && !cap.requiresProfessional };
  }).filter((w) => w.title && w.deliverable);
  if (work.length < 2) throw new Error('PLAN_INVALID: fewer than two usable work packages were produced');
  return { headline: s(r.headline, 400) || `There are ${work.length} important pieces of work between here and your first validation milestone.`, work };
}

// ---------------------------------------------------------------- WORK BRIEF
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' }, deliverable: { type: 'string' },
    inputs: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['KNOWN', 'NEEDED'] }, value: { type: 'string' } }, required: ['item', 'status', 'value'] } },
    constraints: { type: 'object', properties: { budget: { type: 'string' }, deadline: { type: 'string' }, geography: { type: 'string' }, brand: { type: 'string' }, technology: { type: 'string' }, regulatory: { type: 'string' } }, required: ['budget', 'deadline', 'geography', 'brand', 'technology', 'regulatory'] },
    successCriteria: { type: 'array', items: { type: 'string' } },
    expectedOutput: { type: 'string' },
    outOfScope: { type: 'array', items: { type: 'string' } },
    effort: { type: 'object', properties: {
      aiFeasible: { type: 'boolean' }, aiOutputTokens: { type: 'integer' }, specialist: { type: 'string' },
      humanHours: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'high'] },
      hourlyRateInr: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'high'] },
      hybridReviewHours: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'high'] },
      agencyMultiplier: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'high'] },
      costDrivers: { type: 'array', items: { type: 'string' } }, rateBasis: { type: 'string' },
    }, required: ['aiFeasible', 'aiOutputTokens', 'specialist', 'humanHours', 'hourlyRateInr', 'hybridReviewHours', 'agencyMultiplier', 'costDrivers', 'rateBasis'] },
  },
  required: ['objective', 'deliverable', 'inputs', 'constraints', 'successCriteria', 'expectedOutput', 'outOfScope', 'effort'],
};

export function briefPrompt(input: { work: { title: string; description: string; deliverable: string }; cap: Capability; objective: string; memory: string; timeCommitment: string | null }): string {
  return `You are Mogli, Chief of Staff at Hippoturtle. Write a precise WORK BRIEF so that ANY executor (AI, freelancer, agency)
must deliver exactly the same thing. Vague briefs let providers overcharge or under-deliver; be specific.

WORK: ${input.work.title}
Description: ${input.work.description}
Deliverable: ${input.work.deliverable}
Capability: ${input.cap.label}${input.cap.requiresProfessional ? ' — REGULATED: a qualified professional must review/sign where the law requires' : ''}
Company objective: """${input.objective}"""
Founder's available time: ${input.timeCommitment || 'not stated'}

BUSINESS MEMORY (use KNOWN facts from here; anything else the executor needs is NEEDED):
${input.memory}

RULES:
- inputs: what the executor needs. status KNOWN only if it is in business memory (put the value); otherwise NEEDED with value "".
- constraints: budget/deadline only if the founder stated them, else "Not set by founder". geography: India unless stated otherwise.
- successCriteria: 3–6 checkable criteria. outOfScope: 2–5 things explicitly NOT included (protects the founder from scope creep).
- effort: your best ESTIMATE of the human effort for this deliverable (hours), the specialist type, an assumed Indian hourly rate range
  in INR for that specialist (state the basis in rateBasis, e.g. "assumed freelance rate for a mid-level specialist in India — not a market quote"),
  review hours if AI drafts and a human reviews, an agency multiplier, aiOutputTokens needed for an AI draft (1000–9000),
  and costDrivers (what makes the cost go up or down for THIS work).
- aiFeasible=false for anything needing calls, visits, signatures, or a licensed professional's judgement.
Simple English. JSON only.`;
}

export type BriefData = {
  objective: string; deliverable: string; inputs: { item: string; status: 'KNOWN' | 'NEEDED'; value: string }[];
  constraints: Record<'budget' | 'deadline' | 'geography' | 'brand' | 'technology' | 'regulatory', string>;
  successCriteria: string[]; expectedOutput: string; outOfScope: string[]; effort: Record<string, unknown>;
};

export function normaliseBrief(raw: unknown, cap: Capability): BriefData {
  const r = (raw || {}) as Partial<BriefData>;
  const s = (v: unknown, n = 800) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const list = (v: unknown, n = 8) => (Array.isArray(v) ? v.map((x) => s(x, 300)).filter(Boolean).slice(0, n) : []);
  const c = (r.constraints || {}) as Record<string, unknown>;
  const k = (key: string) => s(c[key], 300) || 'Not set by founder';
  const constraints = { budget: k('budget'), deadline: k('deadline'), geography: s(c.geography, 120) || 'India', brand: k('brand'), technology: k('technology'), regulatory: s(c.regulatory, 400) || (cap.requiresProfessional ? 'Qualified professional review required.' : 'None identified.') };
  if (cap.requiresProfessional && !/professional|lawyer|ca\b|chartered/i.test(constraints.regulatory)) constraints.regulatory += ' A qualified professional must review and approve where required by law.';
  const brief: BriefData = {
    objective: s(r.objective), deliverable: s(r.deliverable),
    inputs: (Array.isArray(r.inputs) ? r.inputs : []).slice(0, 12).map((i) => ({ item: s(i?.item, 200), status: i?.status === 'KNOWN' && s(i?.value, 300) ? 'KNOWN' as const : 'NEEDED' as const, value: i?.status === 'KNOWN' ? s(i?.value, 300) : '' })).filter((i) => i.item),
    constraints, successCriteria: list(r.successCriteria, 6), expectedOutput: s(r.expectedOutput), outOfScope: list(r.outOfScope, 5),
    effort: (r.effort || {}) as Record<string, unknown>,
  };
  if (!brief.objective || !brief.deliverable || brief.successCriteria.length === 0) throw new Error('BRIEF_INVALID: the brief was incomplete');
  return brief;
}
