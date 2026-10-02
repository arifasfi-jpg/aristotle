import { requireObjective } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { generatePathways, refreshObjective } from '@/lib/hippo/service';

export const maxDuration = 60;
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('pathways', async () => {
    const { objective } = await requireObjective((await params).id);
    return { result: await generatePathways(await refreshObjective(objective)) };
  });
}
