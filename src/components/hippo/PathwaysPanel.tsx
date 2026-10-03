'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Loader2, Route } from 'lucide-react';
import type { PathwaysResult } from '@/lib/hippo/types';
import { ActionButton, btn, ErrorNote, post } from './client';

const STRENGTH: Record<string, [string, string]> = { SUPPORTED: ['Evidence: supported', 'bg-[#E3F6EC] text-[#14663D]'], PARTIAL: ['Evidence: partial', 'bg-[#FFF1DF] text-[#9A4B00]'], ANALOGOUS: ['Evidence: analogues only', 'bg-[#F1ECFF] text-[#5B21B6]'], NOT_YET_ESTABLISHED: ['Evidence: not yet established', 'bg-[#EFEBE2] text-[#4A5268]'] };

export default function PathwaysPanel({ objectiveId, result, selected, locked, hasWork = false }: { objectiveId: string; result: PathwaysResult | null; selected: string[]; locked: boolean; hasWork?: boolean }) {
  const router = useRouter();
  const [pick, setPick] = useState<string[]>(selected);
  const [busy, setBusy] = useState<'' | 'select' | 'work'>('');
  const [err, setErr] = useState('');

  if (!result) return <div className="ht-card p-6 sm:p-8">
    <div className="flex items-start gap-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#FFF1DF] text-[#D9670A]"><Route size={20}/></span><div><h3 className="text-xl font-extrabold">How could we actually achieve this?</h3><p className="mt-1 text-sm leading-6 text-[#5B6478]">Aristotle will lay out several real pathways to your <b>full</b> objective — with the evidence, economics and first experiment for each. It challenges assumptions; it does not shrink your ambition.</p></div></div>
    <div className="mt-5"><ActionButton url={`/api/hippo/objectives/${objectiveId}/pathways`} label="Show me the pathways" busyLabel="Aristotle is mapping pathways…" variant="accent" /></div>
  </div>;

  async function plan() {
    setErr('');
    try {
      if (!locked) { setBusy('select'); await post(`/api/hippo/objectives/${objectiveId}/select`, { ids: pick }); }
      setBusy('work'); await post(`/api/hippo/objectives/${objectiveId}/work`);
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); router.refresh(); }
    finally { setBusy(''); }
  }

  return <div>
    <div className="grid gap-4 lg:grid-cols-2">{result.pathways.map((p) => {
      const on = pick.includes(p.id); const [sl, sc] = STRENGTH[p.evidenceStrength] || STRENGTH.NOT_YET_ESTABLISHED;
      return <div key={p.id} className={`ht-card p-5 transition ${on ? 'ring-2 ring-[#4F46E5]' : ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div><div className="text-xs font-bold text-[#C9BFAE]">{p.id}</div><h4 className="text-lg font-extrabold leading-tight">{p.name}</h4></div>
          {!locked ? <button type="button" onClick={() => setPick((x) => (on ? x.filter((i) => i !== p.id) : [...x, p.id]))} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${on ? 'bg-[#4F46E5] text-white' : 'border border-[#D9D0BF] bg-white'}`}>{on ? <><Check size={13}/>Pursuing</> : 'Pursue this'}</button>
            : on ? <span className="rounded-full bg-[#4F46E5] px-3 py-1.5 text-xs font-bold text-white">Founder chose this</span> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5"><span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${sc}`}>{sl}</span>{p.lens && <span className="inline-block rounded-full bg-[#EFEBE2] px-2.5 py-0.5 text-[11px] font-semibold text-[#4A5268]">{p.lens.replace(/_/g, ' ').toLowerCase()}</span>}</div>
        <p className="mt-3 text-sm leading-6">{p.howItWorks}</p>
        {(p.customer || p.valueProposition || p.revenueMechanism) && <div className="mt-2 space-y-1 text-sm leading-6 text-[#5B6478]">{p.customer && <p><span className="font-semibold text-[#0B1533]">Customer: </span>{p.customer}</p>}{p.valueProposition && <p><span className="font-semibold text-[#0B1533]">Value: </span>{p.valueProposition}</p>}{p.revenueMechanism && <p><span className="font-semibold text-[#0B1533]">Revenue: </span>{p.revenueMechanism}</p>}</div>}
        <p className="mt-2 text-sm leading-6 text-[#5B6478]"><span className="font-semibold text-[#0B1533]">Why plausible: </span>{p.whyPlausible}</p>
        {p.evidence.length > 0 && <ul className="mt-3 space-y-1 text-sm">{p.evidence.map((e, i) => <li key={i} className="flex gap-2"><span className={`mt-0.5 shrink-0 rounded px-1.5 text-[10px] font-bold leading-5 ${e.kind === 'ANALOGOUS' ? 'bg-[#F1ECFF] text-[#5B21B6]' : 'bg-[#E3F6EC] text-[#14663D]'}`}>{e.kind === 'ANALOGOUS' ? 'Analogue ' : ''}{e.refs.join(' ')}</span>{e.statement}</li>)}</ul>}
        <div className="mt-3 grid gap-2 text-sm">
          <div className="rounded-xl bg-[#FBF7EF] p-3"><div className="text-[10px] font-bold uppercase tracking-wider text-[#6B7389]">Economics</div><div className={`mt-1 ${p.economics.startsWith('Not yet') ? 'italic text-[#8A6A3B]' : ''}`}>{p.economics}</div></div>
          <div className="rounded-xl bg-[#FBF7EF] p-3"><div className="text-[10px] font-bold uppercase tracking-wider text-[#6B7389]">To contribute to the target · requirement, not a forecast</div><div className="mt-1">{p.contributionToTarget}</div></div>
          <div className="rounded-xl bg-[#EEF0FF] p-3"><div className="text-[10px] font-bold uppercase tracking-wider text-[#3730A3]">First experiment</div><div className="mt-1">{p.firstExperiment}</div></div>
        </div>
        {(p.assumptions || []).length > 0 && <div className="mt-3 text-xs text-[#5B6478]"><div className="font-bold text-[#0B1533]">Must be true</div>{(p.assumptions || []).map((c, i) => <div key={i}>• {c}</div>)}</div>}
        {(p.constraints.length > 0 || p.risks.length > 0) && <div className="mt-3 grid gap-3 text-xs text-[#5B6478] sm:grid-cols-2"><div><div className="font-bold text-[#0B1533]">Constraints</div>{p.constraints.map((c, i) => <div key={i}>• {c}</div>)}</div><div><div className="font-bold text-[#0B1533]">Risks</div>{p.risks.map((c, i) => <div key={i}>• {c}</div>)}</div></div>}
      </div>;
    })}</div>
    {!hasWork && <div className="mt-5 flex flex-col gap-3 rounded-2xl bg-[#0B1533] p-5 text-white sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm"><div className="font-bold">{locked ? 'You chose your pathways.' : `${pick.length} pathway${pick.length === 1 ? '' : 's'} selected`}</div><div className="text-white/65">{locked ? 'Hippoturtle turns them into work packages.' : 'You decide which pathways to pursue. Hippoturtle turns them into work.'}</div></div>
      <button type="button" onClick={plan} disabled={!!busy || (!locked && pick.length === 0)} className={btn.accent}>{busy ? <><Loader2 size={16} className="animate-spin"/>{busy === 'select' ? 'Recording your decision…' : 'Mogli is planning the work…'}</> : <>{locked ? 'Plan the work' : 'Pursue & plan the work'} <ArrowRight size={16}/></>}</button>
    </div>}
    <ErrorNote msg={err} onRetry={plan} />
  </div>;
}
