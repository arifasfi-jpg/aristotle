import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import { sameOrigin } from '@/lib/rate-limit';

// Owner-requested cancellation. A queued/waiting job stops at once; a running job finishes its current provider call
// and starts no further step. Nothing is refunded, deleted or rolled back (evidence, AiUsage and the audit stay intact).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Request not allowed.' }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const job = await db.job.findFirst({ where: { id, userId: user.id } });
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const now = new Date();
  const idle = await db.job.updateMany({ where: { id, userId: user.id, status: { in: ['QUEUED', 'WAITING'] } }, data: { status: 'CANCELLED', cancelRequestedAt: now, completedAt: now } });
  if (idle.count === 0) await db.job.updateMany({ where: { id, userId: user.id, status: 'RUNNING' }, data: { cancelRequestedAt: now } });
  if (idle.count === 1 && job.subjectType === 'AUDIT' && job.subjectId) await db.audit.updateMany({ where: { id: job.subjectId, userId: user.id, report: '{}' }, data: { status: 'failed' } });
  const fresh = await db.job.findUniqueOrThrow({ where: { id } });
  return NextResponse.json({ id, status: fresh.status, cancelRequested: Boolean(fresh.cancelRequestedAt) });
}
