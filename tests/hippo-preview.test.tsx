// Preview-only "Open Demo Objective": a fresh browser can open the EXISTING paid demo objective (no new objective,
// audit, order or payment), refresh it repeatedly and concurrently without the ResearchFinding duplicate crash.
// Production can never use it. Runs against REAL PostgreSQL (same env as hippo-e2e); skipped otherwise.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
// Any Razorpay use would show up here: the demo access path must never create an order or payment.
const razorpay = { ordersCreated: 0, constructed: 0 };
vi.mock('razorpay', () => ({ default: class { constructor() { razorpay.constructed++; } orders = { create: async () => { razorpay.ordersCreated++; return {}; }, fetch: async () => ({}), fetchPayments: async () => ({ items: [] }) }; } }));

const RESEARCH = {
  version: 2, retrievedAt: '2026-10-02T10:00:00.000Z', queries: ['q1', 'q2', 'q3'],
  businessModel: { summary: 'Glucometers via pharmacies', customer: 'Diabetics', payer: 'Patients', offering: 'Glucometers', revenueMechanism: 'Unit sales', keyActivities: ['Distribution'], regulatedActivities: [] },
  sources: [
    { id: 'S1', title: 'Pharmacy report', url: 'https://example.org/a', snippet: '', query: 'q1', questionId: 'Q1', retrievedAt: '2026-10-02T10:00:00.000Z' },
    { id: 'S2', title: 'IndiaMART listings', url: 'https://example.org/b', snippet: '', query: 'q2', questionId: 'Q2', retrievedAt: '2026-10-02T10:00:00.000Z' },
  ],
  questions: [
    { id: 'Q1', category: 'CHANNEL', question: 'Where do people buy?', whyItMatters: 'x', query: 'q1', status: 'ANSWERED', sourceIds: ['S1'], findingIds: ['R1'] },
    { id: 'Q2', category: 'CHANNEL', question: 'Who buys on IndiaMART?', whyItMatters: 'x', query: 'q2', status: 'ANSWERED', sourceIds: ['S2'], findingIds: ['R2'] },
    { id: 'Q3', category: 'COST', question: 'Distributor margin?', whyItMatters: 'x', query: 'q3', status: 'NOT_FOUND', sourceIds: [], findingIds: [] },
  ],
  findings: [
    { id: 'R1', questionId: 'Q1', statement: 'Chemists are the main purchase point.', sourceId: 'S1', quote: 'Retail chemists remain the main point of purchase', confidence: 'MEDIUM' },
    { id: 'R2', questionId: 'Q2', statement: 'Distributors buy in bulk.', sourceId: 'S2', quote: 'bulk orders from distributors', confidence: 'MEDIUM' },
  ],
};
const REPORT = {
  oneLineVerdict: 'Reachable via pharmacies.', executiveSummary: 'x', unitEconomics: [], regulatory: [], vulnerabilities: [], goToMarket: [], thirtyDayPlan: [],
  evidence: [{ claim: 'Chemists are the main purchase point.', type: 'FACT', sourceIds: ['R1'], confidence: 'MEDIUM', validation: 'Survey' }, { claim: 'Margins are healthy.', type: 'ASSUMPTION', sourceIds: [], confidence: 'LOW', validation: 'Ask distributors' }],
  decisionMemo: { decisionQuestion: 'Which channels?', criticalAssumptions: [{ assumption: 'Distributor margins work', whyItMatters: 'x', evidenceStatus: 'UNKNOWN', evidence: '', evidenceIds: [], basedOnQuestions: ['Q3'], cheapestTest: 'Ask 3' }], proceedIf: [], changeModelIf: [], evidenceStillRequired: [] },
  experiments: [{ hypothesis: 'h', test: 'Pitch 50 chemists', metric: 'orders', passThreshold: '10', failThreshold: '3' }],
  unknownEconomics: [{ metric: 'CAC', whyUnknown: 'x', howToEstablish: 'pilot' }],
};

let db: any; // eslint-disable-line @typescript-eslint/no-explicit-any
beforeAll(async () => { if (E2E) db = (await import('@/lib/db')).db; });

/** A founder whose ₹99 Aristotle audit has completed (paid, report + research.json saved), not yet synced into Hippoturtle. */
async function paidObjective(opts: { status?: string; paymentStatus?: string; isDemo?: boolean } = {}) {
  const user = await db.user.create({ data: { name: 'F' } });
  const founder = await db.founder.create({ data: { userId: user.id } });
  const org = await db.organization.create({ data: { founderId: founder.id, name: 'Org' } });
  const audit = await db.audit.create({ data: { userId: user.id, idea: 'glucometers', sector: 'Healthtech', assumptions: '[]', report: opts.status === 'failed' ? '{}' : JSON.stringify(REPORT), status: opts.status ?? 'completed', paymentStatus: opts.paymentStatus ?? 'paid', paymentRef: 'pay_TEST123' } });
  await db.projectFile.create({ data: { auditId: audit.id, path: 'research.json', content: JSON.stringify(RESEARCH) } });
  // As in every real paid audit: the founder confirmed the scope before paying (verify's payment gate requires it).
  await db.projectFile.create({ data: { auditId: audit.id, path: 'scope.json', content: JSON.stringify({ version: 1, inputHash: 'x', suggestion: 'GROWTH_PLAN', reasons: [], extractedFacts: [], extractionNotes: [], confirmed: { scope: 'GROWTH_PLAN', source: 'founder', confirmedAt: '', agreedWith: 'suggestion', factsReviewed: true } }) } });
  await db.projectFile.create({ data: { auditId: audit.id, path: 'founder-facts.json', content: JSON.stringify({ version: 1, confirmedAt: '', facts: [
    { id: 'F1', concept: 'volume', timeframe: 'CURRENT', value: 1400, unit: 'units/month', raw: '1,400 units/month', context: '', timeframeEvidence: 'explicit', source: 'FOUNDER_STATED', locked: true, confirmedByFounder: true },
  ] }) } });
  const objective = await db.objective.create({ data: { organizationId: org.id, text: 'Grow glucometer sales to 10,000/month', stage: 'UNDERSTAND', auditId: audit.id, isDemo: opts.isDemo ?? true } });
  return { user, org, audit, objective };
}


async function counts(objectiveId: string, orgId: string) {
  return {
    objectives: await db.objective.count(), audits: await db.audit.count(),
    findings: await db.researchFinding.count({ where: { objectiveId } }),
    ideas: await db.businessIdea.count({ where: { objectiveId } }),
    evidence: await db.evidence.count({ where: { objectiveId } }),
    memory: await db.businessMemory.count({ where: { organizationId: orgId } }),
    memos: await db.decisionMemo.count({ where: { objectiveId } }),
  };
}

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
const preview = () => Object.assign(process.env, { DEMO_MODE: 'true', VERCEL_ENV: 'preview' });
const open = async () => (await import('@/app/api/hippo/preview/demo-objective/route')).POST(new Request('https://preview.example/api/hippo/preview/demo-objective', { method: 'POST' }));

describe.skipIf(!E2E)('Preview-only demo objective access (real Postgres)', () => {
  it('a fresh browser has no company (anonymous session), then opens the EXISTING paid demo objective, repeatedly', async () => {
    preview();
    const { objective, org, audit } = await paidObjective();
    process.env.HIPPO_PREVIEW_DEMO_OBJECTIVE_ID = objective.id;
    const Company = (await import('@/app/company/page')).default;
    const Page = (await import('@/app/objectives/[id]/page')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');

    jar = new Map(); // fresh browser: no cookie → no founder → empty company (the reported symptom)
    expect(renderToStaticMarkup(await Company())).toContain('Your company starts with an objective.');

    const before = await counts(objective.id, org.id);
    for (let i = 0; i < 3; i++) {
      const res = await open();
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`https://preview.example/objectives/${objective.id}`);
    }
    expect((await counts(objective.id, org.id)).objectives).toBe(before.objectives); // no duplicate objective
    expect((await counts(objective.id, org.id)).audits).toBe(before.audits);         // no new audit
    expect(renderToStaticMarkup(await Company())).toContain('Grow glucometer sales to 10,000/month');

    const render = async () => renderToStaticMarkup(await Page({ params: Promise.resolve({ id: objective.id }) }));
    // 8 concurrent loads of the objective page (the 4ac62db race) — none may fail.
    const results = await Promise.allSettled(Array.from({ length: 8 }, render));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    for (const r of results) expect((r as PromiseFulfilledResult<string>).value).toContain('What Aristotle researched');
    const synced = await counts(objective.id, org.id);
    expect(synced).toMatchObject({ findings: 2, ideas: 1, evidence: 2, memos: 1 });
    // Repeated refreshes and another concurrent burst: no duplicate ResearchFinding, BusinessIdea, Evidence or BusinessMemory.
    for (let i = 0; i < 5; i++) await render();
    await Promise.all(Array.from({ length: 8 }, render));
    expect(await counts(objective.id, org.id)).toEqual(synced);

    // Payment untouched: same reference, still paid, no Razorpay order or client.
    expect(await db.audit.findUnique({ where: { id: audit.id } })).toMatchObject({ paymentStatus: 'paid', paymentRef: 'pay_TEST123', status: 'completed' });
    expect(razorpay).toEqual({ ordersCreated: 0, constructed: 0 });
    expect(await db.activityLog.count({ where: { objectiveId: objective.id, type: 'PREVIEW_DEMO_ACCESS' } })).toBe(3);
  });

  it('without a configured id it opens the latest paid demo objective — never a non-demo founder objective', async () => {
    preview(); delete process.env.HIPPO_PREVIEW_DEMO_OBJECTIVE_ID;
    const demo = await paidObjective({ isDemo: true });
    await paidObjective({ isDemo: false }); // a real founder's objective created later must NOT be exposed
    await paidObjective({ isDemo: true, paymentStatus: 'pending', status: 'awaiting_payment' }); // unpaid demo: skipped
    jar = new Map();
    const res = await open();
    expect(res.headers.get('location')).toMatch(new RegExp(`/objectives/${demo.objective.id}$`));
  });

  it('Production can never use it: 404, no session, no button', async () => {
    const { objective } = await paidObjective();
    for (const e of [{ DEMO_MODE: 'true', VERCEL_ENV: 'production' }, { DEMO_MODE: 'false', VERCEL_ENV: 'preview' }, { DEMO_MODE: 'true', VERCEL_ENV: '', NODE_ENV: 'production' }]) {
      process.env = { ...env, ...e, HIPPO_PREVIEW_DEMO_OBJECTIVE_ID: objective.id } as NodeJS.ProcessEnv;
      if (!e.VERCEL_ENV) delete process.env.VERCEL_ENV;
      jar = new Map();
      const res = await open();
      expect(res.status).toBe(404);
      expect(jar.size).toBe(0); // no session cookie issued
      const { renderToStaticMarkup } = await import('react-dom/server');
      const Start = (await import('@/app/start/page')).default;
      expect(renderToStaticMarkup(await Start())).not.toContain('Open Demo Objective');
    }
    preview();
    const { renderToStaticMarkup } = await import('react-dom/server');
    expect(renderToStaticMarkup(await (await import('@/app/start/page')).default())).toContain('Open Demo Objective');
  });
});
