import { NextResponse } from 'next/server';
import { logActivity } from '@/lib/hippo/context';
import { findPreviewDemoObjective, previewDemoAccessEnabled } from '@/lib/hippo/preview';
import { createSession } from '@/lib/session';

/**
 * POST /api/hippo/preview/demo-objective  (Preview / development only)
 * Signs this browser into the owner of the existing paid demo objective and redirects to it.
 * Production: always 404. No objective, audit, order or payment is created.
 */
export async function POST(req: Request) {
  if (!previewDemoAccessEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const found = await findPreviewDemoObjective();
  if (!found) return NextResponse.json({ error: 'No paid demo objective exists on this Preview database yet.' }, { status: 404 });
  await createSession(found.ownerUserId);
  await logActivity({ organizationId: found.objective.organizationId, objectiveId: found.objective.id, type: 'PREVIEW_DEMO_ACCESS', actor: 'Preview', message: 'Opened via the Preview-only demo objective access.' });
  return NextResponse.redirect(new URL(`/objectives/${found.objective.id}`, req.url), 303);
}
