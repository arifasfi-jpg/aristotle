// Regression: Aristotle → Hippoturtle synchronisation must be idempotent and safe under concurrent page loads.
// Production symptom (Vercel Preview): GET /objectives/[id] → "Unique constraint failed on (objectiveId, code)"
// in researchFinding, after payment + audit had completed. The redirect fires router.push() AND router.refresh(),
// so two (or more) renders sync the same finished audit at the same time.
//
// Runs against REAL PostgreSQL (same env vars as hippo-e2e.test.tsx); skipped otherwise.
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
async function paidObjective(opts: { status?: string; paymentStatus?: string } = {}) {
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
  const objective = await db.objective.create({ data: { organizationId: org.id, text: 'Grow glucometer sales to 10,000/month', stage: 'UNDERSTAND', auditId: audit.id } });
  return { user, org, audit, objective };
}

async function counts(objectiveId: string, orgId: string) {
  return {
    findings: await db.researchFinding.count({ where: { objectiveId } }),
    questions: await db.researchQuestion.count({ where: { objectiveId } }),
    ideas: await db.businessIdea.count({ where: { objectiveId } }),
    evidence: await db.evidence.count({ where: { objectiveId } }),
    memos: await db.decisionMemo.count({ where: { objectiveId } }),
    memory: await db.businessMemory.count({ where: { organizationId: orgId } }),
    started: await db.activityLog.count({ where: { objectiveId, type: 'ARISTOTLE_STARTED' } }),
    completed: await db.activityLog.count({ where: { objectiveId, type: 'RESEARCH_COMPLETED' } }),
  };
}
// 2 findings, 3 questions, 1 idea, 2 evidence, 1 memo; memory = idea + 2 facts + 1 unknown question + 1 founder fact + 1 assumption + 1 experiment + 1 unknown metric = 8
const EXPECTED = { findings: 2, questions: 3, ideas: 1, evidence: 2, memos: 1, memory: 8, started: 1, completed: 1 };

describe.skipIf(!E2E)('Aristotle → Hippoturtle sync is idempotent (real Postgres)', () => {
  it('a) first synchronisation succeeds, b+c) the exact same sync again succeeds without duplicates', async () => {
    const { syncAristotle } = await import('@/lib/hippo/aristotle');
    const { refreshObjective } = await import('@/lib/hippo/service');
    const { objective, org } = await paidObjective();
    await refreshObjective(objective);
    expect(await counts(objective.id, org.id)).toEqual(EXPECTED);
    const again = await db.objective.findUnique({ where: { id: objective.id } });
    expect(again.stage).toBe('DECISION');
    await expect(refreshObjective(again)).resolves.toBeTruthy();
    expect(await syncAristotle({ ...again })).toBe('already');
    expect(await counts(objective.id, org.id)).toEqual(EXPECTED);
  });

  it('concurrent loads (router.push + router.refresh, double tabs) never throw and never duplicate', async () => {
    const { refreshObjective } = await import('@/lib/hippo/service');
    for (let round = 0; round < 5; round++) { // races are timing-dependent: repeat on fresh objectives
      const { objective, org } = await paidObjective();
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => refreshObjective(objective)));
      expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      expect(await counts(objective.id, org.id)).toEqual(EXPECTED);
    }
  });

  it('a partially completed earlier run (crash after some rows) is completed on retry without errors or duplicates', async () => {
    const { syncAristotle } = await import('@/lib/hippo/aristotle');
    const { objective, org } = await paidObjective();
    // Earlier run inserted R1 and one memory row, then died before the decision memo was written.
    await db.researchFinding.create({ data: { objectiveId: objective.id, code: 'R1', questionCode: 'Q1', statement: 'Chemists are the main purchase point.', quote: 'Retail chemists remain the main point of purchase', sourceTitle: 'Pharmacy report', sourceUrl: 'https://example.org/a', geography: 'India', confidence: 'MEDIUM' } });
    await db.researchQuestion.create({ data: { objectiveId: objective.id, code: 'Q1', category: 'CHANNEL', question: 'Where do people buy?', whyItMatters: 'x', query: 'q1', status: 'ANSWERED' } });
    await db.evidence.create({ data: { objectiveId: objective.id, claim: 'Chemists are the main purchase point.', type: 'FACT', status: 'VERIFIED_FACT', sourceRefs: ['R1'], confidence: 'MEDIUM', validation: 'Survey' } });
    const first = await syncAristotle({ ...objective, stage: 'RESEARCH' });
    expect(first).toBe('synced');
    const c = await counts(objective.id, org.id);
    expect(c).toMatchObject({ findings: 2, questions: 3, evidence: 2, memos: 1 });
    expect(await syncAristotle({ ...objective, stage: 'DECISION' })).toBe('already');
    expect(await counts(objective.id, org.id)).toEqual(c);
  });

  it('d) /objectives/[id] renders after a successful audit and on every refresh, including concurrent refreshes', async () => {
    const Page = (await import('@/app/objectives/[id]/page')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createSession } = await import('@/lib/session');
    const { objective, org, user } = await paidObjective();
    jar = new Map(); await createSession(user.id);
    const render = async () => renderToStaticMarkup(await Page({ params: Promise.resolve({ id: objective.id }) }));
    const pages = await Promise.all([render(), render(), render()]);
    for (const html of pages) { expect(html).toContain('What Aristotle researched'); expect(html).toContain('Chemists are the main purchase point.'); }
    for (let i = 0; i < 3; i++) expect(await render()).toContain('What Aristotle researched');
    expect(await counts(objective.id, org.id)).toEqual(EXPECTED);
  });

  it('e) a failed analysis is retried through verify without a new payment, then the page syncs once', async () => {
    const { objective, org, audit, user } = await paidObjective({ status: 'failed' });
    const { refreshObjective } = await import('@/lib/hippo/service');
    await refreshObjective(objective); // failed audit: nothing synced, no crash
    expect(await counts(objective.id, org.id)).toMatchObject({ findings: 0, memos: 0 });
    // Retry path = existing verify route with only { auditId }: no Razorpay order, no signature, no charge.
    jar = new Map(); const { createSession } = await import('@/lib/session'); await createSession(user.id);
    vi.doMock('@/lib/ai', () => ({ runAudit: async () => ({ report: REPORT, research: RESEARCH, pricing: { computeInr: 1, marginInr: 0.1 }, provider: 'test' }) }));
    // The audit job lays out pathways after the (stubbed) decision memo.
    const { FAKE_PATHWAYS } = await import('./helpers/escalation-fakes');
    vi.doMock('@/lib/hippo/gateway', async (orig) => ({ ...(await orig<typeof import('@/lib/hippo/gateway')>()), generateJson: async () => ({ data: FAKE_PATHWAYS, provider: 'gemini', model: 'test', task: 'pathways', inputTokens: 0, outputTokens: 0, costInr: 0, ms: 0 }) }));
    vi.resetModules();
    const { POST } = await import('@/app/api/payments/verify/route');
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auditId: audit.id }) }));
    expect(res.status).toBe(200);
    await (await import('@/lib/jobs')).settleDetached(); // Phase 2: the audit runs as a job after verify returns
    const after = await db.audit.findUnique({ where: { id: audit.id } });
    expect(after).toMatchObject({ status: 'completed', paymentStatus: 'paid', paymentRef: 'pay_TEST123' }); // same payment, not charged again
    const svc = await import('@/lib/hippo/service');
    await Promise.all([svc.refreshObjective(objective), svc.refreshObjective(objective)]);
    // + 3 pathway ideas in Business Memory: pathways arrive with the report, so the founder never sees a memo without them.
    expect(await counts(objective.id, org.id)).toEqual({ ...EXPECTED, memory: EXPECTED.memory + 3 });
    expect((await db.decisionMemo.findUnique({ where: { objectiveId: objective.id } })).pathways.pathways).toHaveLength(3);
    vi.doUnmock('@/lib/ai'); vi.doUnmock('@/lib/hippo/gateway');
  });
});
