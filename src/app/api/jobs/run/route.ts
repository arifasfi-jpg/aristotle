import { NextResponse } from 'next/server';
import { runWorker } from '@/lib/jobs';
import { workerAuthorized } from '@/lib/jobs/auth';

// Internal worker trigger (Vercel Cron or another scheduler holding CRON_SECRET). One bounded pass per invocation:
// claims runnable jobs (queued, or abandoned by a dead worker) and runs them until the time budget is used.
// Not callable by the public: without the secret nothing runs, so it cannot be used to cause free AI spend.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function run(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'Not allowed.' }, { status: 401 });
  const results = await runWorker();
  return NextResponse.json({ ok: true, ran: results.map((r) => ({ jobId: r.jobId, status: r.status, steps: r.steps })) });
}
export const GET = run;  // Vercel Cron issues GET
export const POST = run;
