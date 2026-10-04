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
const CLASS = mv({ kind: 'SELL', title: 'Offer one Sunday cooking class to 5 people you know', why: 'See if people will pay to learn from you before renting anything.', bet: 'Friends will book a class', hippoWill: 'Write the invite and a simple menu', needs: ['Send the invite to 10 people'], expectedSignal: 'How many say yes', artifactBrief: 'Class invite', routeKey: 'sunday class invite' });
const TIFFIN = mv({ kind: 'SELL', owner: 'HIPPO', title: 'Pre-order page for home tiffins in your society', why: 'Neighbours are the fastest people to reach from home.', bet: 'Neighbours will pre-order a week of tiffins', hippoWill: 'Make the page and the WhatsApp message', needs: ['Post the message in your society group'], expectedSignal: 'Pre-orders in 3 days', artifactType: 'PUBLIC_PAGE', artifactBrief: 'Tiffin pre-order page', routeKey: 'society tiffin preorder' });
const CAFE = mv({ kind: 'SELL', title: 'Send 5 local cafes a free one-page Instagram idea sheet', why: 'Find out if cafe owners want help before you build any service.', bet: 'Some cafe owners will reply and ask for more', hippoWill: 'Pick 5 cafes near you, look at their Instagram and write each a short honest message plus a one-page idea sheet', needs: ['Send the 5 messages from your Instagram'], expectedSignal: 'Replies, questions about price, or a no', artifactBrief: 'Messages and idea sheet for 5 cafes', routeKey: 'cafe instagram dms' });
const CAFE_REWORDED = mv({ ...CAFE.move, title: 'Send 5 local cafes a free Instagram idea sheet on WhatsApp', routeKey: 'cafe whatsapp messages' });
const CAFE_ALT = mv({ kind: 'TEST', title: 'Ask 3 shop owners you already know what is hard about Instagram', why: 'Talking to people you know is easier than messaging strangers.', bet: 'Owners will name a problem they would pay to fix', hippoWill: 'Write the 3 questions to ask and a note sheet', needs: ['Ask 3 people you already know'], expectedSignal: 'The problems they name', artifactBrief: 'Questions and note sheet', routeKey: 'ask known owners' });
const CAFE_HELP = mv({ ...CAFE.move, title: 'Five ready-to-send cafe messages — you only press send', hippoWill: 'Chose the 5 cafes, wrote each message with their name and one specific idea, and the reply to send if they answer', needs: ['Check the 5 messages and press send'], routeKey: 'cafe instagram dms' });
const CAFE_PRICE = mv({ kind: 'SELL', title: 'Offer the cafe that asked about price a ₹499 first month', why: 'One person is already asking about price — test whether they will pay.', bet: 'The cafe will say yes to a small paid trial', hippoWill: 'Write the reply with what they get for ₹499', needs: ['Send the reply'], expectedSignal: 'A yes, a counter-offer or a no', artifactBrief: 'Price reply', routeKey: 'cafe paid trial offer' });
const CAFE_FOLLOWUP = mv({ kind: 'TEST', title: 'Walk into 2 cafes and show the idea sheet in person', why: 'Messages were ignored; in person is harder to ignore.', bet: 'Owners respond better face to face', hippoWill: 'Print-ready idea sheet and what to say', needs: ['Visit 2 cafes'], expectedSignal: 'Whether they take it and what they say', artifactBrief: 'In-person idea sheet', routeKey: 'cafe in person visit' });
const CAFE_MORE = mv({ kind: 'SELL', title: 'Send the idea sheet to 20 more cafes', why: 'A bigger sample.', bet: 'More messages bring replies', hippoWill: 'Find 20 more cafes and write the messages', needs: ['Send 20 messages'], expectedSignal: 'Replies', artifactBrief: 'Messages', routeKey: 'more cafe messages' });
const TAILOR = 'I want to build a women-focused tailoring marketplace.';
const TAILOR_EVIDENCE = "I spoke to 3 women. They all said they don't have time to visit tailors, don't feel comfortable with male tailors, and travel is expensive.";
const TAILOR_TALK = mv({ kind: 'TALK', title: 'Ask 3 women in Mumbai about their tailor frustrations', why: 'Before building an app, hear the problem from real women.', bet: 'Women find tailoring a hassle', hippoWill: 'Write 5 short questions and a note sheet', needs: ['Ask 3 women you know'], expectedSignal: 'What frustrates them about tailors', artifactBrief: 'Questions and note sheet', routeKey: 'women tailor interviews' });
const TAILOR_REDISCOVER = mv({ kind: 'TALK', title: 'Interview 5 more women about what they want from a tailor', why: 'Understand them better.', bet: 'More detail helps', hippoWill: 'Write interview questions', needs: ['Interview 5 women'], expectedSignal: 'Their needs', artifactBrief: 'Interview guide', routeKey: 'more women interviews' });
const TAILOR_APP = mv({ kind: 'BUILD', title: 'Build the tailoring marketplace app', why: 'Women need it.', bet: 'They will use the app', hippoWill: 'Write the app spec', needs: ['Hire a developer'], expectedSignal: 'Downloads', artifactBrief: 'App spec', routeKey: 'build marketplace app' });
const TAILOR_CONCIERGE = mv({ kind: 'TEST', title: 'Get 3 women their clothes stitched by a woman tailor who comes home', why: 'They said: no time to visit, uncomfortable with male tailors, travel costs — test if we can deliver exactly that, by hand.', bet: 'Women will book and pay for a woman tailor who comes to them', hippoWill: 'Write the offer with a trial price, a simple home-measurement checklist, and a pickup/delivery plan; list where to find women tailors nearby', needs: ['Find 1 woman tailor nearby', 'Offer it to the 3 women at the trial price'], expectedSignal: 'How many book and pay, and what goes wrong with measurements, fitting and pickup', artifactBrief: 'Offer, measurement checklist, pickup plan', routeKey: 'concierge women tailor home visit' });
const SALARY = mv({ kind: 'TALK', title: 'Ask 10 blue-collar workers in a manufacturing cluster about salary advances', why: 'Faster to test.', bet: 'Workers want advances', hippoWill: 'Write the questions', needs: ['Visit a cluster'], expectedSignal: 'Interest', artifactBrief: 'Questions', routeKey: 'salary advance workers' });
const MSME_MOVE = { ...mv({ kind: 'TEST', title: 'Ask 5 kirana and wholesale shop owners if they would buy stock on 30-day credit', why: 'Your MSME BNPL lives or dies on whether small businesses want to defer paying for stock.', bet: 'Shop owners will say yes to 30-day credit on stock', hippoWill: 'Write a 3-line offer and 4 questions about what they buy, how often, and what credit they get today', needs: ['Show it to 5 shop owners in Mumbai'], expectedSignal: 'How many say yes, and what they buy on credit today', artifactBrief: 'Offer and questions', routeKey: 'msme stock credit check' }), alternative: { title: 'Salary advances for factory workers', why: 'a different, possibly faster market — only if you want it' } };
const LUNCH = mv({ kind: 'SELL', owner: 'HIPPO', title: 'Pre-order page for home-cooked lunch boxes near offices', why: 'Office workers nearby want home food; test before cooking.', bet: 'Office workers will pre-order', hippoWill: 'Make and host the page', needs: ['Share the link with 2 office groups'], expectedSignal: 'Pre-order requests in 3 days', artifactType: 'PUBLIC_PAGE', artifactBrief: 'Lunch box pre-order page', routeKey: 'lunchbox preorder page' });

function model(prompt: string): unknown {
  const quoted = [...prompt.matchAll(/"""([\s\S]*?)"""/g)];
  const last = quoted.at(-1)?.[1]?.trim() || '';
  if (prompt.startsWith('MOVE ENGINE')) {
    prompts.push({ kind: 'move', text: prompt });
    const retry = prompt.includes('YOUR PREVIOUS PROPOSAL WAS REJECTED');
    if (/objective: [^\n]*msme/i.test(prompt)) return retry ? MSME_MOVE : SALARY; // the model tries to substitute the business
    if (/objective: .*tailor/i.test(prompt)) {
      if (!prompt.includes('\n- founder reported:')) return TAILOR_TALK;
      return retry ? TAILOR_CONCIERGE : TAILOR_REDISCOVER; // the first try steps backwards (more interviews)
    }
    if (prompt.includes('objective: I want to help local cafes')) {
      const why = (prompt.match(/WHY A NEW MOVE NOW: ([^\n]*)/) || [])[1] || '';
      if (why.includes('materially different activity')) return retry ? CAFE_ALT : CAFE_REWORDED; // first try is the same thing via WhatsApp
      if (why.includes('do far more of it')) return CAFE_HELP;
      if (why.startsWith('the world responded') && !retry) return CAFE_MORE; // "do more of it" — must be refused after a no-reply or a price question
      if (why.startsWith('the world responded')) return /founder reported: Two cafes replied[^\n]*\n(?!- founder reported: I sent)/.test(prompt) && !prompt.includes('Nobody replied') ? CAFE_PRICE : CAFE_FOLLOWUP;
      return CAFE;
    }
    if (prompt.includes('Make this easier')) return mv({ ...SAMPLE.move, title: 'Tell me 3 quiz questions now — I’ll write the librarian note', routeKey: 'librarian note together', needs: ['Say 3 questions out loud to me'] });
    if (prompt.includes('money available: ₹500') && !retry) return PRINT_RUN;                         // over budget → must be rejected
    if (prompt.includes('the last Move failed') && !retry) return PAGE;                                 // repeats the failed route → rejected
    if (prompt.includes('money available: ₹500') || prompt.includes('the last Move failed') || prompt.includes("can't or won't") || prompt.includes('different route')) return LIBRARY;
    if (prompt.includes('Chosen direction: Weekend cooking classes')) return CLASS;
    if (prompt.includes('Chosen direction: Tiffin')) return TIFFIN;
    if (prompt.includes('Chosen direction')) return LUNCH;
    if (prompt.includes('\n- founder reported:') || prompt.includes('\n- seen by Hippo:')) return prompt.includes('\n- seen by Hippo:') ? mv({ kind: 'SELL', title: 'Reply to Priya and ask what price feels fair', why: 'A real parent responded.', bet: 'She will name a price', hippoWill: 'Draft the reply', needs: ['Send the reply'], expectedSignal: 'A price she would pay', artifactBrief: 'Reply draft', routeKey: 'ask first parent price' }) : PAGE;
    return SAMPLE;
  }
  if (prompt.startsWith('PREPARE ARTIFACT')) {
    prompts.push({ kind: 'prepare', text: prompt });
    if (prompt.includes('cafes')) { // the model's first draft invents credentials; Hippo must not let them through
      const fixed = prompt.includes('YOUR PREVIOUS VERSION WAS REJECTED');
      const stubborn = prompt.includes('Five ready-to-send');
      return { title: 'Messages for 5 cafes', markdown: fixed && !stubborn
        ? '## Message\nHey [Name], I noticed a couple of simple things on your Instagram that might help bring in more weekend customers. I put together a quick one-page breakdown with two ideas. No pitch or strings attached. Want me to send it?'
        : '## Message\nHi [Name]! I run a digital marketing service and we have helped cafes grow. I noticed two simple things on your Instagram. Want me to send a one-page breakdown?' };
    }
    return prompt.includes('PUBLIC PAGE')
      ? { title: 'Pre-order page', markdown: 'Page summary', page: { headline: prompt.includes('lunch') ? 'Home-cooked lunch boxes, delivered' : 'Animal Quiz Book by Aaira (age 10)', subhead: 'Fun quizzes written by a kid, for kids', body: 'Ten animal quizzes. Leave your contact and you will hear when it is ready.', cta: 'Tell me when it’s ready' } }
      : { title: 'Animal Quiz — sample', markdown: '# Animal Quiz (sample)\n\n1. Which animal sleeps standing up?\n\n| Friend | Finished? | Favourite round |\n|---|---|---|' };
  }
  if (prompt.includes("doesn't know what yet")) {
    prompts.push({ kind: 'directions', text: prompt });
    if (/Instagram/.test(prompt)) return { directions: [
      { title: 'Instagram help for local cafes', whoItServes: 'cafe owners near you', whyYou: "You're on Instagram every day", firstTest: 'Message 5 cafes with a free idea sheet', objective: 'I want to help local cafes get more customers through Instagram', firstMoveCostInr: 0, firstMoveDays: 3 },
      { title: 'Reels editing for small gyms', whoItServes: 'gym owners', whyYou: 'You know Instagram', firstTest: 'Offer 3 gyms a free reel', objective: 'I want to edit reels for small gyms', firstMoveCostInr: 0, firstMoveDays: 5 },
    ], recommended: 0, why: "you can start today for free, it uses what you already know, and cafe owners will tell us within days if they want it" };
    if (/from home|online/.test(prompt)) return { directions: [ // only two genuinely good options — not padded to three
      { title: 'Tiffin service for your society', whoItServes: 'working families nearby', whyYou: 'You can cook at home in your free hours', firstTest: 'A pre-order page shared in your society group', objective: 'I want to run a home tiffin service for my society', firstMoveCostInr: 0, firstMoveDays: 3 },
      { title: 'Home tuition for kids', whoItServes: 'parents nearby', whyYou: 'Fits 2–3 hours a day', firstTest: 'Offer a free trial class to 3 parents', objective: 'I want to teach kids at home', firstMoveCostInr: 0, firstMoveDays: 5 },
    ], recommended: 0, why: 'you can start without spending money, it fits your hours at home, and we will know within days if neighbours want it' };
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
    if (last === TAILOR_EVIDENCE) return { intent: 'OTHER', reply: 'Got it.' }; // the model misses it — the evidence must still be kept
    if (/^build the platform/.test(last)) return { intent: 'CHANGE_OBJECTIVE', reply: "You're circling back to the app — let's earn it first." };
    if (/^Two replied/.test(last)) return { intent: 'SIGNAL', reply: "That's useful. One person is already asking about price. Let's test whether the offer is valuable enough to pay for.", signal: { summary: 'Two cafes replied; one asked for pricing', polarity: 'POSITIVE', outcome: false } };
    if (/what grade/.test(last)) return { intent: 'QUESTION', reply: 'Ages 8 to 12 — that’s who the sample is for.' };
    return { intent: 'OTHER', reply: 'Got it.' };
  }
  if (prompt.startsWith('You are Hippo —')) {
    prompts.push({ kind: 'turn', text: prompt });
    if (last.startsWith('I am 10 years old')) return { intent: 'OBJECTIVE', reply: 'Love it.', ready_to_propose: true, objective: 'Quiz books for kids, written by a kid', target: '5,000 books through ecommerce', current_state: 'Just an idea', has_business_idea: true };
    // A model that rewrites the founder's business into an adjacent one (the live MSME BNPL bug).
    if (/msme buynow paylater/i.test(last)) return { intent: 'OBJECTIVE', reply: 'An MSME buy-now-pay-later business, nice. Mumbai first?', ready_to_propose: false, has_business_idea: false, objective: 'Hyper-local salary advance brokerage for blue-collar workers in Mumbai' };
    if (/^Yes Mumbai 1st/.test(last)) return { intent: 'ANSWER', reply: 'Got it.', ready_to_propose: true, has_business_idea: false, objective: 'Salary advance brokerage for blue-collar workers' };
    if (/something in lending/.test(last)) return { intent: 'DONT_KNOW', reply: 'Lending is broad.', ready_to_propose: false, has_business_idea: false, objective: 'Salary advance brokerage for blue-collar workers' };
    if (/ladies tailor/.test(last)) return { intent: 'OBJECTIVE', reply: 'Love it. Have you talked to any women about it?', ready_to_propose: false, has_business_idea: true, objective: 'Ladies tailor service in Mumbai' };
    if (last === TAILOR) return { intent: 'OBJECTIVE', reply: 'A women-for-women tailoring service — love it.', ready_to_propose: true, objective: 'Women-focused tailoring marketplace in Mumbai', has_business_idea: true };
    if (/they say they need it/.test(last)) return { intent: 'ANSWER', reply: 'You actually talked to them? What specifically did they say?', ready_to_propose: false, has_business_idea: true, objective: 'Women-focused tailoring marketplace in Mumbai' };
    if (/^No time to visit/.test(last)) return { intent: 'ANSWER', reply: 'That is real.', ready_to_propose: true, has_business_idea: true, objective: 'Women-focused tailoring marketplace in Mumbai' };
    if (last.startsWith('I want to make money quickly')) return { intent: 'DONT_KNOW', reply: 'No problem.', ready_to_propose: false, has_business_idea: false };
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
// What the founder must never be shown in the "I don't know" journey: report furniture, scores, choosing a research route.
const NOT_FOUNDER_FACING = /\d+\s*\/\s*100|score|pathway|research question|evidence|sources|you decide|which (one|option) do you (want|choose)|lens|hypothes|dig in|report/i;
const BEGINNER = 'I want to make money quickly. I know nothing about business. Something digital.';
/** Beginner → two questions → Hippo's recommendation and first Move in ONE turn. */
async function cafeStart(say: (t: string) => Promise<Row>) {
  jar = new Map();
  await say(BEGINNER);
  await say("I'm on Instagram all day");
  const before = Date.now();
  const v = await say('No money, 2 hours a day');
  return { v, before };
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

  it('CANONICAL "₹1 lakh but no idea how": at most two questions, then Hippo recommends one direction and it becomes the first Move (no report, no picking)', async () => {
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
    const said = v.messages.filter((m: Row) => m.role === 'HIPPO').map((m: Row) => m.text).join('\n');
    expect(said).toMatch(/I think we should start with home-cooked lunch boxes — daily demand, and you can test it this week for free\./);
    expect(said).toMatch(/I don't want you spending money building anything yet\.\n\nHere's our first move: Pre-order page for home-cooked lunch boxes near offices\.\nWhat I'll do: Make and host the page\.\nWhat I need from you: Share the link with 2 office groups\.\nWhat we're watching for: Pre-order requests in 3 days\./);
    expect(said).toMatch(/I also considered B\) weekend cooking classes and C\) festival sweets boxes — just say the letter\./);
    expect(said).not.toMatch(NOT_FOUNDER_FACING);
    // Hippo decided: the first Move exists without the founder picking anything.
    expect(v.move).toMatchObject({ title: LUNCH.move.title, owner: 'HIPPO', consequential: true, needsGuardian: false });
    expect(v.quick).toEqual(expect.arrayContaining(['Yes', 'Try B instead', 'Try C instead']));
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('Chosen direction: Home-cooked lunch boxes');
    const directions = prompts.filter((p) => p.kind === 'directions').at(-1)!.text;
    expect(directions).toContain('costing at most ₹2000');
    expect(directions).toMatch(/never name them\): obvious route[\s\S]*international analogue[\s\S]*founder specific/); // lenses: internal only
    expect(await db.objective.count({ where: { text: { contains: 'lunch boxes' } } })).toBeGreaterThanOrEqual(1);
    expect(v.messages.filter((m: Row) => ['HANDOFF', 'RESULT'].includes(m.kind))).toEqual([]); // no research handoff, no report
    const audits = (await db.objective.findMany({ where: { text: { contains: 'lunch boxes' } }, select: { auditId: true } })).map((o: Row) => o.auditId).filter(Boolean);
    expect(await db.audit.count({ where: { id: { in: audits }, paymentStatus: 'paid' } })).toBe(0);
    // The founder can still go another way: "Try B instead" replaces the Move with one for that direction.
    const first = v.move.id;
    v = await say('Try B instead');
    expect(await db.move.findUnique({ where: { id: first } })).toMatchObject({ status: 'SUPERSEDED' });
    expect(v.move.title).toBe(CLASS.move.title);
    expect(v.quick).toEqual(expect.arrayContaining(['Try A instead', 'Try C instead']));
    // A signal that merely starts with "a" is never mistaken for choosing direction A.
    v = await say('a few friends said maybe');
    expect(v.move.title).toBe(CLASS.move.title);
  }, 60_000);

  it('"2–3 hours a day, ₹20,000/month from home, don\'t know what": one question at most, a founder-fit recommendation and a free first Move', async () => {
    const { say } = await mods();
    jar = new Map();
    let v = await say("I have 2–3 hours a day. I want to make ₹20,000/month from home. I don't know what business to start.");
    expect(v.state.capacity.hoursPerWeek).toBe(14);
    expect(lastHippo(v)).toMatch(/What are you good at/);
    v = await say('I cook well and my neighbours like my food');
    expect(v.messages.filter((m: Row) => m.kind === 'IDEA_QUESTION')).toHaveLength(1); // time was already known: no second question
    const said = v.messages.filter((m: Row) => m.role === 'HIPPO').map((m: Row) => m.text).join('\n');
    expect(said).toMatch(/start with tiffin service for your society — you can start without spending money/);
    expect(said).toMatch(/I also considered B\) home tuition for kids — just say the letter/); // two good options, not padded to three
    expect(v.move).toMatchObject({ title: TIFFIN.move.title, cost: 'Free' });
    expect(JSON.stringify(v.messages)).not.toMatch(NOT_FOUNDER_FACING);
  }, 60_000);

  it('"I want to sell something online but I don\'t know what": no report — Hippo asks, decides and creates the first Move', async () => {
    const { say } = await mods();
    jar = new Map();
    let v = await say("I want to sell something online but I don't know what.");
    expect(v.move).toBeNull();
    v = await say('I know a lot about phones');
    v = await say("No money really, maybe 5 hours a week");
    expect(v.messages.filter((m: Row) => m.kind === 'IDEA_QUESTION').length).toBeLessThanOrEqual(2);
    expect(v.move).not.toBeNull();
    expect(v.messages.some((m: Row) => m.role === 'HIPPO' && /I think we should start with/.test(m.text))).toBe(true);
    expect(JSON.stringify(v.messages)).not.toMatch(NOT_FOUNDER_FACING);
  }, 60_000);

  it('ONE turn: the recommendation, why, and the first Move (what I do / what you do / what we watch) — no second hand-off; "ok" accepts it', async () => {
    const { db, say } = await mods();
    let { v } = await cafeStart(say);
    expect(v.state.profile.experience).toBe('NEW');
    const lastFounder = v.messages.map((m: Row) => m.role).lastIndexOf('FOUNDER');
    const after = v.messages.slice(lastFounder + 1);
    expect(after).toHaveLength(1); // exactly one Hippo message
    expect(after[0].text).toMatch(/^I've thought through a few directions\. I think we should start with instagram help for local cafes — you can start today for free/);
    expect(after[0].text).toMatch(/Here's our first move: Send 5 local cafes a free one-page Instagram idea sheet\.\nWhat I'll do: Pick 5 cafes near you[^\n]*\nWhat I need from you: Send the 5 messages from your Instagram\.\nWhat we're watching for: Replies, questions about price, or a no\./);
    expect(after[0].text).toMatch(/I also considered B\) reels editing for small gyms — just say the letter\.$/);
    expect(after[0].text).not.toMatch(/chosen direction|which (one|option)|do you want/i);
    expect(v.move).toMatchObject({ title: CAFE.move.title, status: 'READY' });
    // A: "ok" means yes to the primary recommendation — no new choice, the same Move proceeds.
    const moveId = v.move.id;
    v = await say('ok');
    expect(v.move).toMatchObject({ id: moveId, status: 'APPROVED' });
    expect(lastHippo(v)).toBe("Let's do it. Everything I prepared is on the card above. Your part: Send the 5 messages from your Instagram. Then tell me what happened — even if nobody replied.");
    expect(await db.move.count({ where: { objectiveId: (await db.move.findUnique({ where: { id: moveId } })).objectiveId } })).toBe(1);
    const { movingControl } = await import('@/lib/hippo/moves');
    expect(['ok', 'yes', 'sure', "let's do it", 'fine', 'Fine.', 'alright'].map(movingControl)).toEqual(Array(7).fill('YES'));
  }, 60_000);

  it('B: a founder who "knows nothing" never claims a business, clients or expertise in what Hippo writes for them', async () => {
    const { say } = await mods();
    const { v } = await cafeStart(say);
    const prep = prompts.filter((p) => p.kind === 'prepare');
    expect(prep.at(-2)!.text).toContain('SPEAKING AS THE FOUNDER (strict)');
    expect(prep.at(-2)!.text).toContain('This founder is NEW to this');
    expect(prep.at(-1)!.text).toMatch(/YOUR PREVIOUS VERSION WAS REJECTED[\s\S]*I run a digital marketing service/);
    const md = v.move.artifact.markdown as string;
    expect(md).toContain('I noticed a couple of simple things on your Instagram');
    expect(md).not.toMatch(/I run|we have helped|agency|our clients/i);
  }, 60_000);

  it('C: "help me do this" — Hippo says what it can\'t do without approval and prepares everything else (founder work shrinks to one step)', async () => {
    const { say } = await mods();
    let { v } = await cafeStart(say);
    v = await say('help me do this');
    expect(v.messages.some((m: Row) => /^I can prepare everything, but I can't send it without your approval\./.test(m.text))).toBe(true);
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toMatch(/do far more of it[\s\S]*Do not just rewrite the same script/);
    expect(v.move.title).toBe(CAFE_HELP.move.title);
    expect(v.move.needs).toEqual(['Check the 5 messages and press send']);
    // Even when the model keeps inventing credentials, they are removed before the founder sees them.
    expect(v.move.artifact.markdown).not.toMatch(/I run a digital marketing service|we have helped/i);
    expect(v.move.artifact.markdown).toContain('I noticed two simple things on your Instagram');
  }, 60_000);

  it('D: "I did it" → "What happened?" → a natural-language answer becomes a signal, goes into memory, and drives the next Move', async () => {
    const { db, say } = await mods();
    let { v } = await cafeStart(say);
    const first = v.move.id;
    await say('ok');
    v = await say('I did it');
    expect(lastHippo(v)).toMatch(/What happened\? Tell me even if nobody replied/);
    expect(v.move).toMatchObject({ id: first, status: 'LIVE' });
    v = await say('Two replied and one asked for pricing.');
    expect(v.messages.some((m: Row) => /^That's useful\. One person is already asking about price\. Let's test whether the offer is valuable enough to pay for\./.test(m.text))).toBe(true);
    expect(await db.outcome.findFirst({ where: { moveId: first } })).toMatchObject({ source: 'FOUNDER_REPORTED', polarity: 'POSITIVE', rung: 4 });
    expect(await db.businessMemory.findFirst({ where: { refType: 'move-ledger', kind: 'OUTCOME', title: { contains: 'one asked for pricing' } } })).toBeTruthy();
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('founder reported: Two cafes replied; one asked for pricing');
    expect(v.move.title).toBe(CAFE_PRICE.move.title);
    // Outcomes said in one breath ("I sent it… nobody replied") are signals too — even when the model doesn't label them.
    v = await say('ok');
    v = await say('I sent it to 5 cafes. Nobody replied.');
    const neg = await db.outcome.findFirst({ where: { summary: { contains: 'Nobody replied' } } });
    expect(neg).toMatchObject({ polarity: 'NEGATIVE', source: 'FOUNDER_REPORTED' });
    expect(v.messages.some((m: Row) => /silence or a no tells us something real/.test(m.text))).toBe(true);
    expect(v.move.title).toBe(CAFE_FOLLOWUP.move.title);
    const { readSignal } = await import('@/lib/hippo/moves');
    expect(readSignal('One person said they’re interested')?.polarity).toBe('POSITIVE');
    expect(readSignal('I sent it but one person blocked me')?.polarity).toBe('NEGATIVE');
  }, 60_000);

  it('E: "I can\'t do this" — the same activity through another channel is rejected; the next Move is a materially different approach', async () => {
    const { db, say } = await mods();
    let { v } = await cafeStart(say);
    const first = v.move.id;
    v = await say("I can't do this, I'm scared to message strangers");
    expect(await db.move.findUnique({ where: { id: first } })).toMatchObject({ status: 'DECLINED' });
    const engine = prompts.filter((p) => p.kind === 'move').slice(-2).map((p) => p.text);
    expect(engine[1]).toMatch(/YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*REPEATS_FAILED_ROUTE/); // "same thing via WhatsApp" refused
    expect(v.move.title).toBe(CAFE_ALT.move.title);
  }, 60_000);

  it('LEARNS: tailoring — after women describe the problem, "what\'s next?" moves to delivering it (not more interviews, not an app)', async () => {
    const { db, say } = await mods();
    jar = new Map();
    let v = await say(TAILOR);
    expect(v.move.title).toBe(TAILOR_TALK.move.title);
    const objectiveId = (await db.move.findUnique({ where: { id: v.move.id } })).objectiveId;
    v = await say(TAILOR_EVIDENCE);
    // Kept as durable memory: a founder-reported signal and a Ledger entry.
    expect(await db.outcome.findFirst({ where: { objectiveId, summary: { contains: "don't have time to visit tailors" } } })).toMatchObject({ source: 'FOUNDER_REPORTED', polarity: 'POSITIVE' });
    expect(await db.businessMemory.findFirst({ where: { objectiveId, refType: 'move-ledger', kind: 'OUTCOME', title: { contains: 'male tailors' } } })).toBeTruthy();
    const engine = prompts.filter((p) => p.kind === 'move').slice(-2).map((p) => p.text);
    expect(engine[0]).toMatch(/founder reported: I spoke to 3 women[\s\S]*WHERE THIS BUSINESS IS NOW[^\n]*Do NOT ask them to rediscover it/);
    expect(engine[1]).toMatch(/YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*REDISCOVERY/); // "interview 5 more women" refused
    expect(v.move.title).toBe(TAILOR_CONCIERGE.move.title);
    expect(v.move.why).toMatch(/no time to visit, uncomfortable with male tailors, travel costs/);
    v = await say("What's next?");
    expect(lastHippo(v)).toMatch(/^Given what just happened — I spoke to 3 women\. They all said they don't have time to visit tailors[\s\S]* — the next thing we should do is: Get 3 women their clothes stitched by a woman tailor who comes home\./);
    expect(v.move.title).toBe(TAILOR_CONCIERGE.move.title);
    expect(await db.move.count({ where: { objectiveId, title: { contains: 'Interview' } } })).toBe(0);
    // Pushing back ("build the platform") never wipes the business; the evidence-backed Move stays, and an app is refused.
    v = await say('build the platform');
    expect(v.phase).toBe('MOVING');
    expect(v.move.title).toBe(TAILOR_CONCIERGE.move.title);
    expect(lastHippo(v)).toMatch(/circling back to the app/);
    const { validateMove, emptyCapacity } = await import('@/lib/hippo/moves');
    const ctx = { objective: 'tailoring', constraints: [], knownFacts: [], unknowns: [], preferences: [], profile: {}, capacity: emptyCapacity(), beliefs: [], history: [], signals: [{ summary: TAILOR_EVIDENCE, polarity: 'POSITIVE', source: 'FOUNDER_REPORTED', at: '' }], reason: 'NEXT', blockedRoutes: [] };
    expect(validateMove({ ...(TAILOR_APP.move as Record<string, unknown>), alternative: null, reply: '', beliefs: [] } as never, ctx).problems.join()).toMatch(/PREMATURE_SOFTWARE/);
  }, 60_000);

  it('LEARNS before any Move: "I talked to them…" + what they said in discovery becomes the first Move\'s evidence', async () => {
    const { db, say } = await mods();
    jar = new Map();
    await say('I want to start a ladies tailor service in Mumbai, women for women');
    await say('I talked to them and they say they need it');
    const v = await say('No time to visit the tailor. Discomfort with mens tailors, travel cost');
    const objectiveId = (await db.move.findUnique({ where: { id: v.move.id } })).objectiveId;
    expect(await db.outcome.findFirst({ where: { objectiveId } })).toMatchObject({ source: 'FOUNDER_REPORTED', summary: 'I talked to them and they say they need it — they said: No time to visit the tailor. Discomfort with mens tailors, travel cost' });
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toContain('founder reported: I talked to them and they say they need it — they said: No time to visit the tailor');
    expect(v.move.title).toBe(TAILOR_CONCIERGE.move.title);
  }, 60_000);

  it('LEARNS: "I sent it to 5 cafes. Nobody replied." → "what\'s next?" changes the approach (not "20 more cafes")', async () => {
    const { db, say } = await mods();
    let { v } = await cafeStart(say);
    await say('ok');
    v = await say('I sent it to 5 cafes. Nobody replied.');
    const engine = prompts.filter((p) => p.kind === 'move').slice(-2).map((p) => p.text);
    expect(engine[1]).toMatch(/YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*(MORE_OF_THE_SAME|REPEATS_FAILED_ROUTE)/);
    expect(v.move.title).toBe(CAFE_FOLLOWUP.move.title);
    v = await say("What's next?");
    expect(lastHippo(v)).toMatch(/^Given what just happened — I sent it to 5 cafes\. Nobody replied — the next thing we should do is: Walk into 2 cafes/);
    expect(await db.move.count({ where: { title: CAFE_MORE.move.title } })).toBe(0);
  }, 60_000);

  it('LEARNS: "Two replied and one asked for pricing" → "what\'s next?" is a commercial step (price / trial), not more outreach', async () => {
    const { db, say } = await mods();
    let { v } = await cafeStart(say);
    await say('ok');
    v = await say('Two replied and one asked for pricing.');
    expect(prompts.filter((p) => p.kind === 'move').at(-1)!.text).toMatch(/YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*AWARENESS_AFTER_DEMAND/);
    expect(v.move.title).toBe(CAFE_PRICE.move.title);
    v = await say("What's next?");
    expect(lastHippo(v)).toMatch(/the next thing we should do is: Offer the cafe that asked about price a ₹499 first month\./);
    expect(await db.move.count({ where: { title: CAFE_MORE.move.title } })).toBe(0);
  }, 60_000);

  it('REGRESSION: "MSME BNPL" stays MSME BNPL — no "I don\'t know" questions, no salary advances; an alternative is offered, never substituted', async () => {
    const { db, say } = await mods();
    jar = new Map();
    await say('I want to build a msme buynow paylater busienss');
    let v = await say('Yes Mumbai 1st and India later');
    expect(v.state.objective).toEqual({ value: 'I want to build a msme buynow paylater busienss', provenance: 'FOUNDER' });
    expect(v.messages.filter((m: Row) => ['IDEA_QUESTION', 'DIRECTIONS'].includes(m.kind))).toEqual([]);
    expect(JSON.stringify(v.messages)).not.toMatch(/salary|blue-collar/i);
    const move = await db.move.findUnique({ where: { id: v.move.id } });
    expect((await db.objective.findUnique({ where: { id: move.objectiveId } })).text).toMatch(/msme buynow paylater/);
    const engine = prompts.filter((p) => p.kind === 'move').slice(-2).map((p) => p.text);
    expect(engine[0]).toMatch(/objective: I want to build a msme buynow paylater busienss/);
    expect(engine[1]).toMatch(/YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*OFF_OBJECTIVE: the founder's business serves small businesses, but this targets employees/);
    expect(v.move.title).toBe(MSME_MOVE.move.title);
    expect(v.move.alternative).toEqual({ title: 'Salary advances for factory workers', why: 'a different, possibly faster market — only if you want it' });
    expect(await db.move.count({ where: { title: { contains: 'salary' } } })).toBe(0);
    // Business continues on the founder's objective after the Move cycle.
    v = await say('ok');
    expect(v.state.objective.value).toBe('I want to build a msme buynow paylater busienss');
  }, 60_000);

  it('"something in lending" gets one clarifying question — Hippo does not pick a segment', async () => {
    const { say } = await mods();
    jar = new Map();
    const v = await say('I want to do something in lending');
    expect(lastHippo(v)).toMatch(/^Lending for whom, and for what\?/);
    expect(v.move).toBeNull();
    expect(v.state.directions ?? []).toEqual([]);
    expect(JSON.stringify(v.messages)).not.toMatch(/salary|blue-collar/i);
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
