import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ExternalLink, Microscope, TriangleAlert } from 'lucide-react';
import { db } from '@/lib/db';
import type { AuditReport } from '@/lib/audit';
import { getLockedFacts, getResearch } from '@/lib/audit-meta';
import type { ResearchRecord } from '@/lib/evidence';
import { HttpError, requireObjective } from '@/lib/hippo/context';
import { refreshObjective } from '@/lib/hippo/service';
import type { PathwaysResult, Understanding } from '@/lib/hippo/types';
import { isDemoMode } from '@/lib/payments';
import DecisionMemoView from '@/components/hippo/DecisionMemoView';
import PathwaysPanel from '@/components/hippo/PathwaysPanel';
import ResearchLauncher, { Researching } from '@/components/hippo/ResearchLauncher';
import { AutoRefresh, RetryAristotle } from '@/components/hippo/Status';
import { UnderstandingCard } from '@/components/hippo/UnderstandingCard';
import { Stepper, WorkCard } from '@/components/hippo/Workflow';
import { Badge, Card, Eyebrow, Shell, day } from '@/components/hippo/ui';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Q_TONE: Record<string, ['green' | 'amber' | 'red' | 'grey', string]> = { ANSWERED: ['green', 'Answered'], PARTIAL: ['amber', 'Partly answered'], NOT_FOUND: ['grey', 'No evidence found'], CONTRADICTORY: ['red', 'Contradictory'], SEARCH_FAILED: ['grey', 'Search failed'] };

export default async function ObjectivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let ctx;
  try { ctx = await requireObjective(id); } catch (e) { if (e instanceof HttpError && e.status === 401) redirect('/start'); return notFound(); }
  const objective = await refreshObjective(ctx.objective);
  const u = objective.understanding as Understanding | null;
  const audit = objective.auditId ? await db.audit.findUnique({ where: { id: objective.auditId } }) : null;
  const memo = await db.decisionMemo.findUnique({ where: { objectiveId: objective.id } });

  const header = <div className="mb-8">
    <div className="flex flex-wrap items-center gap-2"><Eyebrow>Objective</Eyebrow>{objective.isDemo && <Badge tone="amber">DEMO DATA</Badge>}<span className="text-xs text-[#6B7389]">Started {day(objective.createdAt)}</span></div>
    <h1 className="mt-2 max-w-4xl text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">{u?.objective || objective.text}</h1>
    <div className="mt-5"><Stepper stage={objective.stage} /></div>
  </div>;

  if (!memo) {
    const paid = audit?.paymentStatus === 'paid';
    const stale = audit?.status === 'generating' && Date.now() - new Date(audit.updatedAt).getTime() > 3 * 60_000;
    let body: React.ReactNode;
    if (!audit) body = <Card><p className="text-sm">This objective has no analysis attached yet.</p></Card>;
    else if (audit.status === 'out_of_scope') body = <Card><p className="text-sm leading-6">This request is outside what Aristotle analyses, so you have not been charged.</p></Card>;
    else if (paid && audit.status === 'generating' && !stale) body = <><AutoRefresh /><Researching /></>;
    else if (paid) body = <Card><div className="flex items-start gap-3"><TriangleAlert className="mt-0.5 shrink-0 text-[#D9670A]"/><div><h2 className="text-lg font-extrabold">Analysis could not be completed.</h2><p className="mt-1 text-sm leading-6 text-[#5B6478]">Your objective is saved and your payment was successful. Any research already completed is kept.</p><div className="mt-4"><RetryAristotle auditId={audit.id} /></div></div></div></Card>;
    else if (audit.paymentRef?.startsWith('order_')) body = <Card><h2 className="text-lg font-extrabold">Waiting for payment confirmation</h2><p className="mt-1 text-sm text-[#5B6478]">If you completed the payment, Hippoturtle can check with Razorpay and continue.</p><div className="mt-4"><RetryAristotle auditId={audit.id} label="CHECK PAYMENT & CONTINUE" /></div></Card>;
    else body = <ResearchLauncher objectiveId={objective.id} auditId={audit.id} demoCheckout={isDemoMode()} />;
    return <Shell>{header}<div className="space-y-5">{u && <UnderstandingCard u={u} />}{body}</div></Shell>;
  }

  const report = memo.content as unknown as AuditReport;
  const research = objective.auditId ? (await getResearch(objective.auditId)) as ResearchRecord | null : null;
  const facts = objective.auditId ? await getLockedFacts(objective.auditId) : [];
  const [questions, findings, work] = await Promise.all([
    db.researchQuestion.findMany({ where: { objectiveId: objective.id }, orderBy: { code: 'asc' } }),
    db.researchFinding.findMany({ where: { objectiveId: objective.id }, orderBy: { createdAt: 'asc' } }),
    db.work.findMany({ where: { objectiveId: objective.id }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const pathways = memo.pathways as unknown as PathwaysResult | null;
  const selected = (Array.isArray(objective.selectedPathways) ? objective.selectedPathways : []) as string[];
  const headline = work.length ? `I've understood the opportunity. There are ${work.length} important pieces of work between here and your first validation milestone. I've converted them into work packages.` : '';

  return <Shell>
    {header}
    <div className="space-y-12">
      {u && <UnderstandingCard u={u} />}

      <section>
        <div className="flex items-center gap-3"><Microscope className="text-[#4F46E5]"/><div><Eyebrow>Aristotle · research</Eyebrow><h2 className="text-2xl font-extrabold tracking-tight">What Aristotle researched</h2></div></div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">{questions.length ? questions.map((q) => { const [tone, label] = Q_TONE[q.status] || Q_TONE.NOT_FOUND; const fs = findings.filter((f) => f.questionCode === q.code); return <div key={q.id} className="ht-card p-5">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-[#C9BFAE]">{q.code} · {q.category.replace('_', ' ').toLowerCase()}</span><Badge tone={tone}>{label}</Badge></div>
          <div className="mt-2 font-bold">{q.question}</div>
          <div className="mt-1 text-xs text-[#6B7389]">Searched: “{q.query}”</div>
          {fs.length ? <ul className="mt-3 space-y-2">{fs.map((f) => <li key={f.id} className="rounded-xl bg-[#F4FAF6] p-3 text-sm"><div className="font-semibold">{f.statement}</div><div className="mt-1 text-xs text-[#5B6478]">“{f.quote}”</div><div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-[#6B7389]"><a href={f.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{f.sourceTitle}<ExternalLink size={11}/></a><span>Retrieved {f.retrievedAt ? day(f.retrievedAt) : '—'}</span><span>{f.geography}</span><span>Confidence {f.confidence.toLowerCase()}</span></div></li>)}</ul>
            : <p className="mt-3 text-sm italic text-[#8A6A3B]">No evidence found — this is an open question, not a fact.</p>}
        </div>; }) : <Card><p className="text-sm italic text-[#8A6A3B]">This analysis has no structured research questions.</p></Card>}</div>
      </section>

      <section>
        <Eyebrow tone="saffron">Executive decision memo</Eyebrow>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">{report.oneLineVerdict || 'Decision memo'}</h2>
        <Card className="mt-5"><DecisionMemoView objectiveText={objective.text} understanding={u} report={report} research={research} findings={findings} facts={facts} pathways={pathways} /></Card>
        {audit && <Link href={`/audit/${audit.id}`} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[#4F46E5] underline">Full Aristotle report & export <ExternalLink size={13}/></Link>}
      </section>

      <section>
        <Eyebrow tone="saffron">Aristotle · pathways</Eyebrow>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">How could we actually achieve {u?.target && u.target !== 'Not stated yet' ? u.target : 'this'}?</h2>
        <div className="mt-5"><PathwaysPanel objectiveId={objective.id} result={pathways} selected={selected} locked={selected.length > 0} hasWork={work.length > 0} /></div>
      </section>

      {work.length > 0 && <section>
        <Eyebrow>Mogli · chief of staff</Eyebrow>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Here’s what needs to happen.</h2>
        <p className="mt-2 max-w-3xl leading-7 text-[#5B6478]">{headline}</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{work.map((w, i) => <WorkCard key={w.id} w={w} n={i + 1} />)}</div>
      </section>}
    </div>
  </Shell>;
}
