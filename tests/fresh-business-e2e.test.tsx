// "Start a New Business" (Preview / local only) on REAL PostgreSQL: /start?fresh=1 and the founder button start a
// genuinely fresh founder session + conversation without touching the existing business, which stays reachable
// ("Switch back"); refresh keeps the current business; Production is unchanged (no button, routes 404).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const env = { ...process.env };
beforeEach(() => { Object.assign(process.env, { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: '3532728abcdef' }); delete process.env.GEMINI_API_KEY; });
afterEach(() => { process.env = { ...env }; });

const BOOK = 'We publish a kids quiz book and sell 300 copies a month; we want 3,000 a month.';
async function setup() {
  const { db } = await import('@/lib/db') as { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const session = await import('@/lib/session');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Start = (await import('@/app/start/page')).default;
  const start = async (q?: Record<string, string>) => renderToStaticMarkup(await Start({ searchParams: Promise.resolve(q ?? {}) }));
  const freshRoute = await import('@/app/api/session/fresh/route');
  const switchRoute = await import('@/app/api/session/switch/route');
  const objectives = await import('@/app/api/hippo/objectives/route');
  const { viewConversation } = await import('@/lib/hippo/conversation-service');
  const newObjective = (text: string, companyName: string) => objectives.POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, companyName }) })).then((r) => r.json());
  return { db, session, start, freshRoute, switchRoute, newObjective, viewConversation };
}

describe.skipIf(!E2E)('Start a New Business (real Postgres)', () => {
  it('REGRESSION: a fresh business never reuses the existing one; the existing one is preserved and reachable', async () => {
    const { db, session, start, freshRoute, switchRoute, newObjective, viewConversation } = await setup();
    jar = new Map();
    const book = await newObjective(BOOK, 'Aaira Books');
    const userA = (await session.getCurrentUser())!;
    const { emptyState } = await import('@/lib/hippo/conversation');
    await db.conversation.create({ data: { userId: userA.id, status: 'HANDED_OFF', phase: 'HANDED_OFF', state: { ...emptyState(), objective: 'Grow the quiz book to 3,000 a month' }, objectiveId: book.objectiveId } });

    // Refresh / navigation keeps the current business.
    expect((await session.getCurrentUser())!.id).toBe(userA.id);
    expect((await viewConversation(userA.id)).objectiveId).toBe(book.objectiveId);
    const before = await start();
    expect(before).toContain('Start a New Business');
    expect(before).not.toContain('Switch back');

    // /start?fresh=1 hands over to the session route (which redirects back to a clean /start).
    await expect(start({ fresh: '1' })).rejects.toThrow('REDIRECT /api/session/fresh');
    const res = await freshRoute.GET(new Request('http://preview.test/api/session/fresh'));
    expect([res.status, res.headers.get('location')]).toEqual([303, 'http://preview.test/start']);

    const userB = (await session.getCurrentUser())!;
    expect(userB.id).not.toBe(userA.id);
    const conv = await viewConversation(userB.id);
    expect([conv.id, conv.objectiveId, conv.messages.length]).toEqual([null, null, 1]); // only Hippo's opening line
    // Nothing of the book business was deleted or archived; its session is still valid.
    expect(await db.objective.count({ where: { id: book.objectiveId } })).toBe(1);
    expect(await db.conversation.findFirst({ where: { userId: userA.id } })).toMatchObject({ status: 'HANDED_OFF', objectiveId: book.objectiveId });
    expect(await db.session.count({ where: { userId: userA.id, expiresAt: { gt: new Date() } } })).toBe(1);

    // The new business lives in its own organisation: no shared company name, memory or objectives.
    const cafe = await newObjective('I want to open a cafe in Pune and reach 200 covers a day.', 'Pune Brews');
    const [oBook, oCafe] = await Promise.all([book.objectiveId, cafe.objectiveId].map((id) => db.objective.findUnique({ where: { id }, include: { organization: true } })));
    expect(oCafe.organizationId).not.toBe(oBook.organizationId);
    expect([oBook.organization.name, oCafe.organization.name]).toEqual(['Aaira Books', 'Pune Brews']);
    expect((await session.getCurrentUser())!.id).toBe(userB.id); // refresh keeps the new business

    // The existing business is listed and can be switched back to.
    const html = await start();
    expect(html).toContain('Your other businesses in this browser');
    expect(html).toContain(BOOK);
    const form = new FormData(); form.set('index', '0');
    expect((await switchRoute.POST(new Request('http://preview.test/api/session/switch', { method: 'POST', body: form }))).status).toBe(303);
    expect((await session.getCurrentUser())!.id).toBe(userA.id);
    expect((await viewConversation(userA.id)).objectiveId).toBe(book.objectiveId);
    expect((await session.previousBusinesses()).map((b) => b.objective)).toEqual(['I want to open a cafe in Pune and reach 200 covers a day.']);
  });

  it('Production is unchanged: no button, ?fresh=1 ignored, both routes 404, session untouched', async () => {
    const { session, start, freshRoute, switchRoute, newObjective } = await setup();
    process.env.VERCEL_ENV = 'production';
    jar = new Map();
    await newObjective(BOOK, 'Aaira Books');
    const userA = (await session.getCurrentUser())!;
    const cookies = new Map(jar);
    const html = await start({ fresh: '1' }); // no redirect thrown
    expect(html).not.toContain('Start a New Business');
    expect((await freshRoute.GET(new Request('http://prod.test/api/session/fresh'))).status).toBe(404);
    expect((await freshRoute.POST(new Request('http://prod.test/api/session/fresh', { method: 'POST' }))).status).toBe(404);
    expect((await switchRoute.POST(new Request('http://prod.test/api/session/switch', { method: 'POST', body: new FormData() }))).status).toBe(404);
    expect(jar).toEqual(cookies);
    expect((await session.getCurrentUser())!.id).toBe(userA.id);
    expect(session.sessionCookieName()).toBe('aristotle_session');
  });
});
