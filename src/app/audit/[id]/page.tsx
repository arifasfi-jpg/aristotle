import { notFound } from 'next/navigation';
import { ArrowDownToLine, CheckCircle2, ExternalLink, ShieldAlert, Target, TrendingUp, TriangleAlert, Wrench } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import type { AuditReport } from '@/lib/audit';
import RetryAnalysis from '@/components/RetryAnalysis';
import { getLockedFacts, getResearch, getScopeRecord } from '@/lib/audit-meta';
import { evidenceSummary, type EvidenceClaim, type DecisionMemo, type UnknownMetric } from '@/lib/evidence';
import { CONCEPT_LABEL, COUNT_CONCEPTS, TIMEFRAME_LABEL, formatFactValue, type FactConcept } from '@/lib/founder-facts';
import { OUT_OF_SCOPE_MESSAGES, SCOPE_LABEL } from '@/lib/routing';

const money=(n:number)=>`₹${Math.round(n).toLocaleString('en-IN')}`;
// Format by what the number measures: counts never get ₹, margins are %, money gets ₹.
const fmt=(x:{unit?:string;concept?:string},n:number)=>{const u=x.unit||'';if(x.concept==='margin'||u.includes('%'))return `${Math.round(n*100)/100}%`;if(COUNT_CONCEPTS.includes(x.concept as FactConcept)||x.concept==='payback'||(!u.includes('₹')&&/(units|orders|customers|months|count|meals|packs|pieces|pharmacies|stores|\/order)/i.test(u)))return Math.round(n*100)/100===Math.round(n)?Math.round(n).toLocaleString('en-IN'):(Math.round(n*100)/100).toLocaleString('en-IN');return money(n);};
const Q_STYLE:Record<string,string>={ANSWERED:'border-[#2c6b57] text-[#77e2c1]',PARTIAL:'border-[#5a4a2d] text-[#ffcf70]',NOT_FOUND:'border-[#3a4657] text-[#93a0b5]',CONTRADICTORY:'border-[#6b2d2d] text-[#ff9f9f]',SEARCH_FAILED:'border-[#3a4657] text-[#93a0b5]'};
const Q_LABEL:Record<string,string>={ANSWERED:'Answered',PARTIAL:'Partly answered',NOT_FOUND:'Not found',CONTRADICTORY:'Contradictory',SEARCH_FAILED:'Search failed'};
const STATUS_STYLE:Record<string,string>={SUPPORTED:'border-[#2c6b57] text-[#77e2c1]',PARTIAL:'border-[#5a4a2d] text-[#ffcf70]',UNKNOWN:'border-[#3a4657] text-[#93a0b5]',CONTRADICTED:'border-[#6b2d2d] text-[#ff9f9f]'};
const STATUS_LABEL:Record<string,string>={SUPPORTED:'Supported by evidence',PARTIAL:'Partly supported',UNKNOWN:'Unknown — needs testing',CONTRADICTED:'Evidence contradicts'};
const CLAIM_STYLE:Record<string,string>={FACT:'border-[#2c6b57] text-[#77e2c1]',FOUNDER:'border-[#2c6b57] text-[#b6f0dc]',CALCULATION:'border-[#2d4a6b] text-[#8fb8ff]',ASSUMPTION:'border-[#3a4657] text-[#93a0b5]',HYPOTHESIS:'border-[#5a2d4a] text-[#ff9fd0]',INFERENCE:'border-[#5a4a2d] text-[#ffcf70]'};
const CLAIM_LABEL:Record<string,string>={FACT:'Sourced fact',FOUNDER:'Founder-stated',CALCULATION:'Calculation',ASSUMPTION:'Assumption',HYPOTHESIS:'Hypothesis',INFERENCE:'Inference'};
const PROV_STYLE:Record<string,string>={FOUNDER_STATED:'border-[#2c6b57] text-[#77e2c1]',CALCULATED:'border-[#2d4a6b] text-[#8fb8ff]',EXTERNAL:'border-[#5a4a2d] text-[#ffcf70]',ASSUMPTION:'border-[#3a4657] text-[#93a0b5]',HYPOTHESIS:'border-[#5a2d4a] text-[#ff9fd0]'};

export default async function AuditPage({params}:{params:Promise<{id:string}>}){
 const {id}=await params; const user=await getCurrentUser();
 if(!user)return <main className="mx-auto max-w-4xl px-6 py-20"><h1 className="text-3xl font-semibold">Session required</h1><p className="mt-3 text-[#93a0b5]">Open this audit in the same browser session used to submit it.</p></main>;
 const audit=await db.audit.findFirst({where:{id,userId:user.id}}); if(!audit)return notFound();
 if(audit.status==='out_of_scope')return <main className="mx-auto max-w-4xl px-6 py-20"><h1 className="text-3xl font-semibold">Outside Aristotle's audit scope</h1><p className="mt-3 text-[#93a0b5]">{OUT_OF_SCOPE_MESSAGES.default} You have not been charged.</p></main>;
 // Never show a report unless this audit was paid AND generation finished.
 if(audit.status!=='completed'||audit.paymentStatus!=='paid'||audit.report==='{}'){
  const stale=audit.status==='generating'&&Date.now()-new Date(audit.updatedAt).getTime()>3*60*1000;
  const paid=audit.paymentStatus==='paid';
  const orderPending=!paid&&!!audit.paymentRef&&audit.paymentRef.startsWith('order_');
  const shell=(title:string,text:string,retry?:string)=><main className="mx-auto max-w-4xl px-6 py-20"><h1 className="text-3xl font-semibold">{title}</h1><p className="mt-3 text-[#93a0b5]">{text}</p>{retry&&<RetryAnalysis auditId={audit.id} label={retry}/>}</main>;
  if(paid&&(audit.status==='failed'||stale||audit.status==='completed'))return shell('Analysis not finished yet','Your payment was successful, but Aristotle could not complete the analysis yet.','Retry Analysis');
  if(paid)return shell('Audit processing','Aristotle is generating your analysis. This usually takes under a minute; refresh this page shortly.');
  if(orderPending)return shell('Waiting for payment confirmation','If you completed the ₹99 payment, Aristotle can check it with Razorpay and continue. You will not be charged again.','Check payment & continue');
  return shell('Audit not paid yet','This audit has not been paid for, so no report has been generated.');
 }
 const raw=JSON.parse(audit.report) as Partial<AuditReport>;
 // obj: safely spread a value as a plain object, fall back to {} if it isn't one
 const obj=(v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
 // arr: use the value only if it really is an array, otherwise use the fallback
 const arr=<T,>(v:unknown,fallback:T[])=>Array.isArray(v)?v as T[]:fallback;
 // num: use the value only if it is a finite number, otherwise use the fallback
 const num=(v:unknown,fallback:number)=>typeof v==='number'&&isFinite(v)?v:fallback;
 const [facts,scopeRec,research]=await Promise.all([getLockedFacts(audit.id),getScopeRecord(audit.id),getResearch(audit.id)]);
 const srcById=new Map((research?.sources||[]).map(x=>[x.id,x])); const scope=scopeRec?.confirmed?.scope;
 // NO template substitution: anything the audit did not produce is shown as "Not produced", never as
 // sector defaults or generic text.
 const NP='Not produced for this audit.';
 const txt=(v:unknown)=>typeof v==='string'&&v.trim()?v:NP;
 const strs=(v:unknown)=>arr<string>(v,[]).filter(x=>typeof x==='string');
 const rawBM=obj(raw.businessModel); const rawTB=obj(raw.technologyBuild); const rawKS=obj(raw.killOrScale); const rawC=obj(raw.customer); const rawMV=obj(raw.marketView);
 const r={
  ...raw,
  score:num(raw.score,NaN),
  executiveSummary:txt(raw.executiveSummary),
  verdict:txt(raw.verdict),
  oneLineVerdict:txt(raw.oneLineVerdict),
  whatThisBusinessIs:txt(raw.whatThisBusinessIs),
  whyItCouldWork:strs(raw.whyItCouldWork),
  whatMustBeTrue:strs(raw.whatMustBeTrue),
  customer:{icp:txt(rawC.icp),problem:txt(rawC.problem),willingnessToPay:txt(rawC.willingnessToPay)},
  businessModel:{revenueModel:txt(rawBM.revenueModel),pricingLogic:txt(rawBM.pricingLogic),keyCostDrivers:strs(rawBM.keyCostDrivers)},
  marketView:{marketType:txt(rawMV.marketType),demandSignal:txt(rawMV.demandSignal),competition:txt(rawMV.competition),marketRisk:txt(rawMV.marketRisk)},
  // Rows with non-numeric values are dropped, never back-filled.
  unitEconomics:arr<AuditReport['unitEconomics'][number]>(raw.unitEconomics,[]).filter(x=>x&&[x.conservative,x.base,x.upside].every(v=>typeof v==='number'&&isFinite(v))).map(x=>({...x,commentary:typeof x.commentary==='string'?x.commentary:'',assumption:typeof x.assumption==='string'?x.assumption:''})),
  experiments:arr<AuditReport['experiments'][number]>(raw.experiments,[]),
  operatingModel:strs(raw.operatingModel),
  technologyBuild:{mvp:strs(rawTB.mvp),avoidBuilding:strs(rawTB.avoidBuilding),estimatedBuildApproach:txt(rawTB.estimatedBuildApproach)},
  regulatory:arr<AuditReport['regulatory'][number]>(raw.regulatory,[]),
  vulnerabilities:arr<AuditReport['vulnerabilities'][number]>(raw.vulnerabilities,[]),
  goToMarket:strs(raw.goToMarket),
  thirtyDayPlan:arr<AuditReport['thirtyDayPlan'][number]>(raw.thirtyDayPlan,[]).map(x=>({...x,actions:strs(x?.actions)})),
  killOrScale:{scaleWhen:strs(rawKS.scaleWhen),pauseWhen:strs(rawKS.pauseWhen)},
  assumptions:strs(raw.assumptions),
  nextSteps:strs(raw.nextSteps),
 } as AuditReport;
 const unknownEconomics=arr<UnknownMetric>((raw as {unknownEconomics?:unknown}).unknownEconomics,[]);
 // Evidence layer: never fall back to template content for older reports that pre-date it.
 const memo=(raw.decisionMemo&&Array.isArray((raw.decisionMemo as DecisionMemo).criticalAssumptions))?raw.decisionMemo as DecisionMemo:undefined;
 const evidence:EvidenceClaim[]=Array.isArray(raw.evidence)?raw.evidence as EvidenceClaim[]:[];
 const evSum=evidenceSummary(evidence);
 const findingById=new Map((research?.findings||[]).map(f=>[f.id,f]));
 const cite=(ids:string[])=>ids.map(id=>{const fd=findingById.get(id);const src=srcById.get(fd?fd.sourceId:id);const f=facts.find(x=>x.id===id);return src?<a key={id} href={src.url} target="_blank" rel="noreferrer" className="mr-2 inline-flex items-center gap-1 text-xs text-[#77e2c1] underline" title={fd?`"${fd.quote}"`:src.title}>[{id}] {src.title.slice(0,48)}</a>:f?<span key={id} className="mr-2 text-xs text-[#77e2c1]">[{id}] founder figure</span>:null;});
 return <main className="mx-auto max-w-6xl px-6 py-10 pb-20">
  <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between"><div><div className="text-xs uppercase tracking-[.2em] text-[#77e2c1]">ARISTOTLE · FOUNDER DECISION MEMO · {audit.sector}{scope&&scope!=='OUT_OF_SCOPE'?<> · {SCOPE_LABEL[scope]}</>:null}</div><h1 className="mt-3 max-w-4xl text-4xl font-semibold tracking-tight md:text-5xl">{audit.idea}</h1><p className="mt-3 text-sm text-[#7f8da3]">Prepared {audit.createdAt.toLocaleString('en-IN')} · {audit.reportLanguage}</p></div><a href={`/api/audits/${audit.id}/export`} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#3a4657] px-4 py-3 font-medium hover:border-[#77e2c1]"><ArrowDownToLine size={17}/> Lock-and-Barrel Export</a></div>

  <section className="mt-8 rounded-3xl border border-[#263446] bg-[#0d121a] p-7 md:p-9"><div className="grid gap-8 md:grid-cols-[1.5fr_.5fr] md:items-center"><div><div className="text-xs font-semibold uppercase tracking-[.18em] text-[#77e2c1]">THE ANSWER IN 60 SECONDS</div><h2 className="mt-3 text-2xl font-semibold md:text-3xl">{r.oneLineVerdict}</h2><p className="mt-5 max-w-3xl text-[15px] leading-7 text-[#c2cad6]">{r.executiveSummary}</p></div><div className="rounded-2xl border border-[#2a394b] bg-[#0a0f16] p-5 text-center"><div className="text-xs uppercase tracking-wider text-[#7f8da3]">Screening signal</div><div className="mt-2 text-6xl font-semibold text-[#77e2c1]">{isFinite(r.score)?Math.round(r.score):'—'}<span className="text-2xl text-[#536176]">/100</span></div><div className="mt-2 text-xs leading-5 text-[#718096]">Not a prediction or recommendation. The decision depends on the evidence and assumptions below.</div></div></div></section>

  {memo&&<Section title="The decision">
   <p className="-mt-2 mb-5 text-[15px] text-[#c2cad6]">{memo.decisionQuestion}</p>
   <div className="text-xs font-semibold uppercase tracking-[.18em] text-[#77e2c1]">The {memo.criticalAssumptions.length} assumptions that decide this</div>
   <div className="mt-4 grid gap-3 md:grid-cols-3">{memo.criticalAssumptions.map((a,i)=><div key={i} className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-5">
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${STATUS_STYLE[a.evidenceStatus]||STATUS_STYLE.UNKNOWN}`}>{STATUS_LABEL[a.evidenceStatus]||'Unknown'}</span>
    <h3 className="mt-3 font-medium leading-6">{a.assumption}</h3>
    <p className="mt-2 text-sm leading-6 text-[#8e9bae]">{a.whyItMatters}</p>
    <p className="mt-3 text-sm leading-6 text-[#c0c8d5]"><strong>Evidence so far:</strong> {a.evidence}</p>
    {a.evidenceIds.length>0&&<div className="mt-2">{cite(a.evidenceIds)}</div>}
    {a.note&&<p className="mt-2 text-xs text-[#ffcf70]">{a.note}</p>}
    <p className="mt-3 text-sm leading-6 text-[#c0c8d5]"><strong>Cheapest test:</strong> {a.cheapestTest}{a.experimentIndex?` (Experiment ${a.experimentIndex})`:''}</p>
   </div>)}</div>
   <div className="mt-4 grid gap-4 md:grid-cols-3"><Mini title="Proceed if" items={memo.proceedIf}/><Mini title="Change the model if" items={memo.changeModelIf}/><Mini title="Evidence still required" items={memo.evidenceStillRequired}/></div>
  </Section>}
  <div className="mt-4 grid gap-4 md:grid-cols-3">
   <InfoCard icon={<Target size={18}/>} title="What this business is" text={r.whatThisBusinessIs}/>
   <InfoCard icon={<TrendingUp size={18}/>} title="Why it could work" items={r.whyItCouldWork}/>
   <InfoCard icon={<TriangleAlert size={18}/>} title="What must be true" items={r.whatMustBeTrue}/>
  </div>

  <Section title="1. Customer & problem"><div className="grid gap-4 md:grid-cols-3"><Mini title="Ideal customer" text={r.customer.icp}/><Mini title="Problem to prove" text={r.customer.problem}/><Mini title="Willingness to pay" text={r.customer.willingnessToPay}/></div></Section>
  <Section title="2. Business model & market"><div className="grid gap-4 md:grid-cols-2"><Mini title="Revenue model" text={r.businessModel.revenueModel}/><Mini title="Pricing logic" text={r.businessModel.pricingLogic}/><Mini title="Market view" text={r.marketView.marketType}/><Mini title="Competition" text={r.marketView.competition}/></div><div className="mt-4 rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><div className="text-xs uppercase tracking-wider text-[#718096]">Key cost drivers</div><ul className="mt-3 grid gap-2 md:grid-cols-2">{r.businessModel.keyCostDrivers.map(x=><li key={x} className="flex gap-2 text-sm text-[#c0c8d5]"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[#77e2c1]"/>{x}</li>)}</ul></div></Section>

  {facts.length>0&&<Section title="Founder figures (locked)"><p className="mb-4 text-sm text-[#7f8da3]">You confirmed these numbers before payment. Aristotle uses them exactly and never replaces them with estimates.</p><div className="grid gap-3 md:grid-cols-2">{facts.map(f=><div key={f.id} className="rounded-2xl border border-[#2c6b57] bg-[#0a0f16] p-4"><div className="text-xs uppercase tracking-wider text-[#77e2c1]">{f.id} · {TIMEFRAME_LABEL[f.timeframe]} · {CONCEPT_LABEL[f.concept]}</div><div className="mt-2 text-lg font-semibold">{formatFactValue(f)}</div>{(f.deadline||f.condition)&&<div className="mt-1 text-xs text-[#93a0b5]">{f.deadline?`By ${f.deadline}`:''}{f.condition?` ${f.condition}`:''}</div>}</div>)}</div></Section>}
  <Section title="3. Unit economics"><p className="mb-5 text-sm text-[#7f8da3]">Only numbers you stated, numbers found in research, or calculations from those. Aristotle does not fill gaps with industry averages.</p>{r.unitEconomics.length===0&&<p className="mb-4 rounded-xl border border-[#3a4657] p-4 text-sm text-[#c0c8d5]">No figure can be established yet from your numbers or from research.</p>}<div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-[#718096]"><tr><th className="pb-3">Metric</th><th className="pb-3">Conservative</th><th className="pb-3">Base</th><th className="pb-3">Upside</th><th className="pb-3">Read this as</th></tr></thead><tbody>{r.unitEconomics.map(x=><tr key={x.metric} className="border-t border-[#202938]"><td className="py-4 pr-4 font-medium">{x.metric}<div className="text-xs font-normal text-[#536176]">{x.unit}</div>{x.provenance&&<span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wider ${PROV_STYLE[x.provenance]||PROV_STYLE.ASSUMPTION}`}>{x.provenance.replace('_','-')}{x.factId?` · ${x.factId}`:''}</span>}</td><td className="py-4">{fmt(x,x.conservative)}</td><td className="py-4">{fmt(x,x.base)}</td><td className="py-4">{fmt(x,x.upside)}</td><td className="max-w-sm py-4 text-xs leading-5 text-[#8e9bae]">{x.commentary}{x.assumption&&<div className="mt-1 text-[#536176]">{x.assumption}</div>}</td></tr>)}</tbody></table></div>{unknownEconomics.length>0&&<div className="mt-5 rounded-2xl border border-[#3a4657] bg-[#0a0f16] p-5"><div className="text-xs uppercase tracking-wider text-[#93a0b5]">Not yet established</div><ul className="mt-3 space-y-3">{unknownEconomics.map(u=><li key={u.metric} className="text-sm leading-6 text-[#c0c8d5]"><strong>{u.metric}:</strong> {u.whyUnknown} <span className="text-[#8e9bae]">How to establish it: {u.howToEstablish}</span></li>)}</ul></div>}</Section>

  <Section title="4. How to build it"><div className="grid gap-4 md:grid-cols-3"><Mini title="MVP — build first" items={r.technologyBuild.mvp}/><Mini title="Do not build yet" items={r.technologyBuild.avoidBuilding}/><Mini title="Operating model" items={r.operatingModel}/></div><div className="mt-4 rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><div className="text-xs uppercase tracking-wider text-[#718096]">Build principle</div><p className="mt-2 text-sm leading-6 text-[#c0c8d5]">{r.technologyBuild.estimatedBuildApproach}</p></div></Section>

  <Section title="5. India regulatory radar">{r.regulatory.length===0&&<p className="mb-4 text-sm text-[#8e9bae]">No regulation could be confirmed from research for this business. Open regulatory questions are listed under "Evidence still required".</p>}<div className="grid gap-3 md:grid-cols-2">{r.regulatory.map(x=><div key={x.name} className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><div className="flex items-center justify-between"><div className="font-medium">{x.name}</div><span className="rounded-full border border-[#2d3b4c] px-2.5 py-1 text-xs text-[#77e2c1]">{x.status}</span></div><p className="mt-3 text-sm leading-6 text-[#a0adbf]">{x.rationale}</p>{(x.activity||x.trigger)&&<p className="mt-2 text-xs leading-5 text-[#8e9bae]"><strong>Activity:</strong> {x.activity||x.trigger}</p>}{x.requirement&&<p className="mt-1 text-xs leading-5 text-[#8e9bae]"><strong>Requirement:</strong> {x.requirement}</p>}{Array.isArray(x.sourceIds)&&x.sourceIds.length>0&&<div className="mt-1">{cite(x.sourceIds)}</div>}<p className="mt-3 text-sm leading-6 text-[#d1d7e0]"><strong>Do this:</strong> {x.action}</p>{x.source?<a className="mt-4 inline-flex items-center gap-1 text-xs text-[#77e2c1]" href={x.source} target="_blank" rel="noreferrer">Official source <ExternalLink size={12}/></a>:<span className="mt-4 inline-block text-xs text-[#718096]">No verified source — confirm with a professional.</span>}</div>)}</div></Section>

  <Section title="6. Vulnerability matrix"><div className="space-y-3">{r.vulnerabilities.map(x=><div key={x.risk} className="grid gap-4 rounded-2xl border border-[#202938] bg-[#0a0f16] p-5 md:grid-cols-[1.1fr_.35fr_1.6fr]"><div><div className="font-medium">{x.risk}</div><p className="mt-2 text-sm leading-6 text-[#8e9bae]">{x.whyItMatters}</p></div><div className="text-xs leading-6 text-[#ffcf70]">{x.probability} probability<br/>{x.impact} impact</div><div className="text-sm leading-6 text-[#c0c8d5]"><strong>Mitigation:</strong> {x.mitigation}</div></div>)}</div></Section>

  <Section title="7. Go-to-market"><ol className="grid gap-3 md:grid-cols-2">{r.goToMarket.map((x,i)=><li key={x} className="flex gap-4 rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><span className="text-sm font-semibold text-[#77e2c1]">0{i+1}</span><span className="text-sm leading-6 text-[#c0c8d5]">{x}</span></li>)}</ol></Section>

  <Section title="8. The first 30 days"><div className="grid gap-3 md:grid-cols-4">{r.thirtyDayPlan.map(x=><div key={x.week} className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><div className="text-xs font-semibold uppercase tracking-wider text-[#77e2c1]">{x.week}</div><h3 className="mt-3 font-medium">{x.objective}</h3><ul className="mt-4 space-y-2 text-sm leading-5 text-[#9aa7ba]">{x.actions.map(a=><li key={a}>• {a}</li>)}</ul><div className="mt-5 border-t border-[#202938] pt-3 text-xs leading-5 text-[#c0c8d5]"><strong>Success:</strong> {x.successMetric}</div></div>)}</div></Section>

  <div className="mt-4 grid gap-4 md:grid-cols-2"><Section title="Scale when"><ul className="space-y-3">{r.killOrScale.scaleWhen.map(x=><li key={x} className="flex gap-2 text-sm leading-6 text-[#c0c8d5]"><CheckCircle2 size={16} className="mt-1 shrink-0 text-[#77e2c1]"/>{x}</li>)}</ul></Section><Section title="Pause / rethink when"><ul className="space-y-3">{r.killOrScale.pauseWhen.map(x=><li key={x} className="flex gap-2 text-sm leading-6 text-[#c0c8d5]"><TriangleAlert size={16} className="mt-1 shrink-0 text-[#ffcf70]"/>{x}</li>)}</ul></Section></div>

  <Section title="9. Experiments to run">{r.experiments.length===0&&<p className="mb-4 text-sm text-[#718096]">Not produced for this audit.</p>}<p className="mb-5 text-sm text-[#7f8da3]">Low-cost tests to validate the most important assumptions before committing to heavy investment.</p><div className="space-y-4">{r.experiments.map((x,i)=><div key={x.hypothesis} className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><div className="flex items-center gap-2 mb-3"><Target size={15} className="shrink-0 text-[#77e2c1]"/><span className="text-xs font-semibold uppercase tracking-wider text-[#77e2c1]">Experiment {i+1}</span></div><div className="grid gap-3 md:grid-cols-[1fr_1fr]"><div><div className="text-xs uppercase tracking-wider text-[#718096] mb-1">Hypothesis</div><p className="text-sm leading-6 text-[#c0c8d5]">{x.hypothesis}</p></div><div><div className="text-xs uppercase tracking-wider text-[#718096] mb-1">Test</div><p className="text-sm leading-6 text-[#c0c8d5]">{x.test}</p></div><div><div className="text-xs uppercase tracking-wider text-[#718096] mb-1">Metric</div><p className="text-sm leading-6 text-[#c0c8d5]">{x.metric}</p></div><div className="grid grid-cols-2 gap-3"><div><div className="text-xs uppercase tracking-wider text-[#4caf7d] mb-1">Pass</div><p className="text-sm leading-6 text-[#c0c8d5]">{x.passThreshold}</p></div><div><div className="text-xs uppercase tracking-wider text-[#ffcf70] mb-1">Fail</div><p className="text-sm leading-6 text-[#c0c8d5]">{x.failThreshold}</p></div></div></div></div>)}</div></Section>

  {research?.version===2&&research.questions&&<Section title="What Aristotle researched"><p className="-mt-2 mb-4 text-sm text-[#7f8da3]">{research.businessModel?.summary}</p><p className="mb-5 text-sm text-[#7f8da3]">Before writing this memo Aristotle asked {research.questions.length} questions about your business and searched for evidence. A finding is kept only if its exact words appear in the source.</p>
   <div className="space-y-3">{research.questions.map(q=>{const fs=(research.findings||[]).filter(f=>f.questionId===q.id);return <div key={q.id} className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-4"><div className="flex flex-wrap items-center gap-2"><span className="text-xs text-[#718096]">{q.id}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${Q_STYLE[q.status]||Q_STYLE.NOT_FOUND}`}>{Q_LABEL[q.status]||q.status}</span><span className="text-[11px] uppercase tracking-wider text-[#536176]">{q.category.replace('_',' / ').toLowerCase()}</span></div><p className="mt-2 text-sm font-medium leading-6">{q.question}</p>{fs.length?<ul className="mt-2 space-y-2">{fs.map(f=><li key={f.id} className="text-sm leading-6 text-[#c0c8d5]">{f.statement} <span className="whitespace-nowrap">{cite([f.id])}</span></li>)}</ul>:<p className="mt-2 text-sm text-[#8e9bae]">No evidence found — this is an open question.</p>}</div>;})}</div>
  </Section>}
  {evidence.length>0&&<Section title="Evidence register"><p className="mb-4 text-sm text-[#7f8da3]">What this report relies on, and how solid each part is. Sources are checked by Aristotle: a claim is only marked as fact if it cites a real research source.</p>
   <div className="mb-5 flex flex-wrap gap-2">{(Object.entries(evSum) as [string,number][]).filter(([,n])=>n>0).map(([t,n])=><span key={t} className={`rounded-full border px-3 py-1 text-xs ${CLAIM_STYLE[t]}`}>{n} {CLAIM_LABEL[t]}</span>)}</div>
   <div className="space-y-3">{evidence.map((e,i)=><div key={i} className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-4"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${CLAIM_STYLE[e.type]}`}>{CLAIM_LABEL[e.type]}</span><span className="text-[11px] uppercase tracking-wider text-[#718096]">{e.confidence} confidence</span></div><p className="mt-2 text-sm leading-6 text-[#d1d7e0]">{e.claim}</p>{e.sourceIds.length>0&&<div className="mt-1">{cite(e.sourceIds)}</div>}{e.note&&<p className="mt-1 text-xs text-[#ffcf70]">{e.note}</p>}{e.validation&&<p className="mt-1 text-xs text-[#8e9bae]"><strong>How to check:</strong> {e.validation}</p>}</div>)}</div>
  </Section>}
  <div className="mt-4 grid gap-4 md:grid-cols-2"><Section title="Immediate next steps"><ul className="space-y-3">{r.nextSteps.map(x=><li key={x} className="flex gap-2 text-sm leading-6 text-[#c0c8d5]"><CheckCircle2 size={16} className="mt-1 shrink-0 text-[#77e2c1]"/>{x}</li>)}</ul></Section><Section title="Assumptions"><ul className="space-y-3">{r.assumptions.map(x=><li key={x} className="text-sm leading-6 text-[#8e9bae]">• {x}</li>)}</ul></Section></div>

  <div className="mt-6 grid gap-4 md:grid-cols-[1fr_.8fr]"><div className="rounded-2xl border border-[#6b4d17] bg-[#1a1408] p-5 text-sm leading-6 text-[#d6bd83]"><ShieldAlert size={18} className="mb-2"/>Regulatory screening is not legal or tax advice. Requirements can change and may depend on facts not captured by the intake.</div><div className="rounded-2xl border border-[#202938] bg-[#0d121a] p-5"><div className="text-xs uppercase tracking-wider text-[#718096]">Transparent build ledger</div><div className="mt-4 space-y-3 text-sm">{[['Audit fee','₹99.00'],['Base compute / tokens',`₹${(audit.computePaise/100).toFixed(2)}`],['Platform margin (10%)',`₹${(audit.marginPaise/100).toFixed(2)}`]].map(([a,b])=><div key={a} className="flex justify-between border-b border-[#202938] pb-3"><span className="text-[#7f8da3]">{a}</span><span>{b}</span></div>)}</div></div></div>
 </main>
}
function Section({title,children}:{title:string;children:React.ReactNode}){return <section className="mt-4 rounded-3xl border border-[#202938] bg-[#0d121a] p-7"><h2 className="text-2xl font-semibold">{title}</h2><div className="mt-5">{children}</div></section>}
function Mini({title,text,items}:{title:string;text?:string;items?:string[]}){return <div className="rounded-2xl border border-[#202938] bg-[#0a0f16] p-5"><div className="text-xs uppercase tracking-wider text-[#718096]">{title}</div>{text&&<p className="mt-3 text-sm leading-6 text-[#c0c8d5]">{text}</p>}{items&&(items.length?<ul className="mt-3 space-y-2 text-sm leading-6 text-[#c0c8d5]">{items.map(x=><li key={x}>• {x}</li>)}</ul>:<p className="mt-3 text-sm text-[#718096]">Not produced for this audit.</p>)}</div>}
function InfoCard({icon,title,text,items}:{icon:React.ReactNode;title:string;text?:string;items?:string[]}){return <div className="rounded-2xl border border-[#202938] bg-[#0d121a] p-5"><div className="flex items-center gap-2 text-[#77e2c1]">{icon}<span className="text-xs font-semibold uppercase tracking-wider">{title}</span></div>{text&&<p className="mt-3 text-sm leading-6 text-[#c0c8d5]">{text}</p>}{items&&(items.length?<ul className="mt-3 space-y-2 text-sm leading-6 text-[#c0c8d5]">{items.map(x=><li key={x}>• {x}</li>)}</ul>:<p className="mt-3 text-sm text-[#718096]">Not produced for this audit.</p>)}</div>}
