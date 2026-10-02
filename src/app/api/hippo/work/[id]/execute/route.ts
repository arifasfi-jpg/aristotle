import { requireWork } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { executeWork } from '@/lib/hippo/service';

export const maxDuration = 60;
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('execute work', async () => {
    const ctx = await requireWork((await params).id);
    const e = await executeWork(ctx);
    return { executionId: e.id, status: e.status };
  });
}
