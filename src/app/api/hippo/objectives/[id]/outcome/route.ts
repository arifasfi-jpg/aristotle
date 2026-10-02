import { requireObjective } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { outcomeSchema } from '@/lib/hippo/outcome-schema';
import { recordOutcome } from '@/lib/hippo/service';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('objective outcome', async () => {
    const ctx = await requireObjective((await params).id);
    const o = await recordOutcome({ org: ctx.org, objective: ctx.objective }, outcomeSchema.parse(await req.json()));
    return { id: o.id };
  });
}
