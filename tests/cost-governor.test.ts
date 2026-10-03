// Phase 1.1 — cost governor hardening. Tests A–T against the production functions. Provider HTTP is faked with a
// stubbed fetch; the ledger database is an in-memory stand-in for `db.modelPrice` / `db.aiUsage` (the same calls run on
// real Postgres in tests/cost-governor-e2e.test.tsx).
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const ledger: Row[] = [];
const prices: Row[] = [];
const reservations: Row[] = [];
let txChain: Promise<unknown> = Promise.resolve(); // Phase 2: reservations run in a scope-serialised transaction
const activeRes = (where: Row) => reservations.filter((r) => r.scopeType === where.scopeType && r.scopeId === where.scopeId && r.releasedAt === null && (!where.expiresAt || r.expiresAt < where.expiresAt.lt));
const sumWhere = (where: Row) => ledger.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).reduce((a, r) => a + r.costInr, 0);
vi.mock('../src/lib/db', () => {
  const costReservation = {
    findMany: async ({ where }: Row) => activeRes(where),
    aggregate: async ({ where }: Row) => ({ _sum: { amountInr: activeRes(where).reduce((a, r) => a + r.amountInr, 0) } }),
    create: async ({ data }: Row) => { const r = { id: `res${reservations.length + 1}`, releasedAt: null, createdAt: new Date(), ...data }; reservations.push(r); return r; },
    update: async ({ where, data }: Row) => Object.assign(reservations.find((r) => r.id === where.id)!, data),
    updateMany: async ({ where, data }: Row) => { const r = reservations.find((x) => x.id === where.id && x.releasedAt === null); if (r) Object.assign(r, data); return { count: r ? 1 : 0 }; },
  };
  const db: Row = {
    modelPrice: { findFirst: async ({ where }: Row) => prices.filter((p) => p.provider === where.provider && p.model === where.model && p.active !== false && p.effectiveFrom <= where.effectiveFrom.lte).sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] ?? null },
    aiUsage: {
      create: async ({ data }: Row) => { ledger.push({ ...data }); return data; },
      aggregate: async ({ where }: Row) => ({ _sum: { costInr: sumWhere(where) } }),
      groupBy: async ({ where }: Row) => {
        const g = new Map<string, Row>();
        for (const r of ledger.filter((x) => x.parentType === where.parentType && x.parentId === where.parentId)) {
          const k = `${r.kind}|${r.costStatus}`; const e = g.get(k) ?? { kind: r.kind, costStatus: r.costStatus, _sum: { costInr: 0 } }; e._sum.costInr += r.costInr; g.set(k, e);
        }
        return [...g.values()];
      },
    },
    costReservation,
    $executeRaw: async () => 0,
  };
  db.$transaction = (fn: (tx: Row) => Promise<unknown>) => { const run = txChain.then(() => fn(db)); txChain = run.catch(() => undefined); return run; };
  return { db };
});

import { accountFailure, clearPriceCache, costOf, modelCallEstimate, priceFor, priceFromRow, scopeBreakdown, searchCallEstimate, type Price } from '../src/lib/ai-usage';
import { approveAdditional, budgetStatus, costCeilingInr, costDisclosure, decideNext, deepIntelligencePolicy, maxCostPaise, netOfGstPaise, quoteAdditional, requestAdditional, type BudgetPolicy } from '../src/lib/cost-governor';
import { aristotleGeminiJson, generateJson, meteredSearch } from '../src/lib/hippo/gateway';

const env = { ...process.env };
const FLASH_LITE = { id: 'mp_gemini_3_5_flash_lite_v', provider: 'gemini', model: 'gemini-3.5-flash-lite', inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5, cachedInputUsdPerMTok: 0.03, reasoningUsdPerMTok: null, usdPerCredit: null, currency: 'USD', verificationStatus: 'VERIFIED', effectiveFrom: new Date('2026-10-03'), active: true };
const TAVILY = { id: 'mp_tavily_search_2026', provider: 'tavily', model: 'search', inputUsdPerMTok: null, outputUsdPerMTok: null, cachedInputUsdPerMTok: null, reasoningUsdPerMTok: null, usdPerCredit: 0.008, currency: 'USD', verificationStatus: 'VERIFIED', effectiveFrom: new Date('2026-01-01'), active: true };
const USAGE = { promptTokenCount: 10_000, candidatesTokenCount: 2_000, thoughtsTokenCount: 1_000, cachedContentTokenCount: 4_000 };
let fetchMode: 'ok' | 'abort' | 'dns' | 'connect-timeout' | 'reset' | 'http503' | 'invalid' = 'ok';
let fetches = 0;

beforeEach(() => {
  process.env = { ...env, HIPPO_USAGE_LEDGER: 'on', GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', GEMINI_MODEL: 'gemini-3.5-flash-lite', USD_INR: '88' };
  delete process.env.HIPPO_MAX_CALL_INR; delete process.env.HIPPO_ALLOW_UNPRICED_MODELS; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  ledger.length = 0; reservations.length = 0; prices.length = 0; prices.push(FLASH_LITE, TAVILY); clearPriceCache(); fetchMode = 'ok'; fetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetches++;
    if (fetchMode === 'abort') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    if (fetchMode === 'dns') throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    if (fetchMode === 'connect-timeout') throw new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    if (fetchMode === 'reset') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    if (fetchMode === 'http503') return new Response('overloaded', { status: 503 });
    if (String(url).includes('tavily')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    const text = fetchMode === 'invalid' ? '{"truncated": ' : JSON.stringify({ ok: true });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: USAGE }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...env }; });

const P = (p: Partial<Price>): Price => ({ id: 'x', inputUsdPerMTok: 0, outputUsdPerMTok: 0, cachedInputUsdPerMTok: 0, reasoningUsdPerMTok: 0, usdPerCredit: 0, currency: 'USD', status: 'VERIFIED_PRICE', ...p });
const call = (usage?: Row) => generateJson('compare', 'Compare this quote.', { type: 'object' }, {}, usage?.budget ? usage : { parentType: 'REQUEST', ...usage });
const verified = priceFromRow(FLASH_LITE as never);
// Exact rupee cost of USAGE on the verified Gemini 3.5 Flash-Lite price (thinking billed at the output rate).
const USAGE_INR = ((10_000 - 4_000) * 0.3 + 4_000 * 0.03 + 2_000 * 2.5 + 1_000 * 2.5) / 1e6 * 88;

describe('A–G: ModelPrice is the only price; the ledger formula', () => {
  it('A. a VERIFIED ModelPrice row is looked up and used; a successful call is ACTUAL cost', async () => {
    expect(await priceFor('gemini', 'gemini-3.5-flash-lite')).toEqual({ id: 'mp_gemini_3_5_flash_lite_v', inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5, cachedInputUsdPerMTok: 0.03, reasoningUsdPerMTok: 2.5, usdPerCredit: 0, currency: 'USD', status: 'VERIFIED_PRICE' });
    await call();
    expect(ledger[0]).toMatchObject({ outcome: 'SUCCESS', costStatus: 'ACTUAL', priceSource: 'VERIFIED_PRICE', priceId: 'mp_gemini_3_5_flash_lite_v' });
    expect(ledger[0].costInr).toBeCloseTo(USAGE_INR, 4);
  });
  it('B. an UNVERIFIED price is used but the cost is marked ESTIMATED; no price → refused (never guessed)', async () => {
    prices.push({ ...FLASH_LITE, id: 'mp_new', model: 'gemini-new', verificationStatus: 'UNVERIFIED' });
    process.env.HIPPO_TIER0_MODEL = 'gemini:gemini-new';
    await call();
    expect(ledger[0]).toMatchObject({ model: 'gemini-new', priceSource: 'UNVERIFIED_PRICE', costStatus: 'ESTIMATED', outcome: 'SUCCESS' });
    process.env.HIPPO_TIER0_MODEL = 'gemini:gemini-unknown';
    await expect(call()).rejects.toThrow(/no ModelPrice for gemini\/gemini-unknown/);
    expect(ledger[1]).toMatchObject({ outcome: 'REFUSED_BUDGET', costStatus: 'NONE', costInr: 0, priceSource: 'UNPRICED' });
    expect(fetches).toBe(1);
  });
  it('C. cached input tokens are charged at the cached rate (missing cached rate → input rate, never cheaper)', () => {
    expect(costOf({ inputTokens: 1_000_000, cachedTokens: 1_000_000 }, verified, 1)).toBeCloseTo(0.03, 6);
    expect(costOf({ inputTokens: 1_000_000, cachedTokens: 400_000 }, verified, 1)).toBeCloseTo(0.6 * 0.3 + 0.4 * 0.03, 6);
    const noCachedRate = priceFromRow({ ...FLASH_LITE, cachedInputUsdPerMTok: null } as never);
    expect(costOf({ inputTokens: 1_000_000, cachedTokens: 1_000_000 }, noCachedRate, 1)).toBeCloseTo(0.3, 6);
  });
  it('D. thinking tokens are charged at the reasoning rate (defaults to the output rate)', () => {
    expect(costOf({ reasoningTokens: 1_000_000 }, verified, 1)).toBeCloseTo(2.5, 6);
    expect(costOf({ reasoningTokens: 1_000_000 }, P({ outputUsdPerMTok: 2, reasoningUsdPerMTok: 7 }), 1)).toBeCloseTo(7, 6);
  });
  it('E. input and output tokens at their own rates, converted at USD_INR', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, verified, 88)).toBeCloseTo((0.3 + 2.5) * 88, 4);
    expect(costOf({ inputTokens: 1_000_000 }, P({ inputUsdPerMTok: 50, currency: 'INR' }), 88)).toBe(50); // INR prices are not converted
  });
  it('F. search is costed by credits, stays visible as SEARCH, and is budget-checked before the request', async () => {
    await meteredSearch({ provider: 'tavily', depth: 'advanced' }, { parentType: 'REQUEST' }, async () => 'ok');
    expect(ledger[0]).toMatchObject({ kind: 'SEARCH', searchCredits: 2, costStatus: 'ACTUAL', outcome: 'SUCCESS' });
    expect(ledger[0].costInr).toBeCloseTo(2 * 0.008 * 88, 4);
    process.env.HIPPO_MAX_CALL_INR = '1';
    const run = vi.fn(async () => 'never');
    await expect(meteredSearch({ provider: 'tavily', depth: 'advanced' }, { parentType: 'REQUEST' }, run)).rejects.toThrow(/AI_BUDGET_EXCEEDED/);
    expect(run).not.toHaveBeenCalled();
  });
  it('G. retries are recorded; the cost is what Gemini reports for the answered request', async () => {
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (first) { first = false; return new Response('thinking config not supported', { status: 400 }); }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: USAGE }), { status: 200 });
    }));
    await aristotleGeminiJson('scope-classifier', { prompt: 'p', schema: {}, timeoutMs: 5000, maxOutputTokens: 500, label: 'scope', fastThinking: true });
    expect(ledger[0]).toMatchObject({ retries: 1, outcome: 'SUCCESS', costStatus: 'ACTUAL' });
    expect(ledger[0].costInr).toBeCloseTo(USAGE_INR, 4);
  });
});

describe('H–J: timeouts and failures are never booked as free when they may have been billed', () => {
  const est = () => modelCallEstimate('Compare this quote.'.length + JSON.stringify({ type: 'object' }).length, 1200, verified);
  it('H. timeout AFTER the request was sent → TIMEOUT, ESTIMATED at the full worst case', async () => {
    fetchMode = 'abort';
    await expect(call()).rejects.toThrow(/timed out/);
    expect(ledger[0]).toMatchObject({ outcome: 'TIMEOUT', costStatus: 'ESTIMATED' });
    expect(ledger[0].costInr).toBe(est().worstInr);
    expect(ledger[0].costInr).toBeGreaterThan(0);
  });
  it('I. timeout BEFORE the request reached the provider (connect timeout) → TIMEOUT, ₹0, NONE', async () => {
    fetchMode = 'connect-timeout';
    await expect(call()).rejects.toThrow(/GEMINI_ERROR/);
    expect(ledger[0]).toMatchObject({ outcome: 'TIMEOUT', costStatus: 'NONE', costInr: 0 });
  });
  it('I. not sent at all (DNS failure / provider not configured) → FAILED_BEFORE_PROVIDER, ₹0, NONE', async () => {
    fetchMode = 'dns';
    await expect(call()).rejects.toThrow(/GEMINI_ERROR/);
    expect(ledger[0]).toMatchObject({ outcome: 'FAILED_BEFORE_PROVIDER', costStatus: 'NONE', costInr: 0 });
    delete process.env.GEMINI_API_KEY;
    await expect(aristotleGeminiJson('decision', { prompt: 'p', schema: {}, timeoutMs: 5000, maxOutputTokens: 500, label: 'd' })).rejects.toThrow(/GEMINI_API_KEY is missing/);
    expect(ledger[1]).toMatchObject({ outcome: 'FAILED_BEFORE_PROVIDER', costStatus: 'NONE', costInr: 0 });
  });
  it('J. provider failure WITH known usage (unusable answer) → INVALID_OUTPUT at the ACTUAL reported usage', async () => {
    fetchMode = 'invalid';
    await expect(call()).rejects.toThrow(/not valid JSON/);
    expect(ledger[0]).toMatchObject({ outcome: 'INVALID_OUTPUT', costStatus: 'ACTUAL', inputTokens: 10_000, reasoningTokens: 1_000 });
    expect(ledger[0].costInr).toBeCloseTo(USAGE_INR, 4);
  });
  it('J. provider failure with UNKNOWN usage: HTTP error → input-only estimate; lost connection → UNKNOWN_PROVIDER_OUTCOME at worst case', async () => {
    fetchMode = 'http503';
    await expect(call()).rejects.toThrow(/HTTP 503/);
    expect(ledger[0]).toMatchObject({ outcome: 'PROVIDER_ERROR', costStatus: 'ESTIMATED' });
    expect(ledger[0].costInr).toBe(est().inputOnlyInr);
    expect(ledger[0].costInr).toBeGreaterThan(0);
    fetchMode = 'reset';
    await expect(call()).rejects.toThrow(/GEMINI_ERROR/);
    expect(ledger[1]).toMatchObject({ outcome: 'UNKNOWN_PROVIDER_OUTCOME', costStatus: 'ESTIMATED' });
    expect(ledger[1].costInr).toBe(est().worstInr);
  });
  it('J. a search that was sent and failed is booked at its credits; cancellation after send is not free either', () => {
    const tav = priceFromRow(TAVILY as never);
    expect(accountFailure(Object.assign(new Error('TAVILY_ERROR 500'), { providerPhase: 'SENT', httpStatus: 500 }), tav, searchCallEstimate(2, tav))).toMatchObject({ outcome: 'PROVIDER_ERROR', costStatus: 'ESTIMATED', costInr: 1.408 });
    expect(accountFailure(Object.assign(new Error('cancelled'), { providerPhase: 'SENT', cancelled: true }), verified, { worstInr: 3, inputOnlyInr: 1 })).toEqual({ outcome: 'CANCELLED', costStatus: 'ESTIMATED', costInr: 3, measured: {} });
    expect(accountFailure(Object.assign(new Error('cancelled'), { providerPhase: 'NOT_SENT', cancelled: true }), verified, { worstInr: 3, inputOnlyInr: 1 })).toMatchObject({ outcome: 'CANCELLED', costStatus: 'NONE', costInr: 0 });
  });
  it('a tiny possibly-billed call is rounded UP, never down to ₹0', () => {
    expect(modelCallEstimate(3, 0, verified).worstInr).toBe(0.0001);
  });
  it('budget refusal BEFORE the provider call → REFUSED_BUDGET, ₹0, NONE, no request made', async () => {
    process.env.HIPPO_MAX_CALL_INR = '0.0001';
    await expect(call()).rejects.toThrow(/AI_BUDGET_EXCEEDED/);
    expect(fetches).toBe(0);
    expect(ledger[0]).toMatchObject({ outcome: 'REFUSED_BUDGET', costStatus: 'NONE', costInr: 0 });
    expect(ledger[0].estimatedInr).toBeGreaterThan(0.0001);
  });
  it('a successful call → SUCCESS, ACTUAL', async () => {
    await call();
    expect(ledger[0]).toMatchObject({ outcome: 'SUCCESS', costStatus: 'ACTUAL' });
  });
});

describe('K–N: cumulative governor', () => {
  const policy = (p: Partial<BudgetPolicy> = {}): BudgetPolicy => ({ scope: { type: 'JOB', id: 'job1' }, includedInr: 230, warningInr: 210, nearLimitInr: 220, perCallInr: 25, ...p });
  it('K. ₹218 spent + ₹12 next = ₹230 → ALLOW; ₹218 + ₹15 → REFUSE (or ASK_FOUNDER when a founder can approve)', () => {
    const p = policy();
    expect(decideNext(p, budgetStatus(p, 218), 12)).toMatchObject({ decision: 'ALLOW', state: 'COST_WARNING' });
    expect(decideNext(p, budgetStatus(p, 218), 15)).toMatchObject({ decision: 'REFUSE', additionalNeededInr: 3 });
    const ask = decideNext(policy({ canAskFounder: true }), budgetStatus(p, 218), 15);
    expect(ask).toMatchObject({ decision: 'ASK_FOUNDER', state: 'ADDITIONAL_BUDGET_REQUIRED', additionalNeededInr: 3 });
    expect(ask.options).toEqual(['ASK_FOUNDER', 'REDUCE_SCOPE', 'DOWNGRADE']);
  });
  it('K. in-flight reservations count: two ₹10 calls with ₹15 left → only one is allowed', () => {
    const p = policy();
    expect(decideNext(p, budgetStatus(p, 215, 0), 10).decision).toBe('ALLOW');
    expect(decideNext(p, budgetStatus(p, 215, 10), 10).decision).toBe('REFUSE');
  });
  it('K. quality is never reduced automatically: only cached evidence / an equivalent cheaper route are chosen', () => {
    const p = policy();
    const s = budgetStatus(p, 225);
    expect(decideNext(p, s, 10, { validCachedEvidence: true }).decision).toBe('USE_VALID_CACHED_EVIDENCE');
    expect(decideNext(p, s, 10, { equivalentCheaperRouteInr: 4 }).decision).toBe('USE_CHEAPER_ROUTE');
    expect(decideNext(p, s, 10, { equivalentCheaperRouteInr: 6 }).decision).toBe('REFUSE');
    for (const spent of [0, 100, 215, 229, 231]) for (const next of [1, 10, 24]) expect(['DOWNGRADE', 'REDUCE_SCOPE']).not.toContain(decideNext(p, budgetStatus(p, spent), next).decision);
  });
  it('L. per-call limit: a single ₹26 call is refused even with plenty of budget left', () => {
    const p = policy();
    expect(decideNext(p, budgetStatus(p, 0), 26)).toMatchObject({ decision: 'REFUSE', reason: expect.stringMatching(/per-call limit ₹25/) });
  });
  it('M. warning thresholds are configurable and reported as states', () => {
    const p = policy();
    expect([0, 209.99, 210, 219.99, 220, 230].map((x) => budgetStatus(p, x).state)).toEqual(['COST_OK', 'COST_OK', 'COST_WARNING', 'COST_WARNING', 'COST_NEAR_LIMIT', 'COST_LIMIT_REACHED']);
    process.env.HIPPO_DI_WARNING_INR = '200'; process.env.HIPPO_DI_NEAR_LIMIT_INR = '215';
    const di = deepIntelligencePolicy({ type: 'JOB', id: 'x' });
    expect([di.warningInr, di.nearLimitInr, di.includedInr]).toEqual([200, 215, 230]);
    expect(budgetStatus(di, 205).state).toBe('COST_WARNING');
  });
  it('N. hard ceiling ₹230 for the ₹299 product; a configured ceiling above it is ignored', () => {
    expect(deepIntelligencePolicy({ type: 'JOB', id: 'x' })).toMatchObject({ pricePaise: 29900, includedInr: 230, warningInr: 210, nearLimitInr: 220 });
    process.env.HIPPO_DI_COST_CEILING_INR = '260';
    expect(deepIntelligencePolicy({ type: 'JOB', id: 'x' }).includedInr).toBe(230);
    process.env.HIPPO_DI_COST_CEILING_INR = '200';
    expect(deepIntelligencePolicy({ type: 'JOB', id: 'x' }).includedInr).toBe(200);
    const p = policy();
    const at = budgetStatus(p, 230);
    expect(at).toMatchObject({ state: 'COST_LIMIT_REACHED', remainingInr: 0 });
    expect(decideNext(p, at, 0.01).decision).toBe('REFUSE');
  });
  it('K. gateway: a budgeted call over the cumulative limit is refused before the provider and recorded with the reason', async () => {
    const budget = policy({ scope: { type: 'JOB', id: 'job-g' } });
    ledger.push({ parentType: 'JOB', parentId: 'job-g', costInr: 229.999, kind: 'MODEL', costStatus: 'ACTUAL' });
    await expect(call({ parentType: 'JOB', parentId: 'job-g', budget })).rejects.toThrow(/REFUSE \[COST_NEAR_LIMIT\]/);
    expect(fetches).toBe(0);
    expect(ledger.at(-1)).toMatchObject({ outcome: 'REFUSED_BUDGET', costStatus: 'NONE', parentType: 'JOB', parentId: 'job-g' });
    ledger.length = 0;
    ledger.push({ parentType: 'JOB', parentId: 'job-g', costInr: 218, kind: 'MODEL', costStatus: 'ACTUAL' });
    await call({ budget }); // parent comes from the budget scope
    expect(ledger.at(-1)).toMatchObject({ outcome: 'SUCCESS', parentType: 'JOB', parentId: 'job-g' });
    expect(fetches).toBe(1);
  });
  it('K. gateway: concurrent calls cannot overshoot the remaining budget together', async () => {
    const budget = policy({ scope: { type: 'JOB', id: 'job-c' } });
    const worst = modelCallEstimate('Compare this quote.'.length + JSON.stringify({ type: 'object' }).length, 1200, verified).worstInr;
    ledger.push({ parentType: 'JOB', parentId: 'job-c', costInr: 230 - worst * 1.5, kind: 'MODEL', costStatus: 'ACTUAL' }); // room for one
    const r = await Promise.allSettled([call({ budget }), call({ budget })]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fetches).toBe(1);
  });
});

describe('O–Q: commercial maths (integer paise)', () => {
  it('P. ₹299 GST-inclusive → ₹253.39 net of 18% GST', () => {
    expect(netOfGstPaise(29900)).toBe(25339);
  });
  it('Q. cost + 10%: ₹253.39 ÷ 1.10 = ₹230.35 maximum cost → hard ceiling ₹230', () => {
    expect(maxCostPaise(29900)).toBe(23035);
    expect(costCeilingInr(29900)).toBe(230);
    expect(230 * 1.1 * 1.18).toBeLessThanOrEqual(299); // the ceiling keeps the margin and the GST whole
  });
  it('O. additional budget: internal ₹50 → ₹55 → GST ₹9.90 → ₹64.90 → presented as ₹65', () => {
    expect(quoteAdditional(5000)).toEqual({ internalCostPaise: 5000, marginPaise: 500, netPaise: 5500, gstPaise: 990, totalPaise: 6490, presentedInr: 65 });
    expect(quoteAdditional(4945)).toMatchObject({ totalPaise: 6419, presentedInr: 65 }); // ₹64.19 is presented as ₹65 (rounded up, never down)
  });
  it('O. extension lifecycle: requested blocks, approved raises the limit and the thresholds; disclosure shows everything', () => {
    let p: BudgetPolicy = { scope: { type: 'JOB', id: 'j' }, includedInr: 230, warningInr: 210, nearLimitInr: 220, canAskFounder: true };
    p = requestAdditional(p, 50);
    const pending = budgetStatus(p, 229);
    expect(pending).toMatchObject({ state: 'ADDITIONAL_BUDGET_REQUIRED', requestedAdditionalInr: 50, approvedAdditionalInr: 0, limitInr: 230 });
    expect(decideNext(p, pending, 0.5).decision).toBe('ASK_FOUNDER');
    expect(costDisclosure(pending, { actualInr: 200, estimatedInr: 29, modelInr: 220, searchInr: 9 }).additionalRequest).toEqual({ internalCostInr: 50, priceInr: 65, gstInr: 9.9 });
    p = approveAdditional(p, 50);
    const s = budgetStatus(p, 229);
    expect(s).toMatchObject({ state: 'COST_OK', warningInr: 260, nearLimitInr: 270, includedInr: 230, approvedAdditionalInr: 50, requestedAdditionalInr: 0, limitInr: 280, remainingInr: 51 });
    expect(decideNext(p, s, 20).decision).toBe('ALLOW');
    const d = costDisclosure(budgetStatus(p, 280), { actualInr: 270, estimatedInr: 10, modelInr: 250, searchInr: 30 });
    expect(d).toMatchObject({ state: 'COST_LIMIT_REACHED', includedInr: 230, approvedAdditionalInr: 50, spentInr: 280, spentProviderReportedInr: 270, spentEstimatedInr: 10, searchInr: 30, remainingInr: 0 });
  });
  it('transparency: the scope breakdown separates provider-reported and estimated cost, model and search', async () => {
    ledger.push({ parentType: 'JOB', parentId: 'b', kind: 'MODEL', costStatus: 'ACTUAL', costInr: 5 }, { parentType: 'JOB', parentId: 'b', kind: 'MODEL', costStatus: 'ESTIMATED', costInr: 2 }, { parentType: 'JOB', parentId: 'b', kind: 'SEARCH', costStatus: 'ACTUAL', costInr: 1.408 });
    expect(await scopeBreakdown({ type: 'JOB', id: 'b' })).toEqual({ actualInr: 6.408, estimatedInr: 2, modelInr: 7, searchInr: 1.408 });
  });
});

describe('R–T: one cost source, no hard-coded prices, no gateway bypass', () => {
  const root = path.join(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(path.relative(root, p).replace(/\\/g, '/')); } };
  walk(path.join(root, 'src'));
  it('R. Audit.computePaise comes from the AiUsage ledger (auditCostInr); no competing formula remains', () => {
    // Phase 2 (intentional move): the audit is persisted by the audit job, not the payment route; same formula.
    const verify = read('src/lib/jobs/aristotle-audit.ts');
    expect(read('src/app/api/payments/verify/route.ts')).not.toMatch(/runAudit|computePaise/);
    expect(verify).toMatch(/const computePaise = Math\.round\(\(\(await auditCostInr\(audit\.id\)\) \?\? 0\) \* 100\)/);
    expect(verify).toMatch(/marginPaise = Math\.round\(computePaise \* PLATFORM_MARGIN\)/);
    expect(verify).not.toMatch(/result\.pricing/);
    expect(fs.existsSync(path.join(root, 'src/lib/pricing.ts'))).toBe(false);
    expect(files.filter((f) => /estimateCompute/.test(read(f)))).toEqual([]);
    expect(read('src/lib/hippo/costs.ts')).toMatch(/costOf\(\{ inputTokens: promptTokens \+ 1500/); // estimates use the ledger formula
  });
  it('S. no provider price is hard-coded in application code (ModelPrice rows only)', () => {
    expect(files.filter((f) => /USD_PER_MILLION|UsdPerMTok:\s*\d|usdPerCredit:\s*0\.\d/.test(read(f)) && !/^src\/lib\/ai-usage\.ts$/.test(f))).toEqual([]);
    // ai-usage.ts itself only has the all-zero UNPRICED sentinel.
    expect(read('src/lib/ai-usage.ts').match(/UsdPerMTok:\s*[1-9]|UsdPerMTok:\s*0\.\d/g)).toBeNull();
    expect(read('src/lib/ai-usage.ts')).not.toMatch(/fallbackPrice|MODEL_INPUT_USD/);
  });
  it('T. every provider call goes through the gateway: metered() is only called by the gateway', () => {
    expect(files.filter((f) => /\bmetered(<[^>]*>)?\(/.test(read(f)) && !['src/lib/ai-usage.ts', 'src/lib/hippo/gateway.ts'].includes(f))).toEqual([]);
    expect(files.filter((f) => /api\.tavily\.com|generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/.test(read(f)) && !['src/lib/gemini.ts', 'src/lib/hippo/gateway.ts', 'src/lib/research.ts'].includes(f))).toEqual([]);
    // Every metered() call in the gateway is preceded by the guard (budget check before the provider).
    const gw = read('src/lib/hippo/gateway.ts');
    expect((gw.match(/await metered</g) || []).length).toBe(3);
    expect((gw.match(/const g = await guard\(/g) || []).length).toBe(3);
  });
});
