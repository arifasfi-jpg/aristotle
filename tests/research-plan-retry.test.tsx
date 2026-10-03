// Paid audit whose research fails after planning: Retry (existing verify route, no payment fields) resumes from the
// saved plan. Real routes + REAL PostgreSQL; only Gemini/Tavily HTTP and the cookie jar are faked. Skipped without the DB env.
import { escalationKind, escalationReply } from './helpers/escalation-fakes';
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
const razorpay = { constructed: 0, ordersCreated: 0 };
vi.mock('razorpay', () => ({ default: class { constructor() { razorpay.constructed++; } orders = { create: async () => { razorpay.ordersCreated++; return {}; }, fetch: async () => ({}), fetchPayments: async () => ({ items: [] }) }; } }));

const IDEA = 'We publish illustrated children’s books in Hindi and English and sell about 300 copies a month through Amazon and school book fairs in Pune. We want to reach 3,000 copies a month.';
const PLAN = { businessModel: { summary: 'Bilingual children’s books sold online and at school fairs.', customer: 'Parents', payer: 'Parents, schools', offering: 'Children’s books', revenueMechanism: 'Per-copy sales', keyActivities: ['Publishing'], regulatedActivities: [] },
  questions: ['bilingual picture books demand india', 'children picture book price india', 'school book fair publishers india', 'short run colour printing cost india', 'amazon india children books hindi', 'pune parents book buying habits'].map((query, i) => ({ category: ['DEMAND', 'ALTERNATIVES_PRICING', 'CHANNEL', 'COST', 'CHANNEL', 'DEMAND'][i], question: `Question ${i + 1} about ${query}?`, whyItMatters: 'x', query })) };
let tavilyDown = true;
const kinds: string[] = [];

describe.skipIf(!E2E)('Retry resumes from the saved research plan (real Postgres, real verify route)', () => {
  it('no re-plan, same payment, no Razorpay order, Aaira Books identity unchanged', async () => {
    // Phase 2: a paid audit job spends under a budget, which needs the AiUsage ledger (on wherever DATABASE_URL is set).
    Object.assign(process.env, { GEMINI_API_KEY: 'g', TAVILY_API_KEY: 't', DEMO_MODE: 'true', VERCEL_ENV: 'preview', HIPPO_USAGE_LEDGER: 'on' });
    const { deterministicAudit } = await import('@/lib/audit');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (url.includes('tavily')) { kinds.push('tavily'); return tavilyDown ? new Response('down', { status: 500 }) : new Response(JSON.stringify({ results: [{ title: 'Kids books', url: `https://example.org/${encodeURIComponent(body.query)}`, content: 'Bilingual picture books are increasingly requested by urban parents.' }] }), { status: 200 }); }
      const prompt: string = body.contents[0].parts[0].text;
      const k = prompt.includes('Restate what this founder') ? 'understand' : prompt.includes('research planner') ? 'plan' : prompt.includes('You extract evidence') ? 'extract' : escalationKind(prompt) ?? 'decision';
      kinds.push(k);
      const data = k === 'understand' ? { objective: 'Grow to 3,000 copies a month', target: '3,000 copies a month', currentState: '300 copies a month', keyQuestion: 'Which channels?', businessKind: 'EXISTING_BUSINESS' }
        : k === 'plan' ? PLAN : k === 'extract' ? { status: 'NOT_FOUND', findings: [] } : k === 'escalate' || k === 'gap' || k === 'pathways' ? escalationReply(prompt) : { ...deterministicAudit({ idea: IDEA, sector: 'D2C / Consumer' }), oneLineVerdict: 'Verdict' };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }), { status: 200 });
    }));
    const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const post = (b: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const objectives = await import('@/app/api/hippo/objectives/route');
    const scope = await import('@/app/api/audits/[id]/scope/route');
    const order = await import('@/app/api/payments/create-order/route');
    const verify = await import('@/app/api/payments/verify/route');

    jar = new Map();
    const created = await (await objectives.POST(post({ text: IDEA, companyName: 'Aaira Books' }))).json();
    const sug = await (await scope.POST(post({ action: 'suggest' }), ctx(created.auditId))).json();
    await scope.POST(post({ action: 'confirm', scope: 'GROWTH_PLAN', facts: sug.facts, factsReviewed: true }), ctx(created.auditId));
    await order.POST(post({ auditId: created.auditId }));

    // First attempt: plan succeeds, every search fails → retryable failure, plan saved.
    const first = await verify.POST(post({ auditId: created.auditId, demo: true }));
    // Phase 2 (intentional): verify returns 200 once the payment is recorded and the job is durable; the job's
    // retryable failure is what marks the audit failed (and keeps the plan checkpoint), as before.
    expect(first.status).toBe(200);
    await (await import('@/lib/jobs')).settleDetached(); // Phase 2: the audit runs as a job after verify returns
    const afterFirst = await db.audit.findUnique({ where: { id: created.auditId } });
    expect(afterFirst).toMatchObject({ status: 'failed', paymentStatus: 'paid' });
    const checkpoint = JSON.parse((await db.projectFile.findFirst({ where: { auditId: created.auditId, path: 'research.json' } })).content);
    expect(checkpoint).toMatchObject({ version: 2, stage: 'PLANNED' });
    expect(kinds.filter((k) => k === 'plan')).toHaveLength(1);

    // Retry: existing verify route, no payment fields. Resumes at search; no second plan, payment or order.
    tavilyDown = false;
    const retry = await verify.POST(post({ auditId: created.auditId }));
    expect(retry.status).toBe(200);
    await (await import('@/lib/jobs')).settleDetached(); // Phase 2: the audit runs as a job after verify returns
    expect(kinds.filter((k) => k === 'plan')).toHaveLength(1);
    const done = await db.audit.findUnique({ where: { id: created.auditId } });
    expect(done).toMatchObject({ status: 'completed', paymentStatus: 'paid', paymentRef: afterFirst.paymentRef });
    expect(razorpay).toEqual({ constructed: 0, ordersCreated: 0 });
    const research = JSON.parse((await db.projectFile.findFirst({ where: { auditId: created.auditId, path: 'research.json' } })).content);
    expect(research.stage).toBeUndefined();
    expect(research.questions).toHaveLength(6);

    // Company identity unchanged; the objective page renders (sync) twice concurrently without errors.
    const objective = await db.objective.findUnique({ where: { id: created.objectiveId }, include: { organization: true } });
    expect(objective.organization.name).toBe('Aaira Books');
    expect(objective.text).toBe(IDEA);
    const Page = (await import('@/app/objectives/[id]/page')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const pages = await Promise.all([1, 2].map(async () => renderToStaticMarkup(await Page({ params: Promise.resolve({ id: created.objectiveId }) }))));
    for (const html of pages) { expect(html).toContain('Aaira Books'); expect(html).toContain('What Aristotle researched'); }
    expect(await db.researchQuestion.count({ where: { objectiveId: created.objectiveId } })).toBe(6);
    vi.unstubAllGlobals(); delete process.env.HIPPO_USAGE_LEDGER;
  }, 30_000);
});
