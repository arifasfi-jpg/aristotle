// Phase 1.1 on REAL PostgreSQL: the migrated (verified) ModelPrice rows are what the gateway prices with; the
// cumulative governor reads its spend from AiUsage; concurrent calls of one scope cannot overshoot; failures of every
// kind land in the ledger with the right certainty; the transparency breakdown and audit total come from the ledger.
// Runs when HIPPO_E2E_DATABASE_URL / HIPPO_E2E_PRISMA_CLIENT / HIPPO_E2E_ADAPTER are set (see hippo-e2e.test.tsx).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const E2E = Boolean(process.env.HIPPO_E2E_DATABASE_URL && process.env.HIPPO_E2E_PRISMA_CLIENT && process.env.HIPPO_E2E_ADAPTER);
vi.mock('@/lib/db', async () => {
  if (!process.env.HIPPO_E2E_DATABASE_URL) return { db: {} };
  const { PrismaClient } = await import(/* @vite-ignore */ process.env.HIPPO_E2E_PRISMA_CLIENT!);
  const { PrismaPg } = await import(/* @vite-ignore */ process.env.HIPPO_E2E_ADAPTER!);
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.HIPPO_E2E_DATABASE_URL }) }) };
});

const USAGE = { promptTokenCount: 10_000, candidatesTokenCount: 2_000, thoughtsTokenCount: 1_000, cachedContentTokenCount: 4_000 };
let mode: 'ok' | 'abort' | 'dns' | 'http503' = 'ok';
let fetches = 0;
const env = { ...process.env };

beforeAll(() => {
  Object.assign(process.env, { HIPPO_USAGE_LEDGER: 'on', GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', GEMINI_MODEL: 'gemini-3.5-flash-lite', USD_INR: '88' });
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.HIPPO_AI_PROVIDER; delete process.env.HIPPO_TIER0_MODEL;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetches++;
    if (mode === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (mode === 'dns') throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    if (mode === 'http503') return new Response('overloaded', { status: 503 });
    if (String(url).includes('tavily')) { await new Promise((r) => setTimeout(r, 20)); return new Response(JSON.stringify({ results: [] }), { status: 200 }); }
    await new Promise((r) => setTimeout(r, 20)); // keep calls in flight long enough to overlap
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: USAGE }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); process.env = { ...env }; });

describe.skipIf(!E2E)('Cost governor (real Postgres)', () => {
  beforeEach(async () => { const { clearPriceCache } = await import('@/lib/ai-usage'); clearPriceCache(); mode = 'ok'; fetches = 0; });
  const id = () => `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it('the migrated verified price is the runtime price; the superseded Phase 1 row is not used', async () => {
    const { priceFor } = await import('@/lib/ai-usage');
    expect(await priceFor('gemini', 'gemini-3.5-flash-lite')).toMatchObject({ id: 'mp_gemini_3_5_flash_lite_v', inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5, cachedInputUsdPerMTok: 0.03, reasoningUsdPerMTok: 2.5, status: 'VERIFIED_PRICE' });
    expect(await priceFor('tavily', 'search')).toMatchObject({ usdPerCredit: 0.008, status: 'VERIFIED_PRICE' });
    for (const [provider, model] of [['gemini', 'gemini-3.5-flash'], ['gemini', 'gemini-3.1-flash-lite'], ['openai', 'gpt-5.6-luna'], ['anthropic', 'claude-opus-5-5']]) {
      expect([model, (await priceFor(provider, model)).status]).toEqual([model, 'VERIFIED_PRICE']);
    }
  });

  it('cumulative limit: spend is read from AiUsage; over the limit is refused before the provider, with state and reason', async () => {
    const { db } = await import('@/lib/db');
    const { generateJson } = await import('@/lib/hippo/gateway');
    const { deepIntelligencePolicy } = await import('@/lib/cost-governor');
    const scope = { type: 'JOB' as const, id: id() };
    const budget = deepIntelligencePolicy(scope);
    expect(budget.includedInr).toBe(230);
    await db.aiUsage.create({ data: { kind: 'MODEL', purpose: 'RESEARCH', task: 'seed', provider: 'gemini', model: 'gemini-3.5-flash-lite', costInr: 218, costStatus: 'ACTUAL', priceSource: 'VERIFIED_PRICE', usdInr: 88, durationMs: 0, outcome: 'SUCCESS', parentType: 'JOB', parentId: scope.id } });
    await generateJson('compare', 'Compare.', {}, {}, { budget });  // ₹218 + small worst case ≤ ₹230 → ALLOW
    expect(fetches).toBe(1);
    await db.aiUsage.create({ data: { kind: 'MODEL', purpose: 'RESEARCH', task: 'seed', provider: 'gemini', model: 'gemini-3.5-flash-lite', costInr: 11, costStatus: 'ESTIMATED', priceSource: 'VERIFIED_PRICE', usdInr: 88, durationMs: 0, outcome: 'TIMEOUT', parentType: 'JOB', parentId: scope.id } });
    await expect(generateJson('compare', 'Compare.', {}, {}, { budget })).rejects.toThrow(/REFUSE \[COST_NEAR_LIMIT\].*limit/);
    expect(fetches).toBe(1);
    const rows = await db.aiUsage.findMany({ where: { parentType: 'JOB', parentId: scope.id, task: 'compare' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r: { outcome: string; costStatus: string }) => [r.outcome, r.costStatus])).toEqual([['SUCCESS', 'ACTUAL'], ['REFUSED_BUDGET', 'NONE']]);
    expect(rows[1].error).toMatch(/committed \+ ₹[\d.]+ next > ₹230\.00 limit/);
  });

  it('concurrent calls of one scope cannot together overshoot the remaining budget', async () => {
    const { db } = await import('@/lib/db');
    const { generateJson } = await import('@/lib/hippo/gateway');
    const { modelCallEstimate, priceFor } = await import('@/lib/ai-usage');
    const scope = { type: 'JOB' as const, id: id() };
    // A realistic call: the provider's reported usage (10k in, 3k out incl. thinking) is within the prompt / output budget.
    const prompt = 'x'.repeat(12_000);
    const worst = modelCallEstimate(prompt.length + 2, 3000, await priceFor('gemini', 'gemini-3.5-flash-lite')).worstInr;
    await db.aiUsage.create({ data: { kind: 'MODEL', purpose: 'RESEARCH', task: 'seed', provider: 'gemini', model: 'gemini-3.5-flash-lite', costInr: 100 - worst * 2.5, costStatus: 'ACTUAL', priceSource: 'VERIFIED_PRICE', usdInr: 88, durationMs: 0, outcome: 'SUCCESS', parentType: 'JOB', parentId: scope.id } });
    const budget = { scope, includedInr: 100, warningInr: 90, nearLimitInr: 95 };
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => generateJson('compare', prompt, {}, { maxOutputTokens: 3000 }, { budget })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2); // room for two worst cases, not four
    expect(fetches).toBe(2);
    const spent = (await db.aiUsage.aggregate({ _sum: { costInr: true }, where: { parentType: 'JOB', parentId: scope.id } }))._sum.costInr;
    expect(spent).toBeLessThanOrEqual(100);
  });

  it('every failure class lands in the ledger with the right certainty; breakdown and audit total come from it', async () => {
    const { generateJson, meteredSearch } = await import('@/lib/hippo/gateway');
    const { auditCostInr, scopeBreakdown } = await import('@/lib/ai-usage');
    const auditId = id();
    const usage = { auditId, parentType: 'AUDIT' as const, parentId: auditId };
    await generateJson('compare', 'Compare.', {}, {}, usage);
    mode = 'abort'; await expect(generateJson('compare', 'Compare.', {}, {}, usage)).rejects.toThrow(/timed out/);
    mode = 'dns'; await expect(generateJson('compare', 'Compare.', {}, {}, usage)).rejects.toThrow();
    mode = 'http503'; await expect(generateJson('compare', 'Compare.', {}, {}, usage)).rejects.toThrow(/HTTP 503/);
    mode = 'ok'; await meteredSearch({ provider: 'tavily', depth: 'advanced' }, usage, async () => 'ok');
    const { db } = await import('@/lib/db');
    const rows = await db.aiUsage.findMany({ where: { auditId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r: { outcome: string; costStatus: string }) => [r.outcome, r.costStatus])).toEqual([
      ['SUCCESS', 'ACTUAL'], ['TIMEOUT', 'ESTIMATED'], ['FAILED_BEFORE_PROVIDER', 'NONE'], ['PROVIDER_ERROR', 'ESTIMATED'], ['SUCCESS', 'ACTUAL'],
    ]);
    expect(rows[0].costInr).toBeCloseTo(((10_000 - 4_000) * 0.3 + 4_000 * 0.03 + 3_000 * 2.5) / 1e6 * 88, 4);
    expect(rows[1].costInr).toBeGreaterThan(0); expect(rows[2].costInr).toBe(0); expect(rows[3].costInr).toBeGreaterThan(0);
    const total = rows.reduce((a: number, r: { costInr: number }) => a + r.costInr, 0);
    expect(await auditCostInr(auditId)).toBeCloseTo(total, 4);
    const b = await scopeBreakdown({ type: 'AUDIT', id: auditId });
    expect(b.actualInr + b.estimatedInr).toBeCloseTo(total, 4);
    expect(b.searchInr).toBeCloseTo(1.408, 4);
    expect(b.estimatedInr).toBeCloseTo(rows[1].costInr + rows[3].costInr, 4);
  });
});
