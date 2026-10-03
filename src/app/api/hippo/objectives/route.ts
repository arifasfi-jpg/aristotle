import { z } from 'zod';
import { getFounderContext, HttpError } from '@/lib/hippo/context';
import { guardIp, guardUser } from '@/lib/rate-limit';
import { handle } from '@/lib/hippo/http';
import { createObjective } from '@/lib/hippo/service';
import { TIME_COMMITMENTS } from '@/lib/hippo/types';

export const maxDuration = 30;
const schema = z.object({
  text: z.string().trim().min(20, 'Please describe what you want to build or achieve in at least a sentence.').max(5000),
  mode: z.enum(['IDEA', 'EXPLORE']).default('IDEA'),
  timeCommitment: z.enum(TIME_COMMITMENTS).nullish(),
  name: z.string().trim().max(100).nullish(),
  companyName: z.string().trim().max(120).nullish(),
  demo: z.boolean().optional(),
});

export async function POST(req: Request) {
  return handle('create objective', async () => {
    // Creating an objective calls the AI before any payment: rate-limited per IP (before a guest account exists) and per user.
    const ip = await guardIp(req, 'objective');
    if (!ip.ok) throw new HttpError(ip.status, ip.error);
    const b = schema.parse(await req.json());
    const ctx = await getFounderContext({ create: true, name: b.name || undefined });
    if (!ctx?.founder || !ctx.org) throw new Error('could not create founder context');
    const u = await guardUser(ctx.user.id, 'objective');
    if (!u.ok) throw new HttpError(u.status, u.error);
    return createObjective({ user: ctx.user, founder: ctx.founder, org: ctx.org }, { text: b.text, mode: b.mode, timeCommitment: b.timeCommitment, isDemo: b.demo, companyName: b.companyName });
  });
}
