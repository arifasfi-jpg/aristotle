// AI cost ledger + per-model prices (ModelPrice only) + failure accounting + platform guard.
// Every model and search call goes through `metered()` (via src/lib/hippo/gateway.ts), which writes one `AiUsage`
// row with the actual rupee cost of THAT provider/model, whether the call succeeded or not.
// The ledger never breaks the business flow: a failed ledger write is logged, the call's result is still returned.
import type { PrismaClient } from '@prisma/client';

/**
 * The ledger's database client, loaded lazily so engine code (research, routing) can be imported and unit-tested
 * without a database. On whenever a database is configured (DATABASE_URL: every deployed environment) or the ledger is
 * forced on (HIPPO_USAGE_LEDGER=on, used by the real-Postgres test harness); HIPPO_USAGE_LEDGER=off disables it.
 */
export const ledgerEnabled = () => process.env.HIPPO_USAGE_LEDGER === 'on' || (process.env.HIPPO_USAGE_LEDGER !== 'off' && Boolean(process.env.DATABASE_URL));
let dbModule: Promise<PrismaClient> | null = null; // one shared import, even when many calls start at once
async function ledgerDb(): Promise<PrismaClient | null> {
  if (!ledgerEnabled()) return null;
  dbModule ??= import('./db').then((m) => m.db);
  return dbModule;
}

export const PURPOSES = ['CONVERSATION', 'ARISTOTLE', 'RESEARCH', 'OPPORTUNITY', 'THINK_TANK', 'WORK', 'OTHER'] as const;
export type UsagePurpose = (typeof PURPOSES)[number];
export type ModelTier = 0 | 1 | 2 | 3;
/**
 * What happened to one provider call, from the ledger's point of view.
 *   SUCCESS                  provider answered with usage
 *   INVALID_OUTPUT           provider answered (and reported usage) but the answer was unusable
 *   PROVIDER_ERROR           provider answered with an error status and no usage
 *   TIMEOUT                  our deadline expired (before or after the request was sent — see costStatus)
 *   CANCELLED                the call was cancelled (before or after sending)
 *   FAILED_BEFORE_PROVIDER   the request never reached the provider (not configured, DNS, connection refused)
 *   UNKNOWN_PROVIDER_OUTCOME the request was sent and we cannot tell whether the provider processed it
 *   REFUSED_BUDGET           a cost governor refused the call before it was made
 */
export type UsageOutcome = 'SUCCESS' | 'INVALID_OUTPUT' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'FAILED_BEFORE_PROVIDER' | 'UNKNOWN_PROVIDER_OUTCOME' | 'REFUSED_BUDGET';
/**
 * How certain the recorded rupee cost is.
 *   ACTUAL     provider-reported usage × a VERIFIED price
 *   ESTIMATED  usage not reported (timeout, error, unknown outcome → best defensible upper estimate) or price unverified
 *   NONE       the request never reached the provider: nothing could have been billed
 *   UNPRICED   no price configured for this model (only when explicitly allowed); cost unknown, recorded as 0
 */
export type CostStatus = 'ACTUAL' | 'ESTIMATED' | 'NONE' | 'UNPRICED';

/** Who/what a call belongs to. Passed explicitly by callers (routes, services, the Aristotle engine). */
export type UsageContext = {
  userId?: string | null; founderId?: string | null; organizationId?: string | null; objectiveId?: string | null;
  workId?: string | null; auditId?: string | null; parentType?: 'TURN' | 'JOB' | 'WORK' | 'AUDIT' | 'REQUEST' | null; parentId?: string | null;
  /** Cumulative budget this call spends from (see cost-governor.ts). Checked BEFORE the call. */
  budget?: import('./cost-governor').BudgetPolicy | null;
};

export type CallSpec = { kind: 'MODEL' | 'SEARCH'; purpose: UsagePurpose; task: string; tier?: ModelTier | null; provider: string; model: string };
export type Measured = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number; searchCalls?: number; searchCredits?: number; retries?: number };

// ---------------------------------------------------------------- prices (ModelPrice is the only source)
export type PriceStatus = 'VERIFIED_PRICE' | 'UNVERIFIED_PRICE' | 'UNPRICED';
export type Price = { id: string | null; inputUsdPerMTok: number; outputUsdPerMTok: number; cachedInputUsdPerMTok: number; reasoningUsdPerMTok: number; usdPerCredit: number; currency: 'USD' | 'INR'; status: PriceStatus };

/** USD→INR conversion rate (configuration, not a provider price). */
export const usdInr = () => { const n = Number(process.env.USD_INR || '88'); return Number.isFinite(n) && n > 0 ? n : 88; };
export const UNPRICED: Price = { id: null, inputUsdPerMTok: 0, outputUsdPerMTok: 0, cachedInputUsdPerMTok: 0, reasoningUsdPerMTok: 0, usdPerCredit: 0, currency: 'USD', status: 'UNPRICED' };
/** A model with no price cannot be budgeted, so it is refused unless HIPPO_ALLOW_UNPRICED_MODELS=true (then recorded UNPRICED). */
export const allowUnpriced = () => process.env.HIPPO_ALLOW_UNPRICED_MODELS === 'true';

type PriceRow = { id: string; inputUsdPerMTok: number | null; outputUsdPerMTok: number | null; cachedInputUsdPerMTok: number | null; reasoningUsdPerMTok: number | null; usdPerCredit: number | null; currency: string; verificationStatus: string };
/** Maps a ModelPrice row to the runtime price. Missing cached/reasoning rates fall back to the input/output rate (never cheaper). */
export function priceFromRow(row: PriceRow): Price {
  const input = row.inputUsdPerMTok ?? 0; const output = row.outputUsdPerMTok ?? 0;
  return { id: row.id, inputUsdPerMTok: input, outputUsdPerMTok: output, cachedInputUsdPerMTok: row.cachedInputUsdPerMTok ?? input, reasoningUsdPerMTok: row.reasoningUsdPerMTok ?? output, usdPerCredit: row.usdPerCredit ?? 0, currency: row.currency === 'INR' ? 'INR' : 'USD', status: row.verificationStatus === 'VERIFIED' ? 'VERIFIED_PRICE' : 'UNVERIFIED_PRICE' };
}

const PRICE_TTL_MS = 5 * 60_000;
const priceCache = new Map<string, { at: number; price: Price }>();
export const clearPriceCache = () => priceCache.clear();

/** The newest active ModelPrice row with effectiveFrom <= now, or UNPRICED. No price is ever hard-coded here. */
export async function priceFor(provider: string, model: string, now = new Date()): Promise<Price> {
  const key = `${provider}\u0000${model}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  const db = await ledgerDb();
  if (!db) return UNPRICED;
  let price = UNPRICED;
  try {
    const row = await db.modelPrice.findFirst({ where: { provider, model, active: true, effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: 'desc' } });
    if (row) price = priceFromRow(row);
  } catch (e) {
    console.error(JSON.stringify({ event: 'model_price_lookup_failed', provider, model, error: e instanceof Error ? e.message : String(e) }));
    return UNPRICED; // not cached: a transient failure must not stick for five minutes
  }
  priceCache.set(key, { at: Date.now(), price });
  return price;
}

/**
 * THE cost formula. Every rupee figure in the product (ledger rows, audit compute cost, work estimates, budgets)
 * comes from here: uncached input at the input rate, cached input at the cached rate, output at the output rate,
 * reasoning ("thinking") tokens at the reasoning rate, search credits at the credit rate. Rounded to 1/10,000 ₹.
 */
export function costOf(m: Measured, p: Price, fx = usdInr()): number {
  return Math.round(rawCostInr(m, p, fx) * 10_000) / 10_000;
}
function rawCostInr(m: Measured, p: Price, fx = usdInr()): number {
  const input = Math.max(0, m.inputTokens ?? 0); const cached = Math.min(input, Math.max(0, m.cachedTokens ?? 0));
  const out = Math.max(0, m.outputTokens ?? 0); const reasoning = Math.max(0, m.reasoningTokens ?? 0);
  const amount = ((input - cached) * p.inputUsdPerMTok + cached * p.cachedInputUsdPerMTok + out * p.outputUsdPerMTok + reasoning * p.reasoningUsdPerMTok) / 1_000_000 + Math.max(0, m.searchCredits ?? 0) * p.usdPerCredit;
  return amount * (p.currency === 'INR' ? 1 : fx);
}
/** Same formula, rounded UP: an estimate of a possibly-billed call is never rounded down to ₹0. */
export const costUpperBound = (m: Measured, p: Price, fx = usdInr()) => Math.ceil(rawCostInr(m, p, fx) * 10_000 - 1e-9) / 10_000;

// ---------------------------------------------------------------- failure accounting
/** Provider clients mark where a failure happened; anything unmarked after a send is treated as possibly billed. */
export type ProviderPhase = 'NOT_SENT' | 'SENT';
export const notSent = <E extends Error>(e: E): E => Object.assign(e, { providerPhase: 'NOT_SENT' as ProviderPhase });
export const sent = <E extends Error>(e: E, extra: { httpStatus?: number; measured?: Measured } = {}): E => Object.assign(e, { providerPhase: 'SENT' as ProviderPhase, ...extra });
const CONNECT_FAILURE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_INVALID_URL|UND_ERR_CONNECT_TIMEOUT/;
const causeCodes = (e: unknown): string => { const out: string[] = []; let c: unknown = e; for (let i = 0; i < 4 && c && typeof c === 'object'; i++) { const o = c as { code?: unknown; name?: unknown; cause?: unknown }; out.push(String(o.code ?? ''), String(o.name ?? '')); c = o.cause; } return out.join(' '); };
/**
 * Where a fetch() failure happened. DNS failure, refused connection or a connect timeout: the request never reached
 * the provider (NOT_SENT). An abort (our deadline) or any other failure once connecting started: it may have been
 * received and processed (SENT) — the conservative assumption, because it is billed as if it ran.
 */
export const fetchFailurePhase = (e: unknown): ProviderPhase => (CONNECT_FAILURE.test(causeCodes(e)) ? 'NOT_SENT' : 'SENT');
/** Ledger outcome for an error (used by logs and tests; the cost comes from accountFailure). */
export const outcomeOf = (e: unknown): UsageOutcome => accountFailure(e, UNPRICED, { worstInr: 0, inputOnlyInr: 0 }).outcome;

/** Upper bound (whole prompt + whole output budget, or the search's credits) and the input-only part. */
export type CallEstimate = { worstInr: number; inputOnlyInr: number };

/**
 * Turns a failed call into a ledger outcome + cost. Never records a call that may have been billed as free:
 * if the request reached the provider and usage is unknown, the defensible estimate is booked as ESTIMATED.
 */
export function accountFailure(e: unknown, price: Price, estimate: CallEstimate): { outcome: UsageOutcome; costStatus: CostStatus; costInr: number; measured: Measured } {
  const err = (e || {}) as { message?: string; name?: string; providerPhase?: ProviderPhase; httpStatus?: number; measured?: Measured; cause?: { code?: string; name?: string }; cancelled?: boolean };
  const msg = String(err.message ?? e);
  const measured = err.measured || {};
  const timeout = /timed out|TIMEOUT|TimeoutError|CONNECT_TIMEOUT/i.test(`${msg} ${causeCodes(e)}`) || err.name === 'TimeoutError';
  const cancelled = Boolean(err.cancelled) || err.name === 'CancelledError';
  if (/AI_BUDGET_EXCEEDED/.test(msg)) return { outcome: 'REFUSED_BUDGET', costStatus: 'NONE', costInr: 0, measured: {} };
  const notReached = err.providerPhase === 'NOT_SENT' || (err.providerPhase !== 'SENT' && CONNECT_FAILURE.test(`${causeCodes(e)} ${msg}`));
  if (notReached) return { outcome: timeout ? 'TIMEOUT' : cancelled ? 'CANCELLED' : 'FAILED_BEFORE_PROVIDER', costStatus: 'NONE', costInr: 0, measured: {} };
  const unpriced = price.status === 'UNPRICED';
  const certainty = (actual: boolean): CostStatus => (unpriced ? 'UNPRICED' : actual && price.status === 'VERIFIED_PRICE' ? 'ACTUAL' : 'ESTIMATED');
  const invalid = /not valid JSON|empty response|_INVALID/i.test(msg);
  const outcome: UsageOutcome = invalid ? 'INVALID_OUTPUT' : timeout ? 'TIMEOUT' : cancelled ? 'CANCELLED' : err.httpStatus ? 'PROVIDER_ERROR' : 'UNKNOWN_PROVIDER_OUTCOME';
  // The provider answered and told us what it used: that usage is the cost, even though the answer was unusable.
  if (Object.keys(measured).length) return { outcome: outcome === 'UNKNOWN_PROVIDER_OUTCOME' ? 'PROVIDER_ERROR' : outcome, costStatus: certainty(true), costInr: unpriced ? 0 : costOf(measured, price), measured };
  if (unpriced) return { outcome, costStatus: 'UNPRICED', costInr: 0, measured: {} };
  // Error status, no usage: the request was received but rejected; at most the input was processed.
  if (outcome === 'PROVIDER_ERROR') return { outcome, costStatus: 'ESTIMATED', costInr: estimate.inputOnlyInr, measured: {} };
  // Sent, then lost (timeout, cancellation, connection reset, unusable answer without usage, anything unknown):
  // it may have run to completion, so the full worst case is booked.
  return { outcome, costStatus: 'ESTIMATED', costInr: estimate.worstInr, measured: {} };
}

// ---------------------------------------------------------------- ledger
export type UsageRecord = CallSpec & Measured & { costInr: number; costStatus: CostStatus; estimatedInr?: number | null; price: Price; durationMs: number; outcome: UsageOutcome; error?: string | null; context?: UsageContext };

export async function recordUsage(r: UsageRecord): Promise<void> {
  const c = r.context || {};
  const db = await ledgerDb();
  if (!db) return;
  try {
    await db.aiUsage.create({ data: {
      kind: r.kind, purpose: r.purpose, task: r.task.slice(0, 80), tier: r.tier ?? null, provider: r.provider, model: r.model,
      inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, cachedTokens: r.cachedTokens ?? 0, reasoningTokens: r.reasoningTokens ?? 0,
      searchCalls: r.searchCalls ?? 0, searchCredits: r.searchCredits ?? 0, estimatedInr: r.estimatedInr ?? null, costInr: r.costInr, costStatus: r.costStatus,
      priceSource: r.price.status, priceId: r.price.id, usdInr: usdInr(), durationMs: Math.round(r.durationMs), retries: r.retries ?? 0,
      outcome: r.outcome, error: r.error ? r.error.slice(0, 300) : null,
      userId: c.userId ?? null, founderId: c.founderId ?? null, organizationId: c.organizationId ?? null, objectiveId: c.objectiveId ?? null,
      workId: c.workId ?? null, auditId: c.auditId ?? null, parentType: c.parentType ?? c.budget?.scope.type ?? null, parentId: c.parentId ?? c.budget?.scope.id ?? null,
    } });
  } catch (e) {
    // Never lose the business result because the ledger write failed; make the miss loud instead.
    console.error(JSON.stringify({ event: 'ai_usage_write_failed', task: r.task, provider: r.provider, model: r.model, costInr: r.costInr, error: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * Runs one model/search call and records it. `run` returns the provider's measured usage alongside its result.
 * On failure the call is still recorded (see accountFailure) and the original error is re-thrown unchanged.
 */
export async function metered<T>(spec: CallSpec, context: UsageContext | undefined, run: () => Promise<{ result: T; measured: Measured }>, estimate: CallEstimate, price?: Price, release: () => unknown = () => undefined): Promise<{ result: T; costInr: number; measured: Measured; durationMs: number }> {
  const started = Date.now();
  try {
    const p = price ?? await priceFor(spec.provider, spec.model);
    return await meteredRun(spec, context, run, estimate, p, started);
  } finally {
    await release(); // after the row is written: briefly double-counted (conservative), never under-counted
  }
}
async function meteredRun<T>(spec: CallSpec, context: UsageContext | undefined, run: () => Promise<{ result: T; measured: Measured }>, estimate: CallEstimate, p: Price, started: number) {
  let out: { result: T; measured: Measured };
  try {
    out = await run();
  } catch (e) {
    const a = accountFailure(e, p, estimate);
    await recordUsage({ ...spec, ...a.measured, costInr: a.costInr, costStatus: a.costStatus, estimatedInr: estimate.worstInr, price: p, durationMs: Date.now() - started, outcome: a.outcome, error: e instanceof Error ? e.message : String(e), context });
    throw e;
  }
  const { result, measured } = out;
  const costInr = p.status === 'UNPRICED' ? 0 : costOf(measured, p);
  const costStatus: CostStatus = p.status === 'UNPRICED' ? 'UNPRICED' : p.status === 'VERIFIED_PRICE' ? 'ACTUAL' : 'ESTIMATED';
  const durationMs = Date.now() - started;
  await recordUsage({ ...spec, ...measured, costInr, costStatus, estimatedInr: estimate.worstInr, price: p, durationMs, outcome: 'SUCCESS', context });
  return { result, costInr, measured, durationMs };
}

// ---------------------------------------------------------------- cumulative spend (budget scopes)
/**
 * Postgres-backed budget reservations (Phase 2). One transaction per decision, serialised per scope by a transaction-
 * scoped advisory lock: spent (AiUsage) + active reservations + this call's worst case is checked against the limit and,
 * when allowed, the reservation is written before the lock is released. Workers in different processes therefore
 * cannot both spend the same headroom. A reservation left by a dead worker expires and is booked as an ESTIMATED
 * AiUsage row at its worst case (the call may have been billed) — never silently dropped.
 */
export const reservationTtlMs = () => { const n = Number(process.env.HIPPO_RESERVATION_TTL_MS || '600000'); return Number.isFinite(n) && n > 0 ? n : 600_000; };
type Scope = { type: string; id: string };
export type ReservationResult<D> = { decision: D; spentInr: number; reservedInr: number; reservationId: string | null };

export async function reserveBudget<D>(scope: Scope, amountInr: number, spec: CallSpec & { priceId: string | null; priceStatus: PriceStatus }, context: UsageContext, decide: (spentInr: number, reservedInr: number) => { allow: boolean; decision: D }): Promise<ReservationResult<D>> {
  const db = await ledgerDb();
  if (!db) throw new Error('budget ledger unavailable: no database');
  const now = new Date();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`budget:${scope.type}:${scope.id}`}))`;
    await expireReservations(tx, scope, now);
    const spent = (await tx.aiUsage.aggregate({ _sum: { costInr: true }, where: { parentType: scope.type, parentId: scope.id } }))._sum.costInr ?? 0;
    const reserved = (await tx.costReservation.aggregate({ _sum: { amountInr: true }, where: { scopeType: scope.type, scopeId: scope.id, releasedAt: null } }))._sum.amountInr ?? 0;
    const d = decide(spent, reserved);
    if (!d.allow) return { decision: d.decision, spentInr: spent, reservedInr: reserved, reservationId: null };
    const c = context;
    const row = await tx.costReservation.create({ data: { scopeType: scope.type, scopeId: scope.id, amountInr, expiresAt: new Date(now.getTime() + reservationTtlMs()),
      spec: { ...spec, context: { userId: c.userId ?? null, founderId: c.founderId ?? null, organizationId: c.organizationId ?? null, objectiveId: c.objectiveId ?? null, workId: c.workId ?? null, auditId: c.auditId ?? null } } } });
    return { decision: d.decision, spentInr: spent, reservedInr: reserved, reservationId: row.id };
  });
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
async function expireReservations(tx: Tx, scope: Scope, now: Date) {
  const dead = await tx.costReservation.findMany({ where: { scopeType: scope.type, scopeId: scope.id, releasedAt: null, expiresAt: { lt: now } } });
  for (const r of dead) {
    const s = r.spec as CallSpec & { priceId: string | null; priceStatus: PriceStatus; context?: Record<string, string | null> };
    await tx.aiUsage.create({ data: {
      kind: s.kind, purpose: s.purpose, task: s.task, tier: s.tier ?? null, provider: s.provider, model: s.model, estimatedInr: r.amountInr, costInr: r.amountInr, costStatus: 'ESTIMATED',
      priceSource: s.priceStatus, priceId: s.priceId, usdInr: usdInr(), durationMs: Math.max(0, now.getTime() - r.createdAt.getTime()), outcome: 'UNKNOWN_PROVIDER_OUTCOME',
      error: 'reservation expired: the worker never recorded this call (booked at its worst case)', parentType: scope.type, parentId: scope.id, ...(s.context || {}),
    } });
    await tx.costReservation.update({ where: { id: r.id }, data: { releasedAt: now } });
  }
}

/** Releases a reservation once its call is recorded in AiUsage (idempotent). */
export async function releaseReservation(id: string | null) {
  if (!id) return;
  const db = await ledgerDb();
  if (!db) return;
  try { await db.costReservation.updateMany({ where: { id, releasedAt: null }, data: { releasedAt: new Date() } }); }
  catch (e) { console.error(JSON.stringify({ event: 'reservation_release_failed', id, error: e instanceof Error ? e.message : String(e) })); } // expires later: over-, never under-counted
}

/** Active (unreleased) reservations of a scope. */
export async function scopeReservedInr(scope: Scope): Promise<number> {
  const db = await ledgerDb();
  if (!db) return 0;
  return (await db.costReservation.aggregate({ _sum: { amountInr: true }, where: { scopeType: scope.type, scopeId: scope.id, releasedAt: null } }))._sum.amountInr ?? 0;
}

/** Total booked (ACTUAL + ESTIMATED) cost of one scope from the ledger: parentType + parentId. */
export async function scopeSpendInr(scope: { type: 'AUDIT' | 'WORK' | 'JOB' | 'TURN'; id: string }): Promise<number> {
  const db = await ledgerDb();
  if (!db) return 0;
  const r = await db.aiUsage.aggregate({ _sum: { costInr: true }, where: { parentType: scope.type, parentId: scope.id } });
  return r._sum.costInr ?? 0;
}

/** Booked cost of a scope split by certainty and kind — the founder's "no hidden AI costs" statement. */
export async function scopeBreakdown(scope: { type: string; id: string }): Promise<{ actualInr: number; estimatedInr: number; modelInr: number; searchInr: number }> {
  const db = await ledgerDb();
  const out = { actualInr: 0, estimatedInr: 0, modelInr: 0, searchInr: 0 };
  if (!db) return out;
  const rows = await db.aiUsage.groupBy({ by: ['kind', 'costStatus'], _sum: { costInr: true }, where: { parentType: scope.type, parentId: scope.id } });
  for (const r of rows) {
    const v = r._sum.costInr ?? 0;
    if (r.costStatus === 'ACTUAL') out.actualInr += v; else out.estimatedInr += v;
    if (r.kind === 'SEARCH') out.searchInr += v; else out.modelInr += v;
  }
  const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
  return { actualInr: r4(out.actualInr), estimatedInr: r4(out.estimatedInr), modelInr: r4(out.modelInr), searchInr: r4(out.searchInr) };
}

/** Ledger cost of one audit (every attempt, retry, failure and search) — the audit's authoritative compute cost. */
export async function auditCostInr(auditId: string): Promise<number | null> {
  const db = await ledgerDb();
  if (!db) return null;
  const r = await db.aiUsage.aggregate({ _sum: { costInr: true }, where: { auditId } });
  return Math.round((r._sum.costInr ?? 0) * 10_000) / 10_000;
}

// ---------------------------------------------------------------- guards (call ceiling + platform free-tier cap)
/** Upper bound for one model call before it is made (see modelCallEstimate). */
export function maxCallCostInr(promptChars: number, maxOutputTokens: number, p: Price): number {
  return modelCallEstimate(promptChars, maxOutputTokens, p).worstInr;
}
/**
 * A model call's worst case and its input-only part. Upper bounds, not averages: one token per prompt character (no
 * tokenizer produces more for text; Indic scripts come close) and the whole output budget (which includes thinking).
 */
export function modelCallEstimate(promptChars: number, maxOutputTokens: number, p: Price): CallEstimate {
  const inputTokens = Math.max(0, Math.ceil(promptChars));
  return { worstInr: costUpperBound({ inputTokens, outputTokens: maxOutputTokens }, p), inputOnlyInr: costUpperBound({ inputTokens }, p) };
}
/** A search request's cost is its credits whatever happens once it is sent. */
export const searchCallEstimate = (credits: number, p: Price): CallEstimate => { const c = costUpperBound({ searchCredits: credits }, p); return { worstInr: c, inputOnlyInr: c }; };
export const callCeilingInr = () => { const n = Number(process.env.HIPPO_MAX_CALL_INR || '25'); return Number.isFinite(n) && n > 0 ? n : 25; };
export const freeDailyCapInr = () => { const n = Number(process.env.HIPPO_FREE_AI_DAILY_CAP_INR || '500'); return Number.isFinite(n) && n >= 0 ? n : 500; };

const SPEND_TTL_MS = 60_000;
let spendCache: { day: string; at: number; inr: number } | null = null;
export const clearSpendCache = () => { spendCache = null; };

/** Rupees spent today (UTC) by calls of the given tasks — the platform's free-tier exposure. Cached for a minute. */
export async function spentTodayInr(tasks: string[], now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const db = await ledgerDb();
  if (!db) return 0;
  if (spendCache && spendCache.day === day && Date.now() - spendCache.at < SPEND_TTL_MS) return spendCache.inr;
  const r = await db.aiUsage.aggregate({ _sum: { costInr: true }, where: { task: { in: tasks }, createdAt: { gte: new Date(`${day}T00:00:00.000Z`) } } });
  const inr = r._sum.costInr ?? 0;
  spendCache = { day, at: Date.now(), inr };
  return inr;
}

export class AiBudgetError extends Error { constructor(detail: string) { super(`AI_BUDGET_EXCEEDED: ${detail}`); } }
