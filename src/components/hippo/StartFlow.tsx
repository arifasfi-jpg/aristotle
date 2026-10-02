'use client';
import { useState } from 'react';
import { ArrowRight, Compass, Loader2, Sparkles } from 'lucide-react';
import { TIME_COMMITMENTS, type Understanding } from '@/lib/hippo/types';
import { btn, ErrorNote, post } from './client';
import ResearchLauncher from './ResearchLauncher';
import { UnderstandingCard } from './UnderstandingCard';

export const DEMO_OBJECTIVE = 'We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month. We need to determine the pathways, economics, channels, CAC, pricing, working capital and execution required.';

type Direction = { title: string; whoItServes: string; whyYou: string; firstTest: string; objective: string };

export default function StartFlow({ demoCheckout }: { demoCheckout: boolean }) {
  const [text, setText] = useState('');
  const [time, setTime] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [explore, setExplore] = useState(false);
  const [about, setAbout] = useState('');
  const [dirs, setDirs] = useState<Direction[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ objectiveId: string; auditId: string; understanding: Understanding } | null>(null);

  async function submit() {
    setBusy(true); setErr('');
    try { setResult(await post('/api/hippo/objectives', { text, mode: dirs.length ? 'EXPLORE' : 'IDEA', timeCommitment: time, demo })); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }
  async function findDirections() {
    setBusy(true); setErr('');
    try { setDirs((await post<{ directions: Direction[] }>('/api/hippo/explore', { about })).directions); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  if (result) return <div className="space-y-5">
    <div className="text-sm font-semibold text-[#4F46E5]">Got it. Here is what I understand.</div>
    <UnderstandingCard u={result.understanding} />
    <ResearchLauncher objectiveId={result.objectiveId} auditId={result.auditId} demoCheckout={demoCheckout} />
  </div>;

  if (busy && !explore) return <div className="ht-card flex flex-col items-center gap-4 px-6 py-16 text-center"><Loader2 className="animate-spin text-[#4F46E5]" size={28}/><div className="text-xl font-extrabold">Got it. Let me understand what you’re trying to achieve.</div><p className="max-w-md text-sm text-[#5B6478]">Reading your objective, your numbers and what you’re really asking.</p></div>;

  return <div className="space-y-5">
    <div className="ht-card p-5 sm:p-7">
      <label htmlFor="objective" className="text-lg font-extrabold">What are you trying to build or achieve?</label>
      <textarea id="objective" value={text} onChange={(e) => { setText(e.target.value); setDemo(false); }} rows={6} maxLength={5000}
        placeholder="I want to build a business selling glucometers in India and scale from 1,400 units a month to 10,000 units."
        className="mt-3 w-full resize-y rounded-2xl border border-[#E1D8C6] bg-[#FBF7EF] p-4 text-[15px] leading-7 outline-none focus:border-[#4F46E5] focus:bg-white" />
      {demo && <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-[#FFF1DF] px-3 py-1 text-xs font-bold text-[#9A4B00]">DEMO DATA — sample founder objective, not a real company</div>}
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button type="button" onClick={() => { setText(DEMO_OBJECTIVE); setDemo(true); setExplore(false); }} className="inline-flex items-center gap-1.5 rounded-full border border-[#D9D0BF] bg-white px-3.5 py-1.5 font-semibold hover:border-[#0B1533]"><Sparkles size={14} className="text-[#D9670A]"/>Use the demo example</button>
        <button type="button" onClick={() => setExplore((x) => !x)} className="inline-flex items-center gap-1.5 rounded-full border border-[#D9D0BF] bg-white px-3.5 py-1.5 font-semibold hover:border-[#0B1533]"><Compass size={14} className="text-[#4F46E5]"/>I don’t have a business idea yet</button>
      </div>

      {explore && <div className="mt-5 rounded-2xl border border-[#E9E2D4] bg-[#FBF7EF] p-4">
        <div className="text-sm font-bold">Tell Hippoturtle about you</div>
        <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={3} maxLength={3000} placeholder="I'm a pharmacist in Pune, good with people, can invest ₹2 lakh and 10 hours a week…" className="mt-2 w-full rounded-xl border border-[#E1D8C6] bg-white p-3 text-sm outline-none focus:border-[#4F46E5]" />
        <button type="button" onClick={findDirections} disabled={busy || about.trim().length < 20} className={`${btn.ghost} mt-2`}>{busy ? <><Loader2 size={15} className="animate-spin"/>Thinking…</> : 'Suggest directions to test'}</button>
        {dirs.length > 0 && <div className="mt-4 grid gap-3 md:grid-cols-3">{dirs.map((d) => <button type="button" key={d.title} onClick={() => { setText(d.objective); setDemo(false); }} className="rounded-xl border border-[#E9E2D4] bg-white p-4 text-left text-sm hover:border-[#4F46E5]"><div className="text-[10px] font-bold uppercase tracking-wider text-[#D9670A]">Hypothesis to test</div><div className="mt-1 font-bold">{d.title}</div><p className="mt-1 text-[#5B6478]">{d.whoItServes}</p><p className="mt-2 text-xs text-[#6B7389]">First test: {d.firstTest}</p><div className="mt-2 text-xs font-bold text-[#4F46E5]">Use this →</div></button>)}</div>}
      </div>}

      <div className="mt-6">
        <div className="text-sm font-bold">How much time can you spend?</div>
        <div className="mt-2 flex flex-wrap gap-2">{TIME_COMMITMENTS.map((t) => <button type="button" key={t} onClick={() => setTime(time === t ? null : t)} className={`rounded-full border px-3.5 py-1.5 text-sm ${time === t ? 'border-[#0B1533] bg-[#0B1533] text-white' : 'border-[#D9D0BF] bg-white'}`}>{t}</button>)}</div>
      </div>
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-[#E9E2D4] pt-5">
        <p className="text-xs text-[#6B7389]">Understanding your objective is free. You decide before anything is charged.</p>
        <button type="button" onClick={submit} disabled={busy || text.trim().length < 20} className={btn.primary}>Continue <ArrowRight size={16}/></button>
      </div>
      <ErrorNote msg={err} onRetry={text.trim().length >= 20 ? submit : undefined} />
    </div>
  </div>;
}
