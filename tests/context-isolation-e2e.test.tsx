// Objective context isolation against a REAL PostgreSQL database (real Prisma schema + migrations, real routes,
// services and pages). Only Gemini HTTP and the cookie store are faked; every prompt sent to the AI is captured so
// the test can prove which company name and which memory each objective's AI calls actually received.
//
// Runs when HIPPO_E2E_DATABASE_URL / HIPPO_E2E_PRISMA_CLIENT / HIPPO_E2E_ADAPTER are set (see hippo-e2e.test.tsx).
import fs from 'fs';
import path from 'path';
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
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (u: string) => { throw new Error(`REDIRECT ${u}`); }, useRouter: () => ({ refresh() {}, push() {} }) }));

const DEMO = 'Demo Glucose Technologies';
const AAIRA_TEXT = 'I am 10 years old and I want to write a quiz book for kids aged 8 to 15. Sell 5,000 physical books and 1,000 digital books.';
const DEMO_TEXT = 'We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month.';
const prompts: { task: string; text: string }[] = [];
let execResult: Record<string, unknown> = {};

beforeAll(() => {
  Object.assign(process.env, { GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', DEMO_MODE: 'true', VERCEL_ENV: 'preview' });
  delete process.env.HIPPO_WORK_PAYMENTS;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const text: string = JSON.parse(String(init?.body || '{}')).contents[0].parts[0].text;
    const task = text.includes('Restate what this founder') ? 'understand' : text.includes('executing a work item') ? 'execute' : 'other';
    prompts.push({ task, text });
    const data = task === 'understand' ? { objective: 'o', target: 't', currentState: 'c', keyQuestion: 'k', businessKind: 'NEW_IDEA' } : execResult;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }), { status: 200 });
  }));
});
afterAll(() => vi.unstubAllGlobals());

const req = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function post(body: unknown) {
  const { POST } = await import('@/app/api/hippo/objectives/route');
  const r = await POST(req(body));
  return { status: r.status, body: await r.json() };
}
const understandPromptFor = (from: number) => prompts.slice(from).filter((p) => p.task === 'understand').map((p) => p.text);

describe.skipIf(!E2E)('Objective context isolation (real Postgres)', () => {
  it('real → demo and demo → real: separate orgs, per-objective company names, AI prompts never cross', async () => {
    const { db } = await import('@/lib/db');
    // Founder 1: Aaira Books first, then the demo.
    jar = new Map();
    let p0 = prompts.length;
    const aaira = await post({ text: AAIRA_TEXT, companyName: 'Aaira Books' });
    expect(aaira.status).toBe(200);
    expect(understandPromptFor(p0)[0]).toContain('"Aaira Books"');
    p0 = prompts.length;
    const demo = await post({ text: DEMO_TEXT, demo: true });
    expect(demo.status).toBe(200);
    expect(understandPromptFor(p0)[0]).toContain(`"${DEMO}"`);
    expect(understandPromptFor(p0)[0]).not.toContain('Aaira');

    const a = await db.objective.findUniqueOrThrow({ where: { id: aaira.body.objectiveId }, include: { organization: true } });
    const d = await db.objective.findUniqueOrThrow({ where: { id: demo.body.objectiveId }, include: { organization: true } });
    expect(a).toMatchObject({ companyName: 'Aaira Books', isDemo: false, organization: { name: 'Aaira Books', isDemo: false } });
    expect(d).toMatchObject({ companyName: DEMO, isDemo: true, organization: { name: DEMO, isDemo: true } });
    expect(d.organizationId).not.toBe(a.organizationId);
    expect(d.organization.founderId).toBe(a.organization.founderId);

    // Founder 2: demo first, then Aaira Books — the real objective must not land in the demo org or take its name.
    jar = new Map();
    const demo2 = await post({ text: DEMO_TEXT, demo: true });
    p0 = prompts.length;
    const aaira2 = await post({ text: AAIRA_TEXT, companyName: 'Aaira Books' });
    expect(understandPromptFor(p0)[0]).toContain('"Aaira Books"');
    expect(understandPromptFor(p0)[0]).not.toContain(DEMO);
    const a2 = await db.objective.findUniqueOrThrow({ where: { id: aaira2.body.objectiveId }, include: { organization: true } });
    const d2 = await db.objective.findUniqueOrThrow({ where: { id: demo2.body.objectiveId }, include: { organization: true } });
    expect(a2).toMatchObject({ companyName: 'Aaira Books', organization: { isDemo: false, name: 'Aaira Books' } });
    expect(d2.organization).toMatchObject({ isDemo: true, name: DEMO });
    expect(d2.organizationId).not.toBe(a2.organizationId);

    // Objective pages: each header shows its own business only.
    const { renderToStaticMarkup } = await import('react-dom/server');
    const Page = (await import('@/app/objectives/[id]/page')).default;
    const page = async (id: string) => renderToStaticMarkup(await Page({ params: Promise.resolve({ id }) }));
    const demoPage = await page(d2.id);
    expect(demoPage).toContain(DEMO);
    expect(demoPage).not.toContain('Aaira Books');
    const aairaPage = await page(a2.id);
    expect(aairaPage).toContain('Aaira Books');
    expect(aairaPage).not.toContain(DEMO);

    // An outcome recorded on the demo objective stays in the demo org — never in Aaira Books' memory/activity.
    const { POST: outcome } = await import('@/app/api/hippo/objectives/[id]/outcome/route');
    expect((await outcome(req({ summary: 'DEMO_OUTCOME_SIGNAL: called 20 pharmacies', metrics: [] }), { params: Promise.resolve({ id: d2.id }) })).status).toBe(200);
    const mem = await db.businessMemory.findFirstOrThrow({ where: { objectiveId: d2.id, kind: 'OUTCOME' } });
    expect(mem.organizationId).toBe(d2.organizationId);
    expect(await db.activityLog.count({ where: { organizationId: a2.organizationId, message: { contains: 'DEMO_OUTCOME_SIGNAL' } } })).toBe(0);
    // The founder's dashboard and memory show the real company, without demo data.
    const company = renderToStaticMarkup(await (await import('@/app/company/page')).default());
    const memory = renderToStaticMarkup(await (await import('@/app/memory/page')).default());
    for (const html of [company, memory]) { expect(html).toContain('Aaira Books'); expect(html).not.toContain('DEMO_OUTCOME_SIGNAL'); expect(html).not.toContain(DEMO); }
  });

  it('memory and execution: only this objective’s memory reaches the AI; org-level (NULL) memory never does; output is marked AI-generated', async () => {
    const { db } = await import('@/lib/db');
    const { memoryBrief } = await import('@/lib/hippo/context');
    const { executeWork } = await import('@/lib/hippo/service');
    const { AI_PROVENANCE_MARKER } = await import('@/lib/hippo/execution');
    jar = new Map();
    const aaira = (await post({ text: AAIRA_TEXT, companyName: 'Aaira Books' })).body.objectiveId as string;
    const other = (await post({ text: 'A completely different venture: a bakery selling 200 cakes a month in Pune.', companyName: null })).body.objectiveId as string;
    const demo = (await post({ text: DEMO_TEXT, demo: true })).body.objectiveId as string;
    const objA = await db.objective.findUniqueOrThrow({ where: { id: aaira } });
    const objO = await db.objective.findUniqueOrThrow({ where: { id: other } });
    const objD = await db.objective.findUniqueOrThrow({ where: { id: demo } });
    expect(objO.organizationId).toBe(objA.organizationId); // same founder company, separate objective memory
    const mem = (organizationId: string, objectiveId: string | null, title: string) => db.businessMemory.create({ data: { organizationId, objectiveId, kind: 'FACT', title, detail: '', status: 'FOUNDER_STATED', owner: 'Founder' } });
    await mem(objA.organizationId, aaira, 'AAIRA_ONLY_FACT');
    await mem(objA.organizationId, other, 'BAKERY_ONLY_FACT');
    await mem(objA.organizationId, null, 'ORG_LEVEL_NULL_FACT');
    await mem(objD.organizationId, demo, 'DEMO_ONLY_FACT');
    await mem(objD.organizationId, null, 'DEMO_ORG_NULL_FACT');

    const brief = await memoryBrief(objA.organizationId, aaira, 200);
    expect(brief).toContain('AAIRA_ONLY_FACT');
    for (const leak of ['BAKERY_ONLY_FACT', 'ORG_LEVEL_NULL_FACT', 'DEMO_ONLY_FACT', 'DEMO_ORG_NULL_FACT', 'glucometer']) expect(brief).not.toContain(leak);
    // A mismatched (org, objective) pair returns nothing rather than another objective's memory.
    expect(await memoryBrief(objD.organizationId, aaira)).toBe('No business memory yet.');

    // Execute an AI work item for Aaira Books whose model output has NO assumptions and NO founder inputs.
    const work = await db.work.create({ data: { organizationId: objA.organizationId, objectiveId: aaira, title: 'Write the back-cover blurb', description: 'd', deliverable: 'Blurb', capability: 'marketing', status: 'APPROVED', executionMode: 'AI' } });
    await db.workBrief.create({ data: { workId: work.id, objective: 'Sell the quiz book', deliverable: 'Blurb', inputs: [], constraints: { budget: 'Not set' }, successCriteria: ['Clear'], expectedOutput: 'Markdown', outOfScope: [], effort: {} } });
    execResult = { summary: 'Blurb written.', markdown: `# Blurb\n\n${'A fun quiz book for curious kids. '.repeat(12)}`, assumptions: [], founderInputsNeeded: [], professionalReviewRequired: false };
    const p0 = prompts.length;
    await executeWork({ work, objective: objA });
    const execPrompt = prompts.slice(p0).find((p) => p.task === 'execute')!.text;
    expect(execPrompt).toContain('"Aaira Books"');
    expect(execPrompt).toContain('AAIRA_ONLY_FACT');
    for (const leak of [DEMO, 'BAKERY_ONLY_FACT', 'ORG_LEVEL_NULL_FACT', 'DEMO_ONLY_FACT']) expect(execPrompt).not.toContain(leak);
    const exec = await db.execution.findFirstOrThrow({ where: { workId: work.id } });
    expect(exec.output!.startsWith(AI_PROVENANCE_MARKER)).toBe(true);
    expect(exec.output).toContain('AI-generated draft');

    // A legacy execution stored WITHOUT the marker is still labelled when shown and downloaded.
    await db.execution.update({ where: { id: exec.id }, data: { output: `# Legacy\n\n${'Old output. '.repeat(30)}` } });
    const { GET } = await import('@/app/api/hippo/work/[id]/output/route');
    const dl = await (await GET(new Request('http://x'), { params: Promise.resolve({ id: work.id }) })).text();
    expect(dl).toContain(AI_PROVENANCE_MARKER);
    expect(dl).toContain('AI-generated draft');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const WorkPage = (await import('@/app/work/[id]/page')).default;
    expect(renderToStaticMarkup(await WorkPage({ params: Promise.resolve({ id: work.id }) }))).toContain('AI-generated draft');
  });

  it('legacy data: a demo-only founder can still create a real objective; ambiguous legacy objectives get no company name', async () => {
    const { db } = await import('@/lib/db');
    const { companyFor } = await import('@/lib/hippo/service');
    // A legacy founder whose ONLY organisation was turned into the demo org by the old code (real + demo objectives in it).
    jar = new Map();
    const first = await post({ text: AAIRA_TEXT, companyName: 'Aaira Books' });
    const legacyOrg = (await db.objective.findUniqueOrThrow({ where: { id: first.body.objectiveId } })).organizationId;
    await db.objective.update({ where: { id: first.body.objectiveId }, data: { companyName: null } });
    await db.objective.create({ data: { organizationId: legacyOrg, text: DEMO_TEXT, mode: 'IDEA', isDemo: true } });
    await db.organization.update({ where: { id: legacyOrg }, data: { isDemo: true, name: DEMO } });
    expect(await companyFor({ companyName: null, organizationId: legacyOrg })).toBeNull(); // never "Demo Glucose" for Aaira

    const p0 = prompts.length;
    const next = await post({ text: 'Launch a second quiz book for teenagers next year with 2,000 copies.', companyName: null });
    expect(next.status).toBe(200); // no "INVARIANT VIOLATION" 500
    const o = await db.objective.findUniqueOrThrow({ where: { id: next.body.objectiveId }, include: { organization: true } });
    expect(o.organization.isDemo).toBe(false);
    expect(o.organizationId).not.toBe(legacyOrg);
    expect(o.companyName).toBeNull(); // the demo org's name is never inherited
    expect(understandPromptFor(p0)[0]).not.toContain(DEMO);
    expect(await db.organization.findUniqueOrThrow({ where: { id: legacyOrg } })).toMatchObject({ isDemo: true, name: DEMO }); // legacy rows untouched
  });

  it('migration backfill: single-objective named orgs only; multi-objective and generic names stay NULL; re-run safe', async () => {
    const { db } = await import('@/lib/db');
    const user = await db.user.create({ data: {} });
    const founder = await db.founder.create({ data: { userId: user.id } });
    const org = (name: string, isDemo = false) => db.organization.create({ data: { founderId: founder.id, name, isDemo } });
    const obj = (organizationId: string, companyName: string | null = null) => db.objective.create({ data: { organizationId, text: 't', mode: 'IDEA', companyName } });
    const single = await org('Sharma Medical Supplies'); const s1 = await obj(single.id);
    const multi = await org(DEMO, true); const m1 = await obj(multi.id); const m2 = await obj(multi.id);
    const generic: Record<string, string> = {};
    for (const name of ['My company', 'my company', '  My   Company ', '   ', 'Hippoturtle', 'Hippo Turtle Labs']) generic[name] = (await obj((await org(name)).id)).id;
    const preset = await org('Old Name'); const p1 = await obj(preset.id, 'Founder Given Name');

    const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261010000000_objective_company_name/migration.sql'), 'utf8').replace(/--.*$/gm, '');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt); // second run: no error, no change

    const name = async (id: string) => (await db.objective.findUniqueOrThrow({ where: { id } })).companyName;
    expect(await name(s1.id)).toBe('Sharma Medical Supplies');
    expect([await name(m1.id), await name(m2.id)]).toEqual([null, null]);
    for (const [n, id] of Object.entries(generic)) expect([n, await name(id)]).toEqual([n, null]);
    expect(await name(p1.id)).toBe('Founder Given Name'); // existing values are never overwritten
  });
});
