import crypto from 'crypto';

/**
 * Demo checkout (no real payment) is allowed ONLY when explicitly enabled AND never in production.
 * A missing Razorpay key never enables it: production fails closed instead of giving away audits.
 */
export function isDemoMode(): boolean {
  if (process.env.DEMO_MODE !== 'true') return false;
  if (process.env.VERCEL_ENV === 'production') return false;
  if (process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV) return false; // self-hosted production
  return true;
}

export const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

export function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
