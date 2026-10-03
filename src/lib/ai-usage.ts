// AI cost ledger + per-model prices + platform guard.
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
export type UsageOutcome = 'OK' | 'ERROR' | 'TIMEOUT' | 'INVALID_OUTPUT' | 'REFUSED_BUDGET';

/** Who/what a call belongs to. Passed explicitly by callers (routes, services, the Aristotle engine). */
export type UsageContext = {
  userId?: string | null; founderId?: string | null; organizationId?: string | null; objectiveId?: string | null;
  workId?: string | null; auditId?: string | null; parentType?: 'TURN' | 'JOB' | 'WORK' | 'AUDIT' | 'REQUEST' | null; parentId?: string | null;
};

export type CallSpec = { kind: 'MODEL' | 'SEARCH'; purpose: UsagePurpose; task: string; tier?: ModelTier | null; provider: string; model: string };
export type Measured = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number; searchCalls?: number; searchCredits?: number; retries?: number };

// ---------------------------------------------------------------- prices
export type Price = { id: string | null; inputUsdPerMTok: number; outputUsdPerMTok: number; cachedInputUsdPerMTok: number; usdPerCredit: number; source: 'MODEL_PRICE' | 'UNPRICED_FALLBACK' };

export const usdInr = () => { const n = Number(process.env.USD_INR || '88'); return Number.isFinite(n) && n > 0 ? n : 88; };

/**
 * A model with no `ModelPrice` row is still costed (with the old app-wide env rates) but marked UNPRICED_FALLBACK in
 * the ledger, so an unpriced model is visible instead of silently priced like another model.
 */
function fallbackPrice(): Price {
  const inRate = Number(process.env.MODEL_INPUT_USD_PER_MILLION || '0.20');
  const outRate = Number(process.env.MODEL_OUTPUT_USD_PER_MILLION || '1.20');
  return { id: null, inputUsdPerMTok: inRate, outputUsdPerMTok: outRate, cachedInputUsdPerMTok: inRate, usdPerCredit: 0, source: 'UNPRICED_FALLBACK' };
}

const PRICE_TTL_MS = 5 * 60_000;
const priceCache = new Map<string, { at: number; price: Price }>();
export const clearPriceCache = () => priceCache.clear();

export async function priceFor(provider: string, model: string, now = new Date()): Promise<Price> {
  const key = `${provider}\u0000${model}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  let price = fallbackPrice();
  const db = await ledgerDb();
  if (!db) return price;
  try {
    const row = await db.modelPrice.findFirst({ where: { provider, model, active: true, effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: 'desc' } });
    if (row) {
      const input = row.inputUsdPerMTok ?? 0;
      price = { id: row.id, inputUsdPerMTok: input, outputUsdPerMTok: row.outputUsdPerMTok ?? 0, cachedInputUsdPerMTok: row.cachedInputUsdPerMTok ?? input, usdPerCredit: row.usdPerCredit ?? 0, source: 'MODEL_PRICE' };
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'model_price_lookup_failed', provider, model, error: e instanceof Error ? e.message : String(e) }));
  }
  priceCache.set(key, { at: Date.now(), price });
  return price;
}

/** Rupee cost of one call. Cached input is billed at the cached rate; reasoning ("thinking") tokens are billed as output. */
export function costOf(m: Measured, p: Price, fx = usdInr()): number {
  const input = Math.max(0, m.inputTokens ?? 0); const cached = Math.min(input, Math.max(0, m.cachedTokens ?? 0));
  const out = Math.max(0, m.outputTokens ?? 0) + Math.max(0, m.reasoningTokens ?? 0);
  const usd = ((input - cached) * p.inputUsdPerMTok + cached * p.cachedInputUsdPerMTok + out * p.outputUsdPerMTok) / 1_000_000 + Math.max(0, m.searchCredits ?? 0) * p.usdPerCredit;
  return Math.round(usd * fx * 10_000) / 10_000;
}

// ---------------------------------------------------------------- ledger
export function outcomeOf(e: unknown): UsageOutcome {
  const msg = e instanceof Error ? e.message : String(e);
  if (/AI_BUDGET_EXCEEDED/.test(msg)) return 'REFUSED_BUDGET';
  if (/timed out|TIMEOUT|AbortError/i.test(msg)) return 'TIMEOUT';
  if (/not valid JSON|empty response|_INVALID/i.test(msg)) return 'INVALID_OUTPUT';
  return 'ERROR';
}

export type UsageRecord = CallSpec & Measured & { costInr: number; estimatedInr?: number | null; price: Price; durationMs: number; outcome: UsageOutcome; error?: string | null; context?: UsageContext };

export async function recordUsage(r: UsageRecord): Promise<void> {
  const c = r.context || {};
  const db = await ledgerDb();
  if (!db) return;
  try {
    await db.aiUsage.create({ data: {
      kind: r.kind, purpose: r.purpose, task: r.task.slice(0, 80), tier: r.tier ?? null, provider: r.provider, model: r.model,
      inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, cachedTokens: r.cachedTokens ?? 0, reasoningTokens: r.reasoningTokens ?? 0,
      searchCalls: r.searchCalls ?? 0, searchCredits: r.searchCredits ?? 0, estimatedInr: r.estimatedInr ?? null, costInr: r.costInr,
      priceSource: r.price.source, priceId: r.price.id, usdInr: usdInr(), durationMs: Math.round(r.durationMs), retries: r.retries ?? 0,
      outcome: r.outcome, error: r.error ? r.error.slice(0, 300) : null,
      userId: c.userId ?? null, founderId: c.founderId ?? null, organizationId: c.organizationId ?? null, objectiveId: c.objectiveId ?? null,
      workId: c.workId ?? null, auditId: c.auditId ?? null, parentType: c.parentType ?? null, parentId: c.parentId ?? null,
    } });
  } catch (e) {
    // Never lose the business result because the ledger write failed; make the miss loud instead.
    console.error(JSON.stringify({ event: 'ai_usage_write_failed', task: r.task, provider: r.provider, model: r.model, costInr: r.costInr, error: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * Runs one model/search call and records it. `run` returns the provider's measured usage alongside its result.
 * On failure the call is still recorded (outcome + error, no tokens unless the provider reported some) and the
 * original error is re-thrown unchanged, so callers behave exactly as before.
 */
export async function metered<T>(spec: CallSpec, context: UsageContext | undefined, run: () => Promise<{ result: T; measured: Measured }>, estimatedInr?: number | null): Promise<{ result: T; costInr: number; measured: Measured; durationMs: number }> {
  const started = Date.now();
  const price = await priceFor(spec.provider, spec.model);
  try {
    const { result, measured } = await run();
    const costInr = costOf(measured, price);
    const durationMs = Date.now() - started;
    await recordUsage({ ...spec, ...measured, costInr, estimatedInr, price, durationMs, outcome: 'OK', context });
    return { result, costInr, measured, durationMs };
  } catch (e) {
    const measured = ((e as { measured?: Measured })?.measured) || {};
    await recordUsage({ ...spec, ...measured, costInr: costOf(measured, price), estimatedInr, price, durationMs: Date.now() - started, outcome: outcomeOf(e), error: e instanceof Error ? e.message : String(e), context });
    throw e;
  }
}

// ---------------------------------------------------------------- guards (call ceiling + platform free-tier cap)
/** Upper bound for one model call before it is made: whole prompt at the input rate + the full output budget. */
export function maxCallCostInr(promptChars: number, maxOutputTokens: number, p: Price): number {
  return costOf({ inputTokens: Math.ceil(promptChars / 3), outputTokens: maxOutputTokens }, p);
}
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
