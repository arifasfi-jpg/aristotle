// V1 Moves on REAL PostgreSQL (HIPPO_MOVES=on): intent → Move → (authorization) → action → signal → learn → next Move.
// Real routes, real job runtime, real gateway + cost governor + ledger, real validation; only the model's HTTP replies and
// the cookie jar are faked. The model replies are chosen by what the prompt contains, so the tests also prove that the
// Move engine is fed the right state (founder capacity, history, signals, blocked routes).
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
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (u: string) => { throw new Error(`REDIRECT ${u}`); }, useRouter: () => ({ refresh() {}, push() {} }) }));
const razorpay = { constructed: 0 };
vi.mock('razorpay', () => ({ default: class { constructor() { razorpay.constructed++; } orders = { create: async () => ({}), fetch: async () => ({}), fetchPayments: async () => ({ items: [] }) }; } }));

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type MoveBody = { move: Row; reply: string; beliefs: Row[] };
const QUIZ = 'I am 10 years old bro. I want to start a business of quiz books for kids. I want to sell 5,000 books through ecommerce.';
const LAKH = 'I want to make ₹1 lakh a month but I have no idea how.';
const prompts: { kind: string; text: string }[] = [];

const mv = (o: Row): MoveBody => ({ move: { kind: 'TEST', owner: 'FOUNDER', costInr: 0, costBasis: 'free', artifactType: 'DOCUMENT', consequential: false, researchJustification: '', needs: [], ...o }, reply: o.reply ?? `Here's what I'd do: ${o.title}.`, beliefs: o.beliefs ?? [] });
const SAMPLE = mv({ title: 'Make a 10-question sample and try it on 5 friends', why: 'Before printing anything, find out if kids enjoy your quizzes.', bet: 'Kids finish it and ask for more', hippoWill: 'Turn your questions into a fun printable sample with your name on it', needs: ['Tell me 10 quiz questions on a topic you love', 'Give the printed sample to 5 friends'], expectedSignal: 'How many finish it and which round they like most', artifactBrief: 'A printable 10-question sample', routeKey: 'friends sample test' });
const PAGE = mv({ kind: 'SELL', owner: 'HIPPO', title: 'Put up a pre-order page parents can respond to', why: 'Kids liked it — now see if parents will want to buy it.', bet: 'Parents of 8–12 year olds will register interest', hippoWill: 'Make and host the page; I see every response', needs: ['A parent to say OK', 'Share the link in a parents WhatsApp group'], expectedSignal: 'Parents leaving their contact to pre-order', artifactType: 'PUBLIC_PAGE', artifactBrief: 'Pre-order interest page', routeKey: 'parents preorder page', beliefs: [{ key: 'kids-enjoy', statement: 'Kids enjoy the quizzes, especially animals', confidence: 'MEDIUM', evidence: '5 of 6 friends finished the sample', disprovedIf: 'A wider group of kids does not finish it' }] });
const LIBRARY = mv({ kind: 'TEST', title: 'Ask your school librarian to try the sample with a class', why: 'A teacher can put it in front of many kids at once.', bet: 'A class will enjoy it', hippoWill: 'Write a short note for the librarian', needs: ['Give the note to the librarian'], expectedSignal: 'Whether the librarian agrees and what the class says', artifactBrief: 'A note for the librarian', routeKey: 'school library test' });
const PRINT_RUN = mv({ kind: 'BUILD', title: 'Print 50 copies at a local shop', why: 'Have stock to sell', bet: 'People will buy printed copies', hippoWill: 'Find a printer and prepare the files', needs: ['Pay the printer'], costInr: 2000, costBasis: 'estimate: local print shop', expectedSignal: 'Copies in hand', artifactBrief: 'Print-ready file', routeKey: 'print fifty copies' });
const LUNCH = mv({ kind: 'SELL', owner: 'HIPPO', title: 'Pre-order page for home-cooked lunch boxes near offices', why: 'Office workers nearby want home food; test before cooking.', bet: 'Office workers will pre-order', hippoWill: 'Make and host the page', needs: ['Share the link with 2 office groups'], expectedSignal: 'Pre-order requests in 3 days', artifactType: 'PUBLIC_PAGE', artifactBrief: 'Lunch box pre-order page', routeKey: 'lunchbox preorder page' });

function model(prompt: string): unknown {
  const quoted = [...prompt.matchAll(/"""([\s\S]*?)"""/g)];
  const last = quoted.at(-1)?.[1]?.trim() || '';
  if (prompt.startsWith('MOVE ENGINE')) {
    prompts.push({ kind: 'move', text: prompt });
    const retry = prompt.includes('YOUR PREVIOUS PROPOSAL WAS REJECTED');
    if (prompt.includes('Make this easier')) return mv({ ...SAMPLE.move, title: 'Tell me 3 quiz questions now — I’ll write the librarian note', routeKey: 'librarian note together', needs: ['Say 3 questions out loud to me'] });
    if (prompt.includes('money available: ₹500') && !retry) return PRINT_RUN;                         // over budget → must be rejected
    if (prompt.includes('the last Move failed') && !retry) return PAGE;                                 // repeats the failed route → rejected
    if (prompt.includes('money available: ₹500') || prompt.includes('the last Move failed') || prompt.includes("can't or won't") || prompt.includes('different route')) return LIBRARY;
    if (prompt.includes('Chosen direction')) return LUNCH;
    if (prompt.includes('WHAT THE WORLD SAID:\n- founder reported') || prompt.includes('seen by Hippo')) return prompt.includes('seen by Hippo') ? mv({ kind: 'SELL', title: 'Reply to Priya and ask what price feels fair', why: 'A real parent responded.', bet: 'She will name a price', hippoWill: 'Draft the reply', needs: ['Send the reply'], expectedSignal: 'A price she would pay', artifactBrief: 'Reply draft', routeKey: 'ask first parent price' }) : PAGE;
    return SAMPLE;
  }
  if (prompt.startsWith('PREPARE ARTIFACT')) {
    prompts.push({ kind: 'prepare', text: prompt });
    return prompt.includes('PUBLIC PAGE')
      ? { title: 'Pre-order page', markdown: 'Page summary', page: { headline: prompt.includes('lunch') ? 'Home-cooked lunch boxes, delivered' : 'Animal Quiz Book by Aaira (age 10)', subhead: 'Fun quizzes written by a kid, for kids', body: 'Ten animal quizzes. Leave your contact and you will hear when it is ready.', cta: 'Tell me when it’s ready' } }
      : { title: 'Animal Quiz — sample', markdown: '# Animal Quiz (sample)\n\n1. Which animal sleeps standing up?\n\n| Friend | Finished? | Favourite round |\n|---|---|---|' };
  }
  if (prompt.includes("doesn't know what yet")) {
    prompts.push({ kind: 'directions', text: prompt });
    return { directions: [
      { title: 'Home-cooked lunch boxes', whoItServes: 'office workers nearby', whyYou: 'You cook well', firstTest: 'Pre-order page shared in 2 office groups', objective: 'I want to sell home-cooked lunch boxes to office workers', firstMoveCostInr: 0, firstMoveDays: 3 },
      { title: 'Weekend cooking classes', whoItServes: 'young professionals', whyYou: 'You cook well', firstTest: 'Offer one class to 5 people', objective: 'I want to run weekend cooking classes', firstMoveCostInr: 500, firstMoveDays: 7 },
      { title: 'Festival sweets boxes', whoItServes: 'families before festivals', whyYou: 'You cook well', firstTest: 'Take 10 pre-orders', objective: 'I want to sell festival sweet boxes', firstMoveCostInr: 1000, firstMoveDays: 5 },
    ], recommended: 0, why: 'daily demand, and you can test it this week for free' };
  }
  if (prompt.startsWith("You are Hippo — the founder's operating partner")) {
    prompts.push({ kind: 'moving', text: prompt });
    if (/loved the animal round/.test(last)) return { intent: 'SIGNAL', reply: 'That’s a great sign!', signal: { summary: '5 of 6 friends finished the sample; they loved the animal round', polarity: 'POSITIVE', outcome: false } };
    if (/only have ₹500/.test(last)) return { intent: 'CORRECTION', reply: 'Noted — ₹500 it is.', budgetInr: 500 };
    if (/what grade/.test(last)) return { intent: 'QUESTION', reply: 'Ages 8 to 12 — that’s who the sample is for.' };
    return { intent: 'OTHER', reply: 'Got it.' };
  }
  if (prompt.startsWith('You are Hippo —')) {
    prompts.push({ kind: 'turn', text: prompt });
    if (last.startsWith('I am 10 years old')) return { intent: 'OBJECTIVE', reply: 'Love it.', ready_to_propose: true, objective: 'Quiz books for kids, written by a kid', target: '5,000 books through ecommerce', current_state: 'Just an idea', has_business_idea: true };
    if (last === LAKH) return { intent: 'DONT_KNOW', reply: 'No problem.', ready_to_propose: false, has_business_idea: false, objective: 'Make ₹1 lakh a month' };
    return { intent: 'ANSWER', reply: 'Nice — and how much time could you give it?', ready_to_propose: true, has_business_idea: false };
  }
  return { ok: true };
}

const env = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, { HIPPO_MOVES: 'on', HIPPO_USAGE_LEDGER: 'on', GEMINI_API_KEY: 'test', TAVILY_API_KEY: 'test', GEMINI_MODEL: 'gemini-3.5-flash-lite', USD_INR: '88', VERCEL_ENV: 'preview' });
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.HIPPO_AI_PROVIDER; delete process.env.HIPPO_TIER0_MODEL; delete process.env.HIPPO_TIER1_MODEL; delete process.env.HIPPO_FREE_AI_DAILY_CAP_INR; delete process.env.HIPPO_MOVE_JOB_INR;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (String(url).includes('tavily')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    const data = model(body.contents[0].parts[0].text);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 } }), { status: 200 });
  }));
});
afterAll(() => { vi.unstubAllGlobals(); process.env = { ...env }; });
beforeEach(async () => { const { clearPriceCache, clearSpendCache } = await import('@/lib/ai-usage'); clearPriceCache(); clearSpendCache(); });

const ip = () => `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
async function mods() {
  const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const jobs = await import('@/lib/jobs');
  const conv = await import('@/app/api/hippo/conversation/route');
  const moveRoute = await import('@/app/api/hippo/moves/[id]/route');
  const pub = await import('@/app/api/p/[slug]/route');
  const addr = ip();
  const say = async (text: string) => { const r = await conv.POST(new Request('http://hippo.test/api/hippo/conversation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': addr }, body: JSON.stringify({ text }) })); expect(r.status).toBe(200); await jobs.settleDetached(); return view(); };
  const view = async () => { const r = await conv.GET(); await jobs.settleDetached(); return (await r.json()) as Row; };
  const act = async (id: string, b: Row) => { const r = await moveRoute.POST(new Request('http://hippo.test/api/hippo/moves/x', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': addr }, body: JSON.stringify(b) }), { params: Promise.resolve({ id }) }); await jobs.settleDetached(); const body = (await r.json()) as Row; return { status: r.status, body: body.thinking ? await view() : body }; }; // the UI polls while Hippo is thinking
  const respond = async (slug: string, b: Row) => pub.POST(new Request(`http://hippo.test/api/p/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip() }, body: JSON.stringify(b) }), { params: Promise.resolve({ slug }) });
  return { db, jobs, say, view, act, respond };
}
const lastHippo = (v: Row) => [...v.messages].reverse().find((m: Row) => m.role === 'HIPPO').text as string;

describe.skipIf(!E2E)('V1 Moves (real Postgres)', () => {
  it('CANONICAL quiz book: vague intent → small real move → real action → real external signal → learning → next move (no report)', async () => {
    const { db, say, view, act, respond } = await mods();
    jar = new Map();
    let v = await say(QUIZ);
    // A first Move — not a report, not a payment.
    expect(v.move).toMatchObject({ title: SAMPLE.move.title, owner: 'FOUNDER', cost: 'Free', status: 'READY', consequential: false });
    expect(v.move.artifact).toMatchObject({ type: 'DOCUMENT', markdown: expect.stringContaining('Animal Quiz') });
    expect(JSON.stringify(v.messages)).not.toMatch(/report|₹99|dig in/i);
    expect(v.state.profile).toMatchObject({ age: 10, minor: true, casual: true });
    const enginePrompt = prompts.filter((p) => p.kind === 'move').at(-1)!.text;
    expect(enginePrompt).toContain('age 10 (UNDER 18)');
    expect(enginePrompt).toContain('this is the first Move');
    const first = await db.move.findUnique({ where: { id: v.move.id } });
    expect(first).toMatchObject({ rung: 2, status: 'READY' });
    const work = await db.work.findUnique({ where: { id: first.workId }, include: { executions: true } });
    expect([work.status, work.executions[0].status]).toEqual(['READY', 'PREPARED']); // prepared, never "completed"
    expect(await db.audit.count({ where: { id: (await db.objective.findUnique({ where: { id: first.objectiveId } })).auditId, paymentStatus: 'paid' } })).toBe(0);

    // Yes → the founder does it → "what happened?"
    expect((await act(v.move.id, { action: 'YES' })).body.move.status).toBe('APPROVED');
    v = (await act(v.move.id, { action: 'DID_IT' })).body;
    expect(v.move).toMatchObject({ status: 'LIVE', proofSource: 'FOUNDER_REPORTED' });
    v = await say('5 of 6 friends finished it and loved the animal round');
    const sig = await db.outcome.findFirst({ where: { moveId: first.id } });
    expect(sig).toMatchObject({ rung: 4, source: 'FOUNDER_REPORTED', polarity: 'POSITIVE' });
    // Learned: belief updated, and the next Move reflects the signal (prompt contained it).
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('founder reported: 5 of 6 friends finished the sample');
    expect(await db.businessMemory.findFirst({ where: { kind: 'BELIEF', refId: { endsWith: ':kids-enjoy' } } })).toMatchObject({ title: 'Kids enjoy the quizzes, especially animals', confidence: 'MEDIUM' });
    expect(await db.move.findUnique({ where: { id: first.id } })).toMatchObject({ status: 'DONE' });
    expect(v.move).toMatchObject({ title: PAGE.move.title, owner: 'HIPPO', status: 'READY', consequential: true, needsGuardian: true });
    expect(v.move.okBecause).toEqual(expect.arrayContaining(['it goes public', "it collects people's contact details", "you're under 18, so a parent or guardian must OK it"]));
    expect(v.move.artifact).toMatchObject({ type: 'PUBLIC_PAGE', status: 'DRAFT' });

    // Consequential + minor: a plain yes is not enough; a guardian's OK publishes it.
    const noGuardian = await act(v.move.id, { action: 'YES' });
    expect(noGuardian.body.move.status).toBe('READY');
    expect(lastHippo(noGuardian.body)).toMatch(/parent or guardian/);
    v = (await act(v.move.id, { action: 'YES', guardian: true })).body;
    expect(v.move).toMatchObject({ status: 'LIVE', proofSource: 'SYSTEM_VERIFIED', proof: `/p/${v.move.artifact.slug}` });
    expect(await db.move.findUnique({ where: { id: v.move.id } })).toMatchObject({ authorizedBy: 'GUARDIAN', rung: 3 });
    const slug = v.move.artifact.slug;

    // The founder's own test is not counted; a stranger's response is a Signal Hippo sees by itself.
    expect((await respond(slug, { name: 'Me', contact: 'me@example.com' })).status).toBe(200);
    const founderJar = jar; jar = new Map();
    expect((await respond(slug, { name: 'Priya Sharma', contact: 'priya@example.com', message: 'My son would love this' })).status).toBe(200);
    jar = founderJar;
    const signals = await db.outcome.findMany({ where: { moveId: v.move.id }, orderBy: { createdAt: 'asc' } });
    expect(signals.map((s: Row) => [s.source, s.external])).toEqual([['SYSTEM_OBSERVED', false], ['SYSTEM_OBSERVED', true]]);
    v = await view();
    expect(v.move.status).toBe('SIGNALLED');
    expect(v.messages.some((m: Row) => m.kind === 'SIGNAL' && /Priya responded/.test(m.text))).toBe(true);
    expect(v.quick).toEqual(["What's next?"]);

    // Next Move reflects what the world said.
    v = await say("What's next?");
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('seen by Hippo: Priya responded');
    expect(v.move.title).toBe('Reply to Priya and ask what price feels fair');
    // Ledger: real actions and signals only, each with who saw it.
    const ledger = await db.businessMemory.findMany({ where: { refType: 'move-ledger', objectiveId: first.objectiveId } });
    expect(ledger.map((l: Row) => l.status)).toEqual(expect.arrayContaining(['FOUNDER_STATED', 'VERIFIED_FACT']));
    expect(razorpay.constructed).toBe(0);
  }, 60_000);

  it('escape routes: "I can\'t" and "this failed" find another way (never the same failed route); "help me" makes it smaller', async () => {
    const { db, say, act } = await mods();
    jar = new Map();
    let v = await say(QUIZ);
    const sample = v.move;
    v = await say("I can't do this — I don't want to give it to friends");
    expect(await db.move.findUnique({ where: { id: sample.id } })).toMatchObject({ status: 'DECLINED' });
    expect(v.state.capacity.avoid).toEqual(expect.arrayContaining(['give it to friends']));
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toMatch(/can't or won't[\s\S]*friends-sample-test/);
    expect(v.move.title).toBe(LIBRARY.move.title);

    v = (await act(v.move.id, { action: 'HELP' })).body;
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('Make this easier: "Ask your school librarian');
    expect(v.move.title).toMatch(/Tell me 3 quiz questions now/);

    // "This failed": a negative signal, and the engine's attempt to repeat the failed route is rejected and retried.
    const failing = v.move;
    const before = prompts.filter((p) => p.kind === 'move').length;
    v = (await act(failing.id, { action: 'FAILED', text: 'Nobody wanted to answer' })).body;
    expect(await db.outcome.findFirst({ where: { moveId: failing.id } })).toMatchObject({ polarity: 'NEGATIVE', rung: 4 });
    expect(await db.move.findUnique({ where: { id: failing.id } })).toMatchObject({ status: 'FAILED' });
    expect(v.move.routeKey ?? v.move.title).not.toBe(failing.title);
    expect(prompts.length - before).toBeGreaterThanOrEqual(1);

    // Exactly one current Move per business, enforced by the database.
    const objectiveId = (await db.move.findUnique({ where: { id: sample.id } })).objectiveId;
    expect(await db.move.count({ where: { objectiveId, status: { in: ['PROPOSED', 'PREPARING', 'READY', 'APPROVED', 'LIVE', 'SIGNALLED', 'PARKED'] } } })).toBe(1);
    await expect(db.move.create({ data: { organizationId: 'x', objectiveId, kind: 'TEST', owner: 'FOUNDER', title: 't', why: 'w', bet: 'b', hippoWill: 'h', needs: [], costBasis: 'free', expectedSignal: 'e', routeKey: 'r', consequentialReasons: [], status: 'PROPOSED' } })).rejects.toThrow();
  }, 60_000);

  it('a founder correction invalidates the current Move; an over-budget proposal is rejected and replaced', async () => {
    const { db, say } = await mods();
    jar = new Map();
    let v = await say(QUIZ);
    const objectiveId = (await db.move.findUnique({ where: { id: v.move.id } })).objectiveId;
    // Make the current Move a ₹2,000 print run, then the founder says they only have ₹500.
    await db.move.update({ where: { id: v.move.id }, data: { title: PRINT_RUN.move.title, costInr: 2000, routeKey: 'print-fifty-copies', status: 'PROPOSED' } });
    v = await say('Actually I only have ₹500');
    expect(v.state.capacity.budgetInr).toBe(500);
    const engine = prompts.filter((p) => p.kind === 'move').slice(-2).map((p) => p.text);
    expect(engine[1]).toMatch(/YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*EXCEEDS_BUDGET/); // the model's ₹2,000 proposal was refused
    expect(v.move.title).toBe(LIBRARY.move.title);
    expect(v.move.cost).toBe('Free');
    expect(await db.move.count({ where: { objectiveId, title: PRINT_RUN.move.title, status: 'SUPERSEDED' } })).toBe(1);
    // A question is answered briefly and the Move stays.
    v = await say('what grade is this for?');
    expect(lastHippo(v)).toBe('Ages 8 to 12 — that’s who the sample is for.');
    expect(v.move.title).toBe(LIBRARY.move.title);
  }, 60_000);

  it('CANONICAL "₹1 lakh but no idea how": at most two questions, three directions, one recommended, then a first Move', async () => {
    const { db, say } = await mods();
    jar = new Map();
    let v = await say(LAKH);
    expect(v.move).toBeNull();
    expect(lastHippo(v)).toMatch(/\?$/);
    v = await say("I'm good at cooking and people always ask for my food");
    expect(lastHippo(v)).toMatch(/money and how many hours/);
    v = await say('I can put in ₹10,000 and 10 hours a week');
    expect(v.state.capacity).toMatchObject({ budgetInr: 10000, hoursPerWeek: 10 });
    expect(v.state.directions).toHaveLength(3);
    expect(lastHippo(v)).toMatch(/^Okay — you don't need to know yet[\s\S]*A\) Home-cooked lunch boxes[\s\S]*I'd start with A/);
    expect(prompts.filter((p) => p.kind === 'directions').at(-1)!.text).toContain('costing at most ₹2000');
    expect(v.quick[0]).toBe('Start with A');
    v = await say('Start with A');
    expect(v.move).toMatchObject({ title: LUNCH.move.title, owner: 'HIPPO', consequential: true, needsGuardian: false });
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('Chosen direction: Home-cooked lunch boxes');
    expect(await db.objective.count({ where: { text: { contains: 'lunch boxes' } } })).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('UI + public surface: one pinned Move card, plain words, the native page (draft hidden, views and self-tests not counted) and the Ledger', async () => {
    const { db, say, view, act, respond } = await mods();
    const { renderToStaticMarkup } = await import('react-dom/server');
    const Start = (await import('@/app/start/page')).default;
    const Memory = (await import('@/app/memory/page')).default;
    const PublicPage = (await import('@/app/p/[slug]/page')).default;
    const pub = await import('@/app/api/p/[slug]/route');
    const INTERNAL = /belief|rung|aristotle|SYSTEM_OBSERVED|FOUNDER_REPORTED|MOVE ENGINE|routeKey|consequential|methodology|hypothesis/i;
    jar = new Map();
    let v = await say(QUIZ);
    let html = renderToStaticMarkup(await Start({}));
    expect(html).toContain('Your next move');
    expect(html).toContain(SAMPLE.move.title);
    expect(html).toContain('What I need from you');
    expect(html).toContain('>Ledger<');
    expect(html).not.toContain('classic objective form');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(INTERNAL);

    await act(v.move.id, { action: 'YES' }); await act(v.move.id, { action: 'DID_IT' });
    v = await say('5 of 6 friends finished it and loved the animal round');
    const slug = v.move.artifact.slug as string;
    const render = async (q: Record<string, string> = {}) => renderToStaticMarkup(await PublicPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(q) }));
    // Draft: the owner sees a preview; a stranger sees nothing; nobody can respond.
    expect(await render()).toContain('Preview — only you can see this');
    const founderJar = jar; jar = new Map();
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect((await respond(slug, { contact: 'x@example.com' })).status).toBe(404);
    jar = founderJar;
    html = renderToStaticMarkup(await Start({}));
    expect(html).toContain('Needs your OK because');
    expect(html).toContain('A parent or guardian has seen this and says OK');
    v = (await act(v.move.id, { action: 'YES', guardian: true })).body;
    // Live: a stranger sees the offer and the form, and is counted; the owner is not.
    expect(await render()).toContain('Your live page');
    jar = new Map();
    const strangerHtml = await render();
    expect(strangerHtml).toContain('Animal Quiz Book by Aaira (age 10)');
    expect(strangerHtml).toContain('No payment is taken.');
    // A real browser form post (no JavaScript), a bot (honeypot) and a bad contact.
    const form = (f: Record<string, string>) => pub.POST(new Request(`http://hippo.test/api/p/${slug}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': ip() }, body: new URLSearchParams(f).toString() }), { params: Promise.resolve({ slug }) });
    const ok = await form({ name: 'Ravi', contact: '+91 98765 43210', message: 'How much?' });
    expect([ok.status, ok.headers.get('location')]).toEqual([303, `http://hippo.test/p/${slug}?thanks=1`]);
    expect((await form({ name: 'bot', contact: 'bot@example.com', website: 'http://spam' })).status).toBe(303);
    expect((await form({ contact: 'nope' })).headers.get('location')).toMatch(/error=/);
    jar = founderJar;
    expect(await db.publicPage.findUnique({ where: { slug } })).toMatchObject({ views: 1 });
    expect(await db.publicResponse.count({ where: { page: { slug } } })).toBe(1);
    await respond(slug, { name: 'Me', contact: 'me@example.com' }); // founder's own test
    v = await view();
    expect(v.move.signals.map((s: Row) => s.summary)).toEqual([expect.stringContaining('Ravi responded')]); // own test not counted
    expect(v.state.signals.some((s: Row) => /Test response/.test(s.summary))).toBe(false);

    // The Ledger: only what really happened, each saying who saw it; plans and drafts are absent.
    html = renderToStaticMarkup(await Memory());
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).toContain('What really happened.');
    expect(text).toMatch(/Seen by Hippo\s+Live: Animal Quiz Book/);
    expect(text).toMatch(/Seen by Hippo\s+Ravi responded/);
    expect(text).toMatch(/You reported\s+5 of 6 friends/);
    expect(text).toMatch(/Your decision\s+Parent\/guardian approved/);
    expect(text).not.toMatch(/Test response from you|Kids enjoy the quizzes/);
    expect(text).toContain('From your first message to the first response from the world');
    const { ledgerFor } = await import('@/lib/hippo/move-service');
    const org = (await db.move.findUnique({ where: { id: v.move.id } })).organizationId;
    const m = (await ledgerFor(org)).milestones;
    expect(m.firstAction && m.firstSignal && m.firstVerified).toBeTruthy();
    expect(m.firstStrangerPayment).toBeNull(); // no payments in V1 — not claimed
    expect(m.firstVerified!.getTime()).toBeGreaterThanOrEqual(m.firstSignal!.getTime());
  }, 60_000);

  it('the cost governor still applies: a Move request over its limit waits instead of spending', async () => {
    const { db, say } = await mods();
    process.env.HIPPO_MOVE_JOB_INR = '0.0001';
    try {
      jar = new Map();
      const v = await say(QUIZ);
      expect(v.move).toBeNull();
      const job = await db.job.findFirst({ where: { type: 'HIPPO_MOVE' }, orderBy: { createdAt: 'desc' } });
      expect(job).toMatchObject({ status: 'WAITING' });
    } finally { delete process.env.HIPPO_MOVE_JOB_INR; }
  }, 60_000);

  it('flag off: the conversation is exactly the previous experience (no Moves)', async () => {
    const { view } = await mods();
    process.env.HIPPO_MOVES = 'off';
    try {
      jar = new Map();
      const v = await view();
      expect('moves' in v).toBe(false);
      expect(v.messages[0].text).toBe('Alright bro. What are you trying to build or achieve?');
      const { renderToStaticMarkup } = await import('react-dom/server');
      const html = renderToStaticMarkup(await (await import('@/app/start/page')).default({}));
      expect(html).toContain('classic objective form');
      expect(html).toContain('>Memory<');
      expect(html).not.toContain('Your next move');
    } finally { process.env.HIPPO_MOVES = 'on'; }
  });
});
