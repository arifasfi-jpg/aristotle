import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError } from '@/lib/hippo/context';
import { recordPublicResponse } from '@/lib/hippo/move-service';
import { clientIp, guardIp, hashIp } from '@/lib/rate-limit';
import { getCurrentUser } from '@/lib/session';

// The native public surface: a visitor responds to a founder's page. Each response is a Signal Hippo observes itself.
// Works without JavaScript (form post → redirect back) and as JSON. Rate-limited per IP; a honeypot field drops bots.
export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().trim().max(100).optional().default(''),
  contact: z.string().trim().min(5, 'Leave an email or phone number so they can reach you.').max(200)
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+?[\d\s-]{7,15}$/.test(v), 'Leave a valid email or phone number.'),
  message: z.string().trim().max(1000).optional().default(''),
  website: z.string().optional().default(''), // honeypot: real people never fill this
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const form = (req.headers.get('content-type') || '').includes('application/json') ? null : await req.formData().catch(() => null);
  const back = (q: string) => NextResponse.redirect(new URL(`/p/${encodeURIComponent(slug)}?${q}`, req.url), 303);
  try {
    const ip = await guardIp(req, 'respond');
    if (!ip.ok) throw new HttpError(ip.status, ip.error);
    const input = schema.parse(form ? Object.fromEntries(form.entries()) : await req.json());
    if (input.website) return form ? back('thanks=1') : NextResponse.json({ ok: true }); // bot: pretend success, record nothing
    const user = await getCurrentUser().catch(() => null);
    await recordPublicResponse(slug, { name: input.name, contact: input.contact, message: input.message }, { ipHash: hashIp(clientIp(req)), viewerUserId: user?.id ?? null });
    return form ? back('thanks=1') : NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500;
    const message = e instanceof z.ZodError ? e.issues[0]?.message : e instanceof HttpError ? e.message : 'Something went wrong. Please try again.';
    if (status === 500) console.error(JSON.stringify({ event: 'public_response_failed', slug, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    return form ? back(`error=${encodeURIComponent(message || 'error')}`) : NextResponse.json({ error: message }, { status });
  }
}
