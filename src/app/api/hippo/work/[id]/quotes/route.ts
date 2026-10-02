import { z } from 'zod';
import { requireWork } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { addQuote } from '@/lib/hippo/service';

export const maxDuration = 30;
const list = z.array(z.string().trim().min(1).max(200)).max(12).default([]);
const schema = z.object({
  providerName: z.string().trim().min(2).max(120),
  tier: z.enum(['INTEGRATED_PARTNER', 'PREFERRED_PROVIDER', 'EXTERNAL_OPTION']).default('EXTERNAL_OPTION'),
  amount: z.number().positive().max(100_000_000),
  includes: list, excludes: list,
  turnaroundDays: z.number().int().min(0).max(365).nullish(),
  revisions: z.number().int().min(0).max(50).nullish(),
  example: z.boolean().optional(),
});
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('add quote', async () => {
    const ctx = await requireWork((await params).id);
    const b = schema.parse(await req.json());
    // Founders can only record EXTERNAL_OPTION providers themselves; partner tiers are created by Hippoturtle onboarding.
    const r = await addQuote(ctx, { ...b, tier: 'EXTERNAL_OPTION', source: b.example ? 'EXAMPLE' : 'FOUNDER_ENTERED' });
    return { quoteId: r.quote.id, comparison: r.comparison };
  });
}
