// Phase 3A on REAL PostgreSQL: the Hippo conversation through the real route, real gateway / ledger / free-tier cap,
// real handoff into the existing objective → Aristotle audit → job pipeline. Only Gemini/Tavily HTTP and the cookie jar
// are faked. Skipped without the HIPPO_E2E_* database env.
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

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: string[] = [];
const env = { ...process.env };
// Scripted Hippo turns, keyed by the founder's last message.
const HIPPO: Record<string, Row> = {
  'I want to build a business selling glucometers and reach 10,000 units a month.': { intent: 'OBJECTIVE', objective: 'Build a glucometer business to 10,000 units a month', ready_to_propose: false, reply: "Interesting. Before I start digging — are you already selling, or starting from zero? Or just tell me in your own words." },
  'We already sell 1,400 units a month. Distribution is the problem.': { intent: 'ANSWER', current_state: 'Selling about 1,400 a month', constraints: ['Distribution is the bottleneck'], founder_facts: [{ key: 'bottleneck', value: 'distribution', quote: 'Distribution is the problem' }], ready_to_propose: true, reply: 'Got it.' },
  "Sorry, carry on. Let's continue.": { intent: 'OTHER', ready_to_propose: true, reply: 'Back on it.' },
};
const PLAN = { businessModel: { summary: 'Glucometers via pharmacies', customer: 'Diabetics', payer: 'Patients', offering: 'Glucometers', revenueMechanism: 'Unit sales', keyActivities: ['Distribution'], regulatedActivities: [] },
  questions: ['where buy glucometers india pharmacy', 'indiamart glucometer buyers', 'glucometer distributor margin', 'home glucose testing india'].map((query, i) => ({ category: ['CHANNEL', 'CHANNEL', 'COST', 'DEMAND'][i], question: `Question ${i + 1}: ${query}?`, whyItMatters: 'x', query })) };

beforeAll(() => {
  Object.assign(process.env, { HIPPO_USAGE_LEDGER: 'on', GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', DEMO_MODE: 'true', VERCEL_ENV: 'preview', GEMINI_MODEL: 'gemini-3.5-flash-lite', USD_INR: '88' });
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.HIPPO_AI_PROVIDER; delete process.env.HIPPO_TIER0_MODEL; delete process.env.HIPPO_TIER1_MODEL; delete process.env.HIPPO_FREE_AI_DAILY_CAP_INR;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (String(url).includes('tavily')) { calls.push('search'); return new Response(JSON.stringify({ results: body.query.includes('pharmacy') ? [{ title: 'Pharmacy report', url: 'https://example.org/pharmacy', content: 'Retail chemists remain the main point of purchase for home glucose monitoring devices.' }] : [] }), { status: 200 }); }
    const prompt: string = body.contents[0].parts[0].text;
    let data: unknown;
    if (prompt.startsWith('You are Hippo —')) {
      calls.push('converse');
      const last = prompt.slice(prompt.lastIndexOf('"""', prompt.length - 4) + 3, prompt.length - 3);
      data = HIPPO[last] ?? { intent: 'OTHER', ready_to_propose: false, reply: 'Tell me more?' };
    } else if (prompt.includes('Restate what this founder')) { calls.push('understand'); data = { objective: 'Grow to 10,000 units', target: '10,000 units/month', currentState: '1,400 units/month', keyQuestion: 'Which channels?', businessKind: 'EXISTING_BUSINESS' }; }
    else if (prompt.includes('Classify this request for Aristotle')) { calls.push('classify'); data = { scope: 'GROWTH_PLAN', confidence: 0.9, reason: 'Existing sales' }; }
    else if (prompt.includes('research planner')) { calls.push('plan'); data = PLAN; }
    else if (prompt.includes('You extract evidence')) { calls.push('extract'); data = prompt.includes('Question 1:') ? { status: 'ANSWERED', findings: [{ statement: 'Chemists are the main purchase point.', sourceId: 'S1', quote: 'Retail chemists remain the main point of purchase', confidence: 'MEDIUM' }] } : { status: 'NOT_FOUND', findings: [] }; }
    else { calls.push('decision'); const { deterministicAudit } = await import('@/lib/audit'); data = { ...deterministicAudit({ idea: 'Glucometers', sector: 'Healthtech' }), unitEconomics: [] }; }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 150 } }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); process.env = { ...env }; });

const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
const req = (b: unknown) => new Request('http://hippo.test/api/hippo/conversation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify(b) });
const count = (k: string) => calls.filter((c) => c === k).length;

describe.skipIf(!E2E)('Hippo conversation (real Postgres)', () => {
  it('conversation → proposal → stop → resume → approval → existing pipeline → research → Hippo explains; persisted; metered', async () => {
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const route = await import('@/app/api/hippo/conversation/route');
    const say = async (text: string) => { const r = await route.POST(req({ text })); expect(r.status).toBe(200); return r.json(); };
    jar = new Map();

    // Opening: nothing is created just by looking.
    const users0 = await db.user.count();
    const first = await (await route.GET()).json();
    expect(first.messages).toEqual([expect.objectContaining({ role: 'HIPPO', text: 'Alright bro. What are you trying to build or achieve?' })]);
    expect(await db.user.count()).toBe(users0);

    // 1–2: objective → one question; no objective/audit/research yet.
    let v = await say('I want to build a business selling glucometers and reach 10,000 units a month.');
    expect(v.messages.at(-1)).toMatchObject({ role: 'HIPPO', text: expect.stringMatching(/already selling, or starting from zero\?/) });
    expect(v.phase).toBe('DISCOVER');
    expect(v.state.target).toMatchObject({ provenance: 'FOUNDER', value: expect.stringMatching(/10,000/) });
    const userId = (await db.conversation.findUnique({ where: { id: v.id } })).userId;
    v = await say('We already sell 1,400 units a month. Distribution is the problem.');
    expect(v.phase).toBe('PROPOSED');
    expect(v.messages.at(-1).text).toMatch(/Here's what I think we're solving[\s\S]*Want me to dig in\?/);
    expect(v.state.known_facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'current_monthly_volume', value: '1400', provenance: 'FOUNDER' }), expect.objectContaining({ key: 'bottleneck', quote: 'Distribution is the problem', provenance: 'FOUNDER' })]));
    // 9: research NOT triggered before approval.
    const founder = await db.founder.findUnique({ where: { userId } });
    const orgIds = (await db.organization.findMany({ where: { founderId: founder.id } })).map((o: Row) => o.id);
    expect(await db.objective.count({ where: { organizationId: { in: orgIds } } })).toBe(0);
    expect(await db.audit.count({ where: { userId } })).toBe(0);
    expect(['plan', 'search', 'understand'].map(count)).toEqual([0, 0, 0]);

    // 6: stop — no model call, no handoff; a later "yes" is not approval.
    const c0 = count('converse');
    v = await say('Stop.');
    expect(v).toMatchObject({ status: 'PAUSED', phase: 'DISCOVER' });
    expect(count('converse')).toBe(c0);
    v = await say("Sorry, carry on. Let's continue.");
    expect(v).toMatchObject({ status: 'ACTIVE', phase: 'PROPOSED' });

    // 7: survives refresh — GET and the server-rendered /start page show the same conversation.
    const refreshed = await (await route.GET()).json();
    expect(refreshed.messages.map((m: Row) => m.text)).toEqual(v.messages.map((m: Row) => m.text));
    const { renderToStaticMarkup } = await import('react-dom/server');
    const html = renderToStaticMarkup(await (await import('@/app/start/page')).default());
    expect(html).toContain('We already sell 1,400 units a month. Distribution is the problem.');
    expect(html).toContain('Want me to dig in?');
    expect(html).toContain('Prefer a form?'); // 11: classic form with the demo example kept as a secondary path

    // 10: explicit approval → handoff into the existing pipeline (objective + understanding + pending ₹99 audit).
    const c1 = count('converse');
    v = await say('Yes, dig in');
    expect(count('converse')).toBe(c1); // approval needs no model call
    expect(v).toMatchObject({ phase: 'HANDED_OFF', status: 'HANDED_OFF', objectiveId: expect.any(String), auditId: expect.any(String) });
    expect(v.messages.at(-1)).toMatchObject({ kind: 'HANDOFF' });
    const objective = await db.objective.findUnique({ where: { id: v.objectiveId } });
    expect(objective.text).toContain('1,400 units a month'); // founder's exact words go to the engine
    expect(objective.understanding).toMatchObject({ source: 'AI' });
    expect(await db.audit.findUnique({ where: { id: v.auditId } })).toMatchObject({ userId, paymentStatus: 'pending', report: '{}' });
    expect(count('understand')).toBe(1);
    expect(count('plan')).toBe(0); // research itself starts at the existing scope / ₹99 step

    // Existing research path (unchanged): scope confirm → demo order → verify → job → Aristotle.
    const scope = await import('@/app/api/audits/[id]/scope/route');
    const ctx = { params: Promise.resolve({ id: v.auditId }) };
    const sug = await (await scope.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'suggest' }) }), ctx)).json();
    expect(sug.facts.some((f: Row) => /1,400/.test(f.raw))).toBe(true); // the founder's number reached Aristotle intact
    await scope.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'confirm', scope: 'GROWTH_PLAN', facts: sug.facts, factsReviewed: true }) }), ctx);
    await (await import('@/app/api/payments/create-order/route')).POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ auditId: v.auditId }) }));
    expect((await (await import('@/app/api/payments/verify/route')).POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ auditId: v.auditId, demo: true }) }))).status).toBe(200);
    await (await import('@/lib/jobs')).settleDetached();
    expect((await db.audit.findUnique({ where: { id: v.auditId } })).status).toBe('completed');
    // Control returns to Hippo: one plain-words explanation, even across several loads.
    await route.GET();
    const after = await (await route.GET()).json();
    const results = after.messages.filter((m: Row) => m.kind === 'RESULT');
    expect(results).toHaveLength(1);
    expect(results[0].text).toMatch(/^The research is back\. Short version:/);

    // 12: every Hippo turn went through the metered gateway on the cheapest tier.
    const turns = await db.aiUsage.findMany({ where: { task: 'converse', userId } });
    expect(turns).toHaveLength(count('converse'));
    expect(turns.every((t: Row) => t.purpose === 'CONVERSATION' && t.tier === 0 && t.model === 'gemini-3.5-flash-lite' && t.priceSource === 'VERIFIED_PRICE' && t.costInr > 0)).toBe(true);

    // Owner-only: another visitor sees only the opening.
    jar = new Map();
    expect((await (await route.GET()).json()).messages).toHaveLength(1);
  }, 30_000);

  it('12: the free-tier cap refuses the model turn (recorded); Hippo still answers deterministically without inventing anything', async () => {
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { clearSpendCache } = await import('@/lib/ai-usage');
    const route = await import('@/app/api/hippo/conversation/route');
    jar = new Map();
    process.env.HIPPO_FREE_AI_DAILY_CAP_INR = '0'; clearSpendCache();
    const c0 = count('converse');
    const r = await route.POST(req({ text: "I don't know" }));
    expect(r.status).toBe(200);
    const v = await r.json();
    expect(count('converse')).toBe(c0); // no provider call
    expect(v.messages.at(-1).text).toMatch(/No problem\. Let's work it out/);
    expect(await db.aiUsage.count({ where: { task: 'converse', outcome: 'REFUSED_BUDGET' } })).toBeGreaterThan(0);
    delete process.env.HIPPO_FREE_AI_DAILY_CAP_INR; clearSpendCache();
    // "Start over" archives (nothing deleted).
    const fresh = await (await route.POST(req({ action: 'new' }))).json();
    expect(fresh.messages).toHaveLength(1);
    expect(await db.conversation.count({ where: { id: v.id, status: 'ARCHIVED' } })).toBe(1);
    expect(await db.conversationMessage.count({ where: { conversationId: v.id } })).toBe(2);
  });

  it('11: the existing demo objective path still works', async () => {
    jar = new Map();
    const { POST } = await import('@/app/api/hippo/objectives/route');
    const { DEMO_OBJECTIVE } = await import('@/components/hippo/StartFlow');
    const r = await POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.${Math.floor(Math.random() * 200) + 20}` }, body: JSON.stringify({ text: DEMO_OBJECTIVE, demo: true }) }));
    expect(r.status).toBe(200);
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await db.objective.findUnique({ where: { id: (await r.json()).objectiveId } })).toMatchObject({ isDemo: true, companyName: 'Demo Glucose Technologies' });
  });
});
