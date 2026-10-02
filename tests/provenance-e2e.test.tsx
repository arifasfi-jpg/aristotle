// Exact case on REAL PostgreSQL: Aaira Books, Work 2 shows "₹99 digital pricing" as Known although the founder never
// stated ₹99 (it came from an Aristotle validation experiment). Only Gemini HTTP and cookies are faked. Skipped without DB env.
import { describe, expect, it, vi } from 'vitest';

const E2E = Boolean(process.env.HIPPO_E2E_DATABASE_URL && process.env.HIPPO_E2E_PRISMA_CLIENT && process.env.HIPPO_E2E_ADAPTER);
vi.mock('@/lib/db', async () => {
  if (!process.env.HIPPO_E2E_DATABASE_URL) return { db: {} };
  const { PrismaClient } = await import(/* @vite-ignore */ process.env.HIPPO_E2E_PRISMA_CLIENT!);
  const { PrismaPg } = await import(/* @vite-ignore */ process.env.HIPPO_E2E_ADAPTER!);
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.HIPPO_E2E_DATABASE_URL }) }) };
});
let jar = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); } }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (u: string) => { throw new Error(`REDIRECT ${u}`); }, useRouter: () => ({ refresh() {}, push() {} }) }));
const razorpay = { constructed: 0 };
vi.mock('razorpay', () => ({ default: class { constructor() { razorpay.constructed++; } } }));

const OBJECTIVE = 'Aaira Books publishes illustrated children’s books. We sell about 300 printed books a month and want to sell 1,000 digital books a month by March 2027.';
const REPORT = { oneLineVerdict: 'Test a digital edition.', executiveSummary: 'x', unitEconomics: [], regulatory: [], vulnerabilities: [], goToMarket: [], thirtyDayPlan: [], evidence: [],
  decisionMemo: { decisionQuestion: 'Will parents buy digital editions?', criticalAssumptions: [], proceedIf: [], changeModelIf: [], evidenceStillRequired: [] },
  experiments: [{ hypothesis: 'Parents will pay ₹99 for a digital picture book', test: 'Price the digital edition at ₹99 and pitch 50 parents', metric: 'orders', passThreshold: '10 orders', failThreshold: '3' }] };
const RESEARCH = { version: 2, retrievedAt: '2026-10-02T10:00:00.000Z', queries: [], sources: [], businessModel: { summary: 'Children’s books', customer: 'Parents', payer: 'Parents', offering: 'Books', revenueMechanism: 'Per copy', keyActivities: [], regulatedActivities: [] }, questions: [], findings: [] };
const prompts: Record<string, string> = {};

describe.skipIf(!E2E)('Aaira Books Work 2: AI-proposed ₹99 is never shown as Known (real Postgres)', () => {
  it('brief, page, execution prompt, legacy brief and explicit founder approval', async () => {
    Object.assign(process.env, { GEMINI_API_KEY: 'g' });
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const prompt: string = JSON.parse(String(init?.body)).contents[0].parts[0].text;
      const k = prompt.includes('Write a precise WORK BRIEF') ? 'brief' : prompt.includes('executing a work item') ? 'execute' : 'other';
      prompts[k] = prompt;
      const data = k === 'brief' ? { objective: 'Validate digital pricing', deliverable: 'A pricing test plan for the digital edition', constraints: {}, successCriteria: ['Defines price points'], expectedOutput: 'Plan', outOfScope: ['Ads'],
        inputs: [{ item: 'Digital book price', status: 'KNOWN', value: '₹99', sourceRef: 'OBJECTIVE' }, { item: 'Target digital books per month', status: 'NEEDED', value: '', sourceRef: '' }],
        effort: { aiFeasible: true, aiOutputTokens: 3000, specialist: 'Pricing analyst', humanHours: { low: 4, high: 6 }, hourlyRateInr: { low: 600, high: 900 }, hybridReviewHours: { low: 1, high: 2 }, agencyMultiplier: { low: 1.5, high: 2 }, costDrivers: [], rateBasis: 'assumed' } }
        : { summary: 's', markdown: `# Pricing test\n${'Detail. '.repeat(40)}`, assumptions: [], founderInputsNeeded: [], professionalReviewRequired: false };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), { status: 200 });
    }));
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { confirmFounderFacts, extractFounderFacts } = await import('@/lib/founder-facts');
    const user = await db.user.create({ data: { name: 'Aaira' } });
    const founder = await db.founder.create({ data: { userId: user.id } });
    const org = await db.organization.create({ data: { founderId: founder.id, name: 'Aaira Books' } });
    const audit = await db.audit.create({ data: { userId: user.id, idea: OBJECTIVE, sector: 'D2C / Consumer', assumptions: '[]', report: JSON.stringify(REPORT), status: 'completed', paymentStatus: 'paid', paymentRef: 'pay_AAIRA1' } });
    await db.projectFile.create({ data: { auditId: audit.id, path: 'research.json', content: JSON.stringify(RESEARCH) } });
    await db.projectFile.create({ data: { auditId: audit.id, path: 'founder-facts.json', content: JSON.stringify({ version: 1, confirmedAt: '', facts: confirmFounderFacts(extractFounderFacts(OBJECTIVE).facts) }) } });
    const objective = await db.objective.create({ data: { organizationId: org.id, text: OBJECTIVE, stage: 'UNDERSTAND', auditId: audit.id } });
    const { refreshObjective } = await import('@/lib/hippo/service');
    await refreshObjective(objective); // Aristotle sync: the ₹99 experiment becomes a HYPOTHESIS memory entry
    expect(await db.businessMemory.findFirst({ where: { organizationId: org.id, kind: 'EXPERIMENT' } })).toMatchObject({ status: 'HYPOTHESIS' });

    const work2 = await db.work.create({ data: { organizationId: org.id, objectiveId: objective.id, title: 'Validate digital pricing', description: 'Test digital edition price', deliverable: 'Pricing test plan', capability: 'strategy', status: 'READY' } });
    jar = new Map(); const { createSession } = await import('@/lib/session'); await createSession(user.id);
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const post = (b: unknown = {}) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const briefRoute = await import('@/app/api/hippo/work/[id]/brief/route');
    expect((await briefRoute.POST(post(), ctx(work2.id))).status).toBe(200);

    // The brief writer saw ₹99 only under "AI PROPOSALS … NOT FACTS", never under founder-stated.
    const p = prompts.brief;
    const founderBlock = p.slice(p.indexOf('FOUNDER-STATED OR FOUNDER-APPROVED'), p.indexOf('AI PROPOSALS'));
    expect(founderBlock).not.toContain('₹99');
    expect(p.slice(p.indexOf('AI PROPOSALS'))).toContain('₹99');

    // Stored brief: ₹99 PROPOSED; the 1,000 target is not asked for again.
    const stored = (await db.workBrief.findUnique({ where: { workId: work2.id } })).inputs;
    expect(stored.find((i: { item: string }) => i.item === 'Digital book price')).toMatchObject({ status: 'PROPOSED', value: '₹99', source: 'AI' });
    expect(stored.find((i: { item: string }) => i.item === 'Target digital books per month')).toMatchObject({ status: 'KNOWN', source: 'FOUNDER' });
    expect(JSON.stringify(stored)).not.toMatch(/"status":"NEEDED"/);

    const Page = (await import('@/app/work/[id]/page')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const html = async (id: string) => renderToStaticMarkup(await Page({ params: Promise.resolve({ id }) }));
    let page = await html(work2.id);
    expect(page).toContain('AI-proposed validation price — not founder-approved');
    expect(page).toContain('I approve this value');
    expect(page).toMatch(/Founder stated · F\d+<\/span><span class="font-semibold">Target digital books per month/);
    expect(page).not.toContain('Needed from you</span><span class="font-semibold">Target digital books');

    // A brief stored BEFORE this fix (₹99 marked KNOWN) is corrected on display and at execution time.
    const legacy = await db.work.create({ data: { organizationId: org.id, objectiveId: objective.id, title: 'Digital launch copy', description: 'd', deliverable: 'Copy', capability: 'marketing', status: 'AWAITING_DECISION' } });
    await db.workBrief.create({ data: { workId: legacy.id, objective: 'o', deliverable: 'Copy', inputs: [{ item: 'Digital book price', status: 'KNOWN', value: '₹99' }], constraints: {}, successCriteria: ['c'], expectedOutput: 'e', outOfScope: [], effort: {} } });
    await db.costEstimate.create({ data: { workId: legacy.id, mode: 'AI', low: 1, high: 2, label: 'COMPUTED', basis: 'b', breakdown: {}, drivers: [] } });
    expect(await html(legacy.id)).toContain('AI-proposed validation price — not founder-approved');
    const choose = await import('@/app/api/hippo/work/[id]/choose/route');
    const execute = await import('@/app/api/hippo/work/[id]/execute/route');
    expect((await choose.POST(post({ mode: 'AI' }), ctx(legacy.id))).status).toBe(200);
    expect((await execute.POST(post(), ctx(legacy.id))).status).toBe(200);
    expect(prompts.execute).toContain('Digital book price: ₹99 — AI-PROPOSED, NOT founder-approved');

    // Only an explicit founder approval changes it.
    const approve = await import('@/app/api/hippo/work/[id]/approve-input/route');
    const res = await (await approve.POST(post({ item: 'Digital book price', value: '₹99' }), ctx(work2.id))).json();
    expect(res).toMatchObject({ approved: true, status: 'KNOWN' });
    page = await html(work2.id);
    expect(page).toContain('Founder approved');
    expect(page).not.toContain('AI-proposed validation price — not founder-approved');
    expect(await db.businessMemory.findFirst({ where: { organizationId: org.id, refType: 'founder_approval' } })).toMatchObject({ status: 'FOUNDER_STATED', value: '₹99', owner: 'Founder' });

    // Nothing else touched: company, objective, payment; no Razorpay.
    expect((await db.organization.findUnique({ where: { id: org.id } })).name).toBe('Aaira Books');
    expect((await db.objective.findUnique({ where: { id: objective.id } })).text).toBe(OBJECTIVE);
    expect(await db.audit.findUnique({ where: { id: audit.id } })).toMatchObject({ paymentStatus: 'paid', paymentRef: 'pay_AAIRA1' });
    expect(razorpay.constructed).toBe(0);
    vi.unstubAllGlobals();
  }, 30_000);
});
