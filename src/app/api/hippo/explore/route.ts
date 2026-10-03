import { z } from 'zod';
import { HttpError } from '@/lib/hippo/context';
import { handle } from '@/lib/hippo/http';
import { generateJson } from '@/lib/hippo/gateway';
import { EXPLORE_SCHEMA, explorePrompt, normaliseDirections } from '@/lib/hippo/explore';
import { guardIp, guardUser } from '@/lib/rate-limit';
import { currentOrGuestUser } from '@/lib/session';

export const maxDuration = 30;
const schema = z.object({ about: z.string().trim().min(20, 'Tell Hippoturtle a little about yourself (skills, interests, time, budget).').max(3000) });
/**
 * "I don't have an idea yet." Free, so protected: same-origin only, rate-limited per IP and per user, every call
 * attributed to a session (a first-time visitor gets the same anonymous session Hippoturtle already creates for an
 * objective), metered in AiUsage and bounded by the platform's daily free-tier cap in the gateway.
 */
export async function POST(req: Request) {
  return handle('explore', async () => {
    const ip = await guardIp(req, 'explore');
    if (!ip.ok) throw new HttpError(ip.status, ip.error);
    const about = schema.parse(await req.json()).about;
    const user = await currentOrGuestUser();
    const u = await guardUser(user.id, 'explore');
    if (!u.ok) throw new HttpError(u.status, u.error);
    const r = await generateJson<unknown>('explore', explorePrompt(about), EXPLORE_SCHEMA, {}, { userId: user.id, parentType: 'REQUEST' });
    return { directions: normaliseDirections(r.data) };
  });
}
