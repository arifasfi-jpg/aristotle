// Mogli · Chief of Staff. Turns the founder's chosen pathways into concrete work packages,
// writes structured Work Briefs and routes each piece of work to a capability.
import { enabledCapabilities, routeCapability, STUDIO_TOOLS, type Capability } from './capabilities';
import { classifyWork, PERFORMER_LABEL, type WorkClassification } from './work-classification';
import { identityBlock, type Pathway, type Understanding, type WorkPlanItem } from './types';
import { describeFact, type FounderFact } from '../founder-facts';
import { classifyInputs, type BriefInput, type ProvenanceContext } from './provenance';

// ---------------------------------------------------------------- WORK GENERATION
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    work: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, description: { type: 'string' }, deliverable: { type: 'string' }, capability: { type: 'string' },
      priority: { type: 'integer' }, pathwayId: { type: 'string' }, whyNow: { type: 'string' }, aiExecutable: { type: 'boolean' },
      externalSteps: { type: 'array', items: { type: 'string' } },
    }, required: ['title', 'description', 'deliverable', 'capability', 'priority', 'pathwayId', 'whyNow', 'aiExecutable', 'externalSteps'] } },
  },
  required: ['headline', 'work'],
};

export function planPrompt(input: { objective: string; understanding: Understanding | null; pathways: Pathway[]; experiments: { test: string; passThreshold: string }[]; thirtyDayPlan: { week: string; objective: string }[]; memory: string; company?: string | null }): string {
  const caps = enabledCapabilities().map((c) => `- ${c.id}: ${c.label} — ${c.description}${c.requiresProfessional ? ' (regulated: AI researches and prepares; signing, filing and reliance-grade drafts need a professional)' : ''}`).join('\n');
  const studio = STUDIO_TOOLS.filter((t) => t.kind === 'GENERATE').map((t) => t.label).join(', ');
  return `You are Mogli, Chief of Staff at Hippoturtle. Convert the founder's chosen pathways into the work that must happen
between today and the FIRST VALIDATION MILESTONE (roughly the next 30 days).
${identityBlock(input.company ?? null)}

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
- 4 to 7 work packages. Each must produce ONE concrete deliverable (a document, page, list, script, plan, checklist, model, creative).
- Tie each to a chosen pathway via pathwayId (P#), or "" if it supports all.
- DELIVERABLE vs EXTERNAL ACTION: the title names what Hippoturtle PRODUCES ("Create Google Search campaign", "Format the manuscript",
  "Calculate unit economics from the supplied transaction data"). Steps that need the outside world — publishing through an account,
  sending to real people, calls/visits, printing/shipping, signing, filing with an authority, paying money — go in externalSteps
  (e.g. ["Publish the campaign from the founder's Google Ads account after approval"]). A later human step never makes the deliverable human-only.
- Only when the work ITSELF is a person's act (calling 50 prospects, signing, filing, paying) is it titled that way; Hippoturtle then
  prepares the supporting material.
- Creative & marketing work (${studio}, campaign preparation) goes to marketing (Aaira Studio, one capability).
  Financial analysis and models go to finance. Regulatory research goes to legal_regulatory; it is AI work — only signing, filing
  and drafts that will be relied on need a professional.
- aiExecutable: true when AI can produce the deliverable (given the founder's inputs). It is advisory; Hippoturtle re-derives it.
- priority: 1 = do first … 5 = later. whyNow: one sentence linked to the validation milestone.
- headline: one sentence the founder will read ("There are N important pieces of work between here and …").
- No invented statistics or prices. Simple English. JSON only.`;
}

export function normalisePlan(raw: unknown): { headline: string; work: (WorkPlanItem & { cap: Capability; classification: WorkClassification })[] } {
  const r = (raw || {}) as { headline?: unknown; work?: unknown };
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const work = (Array.isArray(r.work) ? r.work : []).slice(0, 7).map((w: Record<string, unknown>) => {
    const priority = Math.min(5, Math.max(1, Math.round(Number(w.priority) || 3)));
    const pathwayId = /^P\d+$/.test(s(w.pathwayId, 5)) ? s(w.pathwayId, 5) : undefined;
    const steps = (Array.isArray(w.externalSteps) ? w.externalSteps : []).map((x) => s(x, 200).replace(/[;|\n]+/g, ', ')).filter(Boolean).slice(0, 5);
    const description = `${s(w.description, 1200)}${steps.length ? `\n\nExternal steps (not done by AI): ${steps.join('; ')}` : ''}`;
    const item = { title: s(w.title, 140), description, deliverable: s(w.deliverable, 600), capability: s(w.capability, 40) };
    // Routing and execution class are derived from THIS work only; the planner's capability/aiExecutable are hints.
    const classification = classifyWork(item);
    const cap = routeCapability(classification.capabilityId);
    return { ...item, capability: classification.capabilityId, cap, classification, priority, pathwayId, whyNow: s(w.whyNow, 400), aiExecutable: classification.aiCanExecute };
  }).filter((w) => w.title && w.deliverable);
  if (work.length < 2) throw new Error('PLAN_INVALID: fewer than two usable work packages were produced');
  return { headline: s(r.headline, 400) || `There are ${work.length} important pieces of work between here and your first validation milestone.`, work };
}

// ---------------------------------------------------------------- WORK BRIEF
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' }, deliverable: { type: 'string' },
    inputs: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['KNOWN', 'PROPOSED', 'NEEDED'] }, value: { type: 'string' }, sourceRef: { type: 'string' } }, required: ['item', 'status', 'value', 'sourceRef'] } },
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

export function briefPrompt(input: { work: { title: string; description: string; deliverable: string }; cap: Capability; objective: string; memory: string; timeCommitment: string | null; company?: string | null; facts?: FounderFact[]; findings?: { code: string; statement: string }[]; classification?: WorkClassification }): string {
  const cls = input.classification ?? classifyWork({ ...input.work, capability: input.cap.id });
  return `You are Mogli, Chief of Staff at Hippoturtle. Write a precise WORK BRIEF so that ANY executor (AI, freelancer, agency)
must deliver exactly the same thing. Vague briefs let providers overcharge or under-deliver; be specific.
${identityBlock(input.company ?? null)}

WORK: ${input.work.title}
Description: ${input.work.description}
Deliverable: ${input.work.deliverable}
Capability: ${input.cap.label} (${input.cap.internalName})${cls.tool ? ` · tool: ${cls.tool.label} — produces ${cls.tool.produces}` : ''}${input.cap.requiresProfessional ? ' — REGULATED: a qualified professional must review/sign where the law requires' : ''}
WHAT HIPPOTURTLE PREPARES: ${cls.aiPrepares}
EXTERNAL ACTIONS (NOT part of the deliverable; list them in outOfScope as founder/human steps):
${cls.externalActions.map((a) => `- ${a.step} — ${PERFORMER_LABEL[a.performedBy]}${a.integration ? ` via ${a.integration.label} (not connected)` : ''}; founder approval required`).join('\n') || '- none'}
FOUNDER OBJECTIVE (verbatim, founder stated): """${input.objective}"""
Founder's available time: ${input.timeCommitment || 'not stated'}

FOUNDER-CONFIRMED FACTS (cite as sourceRef):
${(input.facts || []).map((f) => `${f.id}: ${describeFact(f)} — "${f.raw}"`).join('\n') || 'none'}

SOURCED RESEARCH FINDINGS (cite as sourceRef):
${(input.findings || []).map((f) => `${f.code}: ${f.statement}`).join('\n') || 'none'}

BUSINESS MEMORY (grouped by provenance):
${input.memory}

RULES:
- inputs: what the executor needs, each with provenance:
  KNOWN only if the value is stated in the founder objective (sourceRef "OBJECTIVE"), a founder fact (sourceRef "F#"),
  a founder approval, or a sourced finding (sourceRef "R#"). Copy the value exactly.
  PROPOSED for any value that only appears in Aristotle's validation experiments, pathways, assumptions, earlier work
  briefs/outputs or your own suggestion (e.g. a test price) — it is NOT founder-approved. sourceRef "AI".
  NEEDED with value "" for anything else. Never mark as NEEDED something the founder objective or facts already state.
- constraints: budget/deadline only if the founder stated them, else "Not set by founder". geography: India unless stated otherwise.
- successCriteria: 3–6 checkable criteria. outOfScope: 2–5 things explicitly NOT included (protects the founder from scope creep).
- effort: your best ESTIMATE of the human effort for this deliverable (hours), the specialist type, an assumed Indian hourly rate range
  in INR for that specialist (state the basis in rateBasis, e.g. "assumed freelance rate for a mid-level specialist in India — not a market quote"),
  review hours if AI drafts and a human reviews, an agency multiplier, aiOutputTokens needed for an AI draft (1000–9000),
  and costDrivers (what makes the cost go up or down for THIS work).
- aiFeasible: true when AI can produce THE DELIVERABLE above (documents, designs, copy, layouts, plans, analyses, models, research),
  even if an external action follows. Missing source material (a manuscript, a data export) is an input NEEDED, not a reason for false.
Simple English. JSON only.`;
}

export type BriefData = {
  objective: string; deliverable: string; inputs: BriefInput[];
  constraints: Record<'budget' | 'deadline' | 'geography' | 'brand' | 'technology' | 'regulatory', string>;
  successCriteria: string[]; expectedOutput: string; outOfScope: string[]; effort: Record<string, unknown>;
};

/** `provenance` re-derives each input's status deterministically (the model's KNOWN is never trusted on its own). */
export function normaliseBrief(raw: unknown, cap: Capability, provenance: ProvenanceContext = { objectiveText: '', facts: [], findings: [], approvals: [] }): BriefData {
  const r = (raw || {}) as Partial<BriefData>;
  const s = (v: unknown, n = 800) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const list = (v: unknown, n = 8) => (Array.isArray(v) ? v.map((x) => s(x, 300)).filter(Boolean).slice(0, n) : []);
  const c = (r.constraints || {}) as Record<string, unknown>;
  const k = (key: string) => s(c[key], 300) || 'Not set by founder';
  const constraints = { budget: k('budget'), deadline: k('deadline'), geography: s(c.geography, 120) || 'India', brand: k('brand'), technology: k('technology'), regulatory: s(c.regulatory, 400) || (cap.requiresProfessional ? 'Qualified professional review required.' : 'None identified.') };
  if (cap.requiresProfessional && !/professional|lawyer|ca\b|chartered/i.test(constraints.regulatory)) constraints.regulatory += ' A qualified professional must review and approve where required by law.';
  const brief: BriefData = {
    objective: s(r.objective), deliverable: s(r.deliverable),
    inputs: classifyInputs(Array.isArray(r.inputs) ? r.inputs : [], provenance),
    constraints, successCriteria: list(r.successCriteria, 6), expectedOutput: s(r.expectedOutput), outOfScope: list(r.outOfScope, 5),
    effort: (r.effort || {}) as Record<string, unknown>,
  };
  if (!brief.objective || !brief.deliverable || brief.successCriteria.length === 0) throw new Error('BRIEF_INVALID: the brief was incomplete');
  return brief;
}
