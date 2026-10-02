import { z } from 'zod';
import { handle } from '@/lib/hippo/http';
import { generateJson } from '@/lib/hippo/gateway';
import { EXPLORE_SCHEMA, explorePrompt, normaliseDirections } from '@/lib/hippo/explore';

export const maxDuration = 30;
const schema = z.object({ about: z.string().trim().min(20, 'Tell Hippoturtle a little about yourself (skills, interests, time, budget).').max(3000) });
export async function POST(req: Request) {
  return handle('explore', async () => {
    const r = await generateJson<unknown>('explore', explorePrompt(schema.parse(await req.json()).about), EXPLORE_SCHEMA);
    return { directions: normaliseDirections(r.data) };
  });
}
