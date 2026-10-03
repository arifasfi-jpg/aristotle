// The paid Aristotle audit as a durable job. The engine is unchanged (runAudit); this file only decides which stage
// runs next and persists the result exactly as the payment route used to.
//
// Steps and their durable checkpoints (resume = the next step after the last checkpoint):
//   PLAN      → research.json { stage: 'PLANNED', plan }       (existing Aristotle plan checkpoint)
//   RESEARCH  → research.json (complete: sources, findings)     (existing Aristotle research checkpoint)
//   DECIDE    → Job.state.report (decision memo, validated)     (new: so a crash before saving does not re-decide)
//   SAVE      → Audit.report, audit.json, README.md, research.json, computePaise/marginPaise from the ledger
import type { Job, Prisma } from '@prisma/client';
import { db } from '../db';
import { runAudit } from '../ai';
import type { AuditReport } from '../audit';
import { auditCostInr, callCeilingInr } from '../ai-usage';
import { costCeilingInr, PLATFORM_MARGIN, type BudgetPolicy } from '../cost-governor';
import { getLockedFacts, getResearch, getScopeRecord, payableError, saveResearch } from '../audit-meta';
import { isPlanCheckpoint } from '../research';
import type { Scope } from '../routing';
import type { ResearchRecord } from '../evidence';
import { enqueueJob, kickJob, registerJobHandler, renewLease, requeueJob, type JobHandler, type StepResult } from './runtime';

export const AUDIT_JOB = 'ARISTOTLE_AUDIT';

/**
 * Cost limit of a paid audit: the same commercial rule as every product — the price net of 18% GST must cover cost +
 * 10%. ₹99 → ₹83.90 → ÷1.10 = ₹76.27 → ₹76. (The future ₹299 Deep Intelligence product gets ₹230 the same way.)
 */
export const auditBudgetInr = (pricePaise: number) => costCeilingInr(pricePaise);

function policyOf(job: Job): BudgetPolicy {
  const included = job.budgetInr;
  return { scope: { type: 'AUDIT', id: job.budgetScopeId }, includedInr: included, warningInr: Math.round(included * 0.9 * 100) / 100, nearLimitInr: Math.round(included * 0.95 * 100) / 100, perCallInr: callCeilingInr(), canAskFounder: false };
}

type AuditState = { report?: AuditReport; provider?: string } | null;

async function loadOwnedAudit(job: Job) {
  // Ownership is re-verified inside the worker: the job's owner must own the audit it works on.
  const audit = job.subjectType === 'AUDIT' && job.subjectId ? await db.audit.findFirst({ where: { id: job.subjectId, userId: job.userId } }) : null;
  if (!audit) throw new Error('JOB_INVALID: audit not found for this job owner');
  if (audit.paymentStatus !== 'paid') throw new Error('JOB_INVALID: audit is not paid');
  // Payment verification already applied the payment gate (payableError) before creating this job. A paid audit with
  // no scope record is a legacy pre-router order (its paymentRef is now the payment id): NEW_IDEA, no facts — as before.
  const scopeRec = await getScopeRecord(audit.id);
  const legacy = !scopeRec;
  if (!legacy) { const gate = payableError(scopeRec, audit); if (gate.error) throw new Error(`JOB_INVALID: ${gate.error}`); }
  const scope: Scope = legacy ? 'NEW_IDEA' : scopeRec!.confirmed!.scope;
  const founderFacts = legacy ? [] : await getLockedFacts(audit.id);
  return { audit, scope, founderFacts };
}

async function step({ job, deadline, workerId }: { job: Job; deadline: number; workerId: string }): Promise<StepResult> {
  const { audit, scope, founderFacts } = await loadOwnedAudit(job);
  if (audit.report !== '{}') return { done: true }; // already saved (idempotent: never generated twice)
  if (audit.status !== 'generating') await db.audit.updateMany({ where: { id: audit.id, report: '{}' }, data: { status: 'generating' } });
  const state = (job.state ?? null) as AuditState;

  // SAVE: the decision memo exists durably → persist it.
  if (state?.report) {
    await renewLease(job, workerId);
    await saveAudit(audit, scope, founderFacts, state.report, await getResearch(audit.id));
    return { done: true };
  }

  const existing = await getResearch(audit.id);
  const stage: 'PLAN' | 'RESEARCH' | 'DECIDE' = !existing ? 'PLAN' : isPlanCheckpoint(existing) ? 'RESEARCH' : 'DECIDE';
  const usage = { userId: audit.userId, auditId: audit.id, parentType: 'AUDIT' as const, parentId: audit.id, budget: policyOf(job) };
  const result = await runAudit({
    idea: audit.idea,
    sector: audit.sector as never,
    stage: audit.stage || undefined,
    geography: audit.geography || 'India',
    language: (audit.reportLanguage as never) || 'Simple English',
    scope,
    founderFacts,
  }, {
    existingResearch: existing,
    onResearch: async (r) => { await renewLease(job, workerId); await saveResearch(audit.id, r); }, // lease-guarded checkpoint
    usage,
    budgetMs: deadline - Date.now(),
    ...(stage === 'DECIDE' ? {} : { stopAfter: stage }),
  });
  if (result.report) {
    await renewLease(job, workerId);
    if (result.research) await saveResearch(audit.id, result.research);
    return { checkpoint: 'DECIDED', progress: 'GENERATING_REPORT', state: { report: result.report, provider: result.provider } as unknown as Prisma.InputJsonValue };
  }
  if (isPlanCheckpoint(result.research)) return { checkpoint: 'PLANNED', progress: 'RESEARCHING' };
  return { checkpoint: 'RESEARCHED', progress: 'ANALYSING' };
}

/** Persistence of a completed audit — moved verbatim from the payment route (same files, same fields). */
export async function saveAudit(audit: { id: string; idea: string; sector: string }, scope: Scope, founderFacts: unknown[], report: AuditReport, research: ResearchRecord | null) {
  // ONE cost source: the audit's compute cost is the AiUsage ledger total for this audit (every model call, search,
  // retry and failed attempt, at each model's own ModelPrice). The platform margin is 10% of that figure.
  const computePaise = Math.round(((await auditCostInr(audit.id)) ?? 0) * 100);
  const marginPaise = Math.round(computePaise * PLATFORM_MARGIN);
  const pricing = { computeInr: computePaise / 100, marginInr: marginPaise / 100, source: 'AI_USAGE_LEDGER', platformMargin: '10% of disclosed compute' };
  if (research && !isPlanCheckpoint(research)) await saveResearch(audit.id, research);
  const bundle = JSON.stringify({ auditId: audit.id, idea: audit.idea, sector: audit.sector, scope, founderFacts, report, pricing }, null, 2);
  await db.projectFile.upsert({ where: { auditId_path: { auditId: audit.id, path: 'audit.json' } }, update: { content: bundle }, create: { auditId: audit.id, path: 'audit.json', content: bundle } });
  const readme = `# Aristotle export\n\nAudit ID: ${audit.id}\n\nPortable audit bundle. No proprietary database format is required.`;
  await db.projectFile.upsert({ where: { auditId_path: { auditId: audit.id, path: 'README.md' } }, update: { content: readme }, create: { auditId: audit.id, path: 'README.md', content: readme } });
  // The report is written last: "report present" is the completion marker every reader (and the job) relies on.
  await db.audit.update({ where: { id: audit.id }, data: { report: JSON.stringify(report), assumptions: JSON.stringify(report.assumptions), computePaise, marginPaise, status: 'completed' } });
}

const handler: JobHandler = {
  // A step is only started with enough time for the slowest stage (search + extract ≈ 30s; decision ≥ 16s).
  minStepMs: (job) => ((job.state as AuditState)?.report ? 2_000 : job.checkpoint === 'PLANNED' ? 30_000 : 17_000),
  policy: policyOf,
  step,
  async onStatus(job, status) {
    if (!job.subjectId) return;
    // Mirrors the job onto the existing audit status the pages already understand (retry button on 'failed').
    // A transient failure waiting for its automatic retry (QUEUED + lastError) also shows the founder Retry.
    const stopped = status === 'FAILED' || status === 'CANCELLED' || status === 'WAITING' || (status === 'QUEUED' && Boolean(job.lastError));
    if (stopped) await db.audit.updateMany({ where: { id: job.subjectId, userId: job.userId, report: '{}' }, data: { status: 'failed' } });
  },
};
registerJobHandler(AUDIT_JOB, handler);

/**
 * Called by payment verification once the payment is verified and recorded: makes the audit's job durable (one per
 * audit), re-queues it after a failure (founder retry, never a new payment), and starts a bounded run after the
 * response. Returns immediately.
 */
export async function startAuditJob(audit: { id: string; userId: string; pricePaise: number }, startedAt = Date.now()) {
  const { job } = await enqueueJob({ type: AUDIT_JOB, userId: audit.userId, subjectType: 'AUDIT', subjectId: audit.id, budgetScope: { type: 'AUDIT', id: audit.id }, budgetInr: auditBudgetInr(audit.pricePaise) });
  if (['FAILED', 'CANCELLED', 'WAITING'].includes(job.status)) await requeueJob(job.id);
  // Founder retry does not wait for the automatic back-off.
  if (job.status === 'QUEUED') await db.job.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { runAfter: new Date() } });
  await kickJob(job.id, startedAt);
  return (await db.job.findUnique({ where: { id: job.id } }))!;
}
