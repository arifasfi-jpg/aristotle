import { z } from 'zod';
import { requireWork } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { chooseExecution } from '@/lib/hippo/service';

const schema = z.object({ mode: z.enum(['AI', 'HUMAN', 'HYBRID', 'LATER']) });
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('choose execution', async () => {
    const ctx = await requireWork((await params).id);
    return chooseExecution(ctx, schema.parse(await req.json()).mode);
  });
}
