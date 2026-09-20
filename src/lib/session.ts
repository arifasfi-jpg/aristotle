import crypto from 'crypto';
import { cookies } from 'next/headers';
import { db } from './db';

const COOKIE = process.env.ARISTOTLE_SESSION_COOKIE || 'aristotle_session';
const DAYS = 30;

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.session.create({ data: { tokenHash, userId, expiresAt: new Date(Date.now() + DAYS * 86400000) } });
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: DAYS * 86400 });
  return token;
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
