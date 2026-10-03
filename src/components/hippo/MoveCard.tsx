'use client';
// The one pinned Move: what we're doing, why, who does what, what it costs, what we're watching for — and the
// founder's controls. Every control posts to the server, which decides what is allowed (authorization lives there).
import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { ConversationView } from '@/lib/hippo/conversation-service';
import type { MoveView } from '@/lib/hippo/conversation-moves';
import Markdown from './Markdown';
import { post } from './client';
import ResearchLauncher from './ResearchLauncher';

type Action = 'YES' | 'NOT_NOW' | 'RESUME' | 'HELP' | 'ANOTHER_WAY' | 'CANT' | 'FAILED' | 'DID_IT' | 'NEXT' | 'WHY';
const STATUS: Record<string, string> = {
  PROPOSED: 'Suggested', PREPARING: 'Hippo is preparing it', READY: 'Ready for you', APPROVED: 'Your turn',
  LIVE: 'Out in the world', SIGNALLED: 'The world answered', PARKED: 'Paused',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-[10px] font-bold uppercase tracking-[.14em] text-[#6B7389]">{label}</dt><dd className="mt-0.5 text-sm leading-6 text-[#0B1533]">{children}</dd></div>;
}

export default function MoveCard({ move, thinking, objectiveId, auditId, demoCheckout, onView, onError }: {
  move: MoveView; thinking: boolean; objectiveId: string | null; auditId: string | null; demoCheckout: boolean;
  onView: (v: ConversationView) => void; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [guardian, setGuardian] = useState(false);
  const [proof, setProof] = useState('');
  const [open, setOpen] = useState(false);

  async function act(action: Action, extra: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(action); onError('');
    try { onView(await post<ConversationView>(`/api/hippo/moves/${move.id}`, { action, ...extra })); }
    catch (e) { onError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(null); }
  }
  const btn = (action: Action, label: string, primary = false, extra: Record<string, unknown> = {}) =>
    <button key={action} type="button" disabled={Boolean(busy) || thinking} onClick={() => act(action, extra)}
      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold disabled:opacity-50 ${primary ? 'bg-[#0B1533] text-white' : 'border border-[#D9D0BF] bg-white text-[#0B1533] hover:border-[#0B1533]'}`}>
      {busy === action && <Loader2 size={12} className="animate-spin"/>}{label}
    </button>;

  const a = move.artifact;
  const deciding = ['PROPOSED', 'PREPARING', 'READY'].includes(move.status);
  return <section aria-label="Current move" className="rounded-2xl border-2 border-[#0B1533] bg-white p-4 shadow-sm sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-[10px] font-bold uppercase tracking-[.16em] text-[#D9670A]">Your next move</div>
      <span className="rounded-full bg-[#FBF7EF] px-2.5 py-1 text-[11px] font-bold text-[#3A4359] ring-1 ring-[#E9E2D4]">{STATUS[move.status] || move.status}</span>
    </div>
    <h2 className="mt-1.5 text-lg font-extrabold leading-snug tracking-tight">{move.title}</h2>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
      <Row label="Why">{move.why}</Row>
      <Row label="What we're watching for">{move.expectedSignal}</Row>
      <Row label="What Hippo will do">{move.hippoWill}</Row>
      {move.needs.length > 0 && <Row label="What I need from you"><ul className="list-disc pl-4">{move.needs.map((n) => <li key={n}>{n}</li>)}</ul></Row>}
      <Row label="Cost">{move.cost}</Row>
    </dl>

    {thinking && <div className="mt-3 flex items-center gap-2 text-sm text-[#6B7389]"><Loader2 size={14} className="animate-spin text-[#4F46E5]"/>Hippo is getting this ready…</div>}

    {a?.type === 'DOCUMENT' && <div className="mt-4 rounded-xl border border-[#E9E2D4] bg-[#FBF7EF] p-3">
      <button type="button" onClick={() => setOpen(!open)} className="text-sm font-bold text-[#4F46E5]">{open ? 'Hide' : 'Open'} what Hippo prepared: {a.title}</button>
      {open && <div className="mt-2 max-h-[50vh] overflow-y-auto text-sm"><Markdown>{a.markdown}</Markdown></div>}
    </div>}
    {a?.type === 'PUBLIC_PAGE' && <div className="mt-4 rounded-xl border border-[#E9E2D4] bg-[#FBF7EF] p-3 text-sm">
      <a href={`/p/${a.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-bold text-[#4F46E5] underline">{a.status === 'PUBLISHED' ? 'Your live page' : 'Preview the page (not public yet)'}<ExternalLink size={12}/></a>
      {a.status === 'PUBLISHED' && <div className="mt-1 text-xs text-[#5B6478]">Share this link: <span className="select-all font-mono">{a.url}</span></div>}
      {a.status === 'PUBLISHED' && <div className="mt-1 text-xs text-[#5B6478]">{a.views} view{a.views === 1 ? '' : 's'} · {a.responses.filter((r) => !r.fromOwner).length} response{a.responses.filter((r) => !r.fromOwner).length === 1 ? '' : 's'}</div>}
      {a.responses.length > 0 && <ul className="mt-2 space-y-1">{a.responses.slice(0, 5).map((r) => <li key={r.at + r.contact} className="text-xs"><b>{r.name || 'Someone'}</b>{r.fromOwner ? ' (you, testing)' : ''}{r.message ? ` — “${r.message}”` : ''}</li>)}</ul>}
    </div>}
    {a?.type === 'DEEP_RESEARCH' && move.status === 'APPROVED' && objectiveId && auditId && <div className="mt-4"><ResearchLauncher objectiveId={objectiveId} auditId={auditId} demoCheckout={demoCheckout} /></div>}

    {move.signals.length > 0 && <ul className="mt-3 space-y-1">{move.signals.map((s) => <li key={s.at} className="text-xs"><span className={`mr-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${s.source === 'SYSTEM_OBSERVED' ? 'bg-[#E6F4EC] text-[#14663D]' : 'bg-[#EEF0FB] text-[#3A4359]'}`}>{s.source === 'SYSTEM_OBSERVED' ? 'Seen by Hippo' : 'You reported'}</span>{s.summary}</li>)}</ul>}

    {deciding && move.consequential && <div className="mt-4 rounded-xl bg-[#FFF8EE] p-3 text-xs leading-5 text-[#7A4A0A]">
      Needs your OK because {move.okBecause.join(', ')}.
      {move.needsGuardian && <label className="mt-2 flex items-center gap-2 font-semibold"><input type="checkbox" checked={guardian} onChange={(e) => setGuardian(e.target.checked)} />A parent or guardian has seen this and says OK</label>}
    </div>}

    <div className="mt-4 flex flex-wrap gap-1.5">
      {deciding && <>{btn('YES', move.consequential ? 'Yes, go ahead' : "Yes, let's do it", true, move.needsGuardian ? { guardian } : {})}{btn('HELP', 'Help me do this')}{btn('ANOTHER_WAY', 'Try another way')}{btn('NOT_NOW', 'Not now')}</>}
      {move.status === 'APPROVED' && <>
        <form onSubmit={(e) => { e.preventDefault(); void act('DID_IT', proof.trim() ? { proof: proof.trim() } : {}); }} className="flex w-full flex-wrap items-center gap-1.5">
          <label htmlFor="move-proof" className="sr-only">Link to what you did (optional)</label>
          <input id="move-proof" type="url" value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Link to what you did (optional)" className="min-w-0 flex-1 rounded-full border border-[#E1D8C6] bg-[#FBF7EF] px-3 py-2 text-xs outline-none focus:border-[#4F46E5]" />
          <button type="submit" disabled={Boolean(busy)} className="rounded-full bg-[#0B1533] px-3.5 py-2 text-xs font-bold text-white disabled:opacity-50">I did it</button>
        </form>
        {btn('HELP', 'Help me do this')}{btn('CANT', "I can't do this")}</>}
      {move.status === 'LIVE' && <>{btn('FAILED', 'This failed')}{move.owner !== 'HIPPO' && btn('HELP', 'Help me do this')}</>}
      {move.status === 'SIGNALLED' && btn('NEXT', "What's next?", true)}
      {move.status === 'PARKED' && <>{btn('RESUME', 'Bring it back', true)}{btn('ANOTHER_WAY', 'Try another way')}</>}
      {btn('WHY', 'Why?')}
    </div>
    {['LIVE', 'APPROVED'].includes(move.status) && <p className="mt-2 text-[11px] text-[#6B7389]">When something happens, just tell Hippo below — in your own words.</p>}
  </section>;
}
