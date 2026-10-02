// Executive Decision Memo — rendered from Aristotle's validated report. Nothing is back-filled:
// anything Aristotle did not produce is shown as "Not produced" / "Not yet established".
import type { AuditReport } from '@/lib/audit';
import type { ResearchRecord } from '@/lib/evidence';
import { describeFact, type FounderFact } from '@/lib/founder-facts';
import type { PathwaysResult, Understanding } from '@/lib/hippo/types';
import { Badge, List, NotYet } from './ui';
import { CLAIM_LABEL, narrativeProvenance, type ClaimProvenance } from '@/lib/claim-provenance';
import { validateReport } from '@/lib/report-validation';

function ClaimTag({ p }: { p?: ClaimProvenance }) {
  if (!p) return null;
  const tone = p.label === 'SOURCED' ? 'green' : p.label === 'FOUNDER' ? 'blue' : 'amber';
  return <div className="mt-1 flex flex-wrap items-center gap-2 text-xs"><Badge tone={tone}>{CLAIM_LABEL[p.label]}</Badge><span className="text-[#6B7389]">{p.reason}</span></div>;
}

type Finding = { code: string; statement: string; quote: string; sourceTitle: string; sourceUrl: string; confidence: string };

const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '');
const a = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fmtNum = (n: unknown, unit = '') => (typeof n === 'number' && Number.isFinite(n) ? `${unit.includes('₹') ? '₹' : ''}${n.toLocaleString('en-IN')}${unit.includes('%') ? '%' : ''}` : '—');

export function Cite({ ids, findings, research, facts }: { ids?: string[]; findings: Map<string, Finding>; research: ResearchRecord | null; facts: Map<string, FounderFact> }) {
  if (!ids?.length) return null;
  return <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">{ids.map((id) => {
    const f = findings.get(id); const src = research?.sources.find((x) => x.id === id); const fact = facts.get(id);
    const url = f?.sourceUrl || src?.url;
    const title = f ? `${f.sourceTitle}: “${f.quote}”` : src ? src.title : fact ? `Founder: ${describeFact(fact)}` : id;
    const cls = `rounded-md px-1.5 py-0.5 text-[10px] font-bold ${fact ? 'bg-[#E7EBFF] text-[#3730A3]' : 'bg-[#E3F6EC] text-[#14663D]'}`;
    return url ? <a key={id} href={url} target="_blank" rel="noreferrer" title={title} className={cls}>{id}</a> : <span key={id} title={title} className={cls}>{id}</span>;
  })}</span>;
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return <section className="border-t border-[#E9E2D4] py-6 first:border-t-0 first:pt-0">
    <div className="flex items-baseline gap-3"><span className="text-xs font-bold text-[#C9BFAE]">{String(n).padStart(2, '0')}</span><h3 className="text-[15px] font-extrabold uppercase tracking-[.06em]">{title}</h3></div>
    <div className="mt-3 pl-0 sm:pl-8">{children}</div>
  </section>;
}

const P = ({ children }: { children: React.ReactNode }) => <p className="text-sm leading-7 text-[#2A3248]">{children}</p>;
const Text = ({ v }: { v: unknown }) => (s(v) ? <P>{s(v)}</P> : <p className="text-sm"><NotYet>Not produced for this analysis.</NotYet></p>);
const STATUS: Record<string, [string, 'green' | 'amber' | 'red' | 'grey']> = { SUPPORTED: ['Supported', 'green'], PARTIAL: ['Partly supported', 'amber'], UNKNOWN: ['Unknown — test it', 'grey'], CONTRADICTED: ['Evidence contradicts', 'red'] };

export default function DecisionMemoView({ objectiveText, understanding, report: raw, research, findings, facts, pathways }: {
  objectiveText: string; understanding: Understanding | null; report: AuditReport; research: ResearchRecord | null; findings: Finding[]; facts: FounderFact[]; pathways: PathwaysResult | null;
}) {
  const r = raw as unknown as Record<string, unknown>;
  const fm = new Map(findings.map((f) => [f.code, f])); const facm = new Map(facts.map((f) => [f.id, f]));
  const cite = (ids?: string[]) => <Cite ids={ids} findings={fm} research={research} facts={facm} />;
  const memo = o(r.decisionMemo); const customer = o(r.customer); const bm = o(r.businessModel); const mv = o(r.marketView); const tb = o(r.technologyBuild); const ks = o(r.killOrScale);
  const rbm = research?.businessModel;
  // Prose claims are labelled by provenance on every view (older stored reports included).
  const claims = narrativeProvenance(r as Parameters<typeof narrativeProvenance>[0], { research: new Set([...(research?.sources || []).map((x) => x.id), ...findings.map((f) => f.code)]), facts: new Set(facts.map((f) => f.id)) });
  const evidence = a<{ claim: string; type: string; sourceIds: string[]; confidence: string; validation: string }>(r.evidence);
  // Re-validated against the founder's facts on display, so rows stored by older code (e.g. an age shown as a sales figure) are corrected.
  const ue = a<Record<string, unknown>>(validateReport({ ...raw, unitEconomics: a(r.unitEconomics) } as AuditReport, facts).report.unitEconomics).filter((x) => typeof x.base === 'number' && Number.isFinite(x.base as number));
  const unknown = a<{ metric: string; whyUnknown: string; howToEstablish: string }>(r.unknownEconomics);
  const reg = a<{ name: string; status: string; activity?: string; requirement?: string; action: string; sourceIds?: string[]; source?: string }>(r.regulatory);
  const vul = a<{ risk: string; probability: string; impact: string; whyItMatters: string; mitigation: string }>(r.vulnerabilities);
  const exps = a<{ hypothesis: string; test: string; metric: string; passThreshold: string; failThreshold: string }>(r.experiments);
  const plan = a<{ week: string; objective: string; actions: string[]; successMetric: string }>(r.thirtyDayPlan);
  const assumptions = a<{ assumption: string; whyItMatters: string; evidenceStatus: string; evidence: string; evidenceIds: string[]; cheapestTest: string }>(memo.criticalAssumptions);
  const fails = [...a<string>(ks.pauseWhen), ...vul.filter((v) => v.impact === 'High').map((v) => `${v.risk}: ${v.whyItMatters}`)];
  const stillRequired = [...a<string>(memo.evidenceStillRequired), ...unknown.map((u) => `${u.metric} — ${u.howToEstablish}`)];

  return <div>
    <Section n={1} title="What the founder wants"><P>{objectiveText}</P>{understanding && <div className="mt-2 flex flex-wrap gap-2 text-xs"><Badge tone="blue">Target: {understanding.target}</Badge><Badge tone="grey">Today: {understanding.currentState}</Badge></div>}</Section>
    <Section n={2} title="What we understand"><Text v={r.executiveSummary || r.whatThisBusinessIs} />{s(memo.decisionQuestion) && <div className="mt-3 rounded-xl bg-[#0B1533] p-4 text-sm font-semibold text-white"><span className="text-[#FFB067]">Decision question · </span>{s(memo.decisionQuestion)}</div>}</Section>
    <Section n={3} title="Business model">{rbm ? <div className="grid gap-2 text-sm sm:grid-cols-2">{[['Offering', rbm.offering], ['Revenue mechanism', rbm.revenueMechanism], ['Key activities', rbm.keyActivities.join(', ')], ['Regulated activities', rbm.regulatedActivities.map((x) => x.activity).join(', ') || 'None identified']].map(([k, v]) => <div key={k} className="rounded-xl bg-[#FBF7EF] p-3"><div className="text-[11px] font-bold uppercase tracking-wider text-[#6B7389]">{k}</div><div className="mt-1">{v || '—'}</div></div>)}</div> : <Text v={bm.revenueModel} />}</Section>
    <Section n={4} title="Customer"><div className="grid gap-2 text-sm sm:grid-cols-2"><div className="rounded-xl bg-[#FBF7EF] p-3"><div className="text-[11px] font-bold uppercase tracking-wider text-[#6B7389]">Customer</div><div className="mt-1">{rbm?.customer || s(customer.icp) || '—'}</div></div><div className="rounded-xl bg-[#FBF7EF] p-3"><div className="text-[11px] font-bold uppercase tracking-wider text-[#6B7389]">Who pays</div><div className="mt-1">{rbm?.payer || '—'}</div></div></div>{s(customer.willingnessToPay) && <><P><span className="font-semibold">Willingness to pay: </span>{s(customer.willingnessToPay)}</P><ClaimTag p={claims['customer.willingnessToPay']} /></>}</Section>
    <Section n={5} title="Problem"><Text v={customer.problem} /><ClaimTag p={claims['customer.problem']} /></Section>
    <Section n={6} title="Evidence">
      {findings.length ? <ul className="space-y-2">{findings.map((f) => <li key={f.code} className="rounded-xl border border-[#E9E2D4] p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge tone="green">Sourced fact</Badge><span className="font-semibold">{f.statement}</span>{cite([f.code])}</div><div className="mt-1 text-xs text-[#6B7389]">“{f.quote}” — <a className="underline" href={f.sourceUrl} target="_blank" rel="noreferrer">{f.sourceTitle}</a> · Confidence {f.confidence.toLowerCase()} · India</div></li>)}</ul> : <p className="text-sm"><NotYet>Research found no verifiable evidence for this business yet.</NotYet></p>}
      {evidence.length > 0 && <div className="mt-4"><div className="text-xs font-bold uppercase tracking-wider text-[#6B7389]">Evidence register</div><ul className="mt-2 space-y-1.5 text-sm">{evidence.map((e, i) => <li key={i} className="flex flex-wrap items-center gap-2"><Badge tone={e.type === 'FACT' ? 'green' : e.type === 'FOUNDER' ? 'blue' : e.type === 'ASSUMPTION' || e.type === 'HYPOTHESIS' ? 'amber' : 'grey'}>{({ FACT: 'Sourced fact', FOUNDER: 'Founder stated', CALCULATION: 'Calculation', ASSUMPTION: 'Assumption', HYPOTHESIS: 'Hypothesis', INFERENCE: 'Inference' } as Record<string, string>)[e.type] || e.type}</Badge>{e.claim}{cite(e.sourceIds)}{e.type !== 'FACT' && e.type !== 'FOUNDER' && <span className="text-xs text-[#8A6A3B]">Validation required: {e.validation || 'yes'}</span>}</li>)}</ul></div>}
    </Section>
    <Section n={7} title="Key assumptions">{assumptions.length ? <div className="space-y-2">{assumptions.map((x, i) => { const [l, t] = STATUS[x.evidenceStatus] || ['Unknown', 'grey']; return <div key={i} className="rounded-xl border border-[#E9E2D4] p-4 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-bold">{x.assumption}</span><Badge tone={t}>{l}</Badge>{cite(x.evidenceIds)}</div><p className="mt-1 text-[#5B6478]">{x.whyItMatters}</p><p className="mt-1"><span className="font-semibold">Cheapest test: </span>{x.cheapestTest}</p></div>; })}</div> : <p className="text-sm"><NotYet>No critical assumption came out of the research gaps.</NotYet></p>}</Section>
    <Section n={8} title="Market & alternatives"><Text v={mv.demandSignal || mv.marketType} />{s(mv.marketRisk) && <P><span className="font-semibold">Market risk: </span>{s(mv.marketRisk)}</P>}<ClaimTag p={claims['marketView.demandSignal']} /></Section>
    <Section n={9} title="How the money works"><Text v={bm.revenueModel} />{s(bm.pricingLogic) && <P><span className="font-semibold">Pricing logic: </span>{s(bm.pricingLogic)}</P>}<div className="mt-2"><List items={a<string>(bm.keyCostDrivers)} empty="Cost drivers not produced." /></div></Section>
    <Section n={10} title="Unit economics">
      {ue.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase tracking-wider text-[#6B7389]"><th className="py-2 pr-3">Metric</th><th className="py-2 pr-3">Value</th><th className="py-2 pr-3">Basis</th></tr></thead><tbody>{ue.map((x, i) => <tr key={i} className="border-t border-[#E9E2D4]"><td className="py-2 pr-3 font-semibold">{s(x.metric)}</td><td className="py-2 pr-3">{x.conservative === x.upside ? fmtNum(x.base, s(x.unit)) : `${fmtNum(x.conservative, s(x.unit))}–${fmtNum(x.upside, s(x.unit))}`} <span className="text-xs text-[#6B7389]">{s(x.unit)}</span></td><td className="py-2 pr-3"><Badge tone={x.provenance === 'FOUNDER_STATED' ? 'blue' : x.provenance === 'EXTERNAL' ? 'green' : x.provenance === 'CALCULATED' ? 'grey' : 'amber'}>{({ FOUNDER_STATED: 'Founder stated', EXTERNAL: 'Researched', CALCULATED: 'Calculated', ASSUMPTION: 'Assumption', HYPOTHESIS: 'Hypothesis' } as Record<string, string>)[s(x.provenance)] || 'Assumption'}</Badge></td></tr>)}</tbody></table></div> : <p className="text-sm"><NotYet>No figure can be established yet from your numbers or from research.</NotYet></p>}
      {unknown.length > 0 && <div className="mt-3 rounded-xl bg-[#FFF8EE] p-4 text-sm"><div className="font-bold text-[#9A4B00]">Not yet established</div><ul className="mt-2 space-y-1">{unknown.map((u, i) => <li key={i}><span className="font-semibold">{u.metric}</span> — {u.howToEstablish}</li>)}</ul></div>}
    </Section>
    <Section n={11} title="Regulatory radar">{reg.length ? <div className="space-y-2">{reg.map((x, i) => <div key={i} className="rounded-xl border border-[#E9E2D4] p-4 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-bold">{x.name}</span><Badge tone="amber">{x.status}</Badge>{cite(x.sourceIds)}</div>{x.activity && <p className="mt-1"><span className="font-semibold">Activity: </span>{x.activity}</p>}{x.requirement && <p><span className="font-semibold">Requirement: </span>{x.requirement}</p>}<p className="mt-1 text-[#5B6478]">{x.action}</p></div>)}<p className="text-xs text-[#6B7389]">Screening only — confirm with a qualified professional. Hippoturtle is not a lawyer or CA.</p></div> : <p className="text-sm"><NotYet>No regulation was established from research for this business’s activities. See “evidence still required”.</NotYet></p>}</Section>
    <Section n={12} title="Competition"><Text v={mv.competition} /><ClaimTag p={claims['marketView.competition']} /></Section>
    <Section n={13} title="Vulnerabilities">{vul.length ? <div className="grid gap-2 sm:grid-cols-2">{vul.map((v, i) => <div key={i} className="rounded-xl border border-[#E9E2D4] p-4 text-sm"><div className="flex items-center justify-between gap-2"><span className="font-bold">{v.risk}</span><Badge tone={v.impact === 'High' ? 'red' : 'amber'}>{v.probability} / {v.impact}</Badge></div><p className="mt-1 text-[#5B6478]">{v.whyItMatters}</p><p className="mt-1"><span className="font-semibold">Mitigation: </span>{v.mitigation}</p></div>)}</div> : <p className="text-sm"><NotYet>Not produced.</NotYet></p>}</Section>
    <Section n={14} title="How could we actually achieve this?">{pathways ? <><P>{pathways.goal}</P><P>{pathways.ambitionNote}</P>{pathways.combination && <div className="mt-2 rounded-xl bg-[#EEF0FF] p-4 text-sm"><span className="font-bold text-[#3730A3]">Combining pathways: </span>{pathways.combination}</div>}</> : <p className="text-sm"><NotYet>Pathways not generated yet — see below.</NotYet></p>}</Section>
    <Section n={15} title="Plausible pathways">{pathways ? <List items={pathways.pathways.map((p) => `${p.id} · ${p.name} — evidence ${p.evidenceStrength === 'NOT_YET_ESTABLISHED' ? 'not yet established' : p.evidenceStrength.toLowerCase()}`)} /> : <p className="text-sm"><NotYet>Not generated yet.</NotYet></p>}</Section>
    <Section n={16} title="MVP"><List items={a<string>(tb.mvp)} />{a<string>(tb.avoidBuilding).length > 0 && <div className="mt-2 text-sm"><span className="font-semibold">Avoid building: </span>{a<string>(tb.avoidBuilding).join('; ')}</div>}</Section>
    <Section n={17} title="Go-to-market"><List items={a<string>(r.goToMarket)} /></Section>
    <Section n={18} title="Validation experiments">{exps.length ? <div className="space-y-2">{exps.map((x, i) => <div key={i} className="rounded-xl border border-[#E9E2D4] p-4 text-sm"><div className="font-bold">{i + 1}. {x.test}</div><p className="mt-1 text-[#5B6478]">Hypothesis: {x.hypothesis}</p><div className="mt-2 flex flex-wrap gap-2"><Badge tone="green">Pass: {x.passThreshold}</Badge><Badge tone="red">Fail: {x.failThreshold}</Badge><Badge tone="grey">Metric: {x.metric}</Badge></div></div>)}</div> : <p className="text-sm"><NotYet>Not produced.</NotYet></p>}</Section>
    <Section n={19} title="30-day execution plan">{plan.length ? <div className="grid gap-2 sm:grid-cols-2">{plan.map((w, i) => <div key={i} className="rounded-xl bg-[#FBF7EF] p-4 text-sm"><div className="text-xs font-bold uppercase tracking-wider text-[#4F46E5]">{w.week}</div><div className="mt-1 font-bold">{w.objective}</div><List items={a<string>(w.actions)} /><div className="mt-2 text-xs text-[#6B7389]">Success: {w.successMetric}</div></div>)}</div> : <p className="text-sm"><NotYet>Not produced.</NotYet></p>}</Section>
    <Section n={20} title="What must be true"><List items={a<string>(r.whatMustBeTrue)} /></Section>
    <Section n={21} title="What could make this fail"><List items={fails} /></Section>
    <Section n={22} title="Evidence still required"><List items={stillRequired} empty="Nothing listed." /></Section>
    <Section n={23} title="Founder decision checklist">{pathways?.founderChecklist.length ? <ul className="space-y-2 text-sm">{pathways.founderChecklist.map((c, i) => <li key={i} className="flex gap-3"><span className="mt-0.5 h-4 w-4 shrink-0 rounded border-2 border-[#0B1533]"/>{c}</li>)}</ul> : <List items={[...a<string>(memo.proceedIf).map((x) => `Proceed if: ${x}`), ...a<string>(memo.changeModelIf).map((x) => `Change the model if: ${x}`)]} />}<p className="mt-3 text-xs font-semibold text-[#6B7389]">Aristotle does not make this decision for you. You do.</p></Section>
  </div>;
}
