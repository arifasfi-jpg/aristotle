// Hippoturtle orchestration services. API routes stay thin; every step here is
// authorised by the caller (context.ts), idempotent where it can be retried, and logged.
import type { Objective as DbObjective, Prisma } from '@prisma/client';
import { db } from '../db';
import type { AuditReport } from '../audit';
import { getLockedFacts, getResearch } from '../audit-meta';
import type { ResearchRecord } from '../evidence';
import { researchBrief } from '../research';
import { getCapability, routeCapability } from './capabilities';
import { guardMarketingClaims } from './claims';
import { classifyWork } from './work-classification';
import { HttpError, isUniqueViolation, logActivity, memoryBrief, remember } from './context';
import { computeEstimates, midpoint, normaliseEffort } from './costs';
import { comparePrompt, COMPARE_SCHEMA, EXECUTE_SCHEMA, executePrompt, isCustomerFacing, normaliseOutput, positionQuote, rulesExplanation, withAiProvenance, type QuoteComparison } from './execution';
import { aiMeta, executionPrice, generateJson, type GatewayResult } from './gateway';
import { BRIEF_SCHEMA, briefPrompt, normaliseBrief, normalisePlan, PLAN_SCHEMA, planPrompt, type BriefData } from './mogli';
import { normalisePathways, pathwayRefs, PATHWAYS_SCHEMA, pathwaysPrompt } from './pathways';
import { canExecuteNow, workPaymentPlan } from './payments';
import { classifyInputs, itemKey, type BriefInput, type ProvenanceContext } from './provenance';
import { ensureAudit, parseReport, persistPathways, syncAristotle, understandObjective } from './aristotle';
import { advanceTo, businessName, DEFAULT_ORG_NAME, DEMO_COMPANY_NAME, isExecutionMode, PROVIDER_TIERS, type EffortModel, type PathwaysResult, type Understanding } from './types';

type Org = { id: string; isDemo?: boolean; name?: string };
type Objective = { id: string; organizationId: string; companyName: string | null; text: string; stage: string; auditId: string | null; understanding: Prisma.JsonValue; selectedPathways: Prisma.JsonValue };
const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * The founder's business name for ONE objective (null when unnamed or ambiguous). Never the platform's own name.
 * objective.companyName (set at creation, never changed) is authoritative. Legacy objectives (companyName NULL,
 * created before it existed) may use the organisation's name only when that organisation has exactly one
 * objective; with several, the org name may belong to (or have been overwritten by) another objective, so null.
 */
export function resolveCompanyName(objective: { companyName?: string | null }, org: { name?: string | null } | null, objectivesInOrg: number): string | null {
  if (objective.companyName != null) return businessName(objective.companyName);
  return objectivesInOrg === 1 ? businessName(org?.name) : null;
}

/** Objective-aware company identity for AI prompts and objective pages. */
export async function companyFor(objective: { companyName?: string | null; organizationId: string }): Promise<string | null> {
  if (objective.companyName != null) return resolveCompanyName(objective, null, 0); // fast path: no lookup
  const [org, objectivesInOrg] = await Promise.all([
    db.organization.findUnique({ where: { id: objective.organizationId }, select: { name: true } }),
    db.objective.count({ where: { organizationId: objective.organizationId } }),
  ]);
  return resolveCompanyName(objective, org, objectivesInOrg);
}

/** Everything an input value may legitimately trace to: the founder's words, confirmed facts, approvals, verified findings. */
export async function provenanceFor(objective: { id: string; organizationId: string; text: string; auditId: string | null }): Promise<ProvenanceContext> {
  const [facts, findings, approvals] = await Promise.all([
    objective.auditId ? getLockedFacts(objective.auditId) : Promise.resolve([]),
    db.researchFinding.findMany({ where: { objectiveId: objective.id }, select: { code: true, statement: true, quote: true } }),
    db.businessMemory.findMany({ where: { organizationId: objective.organizationId, objectiveId: objective.id, refType: 'founder_approval', status: 'FOUNDER_STATED' }, select: { detail: true, value: true } }),
  ]);
  return { objectiveText: objective.text, facts, findings, approvals: approvals.map((a) => ({ item: a.detail, value: a.value || '' })) };
}

async function logAi(orgId: string, objectiveId: string, workId: string | null, r: GatewayResult<unknown>, actor: string) {
  await logActivity({ organizationId: orgId, objectiveId, workId, type: 'AI_CALL', actor, message: `${actor} used ${r.provider}/${r.model} for ${r.task}`, meta: aiMeta(r) });
}

// ---------------------------------------------------------------- OBJECTIVE
export async function createObjective(ctx: { user: { id: string }; founder: { id: string; name: string | null }; org: Org & { name?: string; isDemo?: boolean } }, input: { text: string; mode: 'IDEA' | 'EXPLORE'; timeCommitment?: string | null; isDemo?: boolean; companyName?: string | null }) {
  if (input.timeCommitment) await db.founder.update({ where: { id: ctx.founder.id }, data: { timeCommitment: input.timeCommitment } });

  let orgId = ctx.org.id;
  let liveOrgName: string | null = null;
  if (input.isDemo) {
    // Demo objectives always get a fresh isolated org — never touch the founder's live org.
    const demoOrg = await db.organization.create({
      data: { founderId: ctx.founder.id, name: DEMO_COMPANY_NAME, isDemo: true },
    });
    orgId = demoOrg.id;
  } else {
    // A real objective must live in the founder's live (non-demo) organisation. Read isDemo from the database rather
    // than trusting the caller. A founder whose only organisation is a demo one (legacy data, or a Preview demo
    // account) gets a new live organisation instead of an error.
    const pick = { id: true, isDemo: true, founderId: true, name: true } as const;
    let live = await db.organization.findUnique({ where: { id: ctx.org.id }, select: pick });
    if (!live || live.isDemo || live.founderId !== ctx.founder.id) {
      live = (await db.organization.findFirst({ where: { founderId: ctx.founder.id, isDemo: false }, orderBy: { createdAt: 'asc' }, select: pick }))
        ?? await db.organization.create({ data: { founderId: ctx.founder.id, name: DEFAULT_ORG_NAME }, select: pick });
    }
    if (live.isDemo) throw new Error('INVARIANT VIOLATION: attempted to attach a real objective to a demo org');
    orgId = live.id;
    liveOrgName = live.name;
    // Only rename the org on the very first objective — after that the name is frozen on the org.
    const existingCount = await db.objective.count({ where: { organizationId: orgId } });
    if (existingCount === 0) {
      const wanted = businessName(input.companyName);
      if (wanted) {
        await db.organization.update({ where: { id: orgId }, data: { name: wanted } });
      }
    }
  }

  // Per-objective company name, fixed at creation: demo → the fictional demo name; real → the founder's input, else
  // the founder's own live organisation's name. A real objective can never take the demo business's name.
  const notDemoName = (n: string | null) => (n && n !== DEMO_COMPANY_NAME ? n : null);
  const companyNameForObjective = input.isDemo ? DEMO_COMPANY_NAME : notDemoName(businessName(input.companyName)) ?? notDemoName(businessName(liveOrgName));

  // companyName is stored on the objective row — immutable after creation.
  const objective = await db.objective.create({
    data: {
      organizationId: orgId,
      text: input.text,
      mode: input.mode,
      isDemo: Boolean(input.isDemo),
      companyName: companyNameForObjective,
    },
  });
  await logActivity({ organizationId: orgId, objectiveId: objective.id, type: 'OBJECTIVE_CREATED', actor: 'Founder', message: `Founder set an objective: ${input.text.slice(0, 160)}` });
  await remember({ organizationId: orgId, objectiveId: objective.id, kind: 'OBJECTIVE', title: input.text.slice(0, 300), status: 'FOUNDER_STATED', owner: 'Founder', source: input.isDemo ? 'Demo data' : 'Founder', refType: 'objective', refId: objective.id });

  const u = await understandObjective(input.text, await companyFor({ companyName: companyNameForObjective, organizationId: orgId }), { userId: ctx.user.id, founderId: ctx.founder.id, organizationId: orgId, objectiveId: objective.id, parentType: 'REQUEST' });
  if (u.meta) await logActivity({ organizationId: orgId, objectiveId: objective.id, type: 'AI_CALL', actor: 'Mogli', message: `Mogli used ${u.meta.provider}/${u.meta.model} for understand`, meta: u.meta });
  if (u.error) console.error('Hippoturtle understand fell back to founder numbers:', u.error);
  const updated = await db.objective.update({ where: { id: objective.id }, data: { understanding: json(u.understanding), stage: 'UNDERSTAND' } });
  const audit = await ensureAudit(updated, ctx.user.id, ctx.founder.name);
  await logActivity({ organizationId: orgId, objectiveId: objective.id, type: 'UNDERSTOOD', actor: 'Mogli', message: `Understood the objective. Key question: ${u.understanding.keyQuestion}`.slice(0, 300) });
  return { objectiveId: objective.id, auditId: audit.id, understanding: u.understanding };
}

/** Called whenever the objective is viewed: links a finished Aristotle audit into Hippoturtle (deterministic, idempotent). */
export async function refreshObjective(objective: DbObjective): Promise<DbObjective> {
  if (!objective.auditId) return objective;
  const audit = await db.audit.findUnique({ where: { id: objective.auditId } });
  // Atomic transition: only the request that actually moves UNDERSTAND → RESEARCH logs it (no duplicate log on concurrent loads).
  if (audit && (audit.paymentStatus === 'paid' || audit.status === 'generating') && objective.stage === 'UNDERSTAND'
    && (await db.objective.updateMany({ where: { id: objective.id, stage: 'UNDERSTAND' }, data: { stage: 'RESEARCH' } })).count === 1) {
    await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, type: 'ARISTOTLE_STARTED', actor: 'Aristotle', message: 'Aristotle started researching the objective.' });
  }
  await syncAristotle({ ...objective, stage: objective.stage === 'UNDERSTAND' ? 'RESEARCH' : objective.stage });
  return db.objective.findUniqueOrThrow({ where: { id: objective.id } });
}

async function loadAristotle(objective: Objective) {
  const memo = await db.decisionMemo.findUnique({ where: { objectiveId: objective.id } });
  if (!memo) throw new HttpError(409, 'Aristotle has not finished the decision memo yet.');
  const report = memo.content as unknown as AuditReport;
  const research = objective.auditId ? ((await getResearch(objective.auditId)) as ResearchRecord | null) : null;
  const facts = objective.auditId ? await getLockedFacts(objective.auditId) : [];
  return { memo, report, research, facts };
}

// ---------------------------------------------------------------- PATHWAYS (Aristotle)
export async function generatePathways(objective: Objective) {
  const { memo, report, research, facts } = await loadAristotle(objective);
  if (memo.pathways) return memo.pathways as unknown as PathwaysResult;
  // Normally the audit job already generated them with the report (synced onto the memo); older reports did not.
  if (report.pathways?.pathways?.length) { await persistPathways(objective, memo.id, report.pathways); return report.pathways; }
  const r = await generateJson<unknown>('pathways', pathwaysPrompt({ objective: objective.text, understanding: objective.understanding as Understanding | null, facts, research, report, company: await companyFor(objective) }), PATHWAYS_SCHEMA, {}, { organizationId: objective.organizationId, objectiveId: objective.id, parentType: 'REQUEST' });
  await logAi(objective.organizationId, objective.id, null, r, 'Aristotle');
  const result = normalisePathways(r.data, pathwayRefs(research, facts));
  await persistPathways(objective, memo.id, result);
  return result;
}

export async function selectPathways(objective: Objective, ids: string[]) {
  const memo = await db.decisionMemo.findUnique({ where: { objectiveId: objective.id } });
  const result = memo?.pathways as unknown as PathwaysResult | null;
  if (!result) throw new HttpError(409, 'Pathways have not been generated yet.');
  const chosen = result.pathways.filter((p) => ids.includes(p.id));
  if (!chosen.length) throw new HttpError(400, 'Choose at least one pathway to pursue.');
  if (await db.work.count({ where: { objectiveId: objective.id } })) throw new HttpError(409, 'Work has already been planned for these pathways.');
  await db.objective.update({ where: { id: objective.id }, data: { selectedPathways: chosen.map((p) => p.id) } });
  const names = chosen.map((p) => p.name).join(', ');
  await remember({ organizationId: objective.organizationId, objectiveId: objective.id, kind: 'DECISION', title: `Founder decided to pursue: ${names}`, detail: `Chosen from ${result.pathways.length} pathways Aristotle laid out.`, status: 'RECORD', owner: 'Founder', refType: 'pathway_decision', refId: `${objective.id}:${chosen.map((p) => p.id).join(',')}` });
  await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, type: 'FOUNDER_DECISION', actor: 'Founder', message: `Founder chose pathways: ${names}` });
  return chosen;
}

// ---------------------------------------------------------------- WORK GENERATION (Mogli)
export async function generateWork(objective: Objective) {
  const existing = await db.work.findMany({ where: { objectiveId: objective.id }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  if (existing.length) return existing;
  const { memo, report } = await loadAristotle(objective);
  const result = memo.pathways as unknown as PathwaysResult | null;
  const selected = (Array.isArray(objective.selectedPathways) ? objective.selectedPathways : []) as string[];
  const chosen = (result?.pathways || []).filter((p) => selected.includes(p.id));
  if (!chosen.length) throw new HttpError(409, 'Choose at least one pathway first.');
  const memory = await memoryBrief(objective.organizationId, objective.id);
  const r = await generateJson<unknown>('plan', planPrompt({ objective: objective.text, understanding: objective.understanding as Understanding | null, pathways: chosen, experiments: report.experiments || [], thirtyDayPlan: report.thirtyDayPlan || [], memory, company: await companyFor(objective) }), PLAN_SCHEMA, {}, { organizationId: objective.organizationId, objectiveId: objective.id, parentType: 'REQUEST' });
  await logAi(objective.organizationId, objective.id, null, r, 'Mogli');
  const plan = normalisePlan(r.data);
  if (await db.work.count({ where: { objectiveId: objective.id } })) return db.work.findMany({ where: { objectiveId: objective.id }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }); // concurrent request won
  for (const w of plan.work) {
    const work = await db.work.create({ data: { organizationId: objective.organizationId, objectiveId: objective.id, title: w.title, description: `${w.description}${w.whyNow ? `\n\nWhy now: ${w.whyNow}` : ''}`, deliverable: w.deliverable, capability: w.capability, priority: w.priority, pathwayId: w.pathwayId ?? null, aiExecutable: w.aiExecutable, status: 'READY' } });
    await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, workId: work.id, type: 'WORK_CREATED', actor: 'Mogli', message: `Work created: ${w.title} → ${w.cap.label}` });
  }
  await db.objective.update({ where: { id: objective.id }, data: { stage: advanceTo(objective.stage, 'WORK_GENERATION') } });
  await remember({ organizationId: objective.organizationId, objectiveId: objective.id, kind: 'WORK', title: plan.headline, detail: plan.work.map((w) => `• ${w.title}`).join('\n'), status: 'RECORD', owner: 'Mogli', refType: 'work_plan', refId: objective.id });
  return db.work.findMany({ where: { objectiveId: objective.id }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
}

// ---------------------------------------------------------------- WORK BRIEF + COST ESTIMATE
export async function prepareBrief(ctx: { work: { id: string; organizationId: string; objectiveId: string; title: string; description: string; deliverable: string; capability: string; status: string }; objective: Objective; founder: { timeCommitment: string | null } }) {
  const { work, objective } = ctx;
  const existing = await db.workBrief.findUnique({ where: { workId: work.id } });
  if (existing) return existing;
  // Routing + execution class come from THIS work only (never from other objectives, earlier work or memory).
  const classification = classifyWork(work);
  const cap = routeCapability(classification.capabilityId);
  const memory = await memoryBrief(objective.organizationId, objective.id);
  const provenance = await provenanceFor(objective);
  const prompt = briefPrompt({ work, cap, objective: objective.text, memory, timeCommitment: ctx.founder.timeCommitment, company: await companyFor(objective), facts: provenance.facts, findings: provenance.findings, classification });
  const r = await generateJson<unknown>('brief', prompt, BRIEF_SCHEMA, {}, { organizationId: objective.organizationId, objectiveId: objective.id, workId: work.id, parentType: 'WORK', parentId: work.id });
  await logAi(objective.organizationId, objective.id, work.id, r, 'Mogli');
  const brief = normaliseBrief(r.data, cap, provenance);
  const effort = normaliseEffort(brief.effort as Partial<EffortModel>, cap);
  const promptTokens = Math.round((prompt.length + memory.length) / 4);
  const estimates = computeEstimates(effort, cap, promptTokens, await executionPrice(), classification.modes);
  let saved;
  try {
    saved = await db.workBrief.create({ data: { workId: work.id, objective: brief.objective, deliverable: brief.deliverable, inputs: json(brief.inputs), constraints: json(brief.constraints), successCriteria: json(brief.successCriteria), expectedOutput: brief.expectedOutput, outOfScope: json(brief.outOfScope), effort: json(effort), provider: r.provider, model: r.model } });
  } catch (e) { if (!isUniqueViolation(e)) throw e; return db.workBrief.findUniqueOrThrow({ where: { workId: work.id } }); } // concurrent request won
  await db.costEstimate.createMany({ data: estimates.map((e) => ({ workId: work.id, mode: e.mode, low: e.low, high: e.high, label: e.label, basis: e.basis, breakdown: json(e.breakdown), drivers: json(e.drivers) })) });
  const primary = estimates.find((e) => e.mode === 'AI') || estimates.find((e) => e.mode === 'HYBRID') || estimates[0];
  await db.work.update({ where: { id: work.id }, data: { estimatedCost: primary ? Math.round(midpoint(primary) * 100) / 100 : null, status: ['READY', 'DRAFT'].includes(work.status) ? 'AWAITING_DECISION' : work.status } });
  await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, workId: work.id, type: 'COST_ESTIMATED', actor: 'Mogli', message: `Brief written and cost estimated for "${work.title}": ${estimates.map((e) => `${e.mode} ₹${e.low.toLocaleString('en-IN')}–₹${e.high.toLocaleString('en-IN')}`).join(' · ')}`.slice(0, 450) });
  return saved;
}

// ---------------------------------------------------------------- FOUNDER CHOICE
export async function chooseExecution(ctx: { work: { id: string; organizationId: string; objectiveId: string; title: string; capability: string; status: string; description?: string; deliverable?: string }; objective: Objective }, choice: string) {
  const { work, objective } = ctx;
  if (['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(work.status)) throw new HttpError(409, 'This work can no longer change execution mode.');
  const briefRow = await db.workBrief.findUnique({ where: { workId: work.id } });
  if (!briefRow) throw new HttpError(409, 'The work brief has not been written yet.');
  if (choice === 'LATER') {
    await db.work.update({ where: { id: work.id }, data: { status: 'AWAITING_DECISION', executionMode: null } });
    await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'FOUNDER_CHOICE', actor: 'Founder', message: `Founder will decide later on "${work.title}".` });
    return { mode: null, payment: null };
  }
  if (!isExecutionMode(choice)) throw new HttpError(400, 'Choose AI, HUMAN, HYBRID or LATER.');
  const classification = classifyWork(work);
  const cap = routeCapability(classification.capabilityId);
  if (!classification.modes.includes(choice)) throw new HttpError(400, `${classification.summary} AI-only execution is not offered for this work.`);
  let estimate = await db.costEstimate.findFirst({ where: { workId: work.id, mode: choice } });
  if (choice === 'AI' && !estimate) {
    // Briefs written before work classification had no AI estimate when the model guessed "not AI-feasible".
    // The work's class allows AI, so compute the AI estimate from the stored effort (deterministic, labelled COMPUTED).
    const ai = computeEstimates(normaliseEffort(briefRow.effort as Partial<EffortModel>, cap), cap, 3000, await executionPrice(), classification.modes).find((e) => e.mode === 'AI');
    if (ai) estimate = await db.costEstimate.create({ data: { workId: work.id, mode: 'AI', low: ai.low, high: ai.high, label: ai.label, basis: ai.basis, breakdown: json(ai.breakdown), drivers: json(ai.drivers) } });
  }
  if (choice === 'AI' && !estimate) throw new HttpError(400, 'AI cannot execute this work on its own.');
  const payment = workPaymentPlan(choice);
  await db.work.update({ where: { id: work.id }, data: { executionMode: choice, paymentStatus: payment.status, status: choice === 'HUMAN' ? 'WAITING_FOR_INPUT' : 'APPROVED' } });
  const label = { AI: 'Hippoturtle (AI)', HUMAN: 'an external provider', HYBRID: 'hybrid (AI draft + human review)' }[choice];
  await remember({ organizationId: work.organizationId, objectiveId: objective.id, kind: 'DECISION', title: `Founder chose ${label} for "${work.title}"`, detail: estimate ? `Estimate at decision time: ₹${estimate.low.toLocaleString('en-IN')}–₹${estimate.high.toLocaleString('en-IN')} (${estimate.label === 'COMPUTED' ? 'calculated' : 'indicative benchmark'}). ${payment.note}` : payment.note, status: 'RECORD', owner: 'Founder', refType: 'work_choice', refId: `${work.id}:${choice}:${Date.now()}` });
  await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'FOUNDER_CHOICE', actor: 'Founder', message: `Founder chose ${label} for "${work.title}".` });
  if (payment.required) await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'PAYMENT_INITIATED', actor: 'Hippoturtle', message: `Payment required but not yet integrated (${payment.status}). Nothing charged.` });
  await db.objective.update({ where: { id: objective.id }, data: { stage: advanceTo(objective.stage, 'EXECUTION') } });
  return { mode: choice, payment };
}

// ---------------------------------------------------------------- EXECUTION
const STALE_MS = 3 * 60_000;

export async function executeWork(ctx: { work: { id: string; organizationId: string; objectiveId: string; title: string; capability: string; status: string; executionMode: string | null; description?: string; deliverable?: string }; objective: Objective }) {
  const { work, objective } = ctx;
  const mode = work.executionMode;
  if (mode !== 'AI' && mode !== 'HYBRID') throw new HttpError(409, 'Choose Hippoturtle (AI) or Hybrid before executing.');
  const payment = workPaymentPlan(mode);
  if (!canExecuteNow(payment)) throw new HttpError(402, payment.note);
  const briefRow = await db.workBrief.findUnique({ where: { workId: work.id } });
  if (!briefRow) throw new HttpError(409, 'The work brief has not been written yet.');
  // Atomic claim: only one execution at a time; a crashed run (stale IN_PROGRESS) can be retried.
  const claim = await db.work.updateMany({ where: { id: work.id, OR: [{ status: 'APPROVED' }, { status: 'IN_PROGRESS', updatedAt: { lt: new Date(Date.now() - STALE_MS) } }] }, data: { status: 'IN_PROGRESS' } });
  if (claim.count === 0) throw new HttpError(409, work.status === 'IN_PROGRESS' ? 'This work is already in progress.' : 'This work is not ready to execute.');
  const classification = classifyWork(work);
  if (!classification.modes.includes(mode)) { await db.work.update({ where: { id: work.id }, data: { status: 'AWAITING_DECISION', executionMode: null } }); throw new HttpError(409, `${classification.summary} Choose Hybrid or an external provider.`); }
  const cap = routeCapability(classification.capabilityId);
  // Inputs are re-classified from provenance at execution time: an AI proposal stored as "KNOWN" by an older brief is still sent as a proposal.
  const provenance = await provenanceFor(objective);
  const brief: BriefData = { objective: briefRow.objective, deliverable: briefRow.deliverable, inputs: classifyInputs(briefRow.inputs as BriefInput[], provenance), constraints: briefRow.constraints as BriefData['constraints'], successCriteria: briefRow.successCriteria as string[], expectedOutput: briefRow.expectedOutput, outOfScope: briefRow.outOfScope as string[], effort: {} };
  const execution = await db.execution.create({ data: { workId: work.id, mode, status: 'RUNNING', input: json({ brief, capability: cap.id }) } });
  await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'EXECUTION_STARTED', actor: cap.internalName, message: `${cap.label} started "${work.title}" (${mode}).` });
  try {
    const memory = await memoryBrief(objective.organizationId, objective.id, 60);
    const research = objective.auditId ? (await getResearch(objective.auditId)) as ResearchRecord | null : null;
    const r = await generateJson<unknown>('execute', executePrompt({ title: work.title, brief, cap, mode, memory, research: research ? researchBrief(research).slice(0, 12_000) : 'none', company: await companyFor(objective), classification }), EXECUTE_SCHEMA, {}, { organizationId: objective.organizationId, objectiveId: objective.id, workId: work.id, parentType: 'WORK', parentId: work.id });
    const out = normaliseOutput(r.data, cap, mode);
    // Every AI-generated deliverable carries an explicit, unconditional AI-generated marker (also re-applied on
    // display/download, so it cannot be lost). It does not replace the structured truth statuses.
    // Customer-facing deliverables: invented testimonials/social proof/statistics/certifications are labelled, never facts.
    const guarded = isCustomerFacing(cap) ? guardMarketingClaims(out.markdown, provenance) : { markdown: out.markdown, claims: [] };
    const taggedMarkdown = withAiProvenance(guarded.markdown, out);
    const waiting = mode === 'HYBRID';
    await db.execution.update({ where: { id: execution.id }, data: { status: waiting ? 'WAITING_FOR_REVIEW' : 'COMPLETED', provider: r.provider, model: r.model, output: taggedMarkdown, outputSummary: out.summary, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costInr: r.costInr, input: json({ brief, capability: cap.id, tool: classification.tool?.id ?? null, executionClass: classification.executionClass, externalActions: classification.externalActions, claims: guarded.claims, assumptions: out.assumptions, founderInputsNeeded: out.founderInputsNeeded, professionalReviewRequired: out.professionalReviewRequired }), completedAt: new Date() } });
    await db.work.update({ where: { id: work.id }, data: { status: waiting ? 'WAITING_FOR_INPUT' : 'COMPLETED', completedAt: waiting ? null : new Date() } });
    await logAi(objective.organizationId, objective.id, work.id, r, cap.internalName);
    await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'EXECUTION_COMPLETED', actor: cap.internalName, message: `${waiting ? 'Draft ready for human review' : 'Completed'}: "${work.title}". Actual AI cost ₹${r.costInr.toFixed(2)}.` });
    await remember({ organizationId: work.organizationId, objectiveId: objective.id, kind: 'WORK', title: `${waiting ? 'Draft produced' : 'Completed'}: ${work.title}`, detail: out.summary, status: 'RECORD', owner: cap.internalName, refType: 'execution', refId: execution.id });
    await remember({ organizationId: work.organizationId, objectiveId: objective.id, kind: 'COST', title: `Actual AI cost of "${work.title}"`, value: `₹${r.costInr.toFixed(2)}`, detail: `${r.inputTokens} input + ${r.outputTokens} output tokens on ${r.provider}/${r.model}. ${payment.note}`, status: 'RECORD', owner: 'Hippoturtle', source: 'Execution log', refType: 'execution_cost', refId: execution.id });
    for (const [i, a] of out.assumptions.slice(0, 5).entries()) await remember({ organizationId: work.organizationId, objectiveId: objective.id, kind: 'ASSUMPTION', title: a, detail: `Made while producing "${work.title}".`, status: 'ASSUMPTION', owner: cap.internalName, refType: 'execution_assumption', refId: `${execution.id}:${i}` });
    return db.execution.findUniqueOrThrow({ where: { id: execution.id } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.execution.update({ where: { id: execution.id }, data: { status: 'FAILED', error: message.slice(0, 500), completedAt: new Date() } });
    await db.work.update({ where: { id: work.id }, data: { status: 'APPROVED' } });
    await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'EXECUTION_FAILED', actor: cap.internalName, message: `Execution of "${work.title}" failed and can be retried. Nothing was charged.` });
    throw e;
  }
}

// ---------------------------------------------------------------- QUOTES (honest broker)
export type QuoteInput = { providerName: string; tier: string; amount: number; includes: string[]; excludes: string[]; turnaroundDays?: number | null; revisions?: number | null; source: 'FOUNDER_ENTERED' | 'EXAMPLE' };

export async function addQuote(ctx: { work: { id: string; organizationId: string; objectiveId: string; title: string; capability: string }; objective: Objective }, q: QuoteInput) {
  const { work, objective } = ctx;
  const tier = (PROVIDER_TIERS as readonly string[]).includes(q.tier) ? q.tier : 'EXTERNAL_OPTION';
  const provider = await db.provider.create({ data: { organizationId: work.organizationId, name: q.providerName, tier, capability: work.capability, addedBy: q.source === 'EXAMPLE' ? 'EXAMPLE' : 'FOUNDER' } });
  const bench = await db.costEstimate.findFirst({ where: { workId: work.id, mode: 'HUMAN' } }) || await db.costEstimate.findFirst({ where: { workId: work.id, mode: 'HYBRID' } });
  const pos = positionQuote(q.amount, bench ? { low: bench.low, high: bench.high } : null);
  let comparison: QuoteComparison = { ...pos, explanation: rulesExplanation(pos), scopeGaps: [], extras: [], explainedBy: 'RULES' };
  const briefRow = await db.workBrief.findUnique({ where: { workId: work.id } });
  if (briefRow) {
    try {
      const brief = { deliverable: briefRow.deliverable, successCriteria: briefRow.successCriteria as string[], outOfScope: briefRow.outOfScope as string[] } as BriefData;
      const r = await generateJson<{ explanation: string; scopeGaps: string[]; extras: string[] }>('compare', comparePrompt({ brief, quote: { provider: q.providerName, amount: q.amount, includes: q.includes, excludes: q.excludes, turnaroundDays: q.turnaroundDays ?? null, revisions: q.revisions ?? null }, pos }), COMPARE_SCHEMA, {}, { organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, parentType: 'WORK', parentId: work.id });
      await logAi(objective.organizationId, objective.id, work.id, r, 'Mogli');
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 6) : []);
      if (typeof r.data.explanation === 'string' && r.data.explanation.trim()) comparison = { ...pos, explanation: r.data.explanation.trim().slice(0, 800), scopeGaps: list(r.data.scopeGaps), extras: list(r.data.extras), explainedBy: 'AI' };
    } catch (e) { console.error('Hippoturtle quote comparison fell back to rules:', e instanceof Error ? e.message : e); }
  }
  const quote = await db.quote.create({ data: { workId: work.id, providerId: provider.id, amount: q.amount, includes: q.includes, excludes: q.excludes, turnaroundDays: q.turnaroundDays ?? null, revisions: q.revisions ?? null, source: q.source, comparison: json(comparison) } });
  const label = q.source === 'EXAMPLE' ? 'Example external quote (not a real provider)' : 'External quote entered by founder';
  await remember({ organizationId: work.organizationId, objectiveId: objective.id, kind: 'QUOTE', title: `${label}: ${q.providerName} ₹${q.amount.toLocaleString('en-IN')} for "${work.title}"`, detail: comparison.explanation, status: 'RECORD', owner: 'Founder', source: label, refType: 'quote', refId: quote.id });
  await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'QUOTE_RECEIVED', actor: 'Founder', message: `${label} recorded for "${work.title}": ₹${q.amount.toLocaleString('en-IN')} (${pos.position.replace('_', ' ').toLowerCase()} benchmark).` });
  return { quote, comparison };
}

// ---------------------------------------------------------------- OUTCOME
export async function recordOutcome(ctx: { org: Org; objective: Objective; work?: { id: string; title: string; status: string; executionMode: string | null } | null }, input: { summary: string; metrics: { label: string; value: string }[] }) {
  const { objective, work } = ctx;
  const outcome = await db.outcome.create({ data: { objectiveId: objective.id, workId: work?.id ?? null, summary: input.summary, metrics: json(input.metrics), recordedBy: 'Founder' } });
  if (work && work.status !== 'COMPLETED') await db.work.update({ where: { id: work.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  // The outcome belongs to the objective's own organisation (a demo objective's org is not the founder's live org).
  await remember({ organizationId: objective.organizationId, objectiveId: objective.id, kind: 'OUTCOME', title: work ? `Outcome of "${work.title}"` : 'Outcome recorded', detail: `${input.summary}${input.metrics.length ? `\n${input.metrics.map((m) => `${m.label}: ${m.value}`).join('\n')}` : ''}`, status: 'FOUNDER_STATED', owner: 'Founder', source: 'Founder', refType: 'outcome', refId: outcome.id });
  await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, workId: work?.id, type: 'OUTCOME_RECORDED', actor: 'Founder', message: `Outcome recorded${work ? ` for "${work.title}"` : ''}: ${input.summary}`.slice(0, 400) });
  await db.objective.update({ where: { id: objective.id }, data: { stage: advanceTo(objective.stage, 'OUTCOME') } });
  return outcome;
}

export const capabilityOf = (id: string) => getCapability(id) ?? routeCapability(id);
export { parseReport };

// ---------------------------------------------------------------- FOUNDER APPROVAL OF A PROPOSED INPUT
/** The founder explicitly approves an AI-proposed brief input. Only this turns a proposal into a founder-approved value. */
export async function approveInput(ctx: { work: { id: string; organizationId: string; title: string }; objective: { id: string; organizationId: string; text: string; auditId: string | null } }, input: { item: string; value: string }) {
  const { work, objective } = ctx;
  const brief = await db.workBrief.findUnique({ where: { workId: work.id } });
  if (!brief) throw new HttpError(409, 'The work brief has not been written yet.');
  const current = classifyInputs(brief.inputs as BriefInput[], await provenanceFor(objective)).find((i) => itemKey(i.item) === itemKey(input.item) && i.value === input.value);
  if (!current) throw new HttpError(400, 'That input is not in this work brief.');
  if (current.status !== 'PROPOSED') return { approved: false, status: current.status };
  await remember({ organizationId: work.organizationId, objectiveId: objective.id, kind: 'DECISION', title: `Founder approved: ${input.item} = ${input.value}`, detail: input.item, value: input.value, status: 'FOUNDER_STATED', owner: 'Founder', source: 'Founder approval', refType: 'founder_approval', refId: `${objective.id}:${itemKey(input.item)}:${input.value}` });
  await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'FOUNDER_DECISION', actor: 'Founder', message: `Founder approved the AI-proposed value for "${input.item}": ${input.value}` });
  return { approved: true, status: 'KNOWN' as const };
}
