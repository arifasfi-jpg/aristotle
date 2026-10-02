import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { db } from '@/lib/db';
import { getFounderContext } from '@/lib/hippo/context';
import { businessName, TRUTH_LABEL, type TruthStatus } from '@/lib/hippo/types';
import { Badge, Card, Eyebrow, Shell, TruthBadge, day, when } from '@/components/hippo/ui';

export const dynamic = 'force-dynamic';

const TRUTH_ORDER: TruthStatus[] = ['VERIFIED_FACT', 'FOUNDER_STATED', 'ASSUMPTION', 'HYPOTHESIS', 'INFERENCE', 'UNKNOWN'];

export default async function Memory() {
  const ctx = await getFounderContext();
  if (!ctx?.org) return <Shell active="memory"><Card><p>No business memory yet. <Link href="/start" className="font-bold text-[#4F46E5] underline">Start with an idea</Link>.</p></Card></Shell>;
  const [rows, activity] = await Promise.all([
    db.businessMemory.findMany({ where: { organizationId: ctx.org.id }, orderBy: { occurredAt: 'desc' }, take: 400 }),
    db.activityLog.findMany({ where: { organizationId: ctx.org.id }, orderBy: { createdAt: 'desc' }, take: 60 }),
  ]);
  const history = rows.filter((r) => ['DECISION', 'WORK', 'OUTCOME', 'QUOTE', 'COST', 'OBJECTIVE'].includes(r.kind));
  const truths = rows.filter((r) => ['FACT', 'ASSUMPTION', 'IDEA'].includes(r.kind));
  const experiments = rows.filter((r) => r.kind === 'EXPERIMENT');
  const byMonth = new Map<string, typeof history>();
  for (const h of history) { const k = new Date(h.occurredAt).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); byMonth.set(k, [...(byMonth.get(k) || []), h]); }

  return <Shell active="memory">
    <Eyebrow>Business memory · {businessName(ctx.org.name) || 'your business'}</Eyebrow>
    <h1 className="mt-1 text-3xl font-extrabold tracking-tight">What happened — and what we know.</h1>
    <p className="mt-2 max-w-3xl leading-7 text-[#5B6478]">Not chat history: a structured record of your objectives, facts, decisions, work, costs, quotes and outcomes. Every entry says how true it is. AI guesses never become facts silently.</p>

    <div className="mt-6 flex flex-wrap gap-2">{TRUTH_ORDER.map((s) => <span key={s} className="inline-flex items-center gap-1.5 text-xs"><TruthBadge status={s}/><b>{rows.filter((r) => r.status === s).length}</b></span>)}</div>

    <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      <Card>
        <h2 className="text-xl font-extrabold">Decision history</h2>
        {byMonth.size ? [...byMonth.entries()].map(([m, items]) => <div key={m} className="mt-5"><div className="text-xs font-bold uppercase tracking-[.16em] text-[#D9670A]">{m}</div><ol className="mt-2 space-y-3 border-l-2 border-[#E9E2D4] pl-4">{items.map((h) => <li key={h.id} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-[#4F46E5]"/><div className="flex flex-wrap items-center gap-2"><Badge tone={h.kind === 'DECISION' ? 'navy' : h.kind === 'OUTCOME' ? 'green' : 'grey'}>{h.kind.toLowerCase()}</Badge><span className="font-semibold">{h.title}</span></div>{h.value && <div className="text-xs font-bold">{h.value}</div>}{h.detail && <p className="mt-0.5 whitespace-pre-line text-xs leading-5 text-[#5B6478]">{h.detail}</p>}<div className="text-[11px] text-[#8A8F9E]">{day(h.occurredAt)} · {h.owner}</div></li>)}</ol></div>) : <p className="mt-2 text-sm text-[#6B7389]">No decisions yet.</p>}
      </Card>
      <div className="space-y-6">
        <Card>
          <h2 className="text-xl font-extrabold">Business truth layer</h2>
          <p className="mt-1 text-xs text-[#6B7389]">Value · source · date · owner · confidence · status.</p>
          <div className="mt-4 space-y-2">{truths.length ? truths.slice(0, 60).map((t) => <div key={t.id} className="rounded-xl border border-[#E9E2D4] p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><TruthBadge status={t.status}/><span className="font-semibold">{t.title}</span>{t.value && <span className="font-bold text-[#4F46E5]">{t.value}</span>}</div><div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-[#6B7389]">{t.sourceUrl ? <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{t.source || 'Source'}<ExternalLink size={10}/></a> : <span>{t.source || 'No source'}</span>}<span>{day(t.occurredAt)}</span><span>Owner: {t.owner}</span>{t.confidence && <span>Confidence: {t.confidence.toLowerCase()}</span>}</div></div>) : <p className="text-sm text-[#6B7389]">Facts appear after Aristotle’s analysis.</p>}</div>
        </Card>
        <Card><h2 className="text-xl font-extrabold">Experiments</h2><div className="mt-3 space-y-2">{experiments.length ? experiments.map((e) => <div key={e.id} className="text-sm"><div className="flex items-center gap-2"><TruthBadge status={e.status}/><span className="font-semibold">{e.title}</span></div><p className="text-xs text-[#5B6478]">{e.detail}</p></div>) : <p className="text-sm text-[#6B7389]">None yet.</p>}</div></Card>
        <Card><h2 className="text-xl font-extrabold">Activity log</h2><ul className="mt-3 space-y-2">{activity.map((a) => <li key={a.id} className="text-xs"><span className="font-mono text-[10px] text-[#8A8F9E]">{a.type}</span> · <b>{a.actor}</b> · {a.message} <span className="text-[#8A8F9E]">({when(a.createdAt)})</span></li>)}</ul></Card>
      </div>
    </div>
    <p className="mt-6 text-xs text-[#6B7389]">Statuses: {TRUTH_ORDER.map((s) => TRUTH_LABEL[s]).join(' · ')}.</p>
  </Shell>;
}
