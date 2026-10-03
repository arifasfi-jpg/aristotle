// Work architecture end to end on a REAL PostgreSQL database, through the real routes, services and pages, with three
// different businesses owned by the same founder (Aaira Books, Demo Glucose Technologies, Ortus Global).
// Only Gemini HTTP and the cookie store are faked. Every prompt is captured so the test can show what Mogli and the
// capabilities actually received. The fake planner deliberately returns the WRONG capabilities and aiExecutable=false
// (as observed on Preview) to prove routing and execution class are derived from the work itself.
//
// Runs when HIPPO_E2E_DATABASE_URL / HIPPO_E2E_PRISMA_CLIENT / HIPPO_E2E_ADAPTER are set (see hippo-e2e.test.tsx).
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
const BIZ = {
  aaira: { company: 'Aaira Books', text: 'I am 10 years old and I want to write a quiz book for kids aged 8 to 15. Sell 5,000 physical books and 1,000 digital books.', marker: 'AAIRA_MEMORY_MARKER',
    work: [
      { title: 'Format the quiz book manuscript', description: 'Print-ready interior.', deliverable: 'Print-ready manuscript PDF', capability: 'operations', priority: 1, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: ['Print 500 copies at a local printer'] },
      { title: 'Create a sample PDF', description: 'Ten sample pages.', deliverable: 'Sample PDF', capability: 'technology', priority: 2, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: [] },
    ] },
  demo: { company: DEMO, text: 'We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month.', marker: 'GLUCOSE_MEMORY_MARKER', demo: true,
    work: [
      { title: 'Prepare financial baseline', description: 'Monthly sales, margin and cash from the supplied transaction data.', deliverable: 'Financial baseline report from supplied transaction data', capability: 'marketing', priority: 1, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: [] },
      { title: 'Transfer the advance payment to the supplier', description: 'Pay 30% advance.', deliverable: 'Advance paid', capability: 'finance', priority: 2, pathwayId: 'P1', whyNow: 'x', aiExecutable: true, externalSteps: [] },
    ] },
  ortus: { company: 'Ortus Global', text: 'Ortus Global sells handcrafted areca-leaf plates made in India from naturally fallen leaves to US households through D2C. Our plates are biodegradable.', marker: 'ORTUS_MEMORY_MARKER',
    work: [
      { title: 'Create the landing page', description: 'Wireframe and copy for US buyers.', deliverable: 'Landing page wireframe and copy', capability: 'technology', priority: 1, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: ['Publish on the founder\'s domain'] },
      { title: 'Create Google Ads campaign', description: 'Search campaign for areca plates.', deliverable: 'Google Search campaign structure, keywords and ads', capability: 'strategy', priority: 2, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: [] },
      { title: 'Publish the Google Ads campaign', description: 'Go live.', deliverable: 'Live campaign', capability: 'marketing', priority: 3, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: [] },
    ] },
};
type Key = keyof typeof BIZ;
const prompts: { task: string; text: string }[] = [];
const FAKE_LANDING = `# Ortus Global\n\n## Why Ortus\n- **100% Chemical-Free** — fallen leaves and water\n- **Sturdy & Leak-Proof**\n- Fully biodegradable and compostable within 60 days\n- Biodegradable\n- Loved by thousands of eco-conscious hosts\n\n## What our customers say\n> "These plates were perfect for our backyard wedding — guests kept asking!"\n> — Sarah M., Austin TX\n\n"Finally a disposable plate I don't feel guilty about." — **David K.**, Seattle WA\n\n${'Order a sample pack today. '.repeat(8)}`;

function gemini(text: string): unknown {
  const task = text.includes('Restate what this founder') ? 'understand' : text.includes('Convert the founder\'s chosen pathways') ? 'plan' : text.includes('Write a precise WORK BRIEF') ? 'brief' : text.includes('executing a work item') ? 'execute' : 'other';
  prompts.push({ task, text });
  const key = (Object.keys(BIZ) as Key[]).find((k) => text.includes(`"${BIZ[k].company}"`))!;
  switch (task) {
    case 'understand': return { objective: 'o', target: 't', currentState: 'c', keyQuestion: 'k', businessKind: 'NEW_IDEA' };
    case 'plan': return { headline: `Work for ${BIZ[key].company}`, work: BIZ[key].work };
    case 'brief': return { objective: 'o', deliverable: 'd', inputs: [], constraints: { budget: '', deadline: '', geography: 'US', brand: '', technology: '', regulatory: '' }, successCriteria: ['c1'], expectedOutput: 'Markdown', outOfScope: ['x'],
      effort: { aiFeasible: false, aiOutputTokens: 4000, specialist: 'Specialist', humanHours: { low: 4, high: 8 }, hourlyRateInr: { low: 600, high: 900 }, hybridReviewHours: { low: 1, high: 2 }, agencyMultiplier: { low: 1.5, high: 2 }, costDrivers: [], rateBasis: 'assumed' } };
    case 'execute': return { summary: 'Done.', markdown: text.includes('WORK: Create the landing page') ? FAKE_LANDING : `# Deliverable\n\n${'Prepared content. '.repeat(20)}`, assumptions: [], founderInputsNeeded: [], professionalReviewRequired: false };
    default: return {};
  }
}

beforeAll(() => {
  // Phase 1.1: like production (DATABASE_URL set → ledger on), ModelPrice is read from this real database; AI cost
  // estimates come from it and there is no env fallback price any more.
  Object.assign(process.env, { GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', DEMO_MODE: 'true', VERCEL_ENV: 'preview', HIPPO_USAGE_LEDGER: 'on' });
  delete process.env.HIPPO_WORK_PAYMENTS;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const text: string = JSON.parse(String(init?.body || '{}')).contents[0].parts[0].text;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini(text)) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); delete process.env.HIPPO_USAGE_LEDGER; });

const req = (body: unknown = {}) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function json(p: Promise<Response> | Response) { const r = await p; return { status: r.status, body: await r.json().catch(() => ({})) }; }

describe.skipIf(!E2E)('Work architecture across three businesses (real Postgres)', () => {
  it('routing, execution class, external actions, claims and isolation — Aaira Books, Demo Glucose, Ortus Global', async () => {
    const { db } = await import('@/lib/db');
    const { deterministicAudit } = await import('@/lib/audit');
    const { AI_PROVENANCE_MARKER } = await import('@/lib/hippo/execution');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const r = {
      objectives: await import('@/app/api/hippo/objectives/route'), work: await import('@/app/api/hippo/objectives/[id]/work/route'), brief: await import('@/app/api/hippo/work/[id]/brief/route'),
      choose: await import('@/app/api/hippo/work/[id]/choose/route'), execute: await import('@/app/api/hippo/work/[id]/execute/route'), output: await import('@/app/api/hippo/work/[id]/output/route'),
    };
    const WorkPage = (await import('@/app/work/[id]/page')).default;
    const page = async (id: string) => renderToStaticMarkup(await WorkPage({ params: ctx(id).params }));

    // One founder, three businesses (the demo goes to its own demo org).
    jar = new Map();
    const objective: Record<Key, string> = {} as never;
    const promptsFor: Record<Key, string[]> = { aaira: [], demo: [], ortus: [] };
    for (const k of Object.keys(BIZ) as Key[]) {
      const b = BIZ[k];
      const created = await json(r.objectives.POST(req({ text: b.text, companyName: 'demo' in b ? null : b.company, demo: 'demo' in b })));
      expect(created.status).toBe(200);
      objective[k] = created.body.objectiveId;
      const o = await db.objective.findUniqueOrThrow({ where: { id: objective[k] } });
      // Aristotle's output for this objective (decision memo + chosen pathway), and one memory entry only it owns.
      await db.decisionMemo.create({ data: { objectiveId: o.id, auditId: o.auditId!, content: { ...deterministicAudit({ idea: b.text, sector: 'Other' }), experiments: [], thirtyDayPlan: [] }, pathways: { goal: 'g', ambitionNote: '', combination: '', founderChecklist: [], pathways: [{ id: 'P1', name: `${b.company} pathway`, howItWorks: 'h', whyPlausible: 'w', evidence: [], economics: 'Not yet established.', constraints: [], risks: [], firstExperiment: 'f', contributionToTarget: 'c', evidenceStrength: 'NOT_YET_ESTABLISHED' }] } } });
      await db.objective.update({ where: { id: o.id }, data: { selectedPathways: ['P1'] } });
      await db.businessMemory.create({ data: { organizationId: o.organizationId, objectiveId: o.id, kind: 'FACT', title: b.marker, detail: '', status: 'FOUNDER_STATED', owner: 'Founder' } });
    }

    const works: Record<string, { id: string; capability: string; aiExecutable: boolean; title: string }> = {};
    for (const k of Object.keys(BIZ) as Key[]) {
      const from = prompts.length;
      expect((await json(r.work.POST(req(), ctx(objective[k])))).status).toBe(200);
      for (const w of await db.work.findMany({ where: { objectiveId: objective[k] } })) works[w.title] = w;
      promptsFor[k].push(...prompts.slice(from).map((p) => p.text));
    }
    // 17–19 + 1–5, 9: routed from the work itself (the planner said operations/technology/strategy and aiExecutable=false).
    const view = (t: string) => [works[t].capability, works[t].aiExecutable];
    expect(view('Format the quiz book manuscript')).toEqual(['marketing', true]);
    expect(view('Create a sample PDF')).toEqual(['marketing', true]);
    expect(view('Prepare financial baseline')).toEqual(['finance', true]);
    expect(view('Create the landing page')).toEqual(['marketing', true]);
    expect(view('Create Google Ads campaign')).toEqual(['marketing', true]);
    expect(view('Transfer the advance payment to the supplier')).toEqual(['finance', false]); // 10

    // Briefs + estimates + choice + execution for each business's AI work; prompts captured per objective.
    const run = async (k: Key, title: string) => {
      const from = prompts.length;
      expect((await json(r.brief.POST(req(), ctx(works[title].id)))).status).toBe(200);
      const modes = (await db.costEstimate.findMany({ where: { workId: works[title].id } })).map((e: { mode: string }) => e.mode);
      expect([title, modes.includes('AI')]).toEqual([title, true]); // the model's aiFeasible=false no longer removes AI
      expect((await json(r.choose.POST(req({ mode: 'AI' }), ctx(works[title].id)))).status).toBe(200);
      expect((await json(r.execute.POST(req(), ctx(works[title].id)))).status).toBe(200);
      promptsFor[k].push(...prompts.slice(from).map((p) => p.text));
      return db.execution.findFirstOrThrow({ where: { workId: works[title].id } });
    };
    const aairaExec = await run('aaira', 'Format the quiz book manuscript');
    await run('demo', 'Prepare financial baseline');
    const landing = await run('ortus', 'Create the landing page');

    // 10. Paying a supplier: the founder acts; AI-only is refused with the reason.
    await json(r.brief.POST(req(), ctx(works['Transfer the advance payment to the supplier'].id)));
    const pay = await json(r.choose.POST(req({ mode: 'AI' }), ctx(works['Transfer the advance payment to the supplier'].id)));
    expect(pay.status).toBe(400);
    expect(pay.body.error).toMatch(/A person needs to do this work/);

    // 6. Publishing the Google Ads campaign: AI prepares it; the external step needs the founder's account + approval.
    const publish = await page(works['Publish the Google Ads campaign'].id);
    expect(publish).toContain('Who does what');
    expect(publish).toContain('Publishing, sending or account steps need your approval and your own account.');
    expect(publish).toContain('External account (integration not connected yet)');
    expect(publish).toContain('Hippoturtle never publishes, sends, signs, files or pays on its own.');
    const prepared = await page(works['Create Google Ads campaign'].id);
    expect(prepared).toContain('routed by Mogli to Aaira Studio › Google Search campaign');
    expect(prepared).toContain('Publish via Google Ads integration from your own account');
    for (const html of [publish, prepared, await page(works['Format the quiz book manuscript'].id)]) expect(html).not.toContain('AI cannot do this work on its own');
    expect(await page(works['Format the quiz book manuscript'].id)).toContain('Print 500 copies at a local printer');

    // 11–16. The landing page as stored, shown and downloaded: no invented testimonials or social proof as facts.
    for (const md of [landing.output!, await (await r.output.GET(new Request('http://x'), ctx(works['Create the landing page'].id))).text(), await page(works['Create the landing page'].id)]) {
      expect(md).toContain('AI-generated draft');
      expect(md).not.toMatch(/Sarah M\.|David K\.|Austin TX|Seattle WA/);
      expect(md).toContain('CUSTOMER TESTIMONIAL — INSERT VERIFIED CUSTOMER QUOTE');
      expect(md).toContain('UNSUPPORTED CLAIM — DO NOT PUBLISH: Loved by thousands of eco-conscious hosts');
      expect(md).toContain('CLAIM TO VERIFY: 100% Chemical-Free');
    }
    expect(landing.output!.startsWith(AI_PROVENANCE_MARKER)).toBe(true);
    expect(aairaExec.output!.startsWith(AI_PROVENANCE_MARKER)).toBe(true);
    const claims = (landing.input as { claims: { text: string; label: string }[] }).claims;
    expect(claims.find((c) => c.text === 'Biodegradable')).toMatchObject({ label: 'FOUNDER_APPROVED' }); // stated in Ortus's objective
    expect(claims.filter((c) => c.label === 'PLACEHOLDER')).toHaveLength(2);

    // Legacy brief (written before classification, the model said "not AI-feasible" → no AI estimate stored):
    // the work's class allows AI, so choosing AI computes and stores the estimate instead of refusing.
    const sample = works['Create a sample PDF'];
    await json(r.brief.POST(req(), ctx(sample.id)));
    await db.costEstimate.deleteMany({ where: { workId: sample.id, mode: 'AI' } });
    expect(await page(sample.id)).toContain('AI / internal execution');
    expect((await json(r.choose.POST(req({ mode: 'AI' }), ctx(sample.id)))).status).toBe(200);
    expect(await db.costEstimate.count({ where: { workId: sample.id, mode: 'AI' } })).toBe(1);

    // 21–23. Cross-objective isolation of every prompt Mogli and the capabilities received; 24. capability ≠ company.
    const others: Record<Key, string[]> = {
      aaira: [DEMO, 'Ortus Global', 'glucomet', 'pharmac', 'areca', BIZ.demo.marker, BIZ.ortus.marker],
      demo: ['Aaira Books', 'Ortus Global', 'quiz book', 'areca', BIZ.aaira.marker, BIZ.ortus.marker],
      ortus: ['Aaira Books', DEMO, 'quiz book', 'glucomet', 'pharmac', BIZ.aaira.marker, BIZ.demo.marker],
    };
    for (const k of Object.keys(BIZ) as Key[]) {
      expect(promptsFor[k].length).toBeGreaterThanOrEqual(3); // plan, brief, execute
      for (const p of promptsFor[k]) {
        expect(p).toContain(`"${BIZ[k].company}"`);
        expect(p).toContain(BIZ[k].marker);
        for (const leak of others[k]) expect([k, leak, p.includes(leak)]).toEqual([k, leak, false]);
      }
    }
    const ortusExec = promptsFor.ortus.find((p) => p.includes('executing a work item'))!;
    expect(ortusExec).toContain('Aaira Studio');                                  // the executing capability …
    expect(ortusExec).toContain('business being analysed and served is "Ortus Global"'); // … is never the company
    const aairaExecPrompt = promptsFor.aaira.find((p) => p.includes('executing a work item'))!;
    expect(aairaExecPrompt).toContain('business being analysed and served is "Aaira Books"');
    expect(aairaExecPrompt).not.toContain('"Aaira Studio"');
  });
});
