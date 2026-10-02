import { z } from 'zod';
import { requireObjective } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { selectPathways } from '@/lib/hippo/service';

const schema = z.object({ ids: z.array(z.string().regex(/^P\d+$/)).min(1, 'Choose at least one pathway to pursue.').max(7) });
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('select pathways', async () => {
    const { objective } = await requireObjective((await params).id);
    return { chosen: await selectPathways(objective, schema.parse(await req.json()).ids) };
  });
}
