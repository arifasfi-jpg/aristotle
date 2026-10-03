// Preview session isolation: each Preview deployment starts with a clean anonymous founder, refresh/navigation within a
// deployment keeps the session, and Production keeps its cookie name unchanged. Also: when a parked job is "due".
import { afterEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); } }) }));
const sessions = new Map<string, { tokenHash: string; userId: string; expiresAt: Date }>();
let users = 0;
vi.mock('@/lib/db', () => ({ db: {
  session: { create: async ({ data }: any) => { sessions.set(data.tokenHash, data); return data; }, findUnique: async ({ where }: any) => { const s = sessions.get(where.tokenHash); return s ? { ...s, user: { id: s.userId } } : null; } }, // eslint-disable-line @typescript-eslint/no-explicit-any
  user: { create: async () => ({ id: `user_${++users}` }) },
} }));

const { sessionCookieName, currentOrGuestUser, getCurrentUser, freshStartAllowed, startFreshSession, switchToPreviousSession } = await import('../src/lib/session');
const { isDue } = await import('../src/lib/jobs/runtime');

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });
const deploy = (env: string | undefined, sha?: string) => {
  if (env) process.env.VERCEL_ENV = env; else delete process.env.VERCEL_ENV;
  if (sha) process.env.VERCEL_GIT_COMMIT_SHA = sha; else delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.ARISTOTLE_SESSION_COOKIE;
};

describe('Session cookie name', () => {
  it('Production and local keep the existing name, whatever the commit', () => {
    expect(sessionCookieName({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: '33eea91504e898' })).toBe('aristotle_session');
    expect(sessionCookieName({})).toBe('aristotle_session');
    expect(sessionCookieName({ ARISTOTLE_SESSION_COOKIE: 'custom', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abc1234' })).toBe('custom');
  });
  it('Preview is namespaced by the deployment commit (7 chars); without a commit it is unchanged', () => {
    expect(sessionCookieName({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: '33eea91504e898' })).toBe('aristotle_session_33eea91');
    expect(sessionCookieName({ VERCEL_ENV: 'preview' })).toBe('aristotle_session');
  });
});

describe('Preview: a new deployment starts clean; the same deployment persists', () => {
  it('REGRESSION: same deployment → same founder on refresh; new deployment → a clean founder; Production unaffected', async () => {
    jar.clear();
    deploy('preview', '33eea91504e898');
    const first = await currentOrGuestUser();
    expect((await getCurrentUser())?.id).toBe(first.id);        // refresh / navigation
    expect((await currentOrGuestUser()).id).toBe(first.id);     // no second user created
    deploy('preview', 'b7c1d20aa');                              // next Preview deployment, same browser
    expect(await getCurrentUser()).toBeNull();                   // the old EMI founder is not reused
    const fresh = await currentOrGuestUser();
    expect(fresh.id).not.toBe(first.id);
    expect([...jar.keys()].sort()).toEqual(['aristotle_session_33eea91', 'aristotle_session_b7c1d20']);
    deploy('production', 'b7c1d20aa');
    expect(sessionCookieName()).toBe('aristotle_session');
  });
});

describe('isDue: when polling may continue a job', () => {
  const now = new Date('2026-10-03T18:20:00Z');
  const past = new Date(now.getTime() - 1000); const future = new Date(now.getTime() + 60_000);
  it('queued and due, or running with an expired lease (dead worker) — nothing else', () => {
    expect(isDue({ status: 'QUEUED', runAfter: past, leaseUntil: null }, now)).toBe(true);
    expect(isDue({ status: 'QUEUED', runAfter: future, leaseUntil: null }, now)).toBe(false); // retry back-off respected
    expect(isDue({ status: 'RUNNING', runAfter: past, leaseUntil: past }, now)).toBe(true);
    expect(isDue({ status: 'RUNNING', runAfter: past, leaseUntil: future }, now)).toBe(false); // a live worker owns it
    for (const status of ['COMPLETED', 'FAILED', 'WAITING', 'CANCELLED']) expect(isDue({ status, runAfter: past, leaseUntil: null }, now)).toBe(false);
  });
});

describe('Start a New Business: session mechanics (no database)', () => {
  it('only outside Production', () => {
    expect(freshStartAllowed({ VERCEL_ENV: 'production' })).toBe(false);
    expect(freshStartAllowed({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(freshStartAllowed({})).toBe(true); // local development
  });
  it('a fresh start is a new founder; the previous session stays valid and is kept for switching back; switching swaps them', async () => {
    jar.clear(); deploy('preview', '3532728abc');
    const a = await currentOrGuestUser();
    const tokenA = jar.get('aristotle_session_3532728')!;
    const b = await startFreshSession();
    expect(b.id).not.toBe(a.id);
    expect((await getCurrentUser())!.id).toBe(b.id);
    expect((await getCurrentUser())!.id).toBe(b.id); // refresh keeps the fresh business
    expect(JSON.parse(jar.get('aristotle_session_3532728_prev')!)).toEqual([tokenA]);
    expect(await switchToPreviousSession(0)).toBe(true);
    expect((await getCurrentUser())!.id).toBe(a.id);
    expect(JSON.parse(jar.get('aristotle_session_3532728_prev')!)).toHaveLength(1);
    expect(await switchToPreviousSession(0)).toBe(true); // and back again
    expect((await getCurrentUser())!.id).toBe(b.id);
    expect(await switchToPreviousSession(4)).toBe(false); // nothing there: unchanged
    expect((await getCurrentUser())!.id).toBe(b.id);
  });
  it('a tampered previous-list cookie is ignored (only well-formed tokens of real sessions are honoured)', async () => {
    jar.clear(); deploy('preview', '3532728abc');
    await currentOrGuestUser();
    jar.set('aristotle_session_3532728_prev', JSON.stringify(['not-a-token', 'f'.repeat(64)]));
    expect(await switchToPreviousSession(0)).toBe(false); // 'f…f' is well-formed but no such session
  });
});
