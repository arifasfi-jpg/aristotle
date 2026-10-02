'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Clock, Loader2, Plus, Sparkles, UserRound, Users } from 'lucide-react';
import { btn, ErrorNote, post } from './client';

export function AutoBrief({ workId }: { workId: string }) {
  const router = useRouter();
  const [err, setErr] = useState('');
  const started = useRef(false);
  async function run() {
    setErr('');
    try { await post(`/api/hippo/work/${workId}/brief`); router.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not write the brief.'); }
  }
  useEffect(() => { if (!started.current) { started.current = true; void run(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="ht-card p-6">{err ? <><div className="font-bold">The work brief could not be written.</div><ErrorNote msg={err} onRetry={run} /></> : <div className="flex items-center gap-3"><Loader2 className="animate-spin text-[#4F46E5]"/><div><div className="font-bold">Mogli is writing the work brief and estimating the cost…</div><div className="text-sm text-[#5B6478]">A precise brief is what stops vague requirements turning into inflated quotes.</div></div></div>}</div>;
}

export type Option = { mode: 'AI' | 'HUMAN' | 'HYBRID'; title: string; range: string; label: string; note: string; available: boolean; reason?: string };
const ICON = { AI: Bot, HUMAN: UserRound, HYBRID: Users };
const CTA = { AI: 'USE HIPPOTURTLE', HUMAN: 'USE EXTERNAL PROVIDER', HYBRID: 'HYBRID' };

export function ChooseMode({ workId, options, current, locked }: { workId: string; options: Option[]; current: string | null; locked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  async function choose(mode: string) {
    setBusy(mode); setErr('');
    try { await post(`/api/hippo/work/${workId}/choose`, { mode }); router.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save your choice.'); }
    finally { setBusy(''); }
  }
  return <div>
    <div className="grid gap-3">{options.map((o, i) => { const I = ICON[o.mode]; const on = current === o.mode; return <div key={o.mode} className={`flex flex-col rounded-2xl border p-5 ${on ? 'border-[#4F46E5] bg-[#F5F6FF] ring-2 ring-[#4F46E5]' : 'border-[#E9E2D4] bg-white'} ${!o.available ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between"><span className="text-[11px] font-bold uppercase tracking-[.16em] text-[#6B7389]">Option {i + 1}</span><I size={18} className="text-[#4F46E5]"/></div>
      <div className="mt-2 font-extrabold">{o.title}</div>
      <div className="mt-2 text-2xl font-extrabold tracking-tight">{o.range}</div>
      <div className="mt-1 text-[11px] font-semibold text-[#9A4B00]">{o.label}</div>
      <p className="mt-2 text-xs leading-5 text-[#5B6478]">{o.available ? o.note : o.reason}</p>
      <div className="mt-auto pt-4">{o.available && !locked && <button type="button" onClick={() => choose(o.mode)} disabled={!!busy} className={on ? btn.primary + ' w-full' : (o.mode === 'AI' ? btn.accent : btn.ghost) + ' w-full'}>{busy === o.mode ? <Loader2 size={15} className="animate-spin"/> : on ? 'Chosen' : CTA[o.mode]}</button>}{on && locked && <div className="text-center text-sm font-bold text-[#4F46E5]">Chosen</div>}</div>
    </div>; })}</div>
    {!locked && <div className="mt-3"><button type="button" onClick={() => choose('LATER')} disabled={!!busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#5B6478] underline"><Clock size={14}/>DECIDE LATER</button></div>}
    <ErrorNote msg={err} />
  </div>;
}

const RUN_STEPS = ['Reading the work brief', 'Loading business memory and research', 'Producing the deliverable', 'Checking it against the success criteria'];
export function ExecuteButton({ workId, label }: { workId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [err, setErr] = useState('');
  useEffect(() => { if (!busy) return; setStep(0); const t = setInterval(() => setStep((s) => Math.min(RUN_STEPS.length - 1, s + 1)), 7000); return () => clearInterval(t); }, [busy]);
  async function run() {
    setBusy(true); setErr('');
    try { await post(`/api/hippo/work/${workId}/execute`); router.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Execution failed.'); router.refresh(); }
    finally { setBusy(false); }
  }
  if (busy) return <div className="rounded-2xl bg-[#0B1533] p-6 text-white"><div className="flex items-center gap-3"><Loader2 className="animate-spin text-[#FFB067]"/><div className="text-lg font-extrabold tracking-wide">WORK IN PROGRESS</div></div><ol className="mt-4 space-y-2 text-sm">{RUN_STEPS.map((s, i) => <li key={s} className={i <= step ? 'text-white' : 'text-white/40'}>{i < step ? '✓' : i === step ? '•' : '○'} {s}</li>)}</ol></div>;
  return <div><button type="button" onClick={run} className={btn.accent}><Sparkles size={16}/>{label}</button><ErrorNote msg={err ? `${err} Nothing was charged.` : ''} onRetry={run} /></div>;
}

export function QuoteForm({ workId, example }: { workId: string; example?: { providerName: string; amount: number; includes: string; excludes: string; turnaroundDays: number; revisions: number } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isExample, setIsExample] = useState(false);
  const [f, setF] = useState({ providerName: '', amount: '', includes: '', excludes: '', turnaroundDays: '', revisions: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const lines = (v: string) => v.split(/\n|;/).map((x) => x.trim()).filter(Boolean);
  async function submit() {
    setBusy(true); setErr('');
    try {
      await post(`/api/hippo/work/${workId}/quotes`, { providerName: f.providerName, amount: Number(f.amount), includes: lines(f.includes), excludes: lines(f.excludes), turnaroundDays: f.turnaroundDays ? Number(f.turnaroundDays) : null, revisions: f.revisions ? Number(f.revisions) : null, example: isExample });
      setOpen(false); setF({ providerName: '', amount: '', includes: '', excludes: '', turnaroundDays: '', revisions: '' }); setIsExample(false); router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not record the quote.'); }
    finally { setBusy(false); }
  }
  const input = 'w-full rounded-xl border border-[#E1D8C6] bg-white px-3 py-2 text-sm outline-none focus:border-[#4F46E5]';
  if (!open) return <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setOpen(true)} className={btn.ghost}><Plus size={15}/>Add a quote you received</button>{example && <button type="button" onClick={() => { setOpen(true); setIsExample(true); setF({ providerName: example.providerName, amount: String(example.amount), includes: example.includes, excludes: example.excludes, turnaroundDays: String(example.turnaroundDays), revisions: String(example.revisions) }); }} className={btn.ghost}>Load an example quote (demo)</button>}</div>;
  return <div className="rounded-2xl border border-[#E9E2D4] bg-[#FBF7EF] p-4">
    {isExample && <div className="mb-3 rounded-lg bg-[#FFF1DF] px-3 py-2 text-xs font-bold text-[#9A4B00]">EXAMPLE EXTERNAL QUOTE — illustrative, not a real provider or a real price.</div>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold">Provider name<input className={input} value={f.providerName} onChange={set('providerName')} /></label>
      <label className="text-xs font-semibold">Quoted amount (₹)<input className={input} inputMode="numeric" value={f.amount} onChange={set('amount')} /></label>
      <label className="text-xs font-semibold">What’s included (one per line)<textarea rows={3} className={input} value={f.includes} onChange={set('includes')} /></label>
      <label className="text-xs font-semibold">What’s excluded (one per line)<textarea rows={3} className={input} value={f.excludes} onChange={set('excludes')} /></label>
      <label className="text-xs font-semibold">Turnaround (days)<input className={input} inputMode="numeric" value={f.turnaroundDays} onChange={set('turnaroundDays')} /></label>
      <label className="text-xs font-semibold">Revision rounds<input className={input} inputMode="numeric" value={f.revisions} onChange={set('revisions')} /></label>
    </div>
    <div className="mt-3 flex gap-2"><button type="button" onClick={submit} disabled={busy || f.providerName.trim().length < 2 || !(Number(f.amount) > 0)} className={btn.primary}>{busy ? <><Loader2 size={15} className="animate-spin"/>Comparing…</> : 'Compare with Hippoturtle’s estimate'}</button><button type="button" onClick={() => setOpen(false)} className={btn.ghost}>Cancel</button></div>
    <ErrorNote msg={err} />
  </div>;
}

export function OutcomeForm({ url, prompt = 'What happened?' }: { url: string; prompt?: string }) {
  const router = useRouter();
  const [summary, setSummary] = useState('');
  const [metrics, setMetrics] = useState([{ label: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    setBusy(true); setErr('');
    try { await post(url, { summary, metrics: metrics.filter((m) => m.label.trim() && m.value.trim()) }); setSummary(''); setMetrics([{ label: '', value: '' }]); router.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not record the outcome.'); }
    finally { setBusy(false); }
  }
  const input = 'rounded-xl border border-[#E1D8C6] bg-white px-3 py-2 text-sm outline-none focus:border-[#4F46E5]';
  return <div>
    <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={prompt} className={`${input} w-full`} />
    <div className="mt-2 space-y-2">{metrics.map((m, i) => <div key={i} className="flex gap-2"><input className={`${input} flex-1`} placeholder="e.g. Pharmacies contacted" value={m.label} onChange={(e) => setMetrics(metrics.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /><input className={`${input} w-32`} placeholder="e.g. 50" value={m.value} onChange={(e) => setMetrics(metrics.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /></div>)}</div>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => setMetrics([...metrics, { label: '', value: '' }])} className="text-sm font-semibold text-[#4F46E5] underline">+ add a number</button></div>
    <button type="button" onClick={submit} disabled={busy || summary.trim().length < 3} className={`${btn.primary} mt-3`}>{busy ? <Loader2 size={15} className="animate-spin"/> : 'Record outcome'}</button>
    <ErrorNote msg={err} />
  </div>;
}

/** Founder explicitly approves an AI-proposed input (e.g. a validation price). Until then it stays "not founder-approved". */
export function ApproveInput({ workId, item, value }: { workId: string; item: string; value: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function approve() {
    setBusy(true); setErr('');
    try { await post(`/api/hippo/work/${workId}/approve-input`, { item, value }); router.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not record approval.'); }
    finally { setBusy(false); }
  }
  return <span className="inline-flex items-center gap-2"><button type="button" onClick={approve} disabled={busy} className="rounded-full border border-[#D9D0BF] bg-white px-2.5 py-0.5 text-[11px] font-bold text-[#0B1533] hover:border-[#0B1533] disabled:opacity-50">{busy ? 'Saving…' : 'I approve this value'}</button>{err && <span className="text-[11px] text-[#A3271B]">{err}</span>}</span>;
}
