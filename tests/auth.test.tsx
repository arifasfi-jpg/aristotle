// Security regression tests for the email-only session vulnerability in POST /api/audits.
//
// The REAL session code (src/lib/session.ts), the REAL route, history page, audit page and export route
// run here. Only the database (in-memory, with Prisma-like unique constraints) and the browser cookie
// jar (one jar per simulated browser) are faked.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const db = { users: new Map<string, Row>(), sessions: new Map<string, Row>(), audits: new Map<string, Row>(), files: [] as Row[] };
let seq = 0;
const id = (p: string) => `${p}_${++seq}`;

const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v);

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      create: async ({ data }: Row) => {
        if (data.email != null && [...db.users.values()].some((u) => u.email === data.email)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' });
        }
        const u = { id: id('user'), email: null, name: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.users.set(u.id, u);
        return { ...u };
      },
      // The fixed code must never call these on the request path; they throw so any regression is caught.
      upsert: async () => { throw new Error('SECURITY REGRESSION: db.user.upsert called from audit creation'); },
      update: async () => { throw new Error('SECURITY REGRESSION: db.user.update called from audit creation'); },
    },
    session: {
      create: async ({ data }: Row) => { const s = { id: id('sess'), createdAt: new Date(), ...data }; db.sessions.set(s.tokenHash, s); return s; },
      findUnique: async ({ where, include }: Row) => {
        const s = db.sessions.get(where.tokenHash);
        if (!s) return null;
        return include?.user ? { ...s, user: { ...db.users.get(s.userId)! } } : s;
      },
    },
    audit: {
      create: async ({ data }: Row) => {
        const a = { id: id('audit'), status: 'completed', paymentStatus: 'pending', paymentRef: null, computePaise: 0, marginPaise: 0, contactEmail: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.audits.set(a.id, a);
        return { ...a };
      },
      findFirst: async ({ where, include }: Row) => {
        const a = [...db.audits.values()].find((x) => matches(x, where));
        if (!a) return null;
        return include?.artifacts ? { ...a, artifacts: db.files.filter((f) => f.auditId === a.id) } : { ...a };
      },
      findMany: async ({ where }: Row) => [...db.audits.values()].filter((x) => matches(x, where)).map((x) => ({ ...x })),
    },
    projectFile: {
      findUnique: async ({ where }: Row) => db.files.find((f) => f.auditId === where.auditId_path.auditId && f.path === where.auditId_path.path) ?? null,
      upsert: async ({ where, update, create }: Row) => {
        const f = db.files.find((x) => x.auditId === where.auditId_path.auditId && x.path === where.auditId_path.path);
        if (f) { Object.assign(f, update); return f; }
        db.files.push({ ...create }); return create;
      },
    },
  },
}));

// One cookie jar per simulated browser.
type Jar = Map<string, string>;
let jar: Jar = new Map();
const browser = () => new Map<string, string>() as Jar;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); } }),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

const { POST: createAudit } = await import('@/app/api/audits/route');
const { GET: exportAudit } = await import('@/app/api/audits/[id]/export/route');
const { default: HistoryPage } = await import('@/app/history/page');
const { default: AuditPage } = await import('@/app/audit/[id]/page');

const IDEA = 'A WhatsApp-first platform for kirana stores to accept repeat orders and reconcile UPI payments.';
const submit = async (b: Jar, name: string, email: string, idea = IDEA) => {
  jar = b;
  const r = await createAudit(new Request('http://x/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, idea, sector: 'B2B SaaS', stage: 'Idea / pre-launch', geography: 'India', language: 'Simple English' }) }));
  expect(r.status).toBe(200);
  return (await r.json()).id as string;
};
const ownerOf = (auditId: string) => db.audits.get(auditId)!.userId as string;
const historyHtml = async (b: Jar) => { jar = b; return renderToStaticMarkup(await HistoryPage()); };
const exportStatus = async (b: Jar, auditId: string) => { jar = b; return (await exportAudit(new Request('http://x'), { params: Promise.resolve({ id: auditId }) })).status; };
const auditPage = async (b: Jar, auditId: string) => {
  jar = b;
  try { return { html: renderToStaticMarkup(await AuditPage({ params: Promise.resolve({ id: auditId }) })) }; }
  catch (e: any) { return { error: String(e?.digest ?? e?.message ?? e) }; }
};

/** Victim: an existing account (as production has today) with a private audit, and their own browser. */
async function seedVictim() {
  const victimBrowser = browser();
  const victimAuditId = await submit(victimBrowser, 'Arif Victim', 'arif@example.com', 'PRIVATE victim idea: confidential D2C ayurveda brand launch plan for Kerala.');
  const victimId = ownerOf(victimAuditId);
  // Model a pre-existing production account, which has its email stored on User.
  db.users.get(victimId)!.email = 'arif@example.com';
  return { victimBrowser, victimAuditId, victimId };
}

beforeEach(() => { db.users.clear(); db.sessions.clear(); db.audits.clear(); db.files.length = 0; jar = new Map(); });

describe('POST /api/audits — email is never proof of identity', () => {
  it('TEST 1: unauthenticated visitor using an existing user\'s email gets a NEW separate identity, not the victim\'s session or data', async () => {
    const { victimAuditId, victimId } = await seedVictim();
    const attacker = browser();
    const attackerAuditId = await submit(attacker, 'Attacker', 'ARIF@example.com');

    const attackerId = ownerOf(attackerAuditId);
    expect(attackerId).not.toBe(victimId);
    // The attacker's cookie maps to the attacker's session, never to the victim.
    const sessionsForVictim = [...db.sessions.values()].filter((s) => s.userId === victimId);
    expect(sessionsForVictim).toHaveLength(1); // only the victim's own original session
    expect([...db.sessions.values()].filter((s) => s.userId === attackerId)).toHaveLength(1);

    // Victim's data is not reachable from the attacker's browser.
    const html = await historyHtml(attacker);
    expect(html).not.toContain('PRIVATE victim idea');
    expect((await auditPage(attacker, victimAuditId)).error).toMatch(/404|NOT_FOUND/);
    expect(await exportStatus(attacker, victimAuditId)).toBe(404);
    // The typed email is kept only as the audit's contact email.
    expect(db.audits.get(attackerAuditId)!.contactEmail).toBe('arif@example.com');
    expect(db.users.get(attackerId)!.email).toBeNull();
  });

  it('TEST 2: authenticated User A submitting User B\'s email keeps the audit with User A; User B untouched', async () => {
    const { victimId: userB } = await seedVictim();
    const userBBefore = { ...db.users.get(userB)! };
    const browserA = browser();
    const firstA = await submit(browserA, 'User A', 'a@example.com');
    const userA = ownerOf(firstA);
    const sessionsBefore = db.sessions.size;

    const secondA = await submit(browserA, 'User A', 'arif@example.com');
    expect(ownerOf(secondA)).toBe(userA);
    expect(db.sessions.size).toBe(sessionsBefore); // no new session, cookie not replaced
    expect(db.users.get(userB)).toEqual(userBBefore);
    expect(db.audits.get(secondA)!.contactEmail).toBe('arif@example.com');
  });

  it('TEST 3: unauthenticated visitor with a brand-new email gets a new user and session', async () => {
    const b = browser();
    const auditId = await submit(b, 'New Founder', 'new@example.com');
    const userId = ownerOf(auditId);
    expect(db.users.get(userId)).toMatchObject({ name: 'New Founder', email: null });
    expect(b.size).toBe(1); // session cookie set
    expect([...db.sessions.values()].filter((s) => s.userId === userId)).toHaveLength(1);
    expect(db.audits.get(auditId)!.contactEmail).toBe('new@example.com');
    expect(await historyHtml(b)).toContain('WhatsApp-first platform');
  });

  it('TEST 4: authenticated user submitting their own email keeps the same user and session', async () => {
    const b = browser();
    const first = await submit(b, 'Founder', 'me@example.com');
    const cookieBefore = [...b.values()][0];
    const second = await submit(b, 'Founder', 'me@example.com');
    expect(ownerOf(second)).toBe(ownerOf(first));
    expect([...b.values()][0]).toBe(cookieBefore);
    expect(db.sessions.size).toBe(1);
    const html = await historyHtml(b);
    expect(html.match(/WhatsApp-first platform/g)).toHaveLength(2); // both audits in one history
  });

  it('TEST 5: another user\'s audit page / export is not accessible (404), and no session gets 401 on export', async () => {
    const { victimBrowser, victimAuditId } = await seedVictim();
    const other = browser();
    await submit(other, 'Someone Else', 'else@example.com');
    expect((await auditPage(other, victimAuditId)).error).toMatch(/404|NOT_FOUND/);
    expect(await exportStatus(other, victimAuditId)).toBe(404);
    expect(await exportStatus(browser(), victimAuditId)).toBe(401);
    expect((await auditPage(browser(), victimAuditId)).html).toContain('Session required');
    // Owner still has full access (no regression).
    expect(await exportStatus(victimBrowser, victimAuditId)).toBe(200);
    expect((await auditPage(victimBrowser, victimAuditId)).html).toContain('PRIVATE victim idea');
  });

  it('TEST 6: submitting another user\'s email never changes that user\'s name', async () => {
    const { victimId } = await seedVictim();
    await submit(browser(), 'Hacked Name', 'arif@example.com');   // unauthenticated attacker
    const a = browser();
    await submit(a, 'User A', 'a@example.com');
    await submit(a, 'Hacked Again', 'arif@example.com');           // authenticated attacker
    expect(db.users.get(victimId)!.name).toBe('Arif Victim');
    expect(db.users.get(victimId)!.email).toBe('arif@example.com');
  });

  it('an expired/invalid cookie is treated as no session (new identity, never an email lookup)', async () => {
    const b = browser();
    b.set(process.env.ARISTOTLE_SESSION_COOKIE || 'aristotle_session', 'forged-or-expired-token');
    const auditId = await submit(b, 'Visitor', 'arif@example.com');
    expect(db.users.get(ownerOf(auditId))!.email).toBeNull();
  });
});
