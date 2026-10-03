import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import { jobView } from '@/lib/jobs';

// "What's happening with my work?" — status, progress, checkpoint, cost (spent / reserved / remaining), waiting
// reason and a safe error summary. Owner only: a job id alone grants nothing (another user's job is "not found").
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const job = await db.job.findFirst({ where: { id, userId: user.id } });
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(await jobView(job));
}
