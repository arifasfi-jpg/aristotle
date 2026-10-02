'use client';
// Confirms the founder's numbers and scope, then starts Aristotle through the EXISTING audit scope,
// Razorpay order and verify routes (no new payment system). Demo Mode skips payment only.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Loader2, Microscope, X } from 'lucide-react';
import { describeFact, type FounderFact } from '@/lib/founder-facts';
import { btn, ErrorNote, post } from './client';

type Scope = 'NEW_IDEA' | 'GROWTH_PLAN' | 'OUT_OF_SCOPE';
type View = { suggestion: Scope; reasons: string[]; outOfScopeMessage?: string; facts: FounderFact[]; confirmed?: { scope: Scope; payable: boolean } };

const STEPS = ['Understanding the business model', 'Writing business-specific research questions', 'Searching for evidence', 'Verifying quotes against sources', 'Writing the decision memo'];

export function Researching() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => Math.min(STEPS.length - 1, x + 1)), 9000); return () => clearInterval(t); }, []);
  return <div className="ht-card overflow-hidden">
    <div className="ht-hero px-6 py-6 text-white"><div className="flex items-center gap-3"><Microscope className="text-[#FFB067]"/><div><div className="text-[11px] font-bold uppercase tracking-[.16em] text-white/60">Aristotle · Venture intelligence</div><div className="text-xl font-extrabold">Aristotle is researching this.</div></div></div><p className="mt-2 text-sm text-white/70">Research comes before conclusions. This usually takes under a minute.</p></div>
    <ol className="space-y-3 p-6">{STEPS.map((s, j) => <li key={s} className={`flex items-center gap-3 text-sm ${j <= i ? 'text-[#0B1533]' : 'text-[#A9A291]'}`}>{j < i ? <CheckCircle2 size={18} className="text-[#14663D]"/> : j === i ? <Loader2 size={18} className="animate-spin text-[#4F46E5]"/> : <span className="h-[18px] w-[18px] rounded-full border border-[#D9D0BF]"/>}{s}</li>)}</ol>
  </div>;
}

export default function ResearchLauncher({ objectiveId, auditId, demoCheckout }: { objectiveId: string; auditId: string; demoCheckout: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [facts, setFacts] = useState<FounderFact[]>([]);
  const [factsOk, setFactsOk] = useState(false);
  const [scope, setScope] = useState<Scope>('NEW_IDEA');
  const [override, setOverride] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'confirm' | 'paying' | 'researching' | 'free'>('loading');
  const [err, setErr] = useState('');

  async function load() {
    setErr(''); setPhase('loading');
    try {
      const v = await post<View>(`/api/audits/${auditId}/scope`, { action: 'suggest' });
      setView(v); setFacts(v.facts); setScope(v.confirmed?.scope && v.confirmed.scope !== 'OUT_OF_SCOPE' ? v.confirmed.scope : v.suggestion === 'GROWTH_PLAN' ? 'GROWTH_PLAN' : 'NEW_IDEA'); setPhase('confirm');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load'); }
  }
  useEffect(() => { void load(); }, [auditId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function verify(payment: Record<string, unknown>) {
    setPhase('researching');
    const r = await fetch('/api/payments/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auditId, ...payment }) });
    // Paid but analysis failed or still running → the objective page shows status and RETRY (never a second payment).
    if (r.ok || [409, 500, 502].includes(r.status)) { router.push(`/objectives/${objectiveId}`); router.refresh(); return; }
    const j = await r.json().catch(() => ({}));
    setErr(j.error || 'Payment could not be verified. You have not been charged twice.'); setPhase('confirm');
  }

  async function start() {
    setErr('');
    if (facts.length && !factsOk) { setErr('Please confirm the numbers are correct (or remove the wrong ones) first.'); return; }
    setPhase('paying');
    try {
      const res = await post<{ confirmed?: { payable: boolean } }>(`/api/audits/${auditId}/scope`, { action: 'confirm', scope, facts, factsReviewed: facts.length > 0 ? factsOk : false });
      if (!res.confirmed?.payable) { setPhase('free'); return; }
      const order = await post<{ demo: boolean; orderId: string; amount: number; currency: string; keyId?: string }>('/api/payments/create-order', { auditId });
      if (order.demo) { await verify({ demo: true }); return; }
      const ok = await new Promise<boolean>((resolve) => { if ((window as unknown as { Razorpay?: unknown }).Razorpay) return resolve(true); const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = () => resolve(true); s.onerror = () => resolve(false); document.body.appendChild(s); });
      if (!ok) throw new Error('Razorpay checkout could not load. Please check your connection and retry.');
      const RZ = (window as unknown as { Razorpay: new (o: unknown) => { open: () => void } }).Razorpay;
      new RZ({ key: order.keyId, amount: order.amount, currency: order.currency, name: 'Hippoturtle', description: 'Aristotle evidence-based analysis', order_id: order.orderId, theme: { color: '#0B1533' },
        handler: (response: Record<string, unknown>) => { void verify(response); }, modal: { ondismiss: () => setPhase('confirm') } }).open();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); setPhase('confirm'); }
  }

  if (phase === 'researching') return <Researching />;
  if (phase === 'free') return <div className="ht-card p-6 text-sm leading-6">{view?.outOfScopeMessage || 'This is outside what Aristotle analyses, so you have not been charged.'}</div>;
  if (phase === 'loading') return <div className="ht-card flex items-center gap-3 p-6 text-sm text-[#5B6478]">{err ? <ErrorNote msg={err} onRetry={load}/> : <><Loader2 size={16} className="animate-spin"/>Preparing your analysis…</>}</div>;
  if (!view) return null;
  const oos = view.suggestion === 'OUT_OF_SCOPE' && !override;

  return <div className="ht-card p-6">
    {facts.length > 0 && <div>
      <div className="text-sm font-bold">Your numbers</div>
      <p className="mt-1 text-sm text-[#5B6478]">Hippoturtle treats these as founder-stated facts and will never change them. Remove anything that is wrong.</p>
      <ul className="mt-3 space-y-2">{facts.map((f, i) => <li key={f.id} className="flex items-start justify-between gap-3 rounded-xl border border-[#E9E2D4] bg-[#FBF7EF] px-4 py-2.5 text-sm"><div><div className="font-semibold">{describeFact(f)}</div><div className="text-xs text-[#6B7389]">“{f.raw}”</div></div><button type="button" aria-label="Remove" onClick={() => { setFacts((fs) => fs.filter((_, j) => j !== i)); setFactsOk(false); }} className="rounded-lg p-1 text-[#6B7389] hover:bg-white"><X size={16}/></button></li>)}</ul>
      <label className="mt-3 flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={factsOk} onChange={(e) => setFactsOk(e.target.checked)} className="h-4 w-4 accent-[#0B1533]"/> These numbers are correct</label>
    </div>}

    <div className={facts.length ? 'mt-6' : ''}>
      <div className="text-sm font-bold">What should Aristotle analyse?</div>
      {oos ? <div className="mt-2 rounded-xl bg-[#FFF1DF] p-4 text-sm leading-6 text-[#6B3A00]">{view.outOfScopeMessage}<button type="button" onClick={() => setOverride(true)} className="mt-2 block font-bold underline">This is actually my business → Continue</button></div>
        : <div className="mt-2 grid gap-2 sm:grid-cols-2">{([['NEW_IDEA', 'A new business or idea'], ['GROWTH_PLAN', 'Growing an existing business']] as const).map(([v, l]) => <button type="button" key={v} onClick={() => setScope(v)} className={`rounded-xl border px-4 py-3 text-left text-sm ${scope === v ? 'border-[#0B1533] bg-[#0B1533] text-white' : 'border-[#E9E2D4] bg-white'}`}><div className="font-semibold">{l}</div>{view.suggestion === v && <div className={`text-xs ${scope === v ? 'text-white/70' : 'text-[#6B7389]'}`}>Suggested</div>}</button>)}</div>}
    </div>

    {!oos && <div className="mt-6 flex flex-col gap-3 border-t border-[#E9E2D4] pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-[#5B6478]"><span className="font-bold text-[#0B1533]">Evidence-based analysis · ₹99 one-time.</span> {demoCheckout ? <span className="font-semibold text-[#D9670A]">Demo Mode: payment is skipped on this preview. Research is real.</span> : 'Secure Razorpay checkout. If analysis fails you can retry without paying again.'}</div>
      <button type="button" onClick={start} disabled={phase === 'paying'} className={btn.accent}>{phase === 'paying' ? <><Loader2 size={16} className="animate-spin"/>Starting…</> : <>Start Aristotle research <ArrowRight size={16}/></>}</button>
    </div>}
    <ErrorNote msg={err} />
  </div>;
}
