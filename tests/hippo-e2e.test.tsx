// END-TO-END founder journey against a REAL PostgreSQL database with the real Prisma schema + migration.
// Only the outside world is faked: Gemini/Tavily HTTP, the cookie store. Every route, service, page and
// SQL query is real.
//
// Runs when HIPPO_E2E_DATABASE_URL (a disposable database with migrations applied) and HIPPO_E2E_PRISMA_CLIENT
// (a driver-adapter build of this schema) + HIPPO_E2E_ADAPTER (@prisma/adapter-pg) are set; skipped otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

const OBJECTIVE = 'We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month. We need to determine the pathways, economics, channels, CAC, pricing, working capital and execution required.';
const SOURCES: Record<string, { title: string; url: string; content: string }> = {
  pharmacy: { title: 'Retail pharmacy channel report', url: 'https://example.org/pharmacy', content: 'Retail chemists remain the main point of purchase for home glucose monitoring devices in Indian cities.' },
  indiamart: { title: 'IndiaMART glucometer listings', url: 'https://example.org/indiamart', content: 'Wholesale glucometer listings on IndiaMART show bulk orders from distributors and clinics across Tier 2 cities.' },
};
let geminiDown = false;
const calls: string[] = [];

function gemini(prompt: string): unknown {
  const k = prompt.includes('Restate what this founder') ? 'understand' : prompt.includes('research planner') ? 'plan_research' : prompt.includes('You extract evidence for ONE research question') ? 'extract'
    : prompt.includes('You are Aristotle, the strategy capability of Hippoturtle') ? 'pathways' : prompt.includes('Convert the founder\'s chosen pathways') ? 'work' : prompt.includes('Write a precise WORK BRIEF') ? 'brief'
    : prompt.includes('executing a work item') ? 'execute' : prompt.includes('HONEST BROKER') ? 'compare' : 'decision';
  calls.push(k);
  switch (k) {
    case 'understand': return { objective: 'Grow glucometer sales from 1,400 to 10,000 units a month.', target: '10,000 units per month', currentState: '~1,400 units/month via IndiaMART and local pharmacies', keyQuestion: 'Which channels can add ~8,600 units a month, at what CAC and working capital?', businessKind: 'EXISTING_BUSINESS' };
    case 'plan_research': return { businessModel: { summary: 'Selling glucometers through B2B marketplaces and pharmacies', customer: 'People with diabetes', payer: 'Patients, pharmacies, distributors', offering: 'Glucometers and strips', revenueMechanism: 'Unit sales and strip repeat purchases', keyActivities: ['Distribution'], regulatedActivities: [{ activity: 'Selling medical devices', whyRegulated: 'Medical device rules' }] }, questions: [
      { category: 'CHANNEL', question: 'Where do Indians buy glucometers?', whyItMatters: 'Channel choice', query: 'where do people buy glucometers india pharmacy' },
      { category: 'CHANNEL', question: 'Who buys glucometers on IndiaMART?', whyItMatters: 'B2B demand', query: 'indiamart glucometer wholesale buyers' },
      { category: 'COST', question: 'What is distributor margin for glucometers?', whyItMatters: 'Economics', query: 'glucometer distributor margin india' },
      { category: 'REGULATION', question: 'What licence is needed to sell glucometers?', whyItMatters: 'Compliance', query: 'licence to sell glucometer india cdsco', activity: 'Selling medical devices' } ] };
    case 'extract': return prompt.includes('Where do Indians buy') ? { status: 'ANSWERED', findings: [{ statement: 'Chemists are the main purchase point for home glucose monitors.', sourceId: 'S1', quote: 'Retail chemists remain the main point of purchase for home glucose monitoring devices', confidence: 'MEDIUM' }] }
      : prompt.includes('Who buys glucometers on IndiaMART') ? { status: 'ANSWERED', findings: [{ statement: 'Distributors and clinics place bulk orders on IndiaMART.', sourceId: 'S2', quote: 'bulk orders from distributors and clinics across Tier 2 cities', confidence: 'MEDIUM' }] } : { status: 'NOT_FOUND', findings: [] };
    case 'pathways': return { goal: 'Reach 10,000 glucometers a month', ambitionNote: 'This needs roughly 7x today’s volume.', combination: 'Pharmacies + distributors together', founderChecklist: ['How much working capital can you commit?', 'Which two channels first?'], pathways: [
      { name: 'Pharmacy network', howItWorks: 'Supply chemists directly', whyPlausible: 'Chemists are where people buy', evidence: [{ statement: 'Chemists are the main purchase point', refs: ['R1'] }], economics: 'Starting from your 1,400/month [F1]', constraints: ['Credit terms'], risks: ['Slow payment'], firstExperiment: 'Pitch 50 chemists', contributionToTarget: 'To add 4,000/month: ~400 chemists × 10 units' },
      { name: 'Distributor network', howItWorks: 'Appoint Tier 2 distributors', whyPlausible: 'IndiaMART shows distributor demand', evidence: [{ statement: 'Distributors buy in bulk on IndiaMART', refs: ['R2'] }, { statement: 'Invented market size', refs: ['R99'] }], economics: 'Distributor margin is 25%', constraints: [], risks: [], firstExperiment: 'Sign 3 distributors', contributionToTarget: 'To add 3,000/month: 10 distributors × 300' },
      { name: 'Diabetes clinics', howItWorks: 'Doctors recommend', whyPlausible: 'Clinics buy in bulk', evidence: [], economics: 'Not yet established.', constraints: [], risks: [], firstExperiment: 'Visit 10 clinics', contributionToTarget: 'To add 1,000/month: 100 clinics × 10' } ] };
    case 'work': return { headline: 'There are 3 important pieces of work between here and your first validation milestone.', work: [
      { title: 'Create a pharmacy go-to-market plan', description: 'Plan to win chemists', deliverable: 'A 30-day pharmacy GTM plan', capability: 'marketing', priority: 1, pathwayId: 'P1', whyNow: 'Fastest validation', aiExecutable: true },
      { title: 'Contact 50 pharmacy prospects', description: 'Calls and visits', deliverable: 'Call log of 50 chemists', capability: 'sales', priority: 2, pathwayId: 'P1', whyNow: 'Real demand signal', aiExecutable: false },
      { title: 'Medical device regulatory checklist', description: 'What licences apply', deliverable: 'Checklist', capability: 'legal_regulatory', priority: 3, pathwayId: '', whyNow: 'Avoid compliance risk', aiExecutable: true } ] };
    case 'brief': return { objective: 'Win the first 50 pharmacies', deliverable: 'A 30-day pharmacy GTM plan', inputs: [{ item: 'Current volume', status: 'KNOWN', value: '1,400 units/month' }, { item: 'Wholesale price', status: 'NEEDED', value: '' }], constraints: { budget: 'Not set by founder', deadline: 'Not set by founder', geography: 'India', brand: 'Not set by founder', technology: 'None', regulatory: 'None identified.' }, successCriteria: ['Names target cities', 'Has outreach script', 'Has weekly targets'], expectedOutput: 'Markdown plan', outOfScope: ['Running ads'], effort: { aiFeasible: true, aiOutputTokens: 5000, specialist: 'Marketing consultant', humanHours: { low: 10, high: 16 }, hourlyRateInr: { low: 600, high: 1000 }, hybridReviewHours: { low: 2, high: 3 }, agencyMultiplier: { low: 1.5, high: 2 }, costDrivers: ['Number of cities'], rateBasis: 'assumed freelance rate, not a quote' } };
    case 'execute': return { summary: 'A 30-day plan to win 50 pharmacies.', markdown: `# Pharmacy GTM plan\n\n## Week 1\n- Shortlist 50 chemists in 2 cities\n\n| Week | Target |\n|---|---|\n| 1 | 50 visits |\n\nWholesale price: [TO CONFIRM: wholesale price]\n\n<script>alert(1)</script>\n\n${'More detail. '.repeat(30)}`, assumptions: ['Founder can visit 2 cities'], founderInputsNeeded: ['Wholesale price'], professionalReviewRequired: false };
    case 'compare': return { explanation: 'This quote is 35% above the benchmark because it includes 3 revision rounds and professional photography.', scopeGaps: [], extras: ['Professional photography'] };
    default: return null; // Aristotle decision: built in the fetch layer
  }
}

async function decisionReport() {
  const { deterministicAudit } = await import('@/lib/audit');
  const base = deterministicAudit({ idea: OBJECTIVE, sector: 'Healthtech' });
  return { ...base, oneLineVerdict: 'Reachable through pharmacies and distributors if working capital holds.', executiveSummary: 'An existing glucometer seller wants 7x growth.',
    decisionMemo: { decisionQuestion: 'Which channels can carry 8,600 more units a month?', criticalAssumptions: [{ assumption: 'Distributor margins leave room for profit', whyItMatters: 'Economics', evidenceStatus: 'UNKNOWN', evidence: 'No evidence found', evidenceIds: [], basedOnQuestions: ['Q3'], cheapestTest: 'Ask 3 distributors', experimentIndex: 1 }], proceedIf: ['3 distributors sign'], changeModelIf: ['Margins below cost'], evidenceStillRequired: ['Distributor margin'] },
    evidence: [{ claim: 'Chemists are the main purchase point.', type: 'FACT', sourceIds: ['R1'], confidence: 'MEDIUM', validation: 'Survey' }],
    unitEconomics: [], unknownEconomics: [{ metric: 'CAC per pharmacy', whyUnknown: 'Not researched', howToEstablish: 'Pilot 50 chemists' }], regulatory: [],
    experiments: [{ hypothesis: 'Chemists will stock', test: 'Pitch 50 chemists', metric: 'Orders', passThreshold: '10 orders', failThreshold: '<3 orders' }] };
}

beforeAll(() => {
  // Phase 1.1: like production (DATABASE_URL set → ledger on), ModelPrice is read from this real database; AI cost
  // estimates come from it and there is no env fallback price any more.
  Object.assign(process.env, { GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', DEMO_MODE: 'true', VERCEL_ENV: 'preview', HIPPO_USAGE_LEDGER: 'on' });
  delete process.env.HIPPO_WORK_PAYMENTS;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (url.includes('tavily')) {
      const s = body.query.includes('pharmacy') ? SOURCES.pharmacy : body.query.includes('indiamart') ? SOURCES.indiamart : null;
      return new Response(JSON.stringify({ results: s ? [s] : [] }), { status: 200 });
    }
    const prompt: string = body.contents[0].parts[0].text;
    if (geminiDown && !prompt.includes('Restate')) return new Response('overloaded', { status: 503 });
    const data = gemini(prompt) ?? await decisionReport();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 1500 } }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); delete process.env.HIPPO_USAGE_LEDGER; });

const req = (body: unknown = {}) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function json(p: Promise<Response> | Response) { const r = await p; return { status: r.status, body: await r.json().catch(() => ({})) }; }

describe.skipIf(!E2E)('Hippoturtle founder journey (real Postgres)', () => {
  it('objective → Aristotle → pathways → work → brief → estimate → choice → AI execution → memory → dashboard', async () => {
    const { db } = await import('@/lib/db');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const r = {
      objectives: await import('@/app/api/hippo/objectives/route'), scope: await import('@/app/api/audits/[id]/scope/route'), order: await import('@/app/api/payments/create-order/route'),
      verify: await import('@/app/api/payments/verify/route'), pathways: await import('@/app/api/hippo/objectives/[id]/pathways/route'), select: await import('@/app/api/hippo/objectives/[id]/select/route'),
      work: await import('@/app/api/hippo/objectives/[id]/work/route'), brief: await import('@/app/api/hippo/work/[id]/brief/route'), choose: await import('@/app/api/hippo/work/[id]/choose/route'),
      execute: await import('@/app/api/hippo/work/[id]/execute/route'), output: await import('@/app/api/hippo/work/[id]/output/route'), quotes: await import('@/app/api/hippo/work/[id]/quotes/route'),
      outcome: await import('@/app/api/hippo/work/[id]/outcome/route'),
    };
    const pages = { objective: (await import('@/app/objectives/[id]/page')).default, work: (await import('@/app/work/[id]/page')).default, company: (await import('@/app/company/page')).default, memory: (await import('@/app/memory/page')).default };
    const html = async (el: Promise<React.ReactElement>) => renderToStaticMarkup(await el);
    // Optional: write rendered pages for visual review (HIPPO_E2E_DUMP=<dir>).
    const dump = async (name: string, markup: string) => { if (process.env.HIPPO_E2E_DUMP) { const fs = await import('fs'); fs.writeFileSync(`${process.env.HIPPO_E2E_DUMP}/${name}.html`, markup); } };

    // 1–3. Founder enters an objective; Hippoturtle understands it and persists it.
    jar = new Map();
    const created = await json(r.objectives.POST(req({ text: OBJECTIVE, timeCommitment: '30 minutes/day', demo: true })));
    expect(created.status).toBe(200);
    const { objectiveId, auditId, understanding } = created.body;
    expect(understanding).toMatchObject({ target: '10,000 units per month', source: 'AI' });
    expect(await db.founder.findFirst({ where: { timeCommitment: '30 minutes/day' } })).toBeTruthy();

    // Founder confirms their numbers; Aristotle runs via the EXISTING scope → order → verify flow (Demo Mode skips payment only).
    const sug = await json(r.scope.POST(req({ action: 'suggest' }), ctx(auditId)));
    expect(sug.body.facts.map((f: { raw: string }) => f.raw).join(' ')).toMatch(/1,400/);
    expect((await json(r.scope.POST(req({ action: 'confirm', scope: 'GROWTH_PLAN', facts: sug.body.facts, factsReviewed: true }), ctx(auditId)))).status).toBe(200);
    expect((await json(r.order.POST(req({ auditId })))).body.demo).toBe(true);
    expect((await json(r.verify.POST(req({ auditId, demo: true })))).status).toBe(200);
    await (await import('@/lib/jobs')).settleDetached(); // Phase 2: the audit runs as a job after verify returns

    // 4–5. The objective page syncs research + decision memo into Hippoturtle tables.
    let page = await html(pages.objective({ params: Promise.resolve({ id: objectiveId }) }));
    expect(page).toContain('What Aristotle researched');
    expect(page).toContain('Chemists are the main purchase point for home glucose monitors.');
    expect(page).toContain('No evidence found — this is an open question');
    expect(page).toContain('How could we actually achieve');
    expect(await db.researchFinding.count({ where: { objectiveId } })).toBe(2);
    expect(await db.decisionMemo.count({ where: { objectiveId } })).toBe(1);
    await html(pages.objective({ params: Promise.resolve({ id: objectiveId }) })); // idempotent sync
    expect(await db.researchFinding.count({ where: { objectiveId } })).toBe(2);
    expect(await db.businessMemory.count({ where: { objectiveId, status: 'VERIFIED_FACT' } })).toBe(2);
    expect(await db.businessMemory.count({ where: { objectiveId, status: 'FOUNDER_STATED', kind: 'FACT' } })).toBe(2);

    // Pathways to the FULL target; ungrounded evidence/numbers are removed.
    const pw = await json(r.pathways.POST(req(), ctx(objectiveId)));
    expect(pw.status).toBe(200);
    expect(pw.body.result.pathways).toHaveLength(3);
    expect(pw.body.result.pathways[1].evidence).toHaveLength(1);
    expect(pw.body.result.pathways[1].economics).toMatch(/^Not yet established/);
    expect(pw.body.result.pathways[0].economics).toContain('[F1]');

    // Founder decides; Mogli generates work.
    expect((await json(r.work.POST(req(), ctx(objectiveId)))).status).toBe(409); // must choose first
    expect((await json(r.select.POST(req({ ids: ['P1', 'P2'] }), ctx(objectiveId)))).status).toBe(200);
    const wk = await json(r.work.POST(req(), ctx(objectiveId)));
    expect(wk.body.work).toHaveLength(3);
    const works = await db.work.findMany({ where: { objectiveId }, orderBy: { priority: 'asc' } });
    expect(works.map((w: { capability: string; aiExecutable: boolean }) => [w.capability, w.aiExecutable])).toEqual([['marketing', true], ['sales', false], ['legal_regulatory', true]]); // regulatory research is AI work; calling prospects is a person's
    page = await html(pages.objective({ params: Promise.resolve({ id: objectiveId }) }));
    expect(page).toContain('Here’s what needs to happen.');
    expect(page).toContain('There are 3 important pieces of work');

    // 6–9. Work brief + cost intelligence + execution options.
    const gtm = works[0];
    expect((await json(r.choose.POST(req({ mode: 'AI' }), ctx(gtm.id)))).status).toBe(409); // no brief yet
    expect((await json(r.brief.POST(req(), ctx(gtm.id)))).status).toBe(200);
    const est = await db.costEstimate.findMany({ where: { workId: gtm.id } });
    expect(est.map((e: { mode: string }) => e.mode).sort()).toEqual(['AGENCY', 'AI', 'HUMAN', 'HYBRID']);
    expect(est.find((e: { mode: string }) => e.mode === 'HUMAN')).toMatchObject({ low: 6000, high: 16000, label: 'AI_BENCHMARK' });
    let wp = await html(pages.work({ params: Promise.resolve({ id: gtm.id }) }));
    for (const s of ['Work brief', 'Needed from you', 'Not set by founder', 'Hippoturtle estimate', 'Indicative estimate — external quote required', 'USE HIPPOTURTLE', 'USE EXTERNAL PROVIDER', 'HYBRID', 'DECIDE LATER', 'External quote not yet available']) expect(wp).toContain(s);

    // A person's act (calling prospects) never offers AI-only; regulatory RESEARCH is AI work (only signing/filing is not).
    await json(r.brief.POST(req(), ctx(works[1].id)));
    const humanOnly = await json(r.choose.POST(req({ mode: 'AI' }), ctx(works[1].id)));
    expect(humanOnly.status).toBe(400);
    expect(humanOnly.body.error).toMatch(/A person needs to do this work/);
    await json(r.brief.POST(req(), ctx(works[2].id)));
    expect((await json(r.choose.POST(req({ mode: 'AI' }), ctx(works[2].id)))).status).toBe(200);
    expect(await html(pages.work({ params: Promise.resolve({ id: works[2].id }) }))).toContain('not legal or tax advice');

    // 10–12. Founder chooses Hippoturtle; execution fails once (retryable, nothing lost), then succeeds.
    expect((await json(r.choose.POST(req({ mode: 'AI' }), ctx(gtm.id)))).body).toMatchObject({ mode: 'AI', payment: { status: 'INCLUDED_EARLY_ACCESS', required: false } });
    geminiDown = true;
    const failed = await json(r.execute.POST(req(), ctx(gtm.id)));
    geminiDown = false;
    expect(failed.status).toBe(502);
    expect(await db.work.findUnique({ where: { id: gtm.id } })).toMatchObject({ status: 'APPROVED' });
    const ok = await json(r.execute.POST(req(), ctx(gtm.id)));
    expect(ok.body.status).toBe('COMPLETED');
    expect((await json(r.execute.POST(req(), ctx(gtm.id)))).status).toBe(409); // no double execution
    const exec = (await db.execution.findFirst({ where: { workId: gtm.id, status: 'COMPLETED' } })) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(exec).toMatchObject({ provider: 'gemini', inputTokens: 2000, outputTokens: 1500 });
    expect(exec.costInr).toBeGreaterThan(0);
    expect(exec.input.brief.deliverable).toBe('A 30-day pharmacy GTM plan');
    const dl = await r.output.GET(new Request('http://x'), ctx(gtm.id));
    expect(dl.headers.get('content-disposition')).toContain('.md');
    expect(await dl.text()).toContain('# Pharmacy GTM plan');
    wp = await html(pages.work({ params: Promise.resolve({ id: gtm.id }) }));
    expect(wp).toContain('WORK COMPLETED');
    await dump('work', wp);
    expect(wp).toContain('<table>');
    expect(wp).not.toContain('<script>alert');

    // Honest broker: a founder-entered quote is compared and explained.
    const q = await json(r.quotes.POST(req({ providerName: 'Acme Marketing', amount: 22000, includes: ['3 revision rounds', 'Photography'], excludes: [] }), ctx(gtm.id)));
    expect(q.body.comparison).toMatchObject({ position: 'ABOVE', deltaPct: 100, explainedBy: 'AI' });

    // 13–15. Outcome → Business Memory → dashboard.
    expect((await json(r.outcome.POST(req({ summary: 'Contacted 50 pharmacies', metrics: [{ label: 'Responded', value: '12' }, { label: 'Converted', value: '2' }] }), ctx(works[1].id)))).status).toBe(200);
    await dump('objective', await html(pages.objective({ params: Promise.resolve({ id: objectiveId }) })));
    const dash = await html(pages.company());
    await dump('company', dash);
    for (const s of ['My company', 'Current objective', 'Active work', 'Completed work', 'Decisions', 'Money spent', 'Recent activity', 'Founder decided to pursue: Pharmacy network, Distributor network']) expect(dash).toContain(s);
    const mem = await html(pages.memory());
    await dump('memory', mem);
    await dump('home', renderToStaticMarkup((await import('@/app/page')).default()));
    await dump('start', renderToStaticMarkup(await (await import('@/app/start/page')).default()));
    for (const s of ['Decision history', 'Business truth layer', 'Sourced fact', 'Founder stated', 'Not yet established', 'Outcome of', 'Responded: 12']) expect(mem).toContain(s);
    const types = (await db.activityLog.findMany({ where: { objectiveId }, select: { type: true } })).map((a: { type: string }) => a.type);
    for (const t of ['OBJECTIVE_CREATED', 'ARISTOTLE_STARTED', 'RESEARCH_COMPLETED', 'DECISION_GENERATED', 'PATHWAYS_GENERATED', 'FOUNDER_DECISION', 'WORK_CREATED', 'COST_ESTIMATED', 'FOUNDER_CHOICE', 'EXECUTION_STARTED', 'EXECUTION_FAILED', 'EXECUTION_COMPLETED', 'QUOTE_RECEIVED', 'OUTCOME_RECORDED', 'AI_CALL']) expect(types).toContain(t);
    expect(JSON.stringify(await db.activityLog.findMany({ where: { type: 'AI_CALL' } }))).not.toMatch(/test|Pharmacy GTM plan/); // metadata only: no keys, no outputs

    // Authorization: another founder cannot see or touch any of it.
    jar = new Map();
    await json(r.objectives.POST(req({ text: 'I want to open a cloud kitchen in Pune serving office lunches.' })));
    expect((await json(r.pathways.POST(req(), ctx(objectiveId)))).status).toBe(404);
    expect((await json(r.execute.POST(req(), ctx(gtm.id)))).status).toBe(404);
    expect((await r.output.GET(new Request('http://x'), ctx(gtm.id))).status).toBe(404);
    await expect(html(pages.work({ params: Promise.resolve({ id: gtm.id }) }))).rejects.toThrow('NOT_FOUND');
    const other = await html(pages.company()); // (the fake AI restates every objective the same way, so compare by id/content)
    expect(other).not.toContain(objectiveId); expect(other).not.toContain('Create a pharmacy go-to-market plan'); expect(other).not.toContain('Founder decided to pursue');
    jar = new Map();
    expect((await json(r.brief.POST(req(), ctx(gtm.id)))).status).toBe(401);
  }, 60_000);

  it('AI not configured: objective is still saved (restated from founder numbers); AI steps fail visibly without fabricating', async () => {
    jar = new Map();
    const saved = { g: process.env.GEMINI_API_KEY };
    delete process.env.GEMINI_API_KEY;
    const { POST } = await import('@/app/api/hippo/objectives/route');
    const res = await json(POST(req({ text: OBJECTIVE })));
    expect(res.status).toBe(200);
    expect(res.body.understanding).toMatchObject({ source: 'FOUNDER_NUMBERS', target: expect.stringContaining('10,000') });
    const ex = await import('@/app/api/hippo/explore/route');
    expect((await json(ex.POST(req({ about: 'I am a pharmacist in Pune with 2 lakh to invest.' })))).status).toBe(503);
    process.env.GEMINI_API_KEY = saved.g;
  });
});
