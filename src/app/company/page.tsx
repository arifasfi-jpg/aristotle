import Link from 'next/link';
import { ArrowRight, Brain, CheckCircle2, CircleDollarSign, FlaskConical, Gavel, Layers } from 'lucide-react';
import { db } from '@/lib/db';
import { getFounderContext } from '@/lib/hippo/context';
import { stageIndex, STAGES, type Understanding } from '@/lib/hippo/types';
import { Stepper, WorkCard } from '@/components/hippo/Workflow';
import { Badge, Card, Eyebrow, inr, Shell, TruthBadge, when } from '@/components/hippo/ui';

export const dynamic = 'force-dynamic';

export default async function Company() {
  const ctx = await getFounderContext();
  if (!ctx?.org) return <Shell active="company"><Card className="mx-auto max-w-xl text-center"><h1 className="text-2xl font-extrabold">Your company starts with an objective.</h1><p className="mt-2 text-[#5B6478]">Tell Hippoturtle what you want to build or achieve.</p><Link href="/start" className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-[#FF8A1F] px-5 py-3 font-bold text-[#0B1533]">START WITH AN IDEA <ArrowRight size={16}/></Link></Card></Shell>;
  const orgId = ctx.org.id;
  const [objectives, work, decisions, experiments, activity, executions, audits, outcomes] = await Promise.all([
    db.objective.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } }),
    db.work.findMany({ where: { organizationId: orgId }, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }] }),
    db.businessMemory.findMany({ where: { organizationId: orgId, kind: 'DECISION' }, orderBy: { occurredAt: 'desc' }, take: 8 }),
    db.businessMemory.findMany({ where: { organizationId: orgId, kind: 'EXPERIMENT' }, orderBy: { occurredAt: 'desc' }, take: 6 }),
    db.activityLog.findMany({ where: { organizationId: orgId, type: { not: 'AI_CALL' } }, orderBy: { createdAt: 'desc' }, take: 8 }),
    db.execution.findMany({ where: { work: { organizationId: orgId }, status: { in: ['COMPLETED', 'WAITING_FOR_REVIEW'] } }, select: { costInr: true } }),
    db.audit.findMany({ where: { userId: ctx.user.id, paymentStatus: 'paid', id: { in: (await db.objective.findMany({ where: { organizationId: orgId }, select: { auditId: true } })).map((o) => o.auditId).filter((x): x is string => !!x) } }, select: { pricePaise: true, paymentRef: true } }),
    db.outcome.count({ where: { objective: { organizationId: orgId } } }),
  ]);
  const current = objectives[0];
  const u = current?.understanding as Understanding | null;
  const active = work.filter((w) => !['COMPLETED', 'CANCELLED'].includes(w.status));
  const done = work.filter((w) => w.status === 'COMPLETED');
  // Only verified Razorpay payments count (Demo Mode never stores a Razorpay payment id).
  const paidAudits = audits.filter((a) => a.paymentRef?.startsWith('pay_'));
  const spentAnalysis = paidAudits.reduce((s, a) => s + a.pricePaise / 100, 0);
  const aiCost = executions.reduce((s, e) => s + e.costInr, 0);
  const progress = current ? Math.round((stageIndex(current.stage) / (STAGES.length - 1)) * 100) : 0;

  return <Shell active="company">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><Eyebrow>My company</Eyebrow><h1 className="mt-1 text-3xl font-extrabold tracking-tight">{ctx.org.name}{ctx.org.isDemo && <span className="ml-2 align-middle"><Badge tone="amber">DEMO DATA</Badge></span>}</h1><p className="mt-1 text-[#5B6478]">Your company’s operating system — objectives, work, decisions and what actually happened.</p></div><Link href="/start" className="inline-flex items-center gap-2 rounded-2xl bg-[#0B1533] px-5 py-3 text-sm font-bold text-white">New objective <ArrowRight size={15}/></Link></div>

    {current ? <Link href={`/objectives/${current.id}`} className="mt-6 block overflow-hidden rounded-[24px] ht-hero p-6 text-white sm:p-8">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-[#FFB067]">Current objective{current.isDemo && <span className="rounded-full bg-white/15 px-2 py-0.5 text-white">Demo data</span>}</div>
      <div className="mt-2 max-w-4xl text-xl font-extrabold leading-snug sm:text-2xl">{u?.objective || current.text}</div>
      {u && <div className="mt-3 flex flex-wrap gap-2 text-sm"><span className="rounded-full bg-white/10 px-3 py-1">Target: {u.target}</span><span className="rounded-full bg-white/10 px-3 py-1">Today: {u.currentState}</span></div>}
      <div className="mt-6 rounded-2xl bg-white p-4 text-[#0B1533]"><div className="mb-2 flex justify-between text-xs font-bold"><span>Journey stage</span><span>{progress}%</span></div><Stepper stage={current.stage} /></div>
    </Link> : <Card className="mt-6"><p>No objective yet. <Link href="/start" className="font-bold text-[#4F46E5] underline">Start with an idea</Link>.</p></Card>}

    <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
      {[[Layers, 'Active work', String(active.length)], [CheckCircle2, 'Completed work', String(done.length)], [Gavel, 'Decisions', String(decisions.length)], [FlaskConical, 'Outcomes recorded', String(outcomes)], [CircleDollarSign, 'Money spent', inr(spentAnalysis + aiCost, aiCost < 1 && spentAnalysis === 0 ? 2 : 0)]].map(([I, k, v]) => { const Icon = I as typeof Layers; return <div key={k as string} className="ht-card p-4"><Icon size={17} className="text-[#4F46E5]"/><div className="mt-3 text-2xl font-extrabold">{v as string}</div><div className="text-xs font-semibold text-[#6B7389]">{k as string}</div></div>; })}
    </div>
    <p className="mt-2 text-xs text-[#6B7389]">Money spent = paid analyses {inr(spentAnalysis)} + actual AI execution cost {inr(aiCost, 2)} (AI execution is not charged during early access). Demo-mode analyses are not counted.</p>

    <section className="mt-10"><div className="flex items-center justify-between"><h2 className="text-xl font-extrabold">Active work</h2></div>
      {active.length ? <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{active.map((w, i) => <WorkCard key={w.id} w={w} n={i + 1} />)}</div> : <p className="mt-3 text-sm text-[#6B7389]">No active work. {current ? 'Open your objective to plan the work.' : ''}</p>}
    </section>
    {done.length > 0 && <section className="mt-10"><h2 className="text-xl font-extrabold">Completed work</h2><div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{done.map((w, i) => <WorkCard key={w.id} w={w} n={i + 1} />)}</div></section>}

    <div className="mt-10 grid items-start gap-6 lg:grid-cols-3">
      <Card><h2 className="font-extrabold">Decisions</h2>{decisions.length ? <ul className="mt-3 space-y-3">{decisions.map((d) => <li key={d.id} className="text-sm"><div className="font-semibold">{d.title}</div><div className="text-xs text-[#6B7389]">{when(d.occurredAt)}</div></li>)}</ul> : <p className="mt-2 text-sm text-[#6B7389]">No decisions yet.</p>}</Card>
      <Card><h2 className="font-extrabold">Experiments</h2>{experiments.length ? <ul className="mt-3 space-y-3">{experiments.map((d) => <li key={d.id} className="text-sm"><div className="flex items-start gap-2"><TruthBadge status={d.status}/><span className="font-semibold">{d.title}</span></div></li>)}</ul> : <p className="mt-2 text-sm text-[#6B7389]">Experiments appear after Aristotle’s analysis.</p>}</Card>
      <Card><div className="flex items-center justify-between"><h2 className="font-extrabold">Recent activity</h2><Link href="/memory" className="inline-flex items-center gap-1 text-xs font-bold text-[#4F46E5]"><Brain size={13}/>Memory</Link></div>{activity.length ? <ul className="mt-3 space-y-3">{activity.map((a) => <li key={a.id} className="text-sm"><div><span className="font-bold">{a.actor}</span> · <span className="text-[#2A3248]">{a.message}</span></div><div className="text-xs text-[#6B7389]">{when(a.createdAt)}</div></li>)}</ul> : <p className="mt-2 text-sm text-[#6B7389]">Nothing yet.</p>}</Card>
    </div>

    {objectives.length > 1 && <section className="mt-10"><h2 className="text-xl font-extrabold">All objectives</h2><div className="mt-3 space-y-2">{objectives.map((o) => <Link key={o.id} href={`/objectives/${o.id}`} className="ht-card flex items-center justify-between gap-3 p-4 text-sm hover:border-[#4F46E5]"><span className="line-clamp-1 font-semibold">{(o.understanding as Understanding | null)?.objective || o.text}</span><Badge tone="grey">{o.stage.replace('_', ' ').toLowerCase()}</Badge></Link>)}</div></section>}
  </Shell>;
}
