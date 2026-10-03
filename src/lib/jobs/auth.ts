import crypto from 'crypto';

/**
 * Internal worker authorization. The worker endpoint runs paid AI work, so it is never public: the caller must present
 * `Authorization: Bearer <CRON_SECRET>` (the header Vercel Cron sends when CRON_SECRET is set). No secret configured →
 * the endpoint is disabled. Constant-time comparison; the secret is never logged.
 */
export function workerAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const got = req.headers.get('authorization') || '';
  const want = `Bearer ${secret}`;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
