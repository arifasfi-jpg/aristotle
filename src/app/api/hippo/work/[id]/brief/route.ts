import { requireWork } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { prepareBrief } from '@/lib/hippo/service';

export const maxDuration = 60;
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('work brief', async () => {
    const ctx = await requireWork((await params).id);
    const brief = await prepareBrief(ctx);
    return { briefId: brief.id };
  });
}
