// Durable job runtime (Phase 2). Postgres is the queue and the source of truth; nothing here is held in memory.
//
//   enqueue (idempotent per business object) → a worker CLAIMS the job with an atomic compare-and-set on
//   (status, runAfter, lease) → runs one step at a time → CHECKPOINTS after each step (lease renewed) → completes.
//
// A worker owns a job only while `leaseUntil` is in the future. A worker that dies leaves its lease to expire; the
// next worker reclaims the job (counted as an attempt) and resumes from the last checkpoint. Every invocation is
// bounded by a time budget; a step that does not fit is not started (the job is handed back, QUEUED).
import crypto from 'crypto';
import type { Job, Prisma } from '@prisma/client';
import { db } from '../db';
import { scopeReservedInr, scopeSpendInr } from '../ai-usage';
import { budgetStatus, type BudgetPolicy, type BudgetState } from '../cost-governor';

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobProgress = 'QUEUED' | 'UNDERSTANDING' | 'RESEARCHING' | 'ANALYSING' | 'SYNTHESISING' | 'GENERATING_REPORT' | 'COMPLETED';

const envMs = (name: string, def: number) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n > 0 ? n : def; };
/** Lease length: longer than one invocation (maxDuration 60s), so a live worker never loses it between renewals. */
export const leaseMs = () => envMs('HIPPO_JOB_LEASE_MS', 90_000);
/** Work budget of one worker invocation (the route's maxDuration is 60s). */
export const workerBudgetMs = () => envMs('HIPPO_WORKER_BUDGET_MS', 55_000);
const backoffMs = (attempt: number) => Math.min(10 * 60_000, envMs('HIPPO_JOB_RETRY_BASE_MS', 30_000) * 2 ** Math.max(0, attempt - 1));

// ---------------------------------------------------------------- step contract
export type StepContext = { job: Job; deadline: number; workerId: string };
export type StepResult =
  | { done: true }
  | { checkpoint: string; progress: JobProgress; state?: Prisma.InputJsonValue | null };
export type JobHandler = {
  /** Minimum time a step needs; a step is never started with less time left (no half-done paid work). */
  minStepMs: (job: Job) => number;
  /** The cost-governor policy the job spends under. */
  policy: (job: Job) => BudgetPolicy;
  step: (ctx: StepContext) => Promise<StepResult>;
  /** Mirrors terminal / waiting states onto the business object (e.g. Audit.status). */
  onStatus?: (job: Job, status: JobStatus) => Promise<void>;
};
const handlers = new Map<string, JobHandler>();
export const registerJobHandler = (type: string, h: JobHandler) => { handlers.set(type, h); };

// ---------------------------------------------------------------- errors
export class LeaseLostError extends Error { constructor() { super('JOB_LEASE_LOST'); } }
/** A step could not finish inside this invocation's time budget; its durable checkpoint is kept. Not a failure. */
export const isYield = (m: string) => /AUDIT_TIME_BUDGET_EXCEEDED|JOB_YIELD/.test(m);
/** Configuration, input or business-state errors: retrying cannot help. */
const PERMANENT = /AI_ENGINE_NOT_CONFIGURED|JOB_INVALID|COST_GOVERNOR_MISCONFIGURED|no ModelPrice for/;
export type FailureClass = 'YIELD' | 'BUDGET' | 'PERMANENT' | 'TRANSIENT' | 'LEASE_LOST';
export function classifyJobError(e: unknown): FailureClass {
  if (e instanceof LeaseLostError) return 'LEASE_LOST';
  const m = e instanceof Error ? e.message : String(e);
  if (isYield(m)) return 'YIELD';
  if (PERMANENT.test(m)) return 'PERMANENT';
  // Governor refusal (limit reached / extra budget needed). A ledger outage is NOT a budget decision: transient.
  if (/AI_BUDGET_EXCEEDED/.test(m) && !/budget ledger unavailable/.test(m) && /(REFUSE|ASK_FOUNDER) \[/.test(m)) return 'BUDGET';
  return 'TRANSIENT'; // provider timeouts / 5xx, network, database, everything unknown — bounded by maxAttempts
}

// ---------------------------------------------------------------- store
export type EnqueueInput = { type: string; userId: string; organizationId?: string | null; subjectType: string; subjectId: string; budgetScope: { type: string; id: string }; budgetInr: number; maxAttempts?: number };
export const dedupeKeyOf = (type: string, subjectId: string) => `${type}:${subjectId}`;

/** One job per business object: a second enqueue returns the existing job (safe under concurrent requests). */
export async function enqueueJob(i: EnqueueInput): Promise<{ job: Job; created: boolean }> {
  const dedupeKey = dedupeKeyOf(i.type, i.subjectId);
  const existing = await db.job.findUnique({ where: { dedupeKey } });
  if (existing) return { job: existing, created: false };
  try {
    const job = await db.job.create({ data: { type: i.type, userId: i.userId, organizationId: i.organizationId ?? null, subjectType: i.subjectType, subjectId: i.subjectId, dedupeKey,
      budgetScopeType: i.budgetScope.type, budgetScopeId: i.budgetScope.id, budgetInr: i.budgetInr, maxAttempts: i.maxAttempts ?? 3 } });
    logJob('job_enqueued', job);
    return { job, created: true };
  } catch (e) {
    const again = await db.job.findUnique({ where: { dedupeKey } });
    if (again) return { job: again, created: false };
    throw e;
  }
}

/**
 * Founder-initiated retry (no new payment): a FAILED / CANCELLED / WAITING job is queued again from its checkpoint
 * with a fresh attempt count. RUNNING / QUEUED / COMPLETED jobs are left alone.
 */
export async function requeueJob(id: string): Promise<boolean> {
  const r = await db.job.updateMany({ where: { id, status: { in: ['FAILED', 'CANCELLED', 'WAITING'] } }, data: { status: 'QUEUED', attempts: 0, runAfter: new Date(), waitingReason: null, cancelRequestedAt: null, leaseOwner: null, leaseUntil: null, completedAt: null } });
  return r.count === 1;
}

/**
 * Claims one job atomically. Two compare-and-set forms, each a single UPDATE … WHERE (row-locked by Postgres, so
 * exactly one concurrent worker gets count = 1):
 *   - a QUEUED job whose runAfter has passed;
 *   - a RUNNING job whose lease expired (its worker died) — this counts as an attempt.
 */
export async function claimJob(id: string, workerId: string, now = new Date()): Promise<Job | null> {
  const lease = { leaseOwner: workerId, leaseUntil: new Date(now.getTime() + leaseMs()) };
  let r = await db.job.updateMany({ where: { id, status: 'QUEUED', runAfter: { lte: now } }, data: { status: 'RUNNING', ...lease } });
  if (r.count === 0) r = await db.job.updateMany({ where: { id, status: 'RUNNING', leaseUntil: { lt: now } }, data: { status: 'RUNNING', ...lease, attempts: { increment: 1 } } });
  if (r.count === 0) return null;
  await db.job.updateMany({ where: { id, startedAt: null }, data: { startedAt: now } });
  const job = await db.job.findUnique({ where: { id } });
  if (!job || job.leaseOwner !== workerId) return null;
  logJob('job_claimed', job, { workerId });
  return job;
}

/** Runnable jobs, oldest first: queued and due, or running with an expired lease. */
export async function runnableJobIds(limit: number, now = new Date()): Promise<string[]> {
  const rows = await db.job.findMany({ where: { OR: [{ status: 'QUEUED', runAfter: { lte: now } }, { status: 'RUNNING', leaseUntil: { lt: now } }] }, orderBy: { runAfter: 'asc' }, take: limit, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Writes only while this worker still holds the lease; otherwise another worker owns the job → LeaseLostError. */
async function owned(job: Job, workerId: string, data: Prisma.JobUpdateManyMutationInput) {
  const r = await db.job.updateMany({ where: { id: job.id, status: 'RUNNING', leaseOwner: workerId }, data });
  if (r.count !== 1) throw new LeaseLostError();
}

/**
 * Renews the lease and proves this worker still owns the job. Called before every durable write a step makes, so a
 * worker that outlived its lease (paused, partitioned) stops instead of overwriting the new owner's checkpoint.
 */
export async function renewLease(job: Pick<Job, 'id'>, workerId: string) {
  await owned(job as Job, workerId, { leaseUntil: new Date(Date.now() + leaseMs()) });
}

async function refreshCost(job: Job): Promise<{ spentInr: number; reservedInr: number }> {
  const scope = { type: job.budgetScopeType as 'AUDIT', id: job.budgetScopeId };
  const [spentInr, reservedInr] = await Promise.all([scopeSpendInr(scope), scopeReservedInr(scope)]);
  await db.job.update({ where: { id: job.id }, data: { costInr: round4(spentInr), reservedInr: round4(reservedInr) } });
  return { spentInr, reservedInr };
}
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ---------------------------------------------------------------- worker
export const newWorkerId = () => `w-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

export type RunOutcome = { jobId: string; status: JobStatus | 'NOT_CLAIMED'; steps: number; error?: string };

/** Runs one job (by id) until it completes, fails, waits, yields or the deadline. Never loops beyond the deadline. */
export async function runJob(id: string, opts: { deadline?: number; workerId?: string } = {}): Promise<RunOutcome> {
  const workerId = opts.workerId ?? newWorkerId();
  const deadline = opts.deadline ?? Date.now() + workerBudgetMs();
  const claimed = await claimJob(id, workerId);
  if (!claimed) return { jobId: id, status: 'NOT_CLAIMED', steps: 0 };
  const handler = handlers.get(claimed.type);
  let job = claimed;
  let steps = 0;
  const finish = async (status: JobStatus, data: Prisma.JobUpdateManyMutationInput = {}) => {
    await owned(job, workerId, { status, leaseOwner: null, leaseUntil: null, ...data });
    const fresh = (await db.job.findUnique({ where: { id } }))!;
    await refreshCost(fresh).catch(() => undefined);
    if (handler?.onStatus) await handler.onStatus(fresh, status).catch((e) => console.error(JSON.stringify({ event: 'job_on_status_failed', jobId: id, error: String(e) })));
    logJob(`job_${status.toLowerCase()}`, fresh, { workerId, steps });
    return { jobId: id, status, steps, error: typeof data.lastError === 'string' ? data.lastError : undefined };
  };
  try {
    if (!handler) return await finish('FAILED', { lastError: `JOB_INVALID: no handler for ${claimed.type}`, completedAt: new Date() });
    if (job.attempts >= job.maxAttempts) return await finish('FAILED', { lastError: `retries exhausted (${job.attempts}/${job.maxAttempts}): ${job.lastError ?? 'worker stopped'}`, completedAt: new Date() });
    for (;;) {
      job = (await db.job.findUnique({ where: { id } }))!;
      if (job.leaseOwner !== workerId || job.status !== 'RUNNING') throw new LeaseLostError();
      if (job.cancelRequestedAt) return await finish('CANCELLED', { completedAt: new Date(), waitingReason: null });
      // Hard budget: never start another billable step once the limit is reached.
      const { spentInr, reservedInr } = await refreshCost(job);
      const state = budgetStatus(handler.policy(job), spentInr, reservedInr).state;
      if (state === 'COST_LIMIT_REACHED' || state === 'ADDITIONAL_BUDGET_REQUIRED') return await finish('WAITING', { waitingReason: state, lastError: null });
      if (deadline - Date.now() < handler.minStepMs(job)) return await finish('QUEUED', { runAfter: new Date(), lastError: null }); // yield: next invocation continues
      const r = await handler.step({ job, deadline, workerId });
      steps++;
      if ('done' in r) return await finish('COMPLETED', { progress: 'COMPLETED', completedAt: new Date(), lastError: null, waitingReason: null });
      await owned(job, workerId, { checkpoint: r.checkpoint, progress: r.progress, ...(r.state !== undefined ? { state: r.state ?? undefined } : {}), leaseUntil: new Date(Date.now() + leaseMs()) });
      logJob('job_checkpoint', { ...job, checkpoint: r.checkpoint, progress: r.progress }, { workerId });
    }
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const cls = classifyJobError(e);
    if (cls === 'LEASE_LOST') { logJob('job_lease_lost', job, { workerId }); return { jobId: id, status: 'NOT_CLAIMED', steps }; }
    try {
      if (cls === 'YIELD') return await finish('QUEUED', { runAfter: new Date(), lastError: null });
      if (cls === 'BUDGET') return await finish('WAITING', { waitingReason: /ASK_FOUNDER/.test(msg) ? 'ADDITIONAL_BUDGET_REQUIRED' : 'COST_LIMIT_REACHED', lastError: msg });
      if (cls === 'PERMANENT') return await finish('FAILED', { lastError: msg, completedAt: new Date() });
      const attempts = job.attempts + 1;
      if (attempts >= job.maxAttempts) return await finish('FAILED', { attempts, lastError: msg, completedAt: new Date() });
      return await finish('QUEUED', { attempts, lastError: msg, runAfter: new Date(Date.now() + backoffMs(attempts)) });
    } catch (e2) {
      if (e2 instanceof LeaseLostError) return { jobId: id, status: 'NOT_CLAIMED', steps };
      // Database unavailable while recording the outcome: the lease expires and another worker reclaims the job.
      console.error(JSON.stringify({ event: 'job_outcome_write_failed', jobId: id, error: String(e2) }));
      return { jobId: id, status: 'NOT_CLAIMED', steps, error: msg };
    }
  }
}

/** One bounded worker pass (cron / internal trigger): claims runnable jobs one by one until the budget is used. */
export async function runWorker(opts: { budgetMs?: number; maxJobs?: number } = {}): Promise<RunOutcome[]> {
  const deadline = Date.now() + (opts.budgetMs ?? workerBudgetMs());
  const out: RunOutcome[] = [];
  const workerId = newWorkerId();
  for (const id of await runnableJobIds(Math.max(1, opts.maxJobs ?? 3))) {
    if (Date.now() >= deadline - 5_000) break;
    out.push(await runJob(id, { deadline, workerId }));
  }
  return out;
}

// ---------------------------------------------------------------- kick (start work after a response)
const detached = new Set<Promise<unknown>>();
/**
 * Starts a bounded run of one job after the current response is sent (Next.js `after`, kept alive by the platform up to
 * the route's maxDuration). Outside a request (scripts, tests) it runs detached. Never awaited by the request: payment
 * verification returns as soon as the job is durable. If this run dies, the lease expires and a later trigger resumes.
 */
export async function kickJob(id: string, startedAt = Date.now()) {
  const run = () => runJob(id, { deadline: startedAt + workerBudgetMs() }).catch((e) => console.error(JSON.stringify({ event: 'job_kick_failed', jobId: id, error: String(e) })));
  try {
    const { after } = await import('next/server');
    after(run);
  } catch {
    const p = run();
    detached.add(p);
    void p.finally(() => detached.delete(p));
  }
}
/** Waits for detached runs (tests and scripts only). */
export async function settleDetached() { while (detached.size) await Promise.allSettled([...detached]); }

// ---------------------------------------------------------------- read model (status API)
export type JobView = {
  id: string; type: string; status: string; progress: string; checkpoint: string | null; attempts: number; maxAttempts: number;
  waitingReason: string | null; lastError: string | null; createdAt: Date; startedAt: Date | null; completedAt: Date | null; updatedAt: Date;
  subject: { type: string | null; id: string | null };
  cost: { budgetInr: number; spentInr: number; reservedInr: number; remainingInr: number; state: BudgetState };
};
export async function jobView(job: Job): Promise<JobView> {
  const scope = { type: job.budgetScopeType as 'AUDIT', id: job.budgetScopeId };
  const [spentInr, reservedInr] = await Promise.all([scopeSpendInr(scope), scopeReservedInr(scope)]);
  const h = handlers.get(job.type);
  const snap = budgetStatus(h ? h.policy(job) : { scope: { type: 'JOB', id: job.id }, includedInr: job.budgetInr, warningInr: job.budgetInr, nearLimitInr: job.budgetInr }, spentInr, reservedInr);
  return {
    id: job.id, type: job.type, status: job.status, progress: job.progress, checkpoint: job.checkpoint, attempts: job.attempts, maxAttempts: job.maxAttempts,
    waitingReason: job.waitingReason, lastError: job.status === 'FAILED' || job.status === 'WAITING' ? publicError(job.lastError) : null,
    createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt, updatedAt: job.updatedAt, subject: { type: job.subjectType, id: job.subjectId },
    cost: { budgetInr: job.budgetInr, spentInr: round4(spentInr), reservedInr: round4(reservedInr), remainingInr: snap.remainingInr, state: snap.state },
  };
}
/** Errors shown to the owner: a short category, never provider bodies or internals. */
function publicError(e: string | null): string | null {
  if (!e) return null;
  if (/AI_BUDGET_EXCEEDED/.test(e)) return 'The cost limit for this work was reached.';
  if (/retries exhausted/.test(e)) return 'The analysis could not be completed after several attempts.';
  if (/NOT_CONFIGURED/.test(e)) return 'The analysis service is not available right now.';
  return 'The analysis could not be completed yet.';
}

function logJob(event: string, job: Pick<Job, 'id' | 'type' | 'userId' | 'status' | 'progress' | 'checkpoint' | 'attempts'>, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, jobId: job.id, type: job.type, userId: job.userId, status: job.status, progress: job.progress, checkpoint: job.checkpoint, attempts: job.attempts, ...extra }));
}
