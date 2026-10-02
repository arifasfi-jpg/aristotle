import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Download, Scale, ShieldAlert } from 'lucide-react';
import { db } from '@/lib/db';
import { allowedModes, routeCapability } from '@/lib/hippo/capabilities';
import { HttpError, requireWork } from '@/lib/hippo/context';
import { LABELS } from '@/lib/hippo/costs';
import { withAiProvenance, type QuoteComparison } from '@/lib/hippo/execution';
import { workPaymentPlan } from '@/lib/hippo/payments';
import { classifyInputs, INPUT_LABEL, proposedLabel, type BriefInput } from '@/lib/hippo/provenance';
import { provenanceFor } from '@/lib/hippo/service';
import type { EffortModel } from '@/lib/hippo/types';
import Markdown from '@/components/hippo/Markdown';
import { AutoRefresh } from '@/components/hippo/Status';
import { ApproveInput, AutoBrief, ChooseMode, ExecuteButton, OutcomeForm, QuoteForm, type Option } from '@/components/hippo/WorkActions';
import { Badge, Card, Eyebrow, inr, inrRange, List, Shell, when, WorkStatus } from '@/components/hippo/ui';

export const dynamic = 'force-dynamic';

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="border-t border-[#E9E2D4] py-4 first:border-t-0 first:pt-0"><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#4F46E5]">{title}</div><div className="mt-2">{children}</div></div>;
}

export default async function WorkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let ctx;
  try { ctx = await requireWork(id); } catch (e) { if (e instanceof HttpError && e.status === 401) redirect('/start'); return notFound(); }
  const { work, objective } = ctx;
  const cap = routeCapability(work.capability);
  const [brief, estimates, quotes, executions, outcomes] = await Promise.all([
    db.workBrief.findUnique({ where: { workId: work.id } }),
    db.costEstimate.findMany({ where: { workId: work.id }, orderBy: { createdAt: 'asc' } }),
    db.quote.findMany({ where: { workId: work.id }, include: { provider: true }, orderBy: { createdAt: 'desc' } }),
    db.execution.findMany({ where: { workId: work.id }, orderBy: { startedAt: 'desc' } }),
    db.outcome.findMany({ where: { workId: work.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  // Provenance is re-derived on every view: an AI proposal never shows as Known unless the founder stated or approved it.
  const inputs = brief ? classifyInputs(brief.inputs as BriefInput[], await provenanceFor(objective)) : [];
  const est = (m: string) => estimates.find((e) => e.mode === m);
  const modes = allowedModes(cap);
  const effort = brief?.effort as EffortModel | undefined;
  const latest = executions[0];
  const output = executions.find((e) => e.output);
  const running = work.status === 'IN_PROGRESS' && latest?.status === 'RUNNING';

  const option = (mode: 'AI' | 'HUMAN' | 'HYBRID', title: string): Option => {
    const e = est(mode); const allowed = modes.includes(mode);
    return { mode, title, range: e ? inrRange(e.low, e.high) : allowed && mode !== 'AI' ? 'Quote required' : '—', label: e ? (e.label === 'COMPUTED' ? 'Calculated from AI model rates' : 'Indicative estimate — external quote required') : allowed ? 'No benchmark yet — external quote required' : '',
      note: e?.basis || workPaymentPlan(mode).note, available: allowed && (mode !== 'AI' || Boolean(e)),
      reason: !allowed ? (cap.requiresProfessional && mode === 'AI' ? 'Not offered: this work legally needs a qualified professional. AI prepares, a professional approves.' : 'Not available for this capability.') : 'AI cannot do this work on its own (calls, visits, signatures or judgement needed).' };
  };

  return <Shell>
    <Link href={`/objectives/${objective.id}`} className="inline-flex items-center gap-1 text-sm font-semibold text-[#5B6478] hover:text-[#0B1533]"><ArrowLeft size={15}/>Back to objective</Link>
    <div className="mt-4 flex flex-wrap items-center gap-2"><Eyebrow>Work · {cap.label}</Eyebrow><span className="text-xs text-[#6B7389]">routed by Mogli to {cap.internalName}</span><WorkStatus status={work.status}/>{cap.requiresProfessional && <Badge tone="amber">Professional sign-off required</Badge>}</div>
    <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{work.title}</h1>
    <p className="mt-2 max-w-3xl whitespace-pre-line leading-7 text-[#5B6478]">{work.description}</p>

    <div className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
      <div className="min-w-0 space-y-6">
        {!brief ? <AutoBrief workId={work.id} /> : <Card>
          <div className="flex items-center justify-between"><h2 className="text-xl font-extrabold">Work brief</h2><span className="text-xs text-[#6B7389]">Written by Mogli · {brief.provider}/{brief.model}</span></div>
          <div className="mt-4">
            <Block title="Objective"><p className="text-sm leading-6">{brief.objective}</p></Block>
            <Block title="Deliverable"><p className="text-sm font-semibold leading-6">{brief.deliverable}</p></Block>
            <Block title="Inputs">{inputs.length ? <ul className="space-y-2 text-sm">{inputs.map((i, k) => <li key={k} className="flex flex-wrap items-center gap-2">
              {i.status === 'KNOWN' ? <Badge tone={i.source === 'RESEARCH' ? 'green' : 'blue'}>{INPUT_LABEL[i.source || 'FOUNDER']}{i.sourceRef ? ` · ${i.sourceRef}` : ''}</Badge> : i.status === 'PROPOSED' ? <Badge tone="amber">{proposedLabel(i.item, i.value)}</Badge> : <Badge tone="amber">Needed from you</Badge>}
              <span className="font-semibold">{i.item}</span>{i.value && <span className="text-[#5B6478]">— {i.value}</span>}
              {i.status === 'PROPOSED' && <ApproveInput workId={work.id} item={i.item} value={i.value} />}
            </li>)}</ul> : <List items={[]} />}</Block>
            <Block title="Constraints"><div className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(brief.constraints as Record<string, string>).map(([k, v]) => <div key={k} className="rounded-xl bg-[#FBF7EF] p-3"><div className="text-[10px] font-bold uppercase tracking-wider text-[#6B7389]">{k}</div><div className={`mt-0.5 ${v === 'Not set by founder' ? 'italic text-[#8A6A3B]' : ''}`}>{v}</div></div>)}</div></Block>
            <Block title="Success criteria"><List items={brief.successCriteria as string[]} /></Block>
            <Block title="Expected output"><p className="text-sm leading-6">{brief.expectedOutput}</p></Block>
            <Block title="Not included"><List items={brief.outOfScope as string[]} empty="Nothing excluded." /></Block>
          </div>
        </Card>}

        {(output || running) && <Card>
          {running ? <><AutoRefresh ms={6000}/><div className="font-extrabold">WORK IN PROGRESS</div><p className="text-sm text-[#5B6478]">{cap.label} is producing the deliverable.</p></> : output && <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><div className="text-lg font-extrabold tracking-wide text-[#14663D]">{output.status === 'WAITING_FOR_REVIEW' ? 'DRAFT READY — AWAITING HUMAN REVIEW' : 'WORK COMPLETED'}</div><div className="text-xs text-[#6B7389]">{output.provider}/{output.model} · {output.completedAt ? when(output.completedAt) : ''} · {output.inputTokens.toLocaleString('en-IN')} in / {output.outputTokens.toLocaleString('en-IN')} out tokens · actual AI cost {inr(output.costInr, 2)}</div></div>
              <a href={`/api/hippo/work/${work.id}/output`} className="inline-flex items-center gap-2 rounded-xl border border-[#D9D0BF] bg-white px-4 py-2 text-sm font-semibold hover:border-[#0B1533]"><Download size={15}/>Download (.md)</a>
            </div>
            {output.outputSummary && <p className="mt-3 rounded-xl bg-[#F4FAF6] p-3 text-sm leading-6">{output.outputSummary}</p>}
            {(cap.requiresProfessional || output.status === 'WAITING_FOR_REVIEW') && <div className="mt-3 flex gap-2 rounded-xl bg-[#FFF1DF] p-3 text-sm text-[#6B3A00]"><ShieldAlert size={17} className="mt-0.5 shrink-0"/>{cap.requiresProfessional ? `Prepared by AI. A qualified ${cap.costModel.specialist.toLowerCase()} must review and approve this before it is relied on. Hippoturtle is not a lawyer or CA.` : 'AI draft complete. A human reviewer has not been assigned yet — add a quote below or review it yourself, then record the outcome.'}</div>}
            {(() => { const meta = output.input as { founderInputsNeeded?: string[] }; return meta?.founderInputsNeeded?.length ? <div className="mt-3 text-sm"><div className="font-bold">Needed from you</div><List items={meta.founderInputsNeeded} /></div> : null; })()}
            <div className="mt-5 max-h-[720px] overflow-y-auto rounded-2xl border border-[#E9E2D4] bg-white p-5"><Markdown>{withAiProvenance(output.output || '', (output.input || {}) as { assumptions?: unknown; founderInputsNeeded?: unknown })}</Markdown></div>
          </>}
        </Card>}
        {latest?.status === 'FAILED' && !running && <Card><div className="font-bold text-[#A3271B]">The last attempt failed and nothing was charged.</div><p className="text-sm text-[#5B6478]">You can retry below.</p></Card>}
      </div>

      <div className="min-w-0 space-y-6">
        {brief && <Card>
          <div className="flex items-center gap-2"><Scale size={18} className="text-[#4F46E5]"/><h2 className="text-xl font-extrabold">Hippoturtle estimate</h2></div>
          <p className="mt-1 text-xs text-[#6B7389]">Estimates, not market prices. AI cost is calculated from configured model rates; human and agency figures are AI-generated benchmarks from the effort assumptions shown.</p>
          <div className="mt-4 space-y-2">{estimates.map((e) => <div key={e.id} className="rounded-xl border border-[#E9E2D4] p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-bold">{{ AI: 'AI / internal execution', HUMAN: 'Human specialist', HYBRID: 'Hybrid (AI + human review)', AGENCY: 'Agency' }[e.mode] || e.mode}</span><span className="text-lg font-extrabold">{inrRange(e.low, e.high)}</span></div><div className="mt-1 text-[11px] font-semibold text-[#9A4B00]">{LABELS[e.label as keyof typeof LABELS] || e.label}</div><p className="mt-1 text-xs leading-5 text-[#5B6478]">{e.basis}</p>{e.mode === 'AI' && <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-[#5B6478]">{Object.entries(e.breakdown as Record<string, number | string>).map(([k, v]) => <div key={k}>{k}: <b>{typeof v === 'number' ? inr(v, 2).replace('₹', '') : v}</b></div>)}</div>}</div>)}
            {!estimates.length && <p className="text-sm italic text-[#8A6A3B]">No estimate could be established for this work.</p>}</div>
          {effort?.costDrivers && <div className="mt-4"><div className="text-sm font-bold">Why does the cost vary?</div><List items={(estimates.find((e) => e.mode !== 'AI')?.drivers as string[]) || effort.costDrivers} /></div>}
        </Card>}

        {brief && <Card>
          <h2 className="text-xl font-extrabold">How should we execute this?</h2>
          <p className="mt-1 text-sm text-[#5B6478]">You decide. Hippoturtle earns the same disclosed 10% margin whichever you choose.</p>
          <div className="mt-4"><ChooseMode workId={work.id} current={work.executionMode} locked={['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(work.status) || (work.status === 'WAITING_FOR_INPUT' && work.executionMode !== 'HUMAN')} options={[option('AI', 'Hippoturtle / AI'), option('HUMAN', 'External human / provider'), option('HYBRID', 'Hybrid')]} /></div>
          {work.executionMode && <div className="mt-4 rounded-xl bg-[#FBF7EF] p-3 text-xs leading-5 text-[#5B6478]"><b className="text-[#0B1533]">Payment: </b>{workPaymentPlan(work.executionMode as 'AI' | 'HUMAN' | 'HYBRID').note}</div>}
          {(work.executionMode === 'AI' || work.executionMode === 'HYBRID') && work.status === 'APPROVED' && <div className="mt-4"><ExecuteButton workId={work.id} label={latest?.status === 'FAILED' ? 'RETRY EXECUTION' : work.executionMode === 'AI' ? 'Execute with Hippoturtle' : 'Produce the AI draft'} /></div>}
        </Card>}

        {brief && <Card>
          <h2 className="text-xl font-extrabold">External quotes</h2>
          <p className="mt-1 text-xs text-[#6B7389]">Hippoturtle is an honest broker: every quote is compared with our own estimate, and we explain the difference.</p>
          <div className="mt-4 space-y-3">{quotes.length ? quotes.map((q) => { const c = q.comparison as QuoteComparison | null; return <div key={q.id} className="rounded-xl border border-[#E9E2D4] p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-bold">{q.provider.name}</div><div className="text-lg font-extrabold">{inr(q.amount)}</div></div>
            <div className="mt-1 flex flex-wrap gap-1.5">{q.source === 'EXAMPLE' ? <Badge tone="amber">Example external quote — not real</Badge> : <Badge tone="blue">Entered by founder</Badge>}<Badge tone="grey">External option</Badge>{c && c.position !== 'NO_BENCHMARK' && <Badge tone={c.position === 'WITHIN' ? 'green' : c.position === 'ABOVE' ? 'red' : 'amber'}>{c.deltaPct! > 0 ? '+' : ''}{c.deltaPct}% vs benchmark</Badge>}</div>
            {c && <><div className="mt-2 text-xs font-bold uppercase tracking-wider text-[#4F46E5]">Why is this quote different?</div><p className="mt-1 leading-6">{c.explanation}</p>{c.scopeGaps.length > 0 && <div className="mt-2 text-xs"><b>Not clearly covered:</b> {c.scopeGaps.join('; ')}</div>}{c.extras.length > 0 && <div className="mt-1 text-xs"><b>Beyond the brief:</b> {c.extras.join('; ')}</div>}</>}
          </div>; }) : <p className="text-sm italic text-[#8A6A3B]">External quote not yet available. Hippoturtle has no preferred provider onboarded for {cap.label.toLowerCase()} yet — you can add a quote you received.</p>}</div>
          <div className="mt-4"><QuoteForm workId={work.id} example={objective.isDemo && est('HUMAN') ? { providerName: 'Example Agency (demo)', amount: Math.round(est('HUMAN')!.high * 1.35 / 100) * 100, includes: 'Everything in the brief\n3 rounds of revisions\nProfessional photography', excludes: 'Landing-page hosting', turnaroundDays: 10, revisions: 3 } : null} /></div>
        </Card>}

        <Card>
          <h2 className="text-xl font-extrabold">Outcome</h2>
          {outcomes.length > 0 && <ul className="mt-3 space-y-2">{outcomes.map((o) => <li key={o.id} className="rounded-xl bg-[#F4FAF6] p-3 text-sm"><div className="font-semibold">{o.summary}</div>{(o.metrics as { label: string; value: string }[]).map((m, i) => <div key={i} className="text-xs text-[#5B6478]">{m.label}: <b>{m.value}</b></div>)}<div className="mt-1 text-[11px] text-[#6B7389]">{when(o.createdAt)} · founder stated</div></li>)}</ul>}
          <p className="mt-2 text-sm text-[#5B6478]">Record what actually happened. It goes into Business Memory, so every future decision starts from real results.</p>
          <div className="mt-3"><OutcomeForm url={`/api/hippo/work/${work.id}/outcome`} prompt="e.g. Sent outreach to 50 pharmacies; 12 replied, 4 asked for samples, 2 ordered." /></div>
        </Card>
      </div>
    </div>
  </Shell>;
}
