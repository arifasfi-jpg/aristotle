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
