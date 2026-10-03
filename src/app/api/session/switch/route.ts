import { NextResponse } from 'next/server';
import { freshStartAllowed, switchToPreviousSession } from '@/lib/session';

// Switch this browser back to a business it started earlier (Preview / local only). Form field: index.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!freshStartAllowed()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const form = await req.formData().catch(() => null);
  const index = Number(form?.get('index'));
  if (!Number.isInteger(index) || index < 0) return NextResponse.json({ error: 'Choose a business.' }, { status: 400 });
  await switchToPreviousSession(index);
  return NextResponse.redirect(new URL('/start', req.url), 303);
}
