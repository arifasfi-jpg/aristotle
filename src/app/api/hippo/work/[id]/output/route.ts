import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { HttpError, requireWork } from '@/lib/hippo/context';

/** Download the latest AI deliverable for this work as Markdown. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { work } = await requireWork((await params).id);
    const e = await db.execution.findFirst({ where: { workId: work.id, output: { not: null } }, orderBy: { startedAt: 'desc' } });
    if (!e?.output) return NextResponse.json({ error: 'No output yet' }, { status: 404 });
    const header = `<!-- Hippoturtle · ${work.title} · ${e.mode} · ${e.provider}/${e.model} · ${e.completedAt?.toISOString() ?? ''} -->\n\n`;
    const name = work.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'deliverable';
    return new NextResponse(header + e.output, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.md"` } });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
