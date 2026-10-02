import { z } from 'zod';
import { requireWork } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { approveInput } from '@/lib/hippo/service';

const schema = z.object({ item: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(300) });
/** Founder explicitly approves an AI-proposed Work Brief input (e.g. a validation price). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('approve input', async () => approveInput(await requireWork((await params).id), schema.parse(await req.json())));
}
