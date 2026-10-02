import { requireObjective } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { generateWork } from '@/lib/hippo/service';

export const maxDuration = 60;
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('generate work', async () => {
    const { objective } = await requireObjective((await params).id);
    return { work: (await generateWork(objective)).map((w) => ({ id: w.id, title: w.title })) };
  });
}
