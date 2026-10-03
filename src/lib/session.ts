import crypto from 'crypto';
import { cookies } from 'next/headers';
import { db } from './db';

const DAYS = 30;

/**
 * Session cookie name. Production (and local): unchanged. Vercel Preview only: namespaced by the deployment's commit,
 * so each new Preview deployment starts with a clean anonymous founder (the Preview URL and database outlive a
 * deployment), while refresh and navigation within one deployment keep the same session.
 */
export function sessionCookieName(env: Record<string, string | undefined> = process.env): string {
  const base = env.ARISTOTLE_SESSION_COOKIE || 'aristotle_session';
  const sha = env.VERCEL_GIT_COMMIT_SHA?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 7);
  return env.VERCEL_ENV === 'preview' && sha ? `${base}_${sha}` : base;
}

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.session.create({ data: { tokenHash, userId, expiresAt: new Date(Date.now() + DAYS * 86400000) } });
  const jar = await cookies();
  jar.set(sessionCookieName(), token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: DAYS * 86400 });
  return token;
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

/** The signed-in (anonymous-cookie) user, or a new anonymous user + session — the same identity Hippoturtle creates for an objective. */
export async function currentOrGuestUser() {
  const user = await getCurrentUser();
  if (user) return user;
  const created = await db.user.create({ data: {} });
  await createSession(created.id);
  return created;
}

// ---------------------------------------------------------------- fresh business (Preview / local testing)
const PREVIOUS_MAX = 5;
const previousCookieName = (env: Record<string, string | undefined> = process.env) => `${sessionCookieName(env)}_prev`;
const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: DAYS * 86400 };
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** "Start a New Business" exists outside Production only (Preview, local). Production behaviour is unchanged. */
export const freshStartAllowed = (env: Record<string, string | undefined> = process.env) => env.VERCEL_ENV !== 'production';

async function previousTokens(): Promise<string[]> {
  const raw = (await cookies()).get(previousCookieName())?.value;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t)).slice(0, PREVIOUS_MAX) : []; } catch { return []; }
}

/**
 * Starts a genuinely fresh business: a new anonymous founder with its own session (so organisation, memory and company
 * name cannot mix with the existing business). Nothing is deleted: the current session stays valid in the database
 * and its token is kept in this browser's "previous businesses" list, so the founder can switch back.
 */
export async function startFreshSession() {
  const jar = await cookies();
  const current = jar.get(sessionCookieName())?.value;
  const prev = await previousTokens();
  const user = await db.user.create({ data: {} });
  await createSession(user.id);
  if (current && /^[a-f0-9]{64}$/.test(current)) jar.set(previousCookieName(), JSON.stringify([current, ...prev.filter((t) => t !== current)].slice(0, PREVIOUS_MAX)), cookieOpts);
  return user;
}

/** The businesses this browser started earlier (most recent first), each with its latest objective, for switching back. */
export async function previousBusinesses(): Promise<{ index: number; userId: string; objective: string | null }[]> {
  const out: { index: number; userId: string; objective: string | null }[] = [];
  for (const [index, token] of (await previousTokens()).entries()) {
    const s = await db.session.findUnique({ where: { tokenHash: hashOf(token) }, include: { user: true } });
    if (!s || s.expiresAt < new Date()) continue;
    const o = await db.objective.findFirst({ where: { organization: { founder: { userId: s.userId } } }, orderBy: { createdAt: 'desc' }, select: { text: true } });
    out.push({ index, userId: s.userId, objective: o?.text ?? null });
  }
  return out;
}

/** Switches this browser back to a previous business; the business it leaves joins the previous list. */
export async function switchToPreviousSession(index: number): Promise<boolean> {
  const jar = await cookies();
  const prev = await previousTokens();
  const target = prev[index];
  if (!target) return false;
  const s = await db.session.findUnique({ where: { tokenHash: hashOf(target) } });
  if (!s || s.expiresAt < new Date()) return false;
  const current = jar.get(sessionCookieName())?.value;
  const rest = prev.filter((_, i) => i !== index);
  jar.set(sessionCookieName(), target, cookieOpts);
  jar.set(previousCookieName(), JSON.stringify([...(current && /^[a-f0-9]{64}$/.test(current) ? [current] : []), ...rest].slice(0, PREVIOUS_MAX)), cookieOpts);
  return true;
}
