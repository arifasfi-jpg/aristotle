import { z } from 'zod';
import { getFounderContext } from '@/lib/hippo/context';
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
    const b = schema.parse(await req.json());
    const ctx = await getFounderContext({ create: true, name: b.name || undefined });
    if (!ctx?.founder || !ctx.org) throw new Error('could not create founder context');
    return createObjective({ user: ctx.user, founder: ctx.founder, org: ctx.org }, { text: b.text, mode: b.mode, timeCommitment: b.timeCommitment, isDemo: b.demo, companyName: b.companyName });
  });
}
