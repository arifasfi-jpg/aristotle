// Aaira Books on REAL PostgreSQL through the real scope → order → verify → objective page flow.
// Only Gemini/Tavily HTTP and cookies are faked. The decision model returns the reproduced bad rows/claims.
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

const AAIRA = 'I am 10 years old and I want to write a quiz book for kids aged 8 to 15... Sell 5,000 physical books... Sell 1,000 digital books.';
const PROBLEM = 'Parents struggle to find quiz books matched to their child\'s age. This problem occurs daily.';
const COMPETITION = 'Established publishers lack direct personalization or localized content.';

describe.skipIf(!E2E)('Aaira Books founder facts and claims (real Postgres)', () => {
  it('new audit: founder age 10, audience 8–15, 5,000 physical / 1,000 digital; no age in unit economics; unsupported claims labelled', async () => {
    Object.assign(process.env, { GEMINI_API_KEY: 'g', TAVILY_API_KEY: 't', DEMO_MODE: 'true', VERCEL_ENV: 'preview' });
    const { deterministicAudit } = await import('@/lib/audit');
    let decisionFacts = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (url.includes('tavily')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      const prompt: string = body.contents[0].parts[0].text;
      const k = prompt.includes('Restate what this founder') ? 'understand' : prompt.includes('research planner') ? 'plan' : 'decision';
      if (k === 'decision') decisionFacts = prompt;
      const data = k === 'understand' ? { objective: 'Write a kids quiz book', target: '5,000 physical and 1,000 digital books', currentState: 'Not stated yet', keyQuestion: 'q', businessKind: 'NEW_IDEA' }
        : k === 'plan' ? { businessModel: { summary: 'Kids quiz books', customer: 'Kids 8–15', payer: 'Parents', offering: 'Quiz books', revenueMechanism: 'Per copy', keyActivities: [], regulatedActivities: [] }, questions: ['a', 'b', 'c', 'd'].map((x) => ({ category: 'DEMAND', question: `Q ${x}?`, whyItMatters: 'x', query: `kids quiz books india ${x}` })) }
        : { ...deterministicAudit({ idea: AAIRA, sector: 'Edtech' }), oneLineVerdict: 'v', customer: { icp: 'Parents', problem: PROBLEM, willingnessToPay: 'Unknown' }, marketView: { marketType: 'Books', demandSignal: 'Unknown', competition: COMPETITION, marketRisk: 'Distribution' },
          // The reproduced bad output: an age row pointing at a sales target.
          unitEconomics: [{ metric: 'Founder age', conservative: 5000, base: 5000, upside: 5000, unit: 'number', commentary: '', assumption: 'FOUNDER-STATED', provenance: 'FOUNDER_STATED', factId: 'F3', concept: 'other', timeframe: 'CURRENT' }] };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), { status: 200 });
    }));
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const post = (b: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    jar = new Map();
    const created = await (await (await import('@/app/api/hippo/objectives/route')).POST(post({ text: AAIRA, companyName: 'Aaira Books' }))).json();
    const scope = await import('@/app/api/audits/[id]/scope/route');
    const sug = await (await scope.POST(post({ action: 'suggest' }), ctx(created.auditId))).json();
    // What the founder is asked to confirm already carries the right meaning.
    expect(sug.facts.map((f: any) => [f.concept, f.value ?? `${f.low}-${f.high}`, f.subject ?? null])).toEqual([['founder_age', 10, 'founder'], ['audience_age', '8-15', 'kids'], ['volume', 5000, 'physical books'], ['volume', 1000, 'digital books']]); // eslint-disable-line @typescript-eslint/no-explicit-any
    await scope.POST(post({ action: 'confirm', scope: 'NEW_IDEA', facts: sug.facts, factsReviewed: true }), ctx(created.auditId));
    await (await import('@/app/api/payments/create-order/route')).POST(post({ auditId: created.auditId }));
    expect((await (await import('@/app/api/payments/verify/route')).POST(post({ auditId: created.auditId, demo: true }))).status).toBe(200);

    // The decision model was told what each number means.
    expect(decisionFacts).toContain('Founder age: 10 years');
    expect(decisionFacts).toContain('Target volume: 5,000 physical books');
    expect(decisionFacts).toContain('Target volume: 1,000 digital books');
    const report = JSON.parse((await db.audit.findUnique({ where: { id: created.auditId } })).report);
    expect(report.unitEconomics.some((r: { metric: string }) => /age/i.test(r.metric))).toBe(false);
    expect(report.unitEconomics.filter((r: any) => r.provenance === 'FOUNDER_STATED').map((r: any) => [r.metric, r.base])).toEqual(expect.arrayContaining([['Target volume — physical books (founder-stated)', 5000], ['Target volume — digital books (founder-stated)', 1000]])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(report.claimProvenance['customer.problem'].label).toBe('HYPOTHESIS');
    expect(report.claimProvenance['marketView.competition'].label).toBe('HYPOTHESIS');

    const { renderToStaticMarkup } = await import('react-dom/server');
    const page = renderToStaticMarkup(await (await import('@/app/objectives/[id]/page')).default({ params: Promise.resolve({ id: created.objectiveId }) }));
    expect(page).not.toMatch(/Founder age<\/td>/);
    expect(page).toContain('Hypothesis — not established by research');
    expect(page).toContain('This problem occurs daily.');
    const memory = await db.businessMemory.findMany({ where: { objectiveId: created.objectiveId, status: 'FOUNDER_STATED', kind: 'FACT' }, select: { title: true } });
    expect(memory.map((m: { title: string }) => m.title).sort()).toEqual(['Founder age: 10 years', 'Target audience age (kids): 8–15 years', 'Target volume: 1,000 digital books', 'Target volume: 5,000 physical books']);
    vi.unstubAllGlobals();
  }, 30_000);

  it('report stored BEFORE this fix ("Founder age | 5,000 | Founder stated") is corrected on display', async () => {
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { deterministicAudit } = await import('@/lib/audit');
    const user = await db.user.create({ data: { name: 'A' } });
    const org = await db.organization.create({ data: { founderId: (await db.founder.create({ data: { userId: user.id } })).id, name: 'Aaira Books' } });
    const stored = { ...deterministicAudit({ idea: AAIRA, sector: 'Edtech' }), customer: { icp: 'Parents', problem: PROBLEM, willingnessToPay: 'Unknown' }, marketView: { marketType: 'Books', demandSignal: 'Unknown', competition: COMPETITION, marketRisk: 'r' },
      unitEconomics: [{ metric: 'Founder age', conservative: 5000, base: 5000, upside: 5000, unit: 'number', commentary: '', assumption: 'FOUNDER-STATED (LOCKED) F2', provenance: 'FOUNDER_STATED', factId: 'F2', concept: 'other', timeframe: 'CURRENT' }] };
    const audit = await db.audit.create({ data: { userId: user.id, idea: AAIRA, sector: 'Edtech', assumptions: '[]', report: JSON.stringify(stored), status: 'completed', paymentStatus: 'paid', paymentRef: 'pay_OLD' } });
    // Facts exactly as the old extractor stored them: meaningless "other" numbers.
    await db.projectFile.create({ data: { auditId: audit.id, path: 'founder-facts.json', content: JSON.stringify({ version: 1, confirmedAt: '', facts: [
      { id: 'F1', concept: 'other', timeframe: 'CURRENT', value: 15, unit: 'number', raw: '15', context: '', timeframeEvidence: 'inferred', source: 'FOUNDER_STATED', locked: true, confirmedByFounder: true },
      { id: 'F2', concept: 'other', timeframe: 'CURRENT', value: 5000, unit: 'number', raw: '5,000', context: '', timeframeEvidence: 'inferred', source: 'FOUNDER_STATED', locked: true, confirmedByFounder: true },
    ] }) } });
    const objective = await db.objective.create({ data: { organizationId: org.id, text: AAIRA, stage: 'UNDERSTAND', auditId: audit.id } });
    jar = new Map(); await (await import('@/lib/session')).createSession(user.id);
    const { renderToStaticMarkup } = await import('react-dom/server');
    const page = renderToStaticMarkup(await (await import('@/app/objectives/[id]/page')).default({ params: Promise.resolve({ id: objective.id }) }));
    expect(page).not.toMatch(/Founder age<\/td>/);
    expect(page).toContain('Hypothesis — not established by research');
    const aristotle = renderToStaticMarkup(await (await import('@/app/audit/[id]/page')).default({ params: Promise.resolve({ id: audit.id }) }));
    expect(aristotle).not.toContain('>Founder age<');
    expect(aristotle).toContain('Hypothesis — not established by research');
  }, 30_000);
});
