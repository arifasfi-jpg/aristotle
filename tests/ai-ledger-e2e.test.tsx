// Phase 1 acceptance, end to end on REAL PostgreSQL: every model and search call made by the real routes (scope
// classifier, objective understanding, explore, the paid Aristotle audit — research plan, searches, extraction,
// decision — and AI work execution) lands in AiUsage with its own provider/model price; failures and refusals are
// recorded; the explore endpoint is protected. Only provider HTTP and the cookie store are faked; every fetch to a
// provider is counted so the test proves the ledger misses nothing.
//
// Runs when HIPPO_E2E_DATABASE_URL / HIPPO_E2E_PRISMA_CLIENT / HIPPO_E2E_ADAPTER are set (see hippo-e2e.test.tsx).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const E2E = Boolean(process.env.HIPPO_E2E_DATABASE_URL && process.env.HIPPO_E2E_PRISMA_CLIENT && process.env.HIPPO_E2E_ADAPTER);

vi.mock('@/lib/db', async () => {
  if (!process.env.HIPPO_E2E_DATABASE_URL) return { db: {} };
  const { PrismaClient } = await import(/* @vite-ignore */ process.env.HIPPO_E2E_PRISMA_CLIENT!);
  const { PrismaPg } = await import(/* @vite-ignore */ process.env.HIPPO_E2E_ADAPTER!);
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.HIPPO_E2E_DATABASE_URL }) }) };
});
let jar = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); } }) }));

const IDEA = 'We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month.';
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50, cachedContentTokenCount: 100 };
const providerCalls = { gemini: 0, tavily: 0 };
const geminiModels: string[] = [];
let failNext: null | 'http' | 'timeout' = null;
let tavilyDown = false;

function gemini(prompt: string): unknown {
  if (prompt.includes('Restate what this founder')) return { objective: 'Grow to 10,000 units', target: '10,000 units/month', currentState: '1,400 units/month', keyQuestion: 'Which channels?', businessKind: 'EXISTING_BUSINESS' };
  if (prompt.includes('Classify this request for Aristotle')) return { scope: 'GROWTH_PLAN', confidence: 0.9, reason: 'Existing sales' };
  if (prompt.includes('has no idea yet')) return { directions: [{ title: 'Home tiffin', whoItServes: 'Office workers', whyYou: 'You cook', firstTest: 'Sell 10 lunches', objective: 'I want to sell home lunches' }] };
  if (prompt.includes('research planner')) return { businessModel: { summary: 'Glucometers via pharmacies', customer: 'Diabetics', payer: 'Patients', offering: 'Glucometers', revenueMechanism: 'Unit sales', keyActivities: ['Distribution'], regulatedActivities: [] }, questions: [
    { category: 'CHANNEL', question: 'Where do Indians buy glucometers?', whyItMatters: 'Channel', query: 'where buy glucometers india pharmacy' },
    { category: 'CHANNEL', question: 'Who buys glucometers on IndiaMART?', whyItMatters: 'B2B', query: 'indiamart glucometer buyers' },
    { category: 'COST', question: 'Distributor margin?', whyItMatters: 'Economics', query: 'glucometer distributor margin' },
    { category: 'DEMAND', question: 'How many diabetics test at home?', whyItMatters: 'Demand', query: 'home glucose testing india' } ] };
  if (prompt.includes('You extract evidence for ONE research question')) return prompt.includes('Where do Indians buy') ? { status: 'ANSWERED', findings: [{ statement: 'Chemists are the main purchase point.', sourceId: 'S1', quote: 'Retail chemists remain the main point of purchase', confidence: 'MEDIUM' }] } : { status: 'NOT_FOUND', findings: [] };
  if (prompt.includes('executing a work item')) return { summary: 'Plan.', markdown: `# Plan\n\n${'Detail. '.repeat(40)}`, assumptions: [], founderInputsNeeded: [], professionalReviewRequired: false };
  return null; // decision memo
}

beforeAll(() => {
  Object.assign(process.env, { HIPPO_USAGE_LEDGER: 'on', GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', DEMO_MODE: 'true', VERCEL_ENV: 'preview', GEMINI_MODEL: 'gemini-3.5-flash-lite', USD_INR: '88' });
  delete process.env.HIPPO_WORK_PAYMENTS; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.HIPPO_AI_PROVIDER;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (url.includes('tavily')) {
      providerCalls.tavily++;
      if (tavilyDown) return new Response('down', { status: 500 });
      const hit = body.query.includes('pharmacy') ? [{ title: 'Pharmacy report', url: 'https://example.org/pharmacy', content: 'Retail chemists remain the main point of purchase for home glucose monitoring devices.' }] : [];
      return new Response(JSON.stringify({ results: hit }), { status: 200 });
    }
    providerCalls.gemini++;
    geminiModels.push(String(url).match(/models\/([^:]+):/)?.[1] || '');
    if (failNext === 'http') { failNext = null; return new Response('overloaded', { status: 503 }); }
    if (failNext === 'timeout') { failNext = null; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    const prompt: string = body.contents[0].parts[0].text;
    let data = gemini(prompt);
    if (data === null) { const { deterministicAudit } = await import('@/lib/audit'); data = { ...deterministicAudit({ idea: IDEA, sector: 'Healthtech' }), unitEconomics: [] }; }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: USAGE }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); delete process.env.HIPPO_USAGE_LEDGER; delete process.env.HIPPO_TIER1_MODEL; delete process.env.HIPPO_FREE_AI_DAILY_CAP_INR; delete process.env.HIPPO_MAX_CALL_INR; });

const req = (body: unknown = {}, headers: Record<string, string> = {}) => new Request('http://hippo.test/api', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function json(p: Promise<Response> | Response) { const r = await p; return { status: r.status, body: await r.json().catch(() => ({})) }; }
let ipSeq = 0;
const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}-${Date.now()}`;

describe.skipIf(!E2E)('AI usage ledger + endpoint protection (real Postgres)', () => {
  beforeEach(async () => {
    const { clearPriceCache, clearSpendCache } = await import('@/lib/ai-usage');
    clearPriceCache(); clearSpendCache();
    delete process.env.HIPPO_TIER1_MODEL; delete process.env.HIPPO_FREE_AI_DAILY_CAP_INR; delete process.env.HIPPO_MAX_CALL_INR;
  });

  it('every model and search call of a full journey is in AiUsage, priced per model, attributed and classified by purpose', async () => {
    const { db } = await import('@/lib/db');
    // A dearer model for tier 1 (explore) proves per-model pricing; the default model keeps the migrated price.
    await db.modelPrice.upsert({ where: { provider_model_effectiveFrom: { provider: 'gemini', model: 'gemini-premium-x', effectiveFrom: new Date('2026-01-01') } }, update: {}, create: { provider: 'gemini', model: 'gemini-premium-x', inputUsdPerMTok: 2.5, outputUsdPerMTok: 15, cachedInputUsdPerMTok: 0.625, effectiveFrom: new Date('2026-01-01'), source: 'fixture' } });
    process.env.HIPPO_TIER1_MODEL = 'gemini:gemini-premium-x';
    const r = {
      objectives: await import('@/app/api/hippo/objectives/route'), explore: await import('@/app/api/hippo/explore/route'), scope: await import('@/app/api/audits/[id]/scope/route'),
      order: await import('@/app/api/payments/create-order/route'), verify: await import('@/app/api/payments/verify/route'),
    };
    const since = new Date();
    const before = { ...providerCalls };
    jar = new Map();
    const ip = { 'x-real-ip': freshIp() };

    const created = await json(r.objectives.POST(req({ text: IDEA }, ip)));
    expect(created.status).toBe(200);
    const { objectiveId, auditId } = created.body;
    expect((await json(r.scope.POST(req({ action: 'classify' }, ip), ctx(auditId)))).status).toBe(200);
    const sug = await json(r.scope.POST(req({ action: 'suggest' }), ctx(auditId)));
    expect((await json(r.scope.POST(req({ action: 'confirm', scope: 'GROWTH_PLAN', facts: sug.body.facts, factsReviewed: true }), ctx(auditId)))).status).toBe(200);
    expect((await json(r.order.POST(req({ auditId })))).body.demo).toBe(true);
    expect((await json(r.verify.POST(req({ auditId, demo: true })))).status).toBe(200);
    expect((await json(r.explore.POST(req({ about: 'I cook well, have ₹10K and two free hours a day.' }, ip)))).status).toBe(200);

    // AI work execution (WORK purpose), on the same objective.
    const objective = await db.objective.findUniqueOrThrow({ where: { id: objectiveId } });
    const work = await db.work.create({ data: { organizationId: objective.organizationId, objectiveId, title: 'Create a pharmacy go-to-market plan', description: 'd', deliverable: 'GTM plan', capability: 'marketing', status: 'APPROVED', executionMode: 'AI' } });
    await db.workBrief.create({ data: { workId: work.id, objective: 'o', deliverable: 'd', inputs: [], constraints: {}, successCriteria: ['c'], expectedOutput: 'md', outOfScope: [], effort: {} } });
    const { executeWork } = await import('@/lib/hippo/service');
    await executeWork({ work, objective });

    const rows = await db.aiUsage.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
    const made = { gemini: providerCalls.gemini - before.gemini, tavily: providerCalls.tavily - before.tavily };
    // 1 + 2: nothing escapes the ledger.
    expect(rows.filter((x: { provider: string }) => x.provider === 'gemini')).toHaveLength(made.gemini);
    expect(rows.filter((x: { kind: string }) => x.kind === 'SEARCH')).toHaveLength(made.tavily);
    expect(made.tavily).toBe(4);
    const tasks = rows.map((x: { task: string }) => x.task);
    for (const t of ['understand', 'scope-classifier', 'research-plan', 'research-search', 'research-extract', 'decision', 'explore', 'execute']) expect([t, tasks.includes(t)]).toEqual([t, true]);
    const purposeOf = Object.fromEntries(rows.map((x: { task: string; purpose: string }) => [x.task, x.purpose]));
    expect(purposeOf).toMatchObject({ understand: 'ARISTOTLE', 'scope-classifier': 'ARISTOTLE', 'research-plan': 'RESEARCH', 'research-search': 'RESEARCH', 'research-extract': 'RESEARCH', decision: 'ARISTOTLE', explore: 'OPPORTUNITY', execute: 'WORK' });

    // 3: rupee cost per actual model. Default model: migrated $0.20/$1.20; explore ran on the dearer tier-1 model.
    const cost = (inP: number, cachedP: number, outP: number) => ((1000 - 100) * inP + 100 * cachedP + (200 + 50) * outP) / 1e6 * 88;
    const decision = rows.find((x: { task: string }) => x.task === 'decision')!;
    expect(decision).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite', priceSource: 'MODEL_PRICE', inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cachedTokens: 100, outcome: 'OK', usdInr: 88 });
    expect(decision.costInr).toBeCloseTo(cost(0.2, 0.2, 1.2), 4);
    const explore = rows.find((x: { task: string }) => x.task === 'explore')!;
    expect(explore).toMatchObject({ model: 'gemini-premium-x', tier: 1, priceSource: 'MODEL_PRICE' });
    expect(explore.costInr).toBeCloseTo(cost(2.5, 0.625, 15), 4);
    expect(geminiModels).toContain('gemini-premium-x');
    const search = rows.find((x: { kind: string }) => x.kind === 'SEARCH')!;
    expect(search).toMatchObject({ provider: 'tavily', model: 'search', searchCalls: 1, searchCredits: 2, priceSource: 'MODEL_PRICE' });
    expect(search.costInr).toBeCloseTo(2 * 0.008 * 88, 4);

    // Attribution: the audit's calls carry the audit + its owner; Hippo calls carry the objective / work.
    const audit = await db.audit.findUniqueOrThrow({ where: { id: auditId } });
    for (const t of ['research-plan', 'research-search', 'research-extract', 'decision']) {
      for (const x of rows.filter((y: { task: string }) => y.task === t)) expect([t, x.auditId, x.userId, x.parentType]).toEqual([t, auditId, audit.userId, 'AUDIT']);
    }
    expect(rows.find((x: { task: string }) => x.task === 'scope-classifier')).toMatchObject({ auditId, userId: audit.userId });
    expect(rows.find((x: { task: string }) => x.task === 'understand')).toMatchObject({ objectiveId, organizationId: objective.organizationId, userId: audit.userId });
    expect(rows.find((x: { task: string }) => x.task === 'execute')).toMatchObject({ workId: work.id, objectiveId, parentType: 'WORK' });
    expect(rows.find((x: { task: string }) => x.task === 'explore')).toMatchObject({ userId: audit.userId });

    // 6: Aristotle behaviour unchanged — the report is produced and stored exactly as before.
    expect(audit.status).toBe('completed');
    expect(JSON.parse(audit.report).verdict).toBeTruthy();
    // The execution's recorded actual cost is the ledger's per-model cost.
    const exec = await db.execution.findFirstOrThrow({ where: { workId: work.id } });
    expect(exec.costInr).toBeCloseTo(Math.round(rows.find((x: { task: string }) => x.task === 'execute')!.costInr * 100) / 100, 2);
  });

  it('failed, timed-out and refused calls are recorded too; an unpriced model is flagged, not priced as another model', async () => {
    const { db } = await import('@/lib/db');
    const { generateJson } = await import('@/lib/hippo/gateway');
    const { tavilySearch } = await import('@/lib/research');
    const since = new Date();
    failNext = 'http';
    await expect(generateJson('compare', 'x', {}, {}, { parentType: 'REQUEST' })).rejects.toThrow(/GEMINI_ERROR/);
    failNext = 'timeout';
    await expect(generateJson('compare', 'x', {}, {}, { parentType: 'REQUEST' })).rejects.toThrow(/timed out/);
    tavilyDown = true;
    await expect(tavilySearch('q', { deep: false, timeoutMs: 5000 })).rejects.toThrow(/TAVILY_ERROR 500/);
    tavilyDown = false;
    process.env.HIPPO_TIER0_MODEL = 'gemini:gemini-never-priced';
    await generateJson('compare', 'Compare this quote.', {}, {}, { parentType: 'REQUEST' });
    delete process.env.HIPPO_TIER0_MODEL;
    process.env.HIPPO_MAX_CALL_INR = '0.0001';
    const callsBefore = providerCalls.gemini;
    await expect(generateJson('execute', 'x'.repeat(1000), {}, {}, { parentType: 'REQUEST' })).rejects.toThrow(/AI_BUDGET_EXCEEDED/);
    expect(providerCalls.gemini).toBe(callsBefore); // refused BEFORE any provider call
    const rows = await db.aiUsage.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((x: { task: string; outcome: string; costInr: number }) => [x.task, x.outcome, x.costInr])).toEqual([
      ['compare', 'ERROR', 0], ['compare', 'TIMEOUT', 0], ['research-search', 'ERROR', 0], ['compare', 'OK', expect.any(Number)], ['execute', 'REFUSED_BUDGET', 0],
    ]);
    expect(rows[3]).toMatchObject({ model: 'gemini-never-priced', priceSource: 'UNPRICED_FALLBACK' });
    expect(rows[4].estimatedInr).toBeGreaterThan(0.0001);
  });

  it('4 + 5: explore is protected — cross-site refused, per-user and per-IP limits, platform free-tier cap', async () => {
    const { db } = await import('@/lib/db');
    const { POST } = await import('@/app/api/hippo/explore/route');
    const about = { about: 'I am good at baking and have weekends free.' };
    // Cross-site browser request: refused before any AI call or account creation.
    jar = new Map();
    const calls0 = providerCalls.gemini; const users0 = await db.user.count();
    expect((await json(POST(req(about, { origin: 'https://evil.example', host: 'hippo.test', 'x-real-ip': freshIp() })))).status).toBe(403);
    expect(providerCalls.gemini).toBe(calls0);
    expect(await db.user.count()).toBe(users0);
    // A first-time visitor is given a session (every call is attributable); the 11th call in an hour is refused.
    jar = new Map();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await json(POST(req(about, { 'x-real-ip': ip })))).status).toBe(200);
    expect(jar.size).toBe(1);
    const limited = await json(POST(req(about, { 'x-real-ip': ip })));
    expect(limited.status).toBe(429);
    expect(providerCalls.gemini).toBe(calls0 + 10);
    // One IP cannot mint guest accounts to get around the per-user limit.
    const shared = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) { jar = new Map(); statuses.push((await json(POST(req(about, { 'x-real-ip': shared })))).status); }
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
    // Platform cap reached → free AI is refused (recorded), objective creation still works without AI.
    process.env.HIPPO_FREE_AI_DAILY_CAP_INR = '0';
    const { clearSpendCache } = await import('@/lib/ai-usage'); clearSpendCache();
    jar = new Map();
    const capped = await json(POST(req(about, { 'x-real-ip': freshIp() })));
    expect(capped.status).toBe(503);
    expect(capped.body.error).toMatch(/busy/);
    expect(await db.aiUsage.count({ where: { task: 'explore', outcome: 'REFUSED_BUDGET' } })).toBeGreaterThan(0);
    const { POST: createObjective } = await import('@/app/api/hippo/objectives/route');
    const o = await json(createObjective(req({ text: IDEA }, { 'x-real-ip': freshIp() })));
    expect(o.status).toBe(200);
    expect(o.body.understanding.source).toBe('FOUNDER_NUMBERS'); // fell back to the founder's own numbers, no AI spend
  });
});
