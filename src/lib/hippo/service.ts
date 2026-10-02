// Hippoturtle orchestration services. API routes stay thin; every step here is
// authorised by the caller (context.ts), idempotent where it can be retried, and logged.
import type { Objective as DbObjective, Prisma } from '@prisma/client';
import { db } from '../db';
import type { AuditReport } from '../audit';
import { getLockedFacts, getResearch } from '../audit-meta';
import type { ResearchRecord } from '../evidence';
import { researchBrief } from '../research';
import { allowedModes, getCapability, routeCapability } from './capabilities';
import { HttpError, isUniqueViolation, logActivity, memoryBrief, remember } from './context';
import { computeEstimates, midpoint, normaliseEffort } from './costs';
import { comparePrompt, COMPARE_SCHEMA, EXECUTE_SCHEMA, executePrompt, normaliseOutput, positionQuote, rulesExplanation, type QuoteComparison } from './execution';
import { aiMeta, generateJson, type GatewayResult } from './gateway';
import { BRIEF_SCHEMA, briefPrompt, normaliseBrief, normalisePlan, PLAN_SCHEMA, planPrompt, type BriefData } from './mogli';
import { normalisePathways, PATHWAYS_SCHEMA, pathwaysPrompt } from './pathways';
import { canExecuteNow, workPaymentPlan } from './payments';
import { classifyInputs, itemKey, type BriefInput, type ProvenanceContext } from './provenance';
import { ensureAudit, parseReport, syncAristotle, understandObjective } from './aristotle';
import { advanceTo, businessName, DEMO_COMPANY_NAME, isExecutionMode, PROVIDER_TIERS, type EffortModel, type PathwaysResult, type Understanding } from './types';

type Org = { id: string; isDemo?: boolean; name?: string };
type Objective = { id: string; organizationId: string; companyName: string | null; text: string; stage: string; auditId: string | null; understanding: Prisma.JsonValue; selectedPathways: Prisma.JsonValue };
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** The founder's business name for this objective's AI prompts (null when unnamed or ambiguous). Never the platform's own name. */
async function companyFor(
  objective: { companyName?: string | null; organizationId: string }
): Promise<string | null> {
  // Per-objective name is authoritative and immutable — always use it when set.
  if (objective.companyName != null) return businessName(objective.companyName);

  // Fallback path: only reached for legacy rows where companyName = NULL (created before this fix).
  // Only safe when this org has exactly one objective (the org name unambiguously belongs to it).
  // For multi-objective orgs, the org name is ambiguous — it may have been overwritten by the bug.
  // Returning null is intentionally conservative: a wrong identity is worse than no identity.
  const [org, objectiveCount] = await Promise.all([
    db.organization.findUnique({ where: { id: objective.organizationId }, select: { name: true } }),
    db.objective.count({ where: { organizationId: objective.organizationId } }),
  ]);

  if (objectiveCount > 1) {
    // Multi-objective org: org name is ambiguous for this objective. Return null.
    // identityBlock(null) produces a neutral prompt with no company identity assumption.
    return null;
  }
  return businessName(org?.name);
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

  // Resolve the per-objective company name:
  // demo → always DEMO_COMPANY_NAME; non-demo → founder input or existing org name.
  const companyNameForObjective =
    input.isDemo
      ? DEMO_COMPANY_NAME
      : businessName(input.companyName) ?? businessName(ctx.org.name) ?? null;

  let orgId = ctx.org.id;
  if (input.isDemo) {
    // Demo objectives always get a fresh isolated org — never touch the founder's live org.
    const demoOrg = await db.organization.create({
      data: { founderId: ctx.founder.id, name: DEMO_COMPANY_NAME, isDemo: true },
    });
    orgId = demoOrg.id;
  } else {
    // Belt-and-suspenders: getFounderContext() should always return a live org for non-demo
    // creation, but assert here to catch any future bypass of that invariant.
    if (ctx.org.isDemo) {
      throw new Error('INVARIANT VIOLATION: attempted to attach a real objective to a demo org');
    }
    // Only rename the org on the very first objective — after that the name is frozen on the org.
    const existingCount = await db.objective.count({ where: { organizationId: ctx.org.id } });
    if (existingCount === 0) {
      const wanted = businessName(input.companyName);
      if (wanted) {
        await db.organization.update({ where: { id: ctx.org.id }, data: { name: wanted } });
      }
    }
  }

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

  const u = await understandObjective(input.text, await companyFor({ companyName: companyNameForObjective, organizationId: orgId }));
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
  const r = await generateJson<unknown>('pathways', pathwaysPrompt({ objective: objective.text, understanding: objective.understanding as Understanding | null, facts, research, report, company: await companyFor(objective) }), PATHWAYS_SCHEMA);
  await logAi(objective.organizationId, objective.id, null, r, 'Aristotle');
  const result = normalisePathways(r.data, { findings: new Set((research?.findings || []).map((f) => f.id)), facts: new Set(facts.map((f) => f.id)) });
  await db.decisionMemo.update({ where: { id: memo.id }, data: { pathways: json(result), founderChecklist: json(result.founderChecklist) } });
  await db.objective.update({ where: { id: objective.id }, data: { pathways: json(result.pathways), stage: advanceTo(objective.stage, 'PATHWAYS') } });
  await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, type: 'PATHWAYS_GENERATED', actor: 'Aristotle', message: `${result.pathways.length} pathways to the full objective: ${result.pathways.map((p) => p.name).join(', ')}`.slice(0, 400) });
  for (const p of result.pathways) {
    await remember({ organizationId: objective.organizationId, objectiveId: objective.id, kind: 'IDEA', title: `Pathway: ${p.name}`, detail: `${p.howItWorks} Evidence: ${p.evidenceStrength}.`, status: p.evidenceStrength === 'NOT_YET_ESTABLISHED' ? 'HYPOTHESIS' : 'INFERENCE', owner: 'Aristotle', refType: 'pathway', refId: `${objective.id}:${p.id}` });
  }
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
  const r = await generateJson<unknown>('plan', planPrompt({ objective: objective.text, understanding: objective.understanding as Understanding | null, pathways: chosen, experiments: report.experiments || [], thirtyDayPlan: report.thirtyDayPlan || [], memory, company: await companyFor(objective) }), PLAN_SCHEMA);
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
  const cap = routeCapability(work.capability);
  const memory = await memoryBrief(objective.organizationId, objective.id);
  const provenance = await provenanceFor(objective);
  const prompt = briefPrompt({ work, cap, objective: objective.text, memory, timeCommitment: ctx.founder.timeCommitment, company: await companyFor(objective), facts: provenance.facts, findings: provenance.findings });
  const r = await generateJson<unknown>('brief', prompt, BRIEF_SCHEMA);
  await logAi(objective.organizationId, objective.id, work.id, r, 'Mogli');
  const brief = normaliseBrief(r.data, cap, provenance);
  const effort = normaliseEffort(brief.effort as Partial<EffortModel>, cap);
  const promptTokens = Math.round((prompt.length + memory.length) / 4);
  const estimates = computeEstimates(effort, cap, promptTokens);
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
export async function chooseExecution(ctx: { work: { id: string; organizationId: string; objectiveId: string; title: string; capability: string; status: string }; objective: Objective }, choice: string) {
  const { work, objective } = ctx;
  if (['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(work.status)) throw new HttpError(409, 'This work can no longer change execution mode.');
  if (!(await db.workBrief.findUnique({ where: { workId: work.id } }))) throw new HttpError(409, 'The work brief has not been written yet.');
  if (choice === 'LATER') {
    await db.work.update({ where: { id: work.id }, data: { status: 'AWAITING_DECISION', executionMode: null } });
    await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'FOUNDER_CHOICE', actor: 'Founder', message: `Founder will decide later on "${work.title}".` });
    return { mode: null, payment: null };
  }
  if (!isExecutionMode(choice)) throw new HttpError(400, 'Choose AI, HUMAN, HYBRID or LATER.');
  const cap = routeCapability(work.capability);
  if (!allowedModes(cap).includes(choice)) throw new HttpError(400, cap.requiresProfessional ? 'This work legally needs a qualified professional, so AI-only execution is not offered.' : 'That execution mode is not available for this work.');
  const estimate = await db.costEstimate.findFirst({ where: { workId: work.id, mode: choice } });
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

export async function executeWork(ctx: { work: { id: string; organizationId: string; objectiveId: string; title: string; capability: string; status: string; executionMode: string | null }; objective: Objective }) {
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
  const cap = routeCapability(work.capability);
  // Inputs are re-classified from provenance at execution time: an AI proposal stored as "KNOWN" by an older brief is still sent as a proposal.
  const brief: BriefData = { objective: briefRow.objective, deliverable: briefRow.deliverable, inputs: classifyInputs(briefRow.inputs as BriefInput[], await provenanceFor(objective)), constraints: briefRow.constraints as BriefData['constraints'], successCriteria: briefRow.successCriteria as string[], expectedOutput: briefRow.expectedOutput, outOfScope: briefRow.outOfScope as string[], effort: {} };
  const execution = await db.execution.create({ data: { workId: work.id, mode, status: 'RUNNING', input: json({ brief, capability: cap.id }) } });
  await logActivity({ organizationId: work.organizationId, objectiveId: objective.id, workId: work.id, type: 'EXECUTION_STARTED', actor: cap.internalName, message: `${cap.label} started "${work.title}" (${mode}).` });
  try {
    const memory = await memoryBrief(objective.organizationId, objective.id, 60);
    const research = objective.auditId ? (await getResearch(objective.auditId)) as ResearchRecord | null : null;
    const r = await generateJson<unknown>('execute', executePrompt({ title: work.title, brief, cap, mode, memory, research: research ? researchBrief(research).slice(0, 12_000) : 'none', company: await companyFor(objective) }), EXECUTE_SCHEMA);
    const out = normaliseOutput(r.data, cap, mode);
    // Every AI-generated execution deliverable carries a machine-readable provenance marker.
    // This is an output-level signal only — it does not replace the structured provenance system
    // (FOUNDER_STATED / VERIFIED_FACT / ASSUMPTION / HYPOTHESIS / INFERENCE / UNKNOWN).
    // The marker is UNCONDITIONAL: it must be present even when assumptions and founderInputsNeeded
    // are empty (the model can embed invented statistics in prose without surfacing them as arrays).
    const provenanceHeader = [
      '<!-- HIPPOTURTLE_PROVENANCE: AI_GENERATED_DRAFT -->',
      '',
      '> **⚠ AI-generated draft — review before use in marketing, legal, or financial communications.**',
      ...(out.founderInputsNeeded.length
        ? ['>', '> **Founder inputs needed:**', ...out.founderInputsNeeded.map((x: string) => `> - ${x}`)]
        : []),
      ...(out.assumptions.length
        ? ['>', '> **AI assumptions (not founder-approved):**', ...out.assumptions.slice(0, 5).map((x: string) => `> - ${x}`)]
        : []),
      '',
    ].join('\n');
    const taggedMarkdown = provenanceHeader + out.markdown;
    const waiting = mode === 'HYBRID' || cap.requiresProfessional;
    await db.execution.update({ where: { id: execution.id }, data: { status: waiting ? 'WAITING_FOR_REVIEW' : 'COMPLETED', provider: r.provider, model: r.model, output: taggedMarkdown, outputSummary: out.summary, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costInr: r.costInr, input: json({ brief, capability: cap.id, assumptions: out.assumptions, founderInputsNeeded: out.founderInputsNeeded, professionalReviewRequired: out.professionalReviewRequired }), completedAt: new Date() } });
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
      const r = await generateJson<{ explanation: string; scopeGaps: string[]; extras: string[] }>('compare', comparePrompt({ brief, quote: { provider: q.providerName, amount: q.amount, includes: q.includes, excludes: q.excludes, turnaroundDays: q.turnaroundDays ?? null, revisions: q.revisions ?? null }, pos }), COMPARE_SCHEMA);
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
  await remember({ organizationId: ctx.org.id, objectiveId: objective.id, kind: 'OUTCOME', title: work ? `Outcome of "${work.title}"` : 'Outcome recorded', detail: `${input.summary}${input.metrics.length ? `\n${input.metrics.map((m) => `${m.label}: ${m.value}`).join('\n')}` : ''}`, status: 'FOUNDER_STATED', owner: 'Founder', source: 'Founder', refType: 'outcome', refId: outcome.id });
  await logActivity({ organizationId: ctx.org.id, objectiveId: objective.id, workId: work?.id, type: 'OUTCOME_RECORDED', actor: 'Founder', message: `Outcome recorded${work ? ` for "${work.title}"` : ''}: ${input.summary}`.slice(0, 400) });
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
