'use client';
// The Hippo conversation — the primary /start experience. Persistent (server-stored), mobile-first chat.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUp, Loader2, RotateCcw } from 'lucide-react';
import type { ConversationView } from '@/lib/hippo/conversation-service';
import { ErrorNote, post } from './client';
import ResearchLauncher from './ResearchLauncher';
import MoveCard from './MoveCard';

function Bubble({ role, text }: { role: 'HIPPO' | 'FOUNDER'; text: string }) {
  const hippo = role === 'HIPPO';
  return <div className={`flex items-end gap-2 ${hippo ? '' : 'flex-row-reverse'}`}>
    {hippo && <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#FF8A1F] to-[#FFB067] text-sm font-extrabold text-[#0B1533]">H</span>}
    <div className={`max-w-[85%] whitespace-pre-line rounded-2xl px-4 py-3 text-[15px] leading-6 sm:max-w-[75%] ${hippo ? 'rounded-bl-md border border-[#E9E2D4] bg-white text-[#0B1533]' : 'rounded-br-md bg-[#0B1533] text-white'}`}>
      <span className="sr-only">{hippo ? 'Hippo: ' : 'You: '}</span>{text}
    </div>
  </div>;
}

function Context({ v }: { v: ConversationView }) {
  const s = v.state;
  const rows = [['Goal', s.objective], ['Target', s.target], ['Today', s.current_state]] as const;
  if (!s.objective && !s.known_facts.length) return null;
  return <div className="rounded-2xl border border-[#E9E2D4] bg-[#FBF7EF] px-4 py-3 text-xs leading-5">
    <div className="text-[10px] font-bold uppercase tracking-[.16em] text-[#4F46E5]">What Hippo understands so far</div>
    <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-[auto_1fr]">
      {rows.filter(([, f]) => f).map(([k, f]) => <div key={k} className="contents"><dt className="font-bold text-[#3A4359]">{k}</dt><dd className="text-[#0B1533]">{f!.value}{f!.provenance === 'FOUNDER' ? <span className="ml-1 text-[#14663D]">· you said</span> : <span className="ml-1 text-[#6B7389]">· Hippo’s reading</span>}</dd></div>)}
    </dl>
    {s.known_facts.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{s.known_facts.slice(0, 6).map((f) => <span key={f.key} title="Stated by you — Hippo never changes it" className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#14663D] ring-1 ring-[#CDE7D6]">“{f.quote}”</span>)}</div>}
  </div>;
}

export default function HippoChat({ initial, demoCheckout }: { initial: ConversationView; demoCheckout: boolean }) {
  const [v, setV] = useState(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [v.messages.length, busy]);
  // Moves: while Hippo works on the next move (or the world may answer a live one), keep the view fresh.
  const live = v.move?.status === 'LIVE';
  useEffect(() => {
    if (!v.moves || busy || !(v.thinking || live)) return;
    const t = setTimeout(async () => {
      try { const r = await fetch('/api/hippo/conversation', { cache: 'no-store' }); if (r.ok) setV(await r.json()); } catch { /* next tick */ }
    }, v.thinking ? 3000 : 10000);
    return () => clearTimeout(t);
  }, [v, busy, live]);

  async function send(msg = text) {
    const t = msg.trim();
    if (!t || busy) return;
    setBusy(true); setErr(''); setPending(t); setText('');
    try { setV(await post<ConversationView>('/api/hippo/conversation', { text: t })); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); setText(t); }
    finally { setBusy(false); setPending(null); }
  }
  async function restart() {
    setBusy(true); setErr('');
    try { setV(await post<ConversationView>('/api/hippo/conversation', { action: 'new' })); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }
  const handoff = [...v.messages].reverse().find((m) => m.kind === 'HANDOFF');
  const quick = v.moves ? (v.quick ?? []) : v.phase === 'PROPOSED' ? ['Yes, dig in', 'Change the target', 'Challenge your assumption', 'Stop'] : v.messages.length <= 1 ? ['I want to start a clothing business', "I don't know yet"] : [];

  return <div className="flex flex-col gap-3">
    {!v.moves && <Context v={v} />}
    {v.moves && v.move && <MoveCard move={v.move} thinking={Boolean(v.thinking)} objectiveId={v.objectiveId} auditId={v.auditId} demoCheckout={demoCheckout} onView={setV} onError={setErr} />}
    <div className="ht-card flex min-h-[55vh] flex-col">
      <div role="log" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
        {v.messages.map((m) => <Bubble key={m.id} role={m.role} text={m.text} />)}
        {pending && <Bubble role="FOUNDER" text={pending} />}
        {v.moves && v.thinking && !v.move && !busy && <div className="flex items-center gap-2 pl-10 text-sm text-[#6B7389]"><Loader2 size={15} className="animate-spin text-[#4F46E5]"/>Hippo is working out the first move…</div>}
        {busy && pending && <div className="flex items-center gap-2 pl-10 text-sm text-[#6B7389]"><Loader2 size={15} className="animate-spin text-[#4F46E5]"/>Hippo is thinking…</div>}
        {!v.moves && handoff && v.objectiveId && v.auditId && v.phase === 'HANDED_OFF' && <div className="pl-0 sm:pl-10">
          <ResearchLauncher objectiveId={v.objectiveId} auditId={v.auditId} demoCheckout={demoCheckout} />
        </div>}
        {v.objectiveId && v.messages.some((m) => m.kind === 'RESULT') && <div className="pl-10"><Link href={`/objectives/${v.objectiveId}`} className="inline-flex items-center gap-1.5 text-sm font-bold text-[#4F46E5]">Open the full analysis <ArrowRight size={14}/></Link></div>}
        <div ref={end} />
      </div>
      <div className="border-t border-[#E9E2D4] p-3 sm:p-4">
        {quick.length > 0 && !busy && <div className="mb-2 flex flex-wrap gap-1.5">{quick.map((q) => <button key={q} type="button" onClick={() => send(q)} className="rounded-full border border-[#D9D0BF] bg-white px-3 py-1 text-xs font-semibold hover:border-[#0B1533]">{q}</button>)}</div>}
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex items-end gap-2">
          <label htmlFor="hippo-input" className="sr-only">Message Hippo</label>
          <textarea id="hippo-input" value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={2000} placeholder={v.status === 'PAUSED' ? 'Paused — say anything to pick it up again' : 'Tell Hippo in your own words…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            className="max-h-40 min-h-[48px] flex-1 resize-none rounded-2xl border border-[#E1D8C6] bg-[#FBF7EF] px-4 py-3 text-[15px] leading-6 outline-none focus:border-[#4F46E5] focus:bg-white" />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#0B1533] text-white disabled:opacity-40">{busy ? <Loader2 size={18} className="animate-spin"/> : <ArrowUp size={18}/>}</button>
        </form>
        <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7389]">
          <span>{v.moves ? 'Talking to Hippo is free. Nothing goes public, costs money or is sent without your OK.' : 'Talking to Hippo is free. Nothing is researched or charged until you say so.'}</span>
          {v.id && <button type="button" onClick={restart} disabled={busy} className="inline-flex items-center gap-1 font-semibold hover:text-[#0B1533]"><RotateCcw size={12}/>Start over</button>}
        </div>
        <ErrorNote msg={err} onRetry={text.trim() ? () => send() : undefined} />
      </div>
    </div>
  </div>;
}
