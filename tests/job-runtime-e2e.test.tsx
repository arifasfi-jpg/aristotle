// Phase 2 — durable job runtime on REAL PostgreSQL. Real routes, real job runtime, real gateway + cost governor + ledger;
// only Gemini/Tavily HTTP and the cookie jar are faked. Tests A–Z plus the two critical tests (worker death mid-audit,
// four concurrent workers on one finite budget). Skipped without the HIPPO_E2E_* database env.
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
const razorpay = { constructed: 0 };
vi.mock('razorpay', () => ({ default: class { constructor() { razorpay.constructed++; } orders = { create: async () => ({}), fetch: async () => ({}), fetchPayments: async () => ({ items: [] }) }; } }));

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const IDEA = 'We sell about 1,400 glucometers a month through IndiaMART and pharmacies in Pune and want to reach 10,000 units a month.';
const PLAN = { businessModel: { summary: 'Glucometers via pharmacies', customer: 'Diabetics', payer: 'Patients', offering: 'Glucometers', revenueMechanism: 'Unit sales', keyActivities: ['Distribution'], regulatedActivities: [] },
  questions: ['where buy glucometers india pharmacy', 'indiamart glucometer buyers', 'glucometer distributor margin', 'home glucose testing india'].map((query, i) => ({ category: ['CHANNEL', 'CHANNEL', 'COST', 'DEMAND'][i], question: `Question ${i + 1}: ${query}?`, whyItMatters: 'x', query })) };
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50, cachedContentTokenCount: 100 };
const calls: string[] = [];
let tavilyHang = false;
let engineGate: Promise<void> | null = null;
let geminiDelayMs = 0;
let geminiFail: null | 'http503' = null;
const env = { ...process.env };

function kind(prompt: string) {
  return prompt.includes('Restate what this founder') ? 'understand' : prompt.includes('Classify this request for Aristotle') ? 'classify' : prompt.includes('research planner') ? 'plan'
    : prompt.includes('You extract evidence') ? 'extract' : prompt.startsWith('COMPARE') ? 'compare' : 'decision';
}
beforeAll(() => {
  Object.assign(process.env, { HIPPO_USAGE_LEDGER: 'on', GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', DEMO_MODE: 'true', VERCEL_ENV: 'preview', GEMINI_MODEL: 'gemini-3.5-flash-lite', USD_INR: '88', CRON_SECRET: 'cron-secret-for-tests-0123456789' });
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.HIPPO_AI_PROVIDER; delete process.env.HIPPO_TIER0_MODEL; delete process.env.HIPPO_TIER1_MODEL;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (String(url).includes('tavily')) {
      calls.push('search');
      if (tavilyHang) return new Promise<Response>(() => undefined); // the worker making this call "dies" here
      const hit = body.query.includes('pharmacy') ? [{ title: 'Pharmacy report', url: 'https://example.org/pharmacy', content: 'Retail chemists remain the main point of purchase for home glucose monitoring devices.' }] : [];
      return new Response(JSON.stringify({ results: hit }), { status: 200 });
    }
    const prompt: string = body.contents[0].parts[0].text;
    const k = kind(prompt);
    if (engineGate && k !== 'understand' && k !== 'classify') await engineGate;
    if (geminiDelayMs) await new Promise((r) => setTimeout(r, geminiDelayMs));
    calls.push(k);
    if (geminiFail === 'http503') return new Response('overloaded', { status: 503 });
    let data: unknown;
    if (k === 'understand') data = { objective: 'Grow to 10,000 units', target: '10,000 units/month', currentState: '1,400 units/month', keyQuestion: 'Which channels?', businessKind: 'EXISTING_BUSINESS' };
    else if (k === 'classify') data = { scope: 'GROWTH_PLAN', confidence: 0.9, reason: 'Existing sales' };
    else if (k === 'plan') data = PLAN;
    else if (k === 'extract') data = prompt.includes('Question 1:') ? { status: 'ANSWERED', findings: [{ statement: 'Chemists are the main purchase point.', sourceId: 'S1', quote: 'Retail chemists remain the main point of purchase', confidence: 'MEDIUM' }] } : { status: 'NOT_FOUND', findings: [] };
    else if (k === 'compare') data = { ok: true };
    else { const { deterministicAudit } = await import('@/lib/audit'); data = { ...deterministicAudit({ idea: IDEA, sector: 'Healthtech' }), unitEconomics: [] }; }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: k === 'compare' ? { promptTokenCount: 10_000, candidatesTokenCount: 2_000, thoughtsTokenCount: 1_000 } : USAGE }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); process.env = { ...env }; });

const post = (b: unknown, h: Record<string, string> = {}) => new Request('http://hippo.test/api', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const count = (k: string) => calls.filter((c) => c === k).length;
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mods() {
  const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const jobs = await import('@/lib/jobs');
  return { db, jobs };
}
/** Objective → scope confirmed → ₹99 demo order. Returns the payable audit (not yet paid). */
async function payableAudit() {
  jar = new Map();
  const objectives = await import('@/app/api/hippo/objectives/route');
  const scope = await import('@/app/api/audits/[id]/scope/route');
  const order = await import('@/app/api/payments/create-order/route');
  const created = await (await objectives.POST(post({ text: IDEA }, { 'x-real-ip': `203.0.113.${Math.floor(Math.random() * 250) + 1}` }))).json();
  const sug = await (await scope.POST(post({ action: 'suggest' }), ctx(created.auditId))).json();
  await scope.POST(post({ action: 'confirm', scope: 'GROWTH_PLAN', facts: sug.facts, factsReviewed: true }), ctx(created.auditId));
  await order.POST(post({ auditId: created.auditId }));
  return created.auditId as string;
}
const verifyRoute = async () => (await import('@/app/api/payments/verify/route')).POST;

// A test-only job type: deterministic steps whose behaviour each test chooses. Uses the real runtime and gateway.
const behaviour = new Map<string, (job: Row, n: number) => Promise<Row>>();
const stepsRun = new Map<string, number>();
async function testJob(o: { userId?: string; budgetInr?: number; scopeId?: string; maxAttempts?: number; run: (job: Row, n: number) => Promise<Row> }) {
  const { db, jobs } = await mods();
  if (!behaviour.size) {
    jobs.registerJobHandler('TEST_STEPS', {
      minStepMs: () => 0,
      policy: (job) => ({ scope: { type: 'JOB', id: job.budgetScopeId }, includedInr: job.budgetInr, warningInr: job.budgetInr * 0.9, nearLimitInr: job.budgetInr * 0.95, perCallInr: 25 }),
      step: async ({ job }) => { const n = (stepsRun.get(job.id) ?? 0) + 1; stepsRun.set(job.id, n); return behaviour.get(job.id)!(job, n) as never; },
    });
  }
  const userId = o.userId ?? (await db.user.create({ data: {} })).id;
  const subjectId = uid();
  const { job } = await jobs.enqueueJob({ type: 'TEST_STEPS', userId, subjectType: 'TEST', subjectId, budgetScope: { type: 'JOB', id: o.scopeId ?? subjectId }, budgetInr: o.budgetInr ?? 50, maxAttempts: o.maxAttempts });
  behaviour.set(job.id, o.run);
  return job as Row;
}
/** One governed model call charged to the job's budget scope (what a real step does). */
async function governedCall(job: Row, prompt = `COMPARE ${'x'.repeat(12_000)}`, maxOutputTokens = 3000) {
  // A realistic call: the provider's reported usage (10k in, 3k out) is within the prompt length and output budget.
  const { generateJson } = await import('@/lib/hippo/gateway');
  const policy = { scope: { type: 'JOB' as const, id: job.budgetScopeId }, includedInr: job.budgetInr, warningInr: job.budgetInr * 0.9, nearLimitInr: job.budgetInr * 0.95, perCallInr: 25 };
  return generateJson('compare', prompt, {}, { maxOutputTokens }, { userId: job.userId, budget: policy });
}

describe.skipIf(!E2E)('Durable job runtime (real Postgres)', () => {
  beforeEach(async () => {
    const { clearPriceCache, clearSpendCache } = await import('@/lib/ai-usage');
    clearPriceCache(); clearSpendCache();
    tavilyHang = false; engineGate = null; geminiDelayMs = 0; geminiFail = null;
    delete process.env.HIPPO_JOB_LEASE_MS; delete process.env.HIPPO_RESERVATION_TTL_MS; delete process.env.HIPPO_JOB_RETRY_BASE_MS;
  });

  it('A. job creation is durable and idempotent per business object (concurrent enqueues → one row)', async () => {
    const { db, jobs } = await mods();
    const user = await db.user.create({ data: {} });
    const subjectId = uid();
    const input = { type: 'TEST_STEPS', userId: user.id, subjectType: 'TEST', subjectId, budgetScope: { type: 'JOB', id: subjectId }, budgetInr: 10 };
    const r = await Promise.all([1, 2, 3, 4, 5].map(() => jobs.enqueueJob(input)));
    expect(new Set(r.map((x) => x.job.id)).size).toBe(1);
    expect(r.filter((x) => x.created)).toHaveLength(1);
    expect(await db.job.count({ where: { dedupeKey: `TEST_STEPS:${subjectId}` } })).toBe(1);
    expect(r[0].job).toMatchObject({ status: 'QUEUED', progress: 'QUEUED', attempts: 0, userId: user.id, budgetInr: 10, leaseOwner: null });
  });

  it('C + D + E. safe claim: exactly one of eight concurrent workers wins; the lease blocks others until it expires; a reclaim counts as an attempt', async () => {
    const { db, jobs } = await mods();
    const job = await testJob({ run: async () => ({ done: true }) });
    const claims = await Promise.all([...Array(8)].map((_, i) => jobs.claimJob(job.id, `worker-${i}`)));
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    const owner = winners[0]!.leaseOwner!;
    expect(await jobs.claimJob(job.id, 'late-worker')).toBeNull(); // lease still valid
    // E: the owner dies; its lease expires; another worker reclaims (attempt counted) and the dead owner is locked out.
    await db.job.update({ where: { id: job.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const reclaimed = await jobs.claimJob(job.id, 'rescuer');
    expect(reclaimed).toMatchObject({ status: 'RUNNING', leaseOwner: 'rescuer', attempts: 1 });
    await expect(jobs.renewLease(job as never, owner)).rejects.toThrow(/JOB_LEASE_LOST/);
    expect(await jobs.claimJob(job.id, owner)).toBeNull();
  });

  it('CRITICAL: worker dies mid-audit after the plan checkpoint → a second worker resumes; the plan is not repeated; report, AiUsage and cost are correct, nothing duplicated', async () => {
    const { db, jobs } = await mods();
    process.env.HIPPO_JOB_LEASE_MS = '1500'; process.env.HIPPO_RESERVATION_TTL_MS = '1500';
    const auditId = await payableAudit();
    const audit = await db.audit.update({ where: { id: auditId }, data: { paymentStatus: 'paid', status: 'generating' } });
    const { job } = await jobs.enqueueJob({ type: jobs.AUDIT_JOB, userId: audit.userId, subjectType: 'AUDIT', subjectId: auditId, budgetScope: { type: 'AUDIT', id: auditId }, budgetInr: 76 });
    const before = calls.length;
    // Worker 1: plans (checkpoint), then every search hangs forever — the process is gone.
    tavilyHang = true;
    void jobs.runJob(job.id, { workerId: 'worker-1' });
    for (let i = 0; i < 100 && calls.slice(before).filter((c) => c === 'search').length < 4; i++) await sleep(20);
    const mid = await db.job.findUnique({ where: { id: job.id } });
    expect(mid).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-1', checkpoint: 'PLANNED', progress: 'RESEARCHING' });
    expect(JSON.parse((await db.projectFile.findFirst({ where: { auditId, path: 'research.json' } })).content)).toMatchObject({ stage: 'PLANNED' });
    // Worker 2 after the lease expired.
    tavilyHang = false;
    expect(await jobs.runJob(job.id, { workerId: 'worker-2' })).toMatchObject({ status: 'NOT_CLAIMED' }); // too early
    await sleep(1700);
    const r = await jobs.runJob(job.id, { workerId: 'worker-2' });
    expect(r).toMatchObject({ status: 'COMPLETED', steps: 3 }); // RESEARCH → DECIDE → SAVE (PLAN not repeated)
    const made = calls.slice(before);
    expect(made.filter((c) => c === 'plan')).toHaveLength(1);
    expect(made.filter((c) => c === 'decision')).toHaveLength(1);
    expect(made.filter((c) => c === 'search')).toHaveLength(8); // 4 lost with worker 1 + 4 by worker 2
    const done = await db.job.findUnique({ where: { id: job.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', progress: 'COMPLETED', attempts: 1, leaseOwner: null });
    const a = await db.audit.findUnique({ where: { id: auditId } });
    expect(a.status).toBe('completed');
    expect(JSON.parse(a.report).verdict).toBeTruthy();
    // No duplicate findings / outputs.
    const research = JSON.parse((await db.projectFile.findFirst({ where: { auditId, path: 'research.json' } })).content);
    expect(research.stage).toBeUndefined();
    expect(research.questions).toHaveLength(4);
    expect(new Set(research.findings.map((f: Row) => f.id)).size).toBe(research.findings.length);
    expect(research.findings).toHaveLength(1);
    expect(await db.projectFile.count({ where: { auditId, path: { in: ['audit.json', 'research.json', 'README.md'] } } })).toBe(3);
    // AiUsage: one row per call made; the lost searches are booked at their worst case (the dead worker never recorded them).
    const rows = await db.aiUsage.findMany({ where: { parentType: 'AUDIT', parentId: auditId } });
    const by = (task: string, outcome: string) => rows.filter((x: Row) => x.task === task && x.outcome === outcome).length;
    expect([by('research-plan', 'SUCCESS'), by('research-search', 'SUCCESS'), by('research-search', 'UNKNOWN_PROVIDER_OUTCOME'), by('decision', 'SUCCESS')]).toEqual([1, 4, 4, 1]);
    expect(rows.filter((x: Row) => x.outcome === 'UNKNOWN_PROVIDER_OUTCOME').every((x: Row) => x.costStatus === 'ESTIMATED' && Math.abs(x.costInr - 1.408) < 1e-6)).toBe(true);
    expect(await db.costReservation.count({ where: { scopeType: 'AUDIT', scopeId: auditId, releasedAt: null } })).toBe(0);
    // Total cost = ledger = audit compute = job cost.
    const total = rows.reduce((s: number, x: Row) => s + x.costInr, 0);
    expect(a.computePaise).toBe(Math.round(total * 100));
    expect(done.costInr).toBeCloseTo(total, 3);
  }, 20_000);

  it('Q + R + T + U. verification creates the job and returns before the AI work; the job completes the audit with the unchanged report format', async () => {
    const { db, jobs } = await mods();
    const auditId = await payableAudit();
    let open!: () => void;
    engineGate = new Promise<void>((r) => { open = r; });
    const before = calls.length;
    const res = await (await verifyRoute())(post({ auditId, demo: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, queued: true, jobId: expect.any(String) });
    // R: the response came back while no AI step had finished: the report does not exist yet.
    expect(calls.slice(before).filter((c) => ['plan', 'search', 'extract', 'decision'].includes(c))).toEqual([]);
    expect((await db.audit.findUnique({ where: { id: auditId } }))).toMatchObject({ paymentStatus: 'paid', status: 'generating', report: '{}' });
    // Q: the durable job.
    const job = await db.job.findUnique({ where: { id: body.jobId } });
    expect(job).toMatchObject({ type: 'ARISTOTLE_AUDIT', subjectType: 'AUDIT', subjectId: auditId, dedupeKey: `ARISTOTLE_AUDIT:${auditId}`, budgetScopeType: 'AUDIT', budgetScopeId: auditId, budgetInr: 76 });
    open(); engineGate = null;
    await jobs.settleDetached();
    const a = await db.audit.findUnique({ where: { id: auditId } });
    expect(a.status).toBe('completed');
    expect(await db.job.findUnique({ where: { id: body.jobId } })).toMatchObject({ status: 'COMPLETED', progress: 'COMPLETED', checkpoint: 'DECIDED' });
    // U: the stored report is exactly what the unchanged engine produces for this input; bundle shape unchanged.
    const { runAudit } = await import('@/lib/ai');
    const { getLockedFacts } = await import('@/lib/audit-meta');
    const research = JSON.parse((await db.projectFile.findFirst({ where: { auditId, path: 'research.json' } })).content);
    const direct = await runAudit({ idea: a.idea, sector: a.sector, stage: a.stage || undefined, geography: a.geography || 'India', language: a.reportLanguage, scope: 'GROWTH_PLAN', founderFacts: await getLockedFacts(auditId) }, { existingResearch: research });
    expect(JSON.parse(a.report)).toEqual(JSON.parse(JSON.stringify(direct.report)));
    const bundle = JSON.parse((await db.projectFile.findFirst({ where: { auditId, path: 'audit.json' } })).content);
    expect(Object.keys(bundle)).toEqual(['auditId', 'idea', 'sector', 'scope', 'founderFacts', 'report', 'pricing']);
    expect(bundle.pricing).toEqual({ computeInr: a.computePaise / 100, marginInr: a.marginPaise / 100, source: 'AI_USAGE_LEDGER', platformMargin: '10% of disclosed compute' });
    // J: a repeat verify never regenerates and never creates a second job.
    expect(await (await (await verifyRoute())(post({ auditId }))).json()).toMatchObject({ alreadyGenerated: true });
    expect(await db.job.count({ where: { subjectId: auditId } })).toBe(1);
    expect(razorpay.constructed).toBe(0);
  });

  it('S + Y. the protected worker endpoint runs a queued paid audit to completion; without the secret nothing runs', async () => {
    const { db, jobs } = await mods();
    const { GET } = await import('@/app/api/jobs/run/route');
    const auditId = await payableAudit();
    const audit = await db.audit.update({ where: { id: auditId }, data: { paymentStatus: 'paid', status: 'generating' } });
    const { job } = await jobs.enqueueJob({ type: jobs.AUDIT_JOB, userId: audit.userId, subjectType: 'AUDIT', subjectId: auditId, budgetScope: { type: 'AUDIT', id: auditId }, budgetInr: 76 });
    const before = calls.length;
    for (const h of [{}, { authorization: 'Bearer wrong-secret-wrong-secret-xx' }, { authorization: 'cron-secret-for-tests-0123456789' }] as Record<string, string>[]) {
      expect((await GET(new Request('http://hippo.test/api/jobs/run', { headers: h }))).status).toBe(401);
    }
    const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
    expect((await GET(new Request('http://hippo.test/api/jobs/run', { headers: { authorization: 'Bearer undefined' } }))).status).toBe(401);
    process.env.CRON_SECRET = saved;
    expect(calls.length).toBe(before);
    expect((await db.job.findUnique({ where: { id: job.id } })).status).toBe('QUEUED');
    // Other tests may leave runnable jobs; run passes until this one is done (each pass is bounded).
    for (let i = 0; i < 5 && (await db.job.findUnique({ where: { id: job.id } })).status !== 'COMPLETED'; i++) {
      const res = await GET(new Request('http://hippo.test/api/jobs/run', { headers: { authorization: 'Bearer cron-secret-for-tests-0123456789' } }));
      expect(res.status).toBe(200);
    }
    expect(await db.job.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'COMPLETED' });
    expect((await db.audit.findUnique({ where: { id: auditId } })).status).toBe('completed');
  }, 20_000);

  it('B + W + X. status/cancel are owner-only; a job never works on another tenant’s audit', async () => {
    const { db, jobs } = await mods();
    const { GET: status } = await import('@/app/api/jobs/[id]/route');
    const { POST: cancel } = await import('@/app/api/jobs/[id]/cancel/route');
    const { createSession } = await import('@/lib/session');
    const owner = await db.user.create({ data: {} });
    const other = await db.user.create({ data: {} });
    const job = await testJob({ userId: owner.id, run: async () => ({ done: true }) });
    jar = new Map();
    expect((await status(new Request('http://x'), ctx(job.id))).status).toBe(401);           // X: no session
    expect((await cancel(post({}), ctx(job.id))).status).toBe(401);
    await createSession(other.id);
    expect((await status(new Request('http://x'), ctx(job.id))).status).toBe(404);           // B: id alone grants nothing
    expect((await cancel(post({}), ctx(job.id))).status).toBe(404);
    expect((await db.job.findUnique({ where: { id: job.id } })).status).toBe('QUEUED');
    jar = new Map(); await createSession(owner.id);
    const view = await (await status(new Request('http://x'), ctx(job.id))).json();
    expect(view).toMatchObject({ id: job.id, status: 'QUEUED', progress: 'QUEUED', attempts: 0, cost: { budgetInr: 50, spentInr: 0, reservedInr: 0, remainingInr: 50, state: 'COST_OK' } });
    // W: a job whose owner does not own the audit fails permanently without any AI call.
    const auditId = await payableAudit();
    await db.audit.update({ where: { id: auditId }, data: { paymentStatus: 'paid' } });
    const { job: stolen } = await jobs.enqueueJob({ type: jobs.AUDIT_JOB, userId: other.id, subjectType: 'AUDIT', subjectId: auditId, budgetScope: { type: 'AUDIT', id: auditId }, budgetInr: 76 });
    const before = calls.length;
    expect(await jobs.runJob(stolen.id)).toMatchObject({ status: 'FAILED' });
    expect(calls.length).toBe(before);
    expect((await db.job.findUnique({ where: { id: stolen.id } })).lastError).toMatch(/JOB_INVALID: audit not found for this job owner/);
    expect((await db.audit.findUnique({ where: { id: auditId } })).report).toBe('{}');
  });

  it('G + H + I. checkpoints are durable; a resumed job continues after the last checkpoint and completed steps are not repeated', async () => {
    const { db, jobs } = await mods();
    const job = await testJob({ run: async (j, n) => (n === 1 ? { checkpoint: 'ONE', progress: 'RESEARCHING', state: { one: 'result-1' } } : n === 2 ? (() => { throw new Error('GEMINI_ERROR (x): HTTP 503'); })() : { done: true }) });
    process.env.HIPPO_JOB_RETRY_BASE_MS = '1';
    expect(await jobs.runJob(job.id)).toMatchObject({ status: 'QUEUED', steps: 1 });
    expect(await db.job.findUnique({ where: { id: job.id } })).toMatchObject({ checkpoint: 'ONE', progress: 'RESEARCHING', state: { one: 'result-1' }, attempts: 1 });
    await sleep(5);
    // The handler resumes from checkpoint ONE (it is told the job, including its checkpoint and state).
    behaviour.set(job.id, async (j, n) => { expect([j.checkpoint, j.state]).toEqual(['ONE', { one: 'result-1' }]); return n === 3 ? { done: true } : { done: true }; });
    expect(await jobs.runJob(job.id)).toMatchObject({ status: 'COMPLETED', steps: 1 });
    expect(stepsRun.get(job.id)).toBe(3); // step 1 once, failed step 2 once, resumed step once — never step 1 again
  });

  it('K + L. transient failures retry with bounded attempts and back-off; permanent failures fail at once', async () => {
    const { db, jobs } = await mods();
    process.env.HIPPO_JOB_RETRY_BASE_MS = '60000';
    const flaky = await testJob({ maxAttempts: 2, run: async () => { throw new Error('TAVILY_TIMEOUT after 15s'); } });
    expect(await jobs.runJob(flaky.id)).toMatchObject({ status: 'QUEUED' });
    const j1 = await db.job.findUnique({ where: { id: flaky.id } });
    expect(j1).toMatchObject({ attempts: 1, lastError: 'TAVILY_TIMEOUT after 15s', leaseOwner: null });
    expect(j1.runAfter.getTime()).toBeGreaterThan(Date.now() + 50_000); // back-off
    expect(await jobs.claimJob(flaky.id, 'eager')).toBeNull();            // not before runAfter
    await db.job.update({ where: { id: flaky.id }, data: { runAfter: new Date() } });
    expect(await jobs.runJob(flaky.id)).toMatchObject({ status: 'FAILED' }); // attempts exhausted (2/2)
    expect(await db.job.findUnique({ where: { id: flaky.id } })).toMatchObject({ status: 'FAILED', attempts: 2, completedAt: expect.any(Date) });
    const broken = await testJob({ run: async () => { throw new Error('AI_ENGINE_NOT_CONFIGURED: GEMINI_API_KEY is missing'); } });
    expect(await jobs.runJob(broken.id)).toMatchObject({ status: 'FAILED' });
    expect(await db.job.findUnique({ where: { id: broken.id } })).toMatchObject({ attempts: 0 });
    expect(stepsRun.get(broken.id)).toBe(1);
  });

  it('M + N + P. cumulative cost is the ledger; a refused call parks the job WAITING; no step starts once the limit is reached; reservations are released', async () => {
    const { db, jobs } = await mods();
    const job = await testJob({ budgetInr: 3, run: async (j, n) => { await governedCall(j); return n < 5 ? { checkpoint: `CALL${n}`, progress: 'ANALYSING' } : { done: true }; } });
    const before = count('compare');
    const r = await jobs.runJob(job.id);
    expect(r.status).toBe('WAITING');
    const fresh = await db.job.findUnique({ where: { id: job.id } });
    expect(fresh.waitingReason).toBe('COST_LIMIT_REACHED');
    expect(fresh.lastError).toMatch(/AI_BUDGET_EXCEEDED: REFUSE \[/);
    const rows = await db.aiUsage.findMany({ where: { parentType: 'JOB', parentId: job.budgetScopeId } });
    const spent = rows.reduce((s: number, x: Row) => s + x.costInr, 0);
    expect(spent).toBeLessThanOrEqual(3);
    expect(rows.filter((x: Row) => x.outcome === 'SUCCESS')).toHaveLength(count('compare') - before);
    expect(rows.filter((x: Row) => x.outcome === 'REFUSED_BUDGET')).toHaveLength(1);
    expect(fresh.costInr).toBeCloseTo(spent, 4); // N
    expect(await db.costReservation.count({ where: { scopeType: 'JOB', scopeId: job.budgetScopeId, releasedAt: null } })).toBe(0); // P
    expect(await db.costReservation.count({ where: { scopeType: 'JOB', scopeId: job.budgetScopeId } })).toBe(count('compare') - before);
    // Hard limit reached before a step: the worker does not start it (no call, no reservation).
    const full = await testJob({ budgetInr: 1, run: async (j) => { await governedCall(j); return { done: true }; } });
    await db.aiUsage.create({ data: { kind: 'MODEL', purpose: 'WORK', task: 'seed', provider: 'gemini', model: 'gemini-3.5-flash-lite', costInr: 1, costStatus: 'ACTUAL', priceSource: 'VERIFIED_PRICE', usdInr: 88, durationMs: 0, outcome: 'SUCCESS', parentType: 'JOB', parentId: full.budgetScopeId } });
    const c0 = calls.length;
    expect(await jobs.runJob(full.id)).toMatchObject({ status: 'WAITING', steps: 0 });
    expect(await db.job.findUnique({ where: { id: full.id } })).toMatchObject({ waitingReason: 'COST_LIMIT_REACHED' });
    expect(calls.length).toBe(c0);
    expect(stepsRun.get(full.id)).toBeUndefined(); // the step itself was never started
    expect(await db.aiUsage.count({ where: { parentType: 'JOB', parentId: full.budgetScopeId, outcome: 'REFUSED_BUDGET' } })).toBe(0);
  });

  it('CRITICAL: four concurrent workers on jobs sharing one finite budget cannot overspend it (Postgres reservations)', async () => {
    const { db, jobs } = await mods();
    const { modelCallEstimate, priceFor } = await import('@/lib/ai-usage');
    const worst = modelCallEstimate(`COMPARE ${'x'.repeat(12_000)}`.length + 2, 3000, await priceFor('gemini', 'gemini-3.5-flash-lite')).worstInr;
    const scopeId = `shared-${uid()}`;
    const limit = Math.round(worst * 2.5 * 10_000) / 10_000; // room for two worst cases, not three
    geminiDelayMs = 150; // all four calls overlap in time
    const four: Row[] = [];
    for (let i = 0; i < 4; i++) four.push(await testJob({ scopeId, budgetInr: limit, run: async (j) => { await governedCall(j); return { done: true }; } }));
    const before = count('compare');
    const results = await Promise.all(four.map((j, i) => jobs.runJob(j.id, { workerId: `concurrent-${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual(['COMPLETED', 'COMPLETED', 'WAITING', 'WAITING']);
    expect(count('compare') - before).toBe(2);
    const spent = (await db.aiUsage.aggregate({ _sum: { costInr: true }, where: { parentType: 'JOB', parentId: scopeId } }))._sum.costInr;
    expect(spent).toBeLessThanOrEqual(limit);
    expect(await db.costReservation.count({ where: { scopeType: 'JOB', scopeId, releasedAt: null } })).toBe(0);
    // The same guarantee one level down: 4 simultaneous reservation transactions on one scope.
    const { reserveBudget } = await import('@/lib/ai-usage');
    const scope2 = { type: 'JOB', id: `raw-${uid()}` };
    const spec = { kind: 'MODEL' as const, purpose: 'WORK' as const, task: 'compare', provider: 'gemini', model: 'gemini-3.5-flash-lite', priceId: null, priceStatus: 'VERIFIED_PRICE' as const };
    const raw = await Promise.all([1, 2, 3, 4].map(() => reserveBudget(scope2, 20, spec, {}, (s, r) => ({ allow: s + r + 20 <= 50, decision: s + r + 20 <= 50 }))));
    expect(raw.filter((x) => x.reservationId)).toHaveLength(2);
  }, 20_000);

  it('Z. database failure fails closed: no ungoverned billable call; the job retries later instead of waiting for money', async () => {
    const { db, jobs } = await mods();
    const job = await testJob({ run: async (j) => { await governedCall(j); return { done: true }; } });
    // Simulated database outage for the budget transaction (the ledger cannot be read or reserved).
    const own = Object.prototype.hasOwnProperty.call(db, '$transaction'); const orig = db.$transaction;
    db.$transaction = async () => { throw new Error('Connection terminated unexpectedly'); };
    const before = calls.length;
    expect(await jobs.runJob(job.id)).toMatchObject({ status: 'QUEUED' });
    if (own) db.$transaction = orig; else delete db.$transaction;
    expect(calls.length).toBe(before);
    const fresh = await db.job.findUnique({ where: { id: job.id } });
    expect(fresh.lastError).toMatch(/budget ledger unavailable: Connection terminated/);
    expect(fresh).toMatchObject({ attempts: 1, waitingReason: null });
    expect(jobs.classifyJobError(new Error(fresh.lastError))).toBe('TRANSIENT');
  });

  it('cancellation: a running job finishes its current step and starts no other; a queued job stops at once; nothing is deleted', async () => {
    const { db, jobs } = await mods();
    const { POST: cancel } = await import('@/app/api/jobs/[id]/cancel/route');
    const { createSession } = await import('@/lib/session');
    const owner = await db.user.create({ data: {} });
    jar = new Map(); await createSession(owner.id);
    const job = await testJob({ userId: owner.id, run: async (j, n) => { await governedCall(j); if (n === 1) expect((await cancel(post({}), ctx(j.id))).status).toBe(200); return { checkpoint: `S${n}`, progress: 'ANALYSING' }; } });
    const cr = await jobs.runJob(job.id);
    expect([cr, (await db.job.findUnique({ where: { id: job.id } })).lastError]).toMatchObject([{ status: 'CANCELLED', steps: 1 }, null]);
    expect(stepsRun.get(job.id)).toBe(1);
    expect(await db.aiUsage.count({ where: { parentType: 'JOB', parentId: job.budgetScopeId } })).toBe(1); // spend kept
    const queued = await testJob({ userId: owner.id, run: async () => ({ done: true }) });
    expect(await (await cancel(post({}), ctx(queued.id))).json()).toMatchObject({ status: 'CANCELLED' });
    expect(await jobs.runJob(queued.id)).toMatchObject({ status: 'NOT_CLAIMED' });
  });
});
