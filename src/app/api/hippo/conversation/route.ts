import { z } from 'zod';
import { getFounderContext, HttpError } from '@/lib/hippo/context';
import { guardIp, guardUser } from '@/lib/rate-limit';
import { handle } from '@/lib/hippo/http';
import { newConversation, postMessage, viewConversation } from '@/lib/hippo/conversation-service';

// The Hippo conversation. GET: the founder's current conversation (survives refresh). POST: one founder message
// (or { action: 'new' } to start over). Each turn uses the cheapest model tier through the metered gateway, is
// rate-limited, and counts against the platform's free-tier cap. Research starts only after explicit approval.
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle('load conversation', async () => {
    const ctx = await getFounderContext({ create: false });
    return viewConversation(ctx?.user.id ?? null);
  });
}

const schema = z.union([
  z.object({ text: z.string().trim().min(1, 'Say something to Hippo.').max(2000, 'Keep it under 2,000 characters.') }),
  z.object({ action: z.literal('new') }),
]);

export async function POST(req: Request) {
  return handle('hippo message', async () => {
    const ip = await guardIp(req, 'converse');
    if (!ip.ok) throw new HttpError(ip.status, ip.error);
    const b = schema.parse(await req.json());
    const ctx = await getFounderContext({ create: true });
    if (!ctx?.founder || !ctx.org) throw new Error('could not create founder context');
    if ('action' in b) return newConversation(ctx.user.id);
    const u = await guardUser(ctx.user.id, 'converse');
    if (!u.ok) throw new HttpError(u.status, u.error);
    return postMessage({ user: ctx.user, founder: ctx.founder, org: ctx.org }, b.text);
  });
}
