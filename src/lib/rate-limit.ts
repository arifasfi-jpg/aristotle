// Request limits for endpoints that spend AI money before any payment (abuse / cost protection).
// Fixed one-hour windows in Postgres, incremented atomically (INSERT … ON CONFLICT … RETURNING), keyed by
// action + hashed client IP and action + user. IPs are never stored in clear.
import crypto from 'crypto';

export type GuardedAction = 'explore' | 'objective' | 'scope-classify' | 'quote';

/** Requests per hour. Per-IP limits stop one machine from minting guest accounts to bypass the per-user limit. */
export const LIMITS: Record<GuardedAction, { user: number; ip: number }> = {
  explore: { user: 10, ip: 30 },
  objective: { user: 10, ip: 30 },
  'scope-classify': { user: 20, ip: 60 },
  quote: { user: 30, ip: 90 },
};
const WINDOW_MS = 60 * 60_000;

/** Client IP as the platform reports it (Vercel sets x-vercel-forwarded-for / x-real-ip; never trusted for auth). */
export function clientIp(req: Request): string {
  const h = req.headers;
  return (h.get('x-vercel-forwarded-for') || h.get('x-real-ip') || h.get('x-forwarded-for') || 'unknown').split(',')[0].trim() || 'unknown';
}
export const hashIp = (ip: string) => crypto.createHash('sha256').update(`${process.env.HIPPO_IP_SALT || 'hippoturtle'}\u0000${ip}`).digest('hex').slice(0, 32);

/**
 * Browser requests carry an Origin header; a cross-site Origin is refused (a page elsewhere cannot spend a visitor's
 * allowance). Requests without Origin (server-to-server, tests) are still rate-limited.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  try { return Boolean(host) && new URL(origin).host === host; } catch { return false; }
}

/** Atomically counts one request in the current window; returns the new count. */
export async function hit(key: string, now = new Date()): Promise<{ count: number; resetAt: Date }> {
  const windowStart = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  const { db } = await import('./db'); // lazy: importing the limiter never constructs a database client
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count") VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  return { count: Number(rows[0]?.count ?? 1), resetAt: new Date(windowStart.getTime() + WINDOW_MS) };
}

export type GuardResult = { ok: true } | { ok: false; status: 403 | 429; error: string };

const TOO_MANY = 'You have reached the limit for now. Please try again in a little while.';

/** IP check first (before a guest account is created), then the user check once the caller is known. */
export async function guardIp(req: Request, action: GuardedAction): Promise<GuardResult> {
  if (!sameOrigin(req)) return { ok: false, status: 403, error: 'Request not allowed.' };
  const ip = clientIp(req);
  // No client IP (never on Vercel; possible behind a misconfigured proxy): do not throttle everyone as one "unknown"
  // visitor. The per-user limit and the platform's daily free-tier cap still apply.
  if (ip === 'unknown') return { ok: true };
  return limit(`${action}:ip:${hashIp(ip)}`, LIMITS[action].ip);
}
export async function guardUser(userId: string, action: GuardedAction): Promise<GuardResult> {
  return limit(`${action}:user:${userId}`, LIMITS[action].user);
}

async function limit(key: string, max: number): Promise<GuardResult> {
  try {
    const { count } = await hit(key);
    return count > max ? { ok: false, status: 429, error: TOO_MANY } : { ok: true };
  } catch (e) {
    // The limiter's own failure must not take the product down; the per-call ceiling and the platform's
    // daily free-tier cap (gateway) still bound spend. The miss is logged.
    console.error(JSON.stringify({ event: 'rate_limit_unavailable', key: key.split(':').slice(0, 2).join(':'), error: e instanceof Error ? e.message : String(e) }));
    return { ok: true };
  }
}
