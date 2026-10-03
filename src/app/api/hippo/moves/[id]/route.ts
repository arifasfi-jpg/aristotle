import { z } from 'zod';
import { HttpError, requireFounder } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { cardAction } from '@/lib/hippo/conversation-moves';
import { viewConversation } from '@/lib/hippo/conversation-service';
import { movesEnabled } from '@/lib/hippo/moves';
import { guardIp } from '@/lib/rate-limit';

// The Move card's controls (Yes / Not now / Help me / Try another way / I can't / This failed / I did it / What's next /
// Why). Same rules as saying it in chat; the founder's choice and Hippo's answer are added to the conversation.
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const schema = z.object({
  action: z.enum(['YES', 'NOT_NOW', 'RESUME', 'HELP', 'ANOTHER_WAY', 'CANT', 'FAILED', 'DID_IT', 'NEXT', 'WHY']),
  text: z.string().trim().max(1000).optional(),
  proof: z.string().trim().url('Paste a link (or leave it empty).').max(500).optional(),
  guardian: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('move action', async () => {
    if (!movesEnabled()) throw new HttpError(404, 'Not found');
    const ip = await guardIp(req, 'converse');
    if (!ip.ok) throw new HttpError(ip.status, ip.error);
    const ctx = await requireFounder();
    const b = schema.parse(await req.json());
    await cardAction(ctx, (await params).id, b.action, { text: b.text, proof: b.proof, guardian: b.guardian });
    return viewConversation(ctx.user.id);
  });
}
