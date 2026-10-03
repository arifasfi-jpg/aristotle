import { NextResponse } from 'next/server';
import { freshStartAllowed, startFreshSession } from '@/lib/session';

// "Start a New Business" (Preview / local only): a new anonymous founder session and an empty conversation. The
// existing business is not touched — its session stays valid and this browser keeps it in its previous list.
// GET is the target of /start?fresh=1; POST is the button. Both redirect to a clean /start, so a refresh there never
// starts yet another business. In Production this route does not exist (404) and nothing changes.
export const dynamic = 'force-dynamic';

async function fresh(req: Request) {
  if (!freshStartAllowed()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await startFreshSession();
  return NextResponse.redirect(new URL('/start', req.url), 303);
}
export const GET = fresh;
export const POST = fresh;
