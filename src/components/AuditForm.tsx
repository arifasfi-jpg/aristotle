'use client';
import { useState } from 'react';
import { ArrowRight, Loader2, Trash2 } from 'lucide-react';

const sectors = ['Quick Commerce','D2C / Consumer','B2B SaaS','Digital Agency','Fintech','Healthtech','Edtech','Marketplace','Manufacturing','Other'];

type Scope = 'NEW_IDEA' | 'GROWTH_PLAN' | 'OUT_OF_SCOPE';
type Fact = { id: string; concept: string; timeframe: string; value?: number; low?: number; high?: number; unit: string; period?: string; condition?: string; deadline?: string; text?: string; raw: string; context: string };
type ScopeView = { suggestion: Scope; reasons: string[]; outOfScopeMessage?: string; facts: Fact[]; notes: string[]; classifier?: { scope?: Scope; confidence?: number; confident?: boolean; error?: string } };

const SCOPE_NAME: Record<Scope, string> = { NEW_IDEA: 'a New Business / Idea', GROWTH_PLAN: 'an Existing Business / Growth Plan', OUT_OF_SCOPE: 'outside Aristotle’s audit scope' };
const CONCEPTS: [string, string][] = [['selling_price','Selling price'],['unit_cost','Unit cost'],['margin','Margin'],['volume','Volume'],['revenue','Revenue'],['customers','Customers'],['order_quantity','Units per order'],['aov','Average order value'],['marketing_budget','Marketing budget'],['shipping','Shipping'],['channel','Sales channel'],['start_year','Operating since'],['other','Other']];
const TIMEFRAMES: [string, string][] = [['CURRENT','Current'],['TARGET','Target'],['PROPOSED','Proposed / estimate'],['HISTORICAL','Historical'],['CONDITIONAL','Conditional']];

export default function AuditForm(){
 const [form,setForm]=useState({name:'',email:'',idea:'',sector:'B2B SaaS',stage:'Idea / pre-launch',geography:'India',language:'Simple English'}); const [busy,setBusy]=useState(false); const [err,setErr]=useState('');
 const [auditId,setAuditId]=useState<string|null>(null); const [view,setView]=useState<ScopeView|null>(null);
 const [choice,setChoice]=useState<Scope|'NOT_SURE'|null>(null); const [override,setOverride]=useState(false);
 const [facts,setFacts]=useState<Fact[]>([]); const [factsOk,setFactsOk]=useState(false); const [done,setDone]=useState('');

 const post=async(url:string,body:unknown)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||'Something went wrong');return j;};

 // Step 1: create the audit and get Aristotle's suggestion (no payment, no AI).
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setErr('');try{
  const j=await post('/api/audits',form);setAuditId(j.id);
  const v:ScopeView=await post(`/api/audits/${j.id}/scope`,{action:'suggest'});
  setView(v);setFacts(v.facts);setFactsOk(false);setChoice(null);setOverride(false);
 }catch(e:any){setErr(e.message)}finally{setBusy(false)}}

 // "Not sure": Gemini may classify once; the founder still has to confirm.
 async function notSure(){if(!auditId)return;setBusy(true);setErr('');setChoice('NOT_SURE');try{const v:ScopeView=await post(`/api/audits/${auditId}/scope`,{action:'classify'});setView(v);}catch(e:any){setErr(e.message)}finally{setBusy(false)}}

 // Step 2: founder confirms the scope (+ reviewed numbers) → payment.
 async function confirmAndPay(scope:Scope){if(!auditId||!view)return;setBusy(true);setErr('');try{
  const needsReview=scope!=='OUT_OF_SCOPE'&&view.facts.length>0;
  if(needsReview&&!factsOk)throw new Error('Please review the numbers and tick “These numbers are correct”.');
  const res=await post(`/api/audits/${auditId}/scope`,{action:'confirm',scope,facts:scope==='OUT_OF_SCOPE'?[]:facts,factsReviewed:needsReview?factsOk:false});
  if(!res.confirmed?.payable){setDone(view.outOfScopeMessage||'This request is outside Aristotle’s audit scope. You have not been charged.');return;}
  await pay(auditId);
 }catch(e:any){setErr(e.message)}finally{setBusy(false)}}

 async function pay(id:string){
  const order=await post('/api/payments/create-order',{auditId:id});
  if(order.demo){await complete(id,{demo:true});return;}
  const script=await loadRazorpay();if(!script)throw new Error('Razorpay checkout could not load');
  const rz=new (window as any).Razorpay({key:order.keyId,amount:order.amount,currency:order.currency,name:'Aristotle',description:'Venture audit',order_id:order.orderId,handler:async (response:any)=>complete(id,response),prefill:{name:form.name,email:form.email},theme:{color:'#77e2c1'}});rz.open();
 }
 async function complete(id:string,payment:any){setBusy(true);
  const r=await fetch('/api/payments/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auditId:id,...payment})});
  // Paid but generation failed / still running → the audit page shows status and a Retry button (no second payment).
  if(r.ok||r.status===502||r.status===409||r.status===500){window.location.href=`/audit/${id}`;return;}
  const j=await r.json().catch(()=>({}));setErr(j.error||'Payment verification failed');setBusy(false);}
 function loadRazorpay(){return new Promise<boolean>(resolve=>{if((window as any).Razorpay)return resolve(true);const s=document.createElement('script');s.src='https://checkout.razorpay.com/v1/checkout.js';s.onload=()=>resolve(true);s.onerror=()=>resolve(false);document.body.appendChild(s)})}
 const setFact=(i:number,patch:Partial<Fact>)=>{setFactsOk(false);setFacts(fs=>fs.map((f,j)=>j===i?{...f,...patch}:f));};

 if(done)return <div className="rounded-2xl border border-[#293445] bg-[#0b1017] p-6 text-sm leading-6 text-[#b6c0cf]">{done}</div>;

 // ---------------- Confirmation step ----------------
 if(view&&auditId){
  const cls=view.classifier; const aiScope=cls?.scope;
  const showOos=view.suggestion==='OUT_OF_SCOPE'&&!override;
  const suggested:Scope|null=choice==='NOT_SURE'?(aiScope&&cls?.confident?aiScope:null):view.suggestion==='OUT_OF_SCOPE'?null:view.suggestion;
  const other=(s:Scope):Scope=>s==='NEW_IDEA'?'GROWTH_PLAN':'NEW_IDEA';
  const needsReview=view.facts.length>0;
  return <div className="space-y-6">
   {showOos?<div className="rounded-2xl border border-[#6b4d17] bg-[#1a1408] p-5">
     <div className="font-medium text-[#ffcf70]">This appears to be outside Aristotle&apos;s standard audit scope.</div>
     {view.outOfScopeMessage&&<p className="mt-2 text-sm text-[#d6bd83]">{view.outOfScopeMessage}</p>}
     <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={()=>confirmAndPay('OUT_OF_SCOPE')} className="rounded-xl border border-[#3a4657] px-4 py-2 text-sm">OK, no audit needed</button><button type="button" disabled={busy} onClick={()=>setOverride(true)} className="rounded-xl bg-[#77e2c1] px-4 py-2 text-sm font-semibold text-[#07110d]">This is actually my business → Continue</button></div>
    </div>:<>
    <div className="rounded-2xl border border-[#293445] bg-[#0b1017] p-5">
     <div className="font-medium">What are you asking Aristotle to analyse?</div>
     {suggested&&<div className="mt-3 rounded-xl border border-[#2c6b57] bg-[#0d1a16] p-3 text-sm text-[#b6f0dc]">Aristotle thinks this is {SCOPE_NAME[suggested]}. You decide.</div>}
     {choice==='NOT_SURE'&&cls&&!(aiScope&&cls.confident)&&<div className="mt-3 rounded-xl border border-[#3a4657] p-3 text-sm text-[#b6c0cf]">{cls.error||'Aristotle is not confident enough to decide. Please choose the option that fits.'}</div>}
     <div className="mt-4 grid gap-3 md:grid-cols-3">
      <ScopeOption active={choice==='NEW_IDEA'} onClick={()=>setChoice('NEW_IDEA')} title="New business / idea" desc="I am planning to start this business or launch this product."/>
      <ScopeOption active={choice==='GROWTH_PLAN'} onClick={()=>setChoice('GROWTH_PLAN')} title="Existing business / growth" desc="This business is already operating and I want to grow, scale or improve it."/>
      <ScopeOption active={choice==='NOT_SURE'} onClick={notSure} title="Not sure" desc="Let Aristotle suggest. You still confirm."/>
     </div>
     {suggested&&choice!=='NEW_IDEA'&&choice!=='GROWTH_PLAN'&&<div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={()=>setChoice(suggested)} className="rounded-xl bg-[#77e2c1] px-4 py-2 text-sm font-semibold text-[#07110d]">Yes, continue</button><button type="button" disabled={busy} onClick={()=>setChoice(other(suggested))} className="rounded-xl border border-[#3a4657] px-4 py-2 text-sm">No, this is {SCOPE_NAME[other(suggested)]}</button></div>}
    </div>
    {needsReview&&<div className="rounded-2xl border border-[#293445] bg-[#0b1017] p-5">
     <div className="font-medium">Numbers Aristotle will treat as fixed facts</div>
     <p className="mt-1 text-sm text-[#7f8da3]">Check what each number is. Once you confirm, Aristotle uses them exactly and never replaces them with estimates.</p>
     {view.notes.length>0&&<ul className="mt-3 space-y-1 text-xs text-[#ffcf70]">{view.notes.map(n=><li key={n}>• {n}</li>)}</ul>}
     <div className="mt-4 space-y-3">{facts.map((f,i)=><div key={f.id} className="grid gap-2 rounded-xl border border-[#202938] p-3 md:grid-cols-[1.1fr_1fr_1fr_.9fr_auto] md:items-center">
      <div className="text-xs text-[#93a0b5]">You wrote: <span className="text-[#c0c8d5]">“{f.raw}”</span></div>
      <select aria-label="What is this number" value={f.concept} onChange={e=>setFact(i,{concept:e.target.value})} className="rounded-lg border border-[#293445] bg-[#0b1017] px-2 py-2 text-sm">{CONCEPTS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      <select aria-label="Timeframe" value={f.timeframe} onChange={e=>setFact(i,{timeframe:e.target.value})} className="rounded-lg border border-[#293445] bg-[#0b1017] px-2 py-2 text-sm">{TIMEFRAMES.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      {f.low!==undefined&&f.high!==undefined?<div className="flex gap-1"><input aria-label="Low" value={f.low} onChange={e=>setFact(i,{low:Number(e.target.value)})} className="w-full rounded-lg border border-[#293445] bg-[#0b1017] px-2 py-2 text-sm"/><input aria-label="High" value={f.high} onChange={e=>setFact(i,{high:Number(e.target.value)})} className="w-full rounded-lg border border-[#293445] bg-[#0b1017] px-2 py-2 text-sm"/></div>
       :f.value!==undefined?<input aria-label="Value" value={f.value} onChange={e=>setFact(i,{value:Number(e.target.value)})} className="rounded-lg border border-[#293445] bg-[#0b1017] px-2 py-2 text-sm"/>
       :<input aria-label="Details" value={f.text||''} onChange={e=>setFact(i,{text:e.target.value})} className="rounded-lg border border-[#293445] bg-[#0b1017] px-2 py-2 text-sm"/>}
      <button type="button" aria-label="Remove this number" onClick={()=>{setFactsOk(false);setFacts(fs=>fs.filter((_,j)=>j!==i));}} className="justify-self-end rounded-lg border border-[#3a4657] p-2 text-[#93a0b5]"><Trash2 size={15}/></button>
      <div className="text-xs text-[#536176] md:col-span-5">{f.unit}{f.deadline?` · by ${f.deadline}`:''}{f.condition?` · ${f.condition}`:''}</div>
     </div>)}</div>
     <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={factsOk} onChange={e=>setFactsOk(e.target.checked)}/> These numbers are correct</label>
    </div>}
   </>}
   {err&&<div className="rounded-xl border border-red-900/60 bg-red-950/20 p-3 text-sm text-red-300">{err}</div>}
   {!showOos&&<div className="flex flex-col gap-4 rounded-2xl border border-[#202938] bg-[#0b1017] p-5 md:flex-row md:items-center md:justify-between"><div><div className="font-medium">{choice==='GROWTH_PLAN'?'Growth plan for your existing business':'Instant venture audit'}</div><div className="mt-1 text-sm text-[#7f8da3]">₹99 one-time · no subscription · export anytime</div></div><button type="button" disabled={busy||(choice!=='NEW_IDEA'&&choice!=='GROWTH_PLAN')||(needsReview&&!factsOk)} onClick={()=>(choice==='NEW_IDEA'||choice==='GROWTH_PLAN')&&confirmAndPay(choice)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#77e2c1] px-5 py-3 font-semibold text-[#07110d] disabled:opacity-60">{busy?<><Loader2 className="animate-spin" size={17}/> Working…</>:<>Confirm &amp; pay ₹99 <ArrowRight size={17}/></>}</button></div>}
  </div>;
 }

 // ---------------- Intake step (unchanged fields) ----------------
 return <form onSubmit={submit} className="space-y-6">
  <div className="grid gap-5 md:grid-cols-2"><Field label="Founder name" value={form.name} onChange={v=>setForm({...form,name:v})} placeholder="Your name"/><Field label="Email" type="email" value={form.email} onChange={v=>setForm({...form,email:v})} placeholder="you@company.com"/></div>
  <div><label className="mb-2 block text-sm font-medium">What are you building?</label><textarea required minLength={20} value={form.idea} onChange={e=>setForm({...form,idea:e.target.value})} rows={7} placeholder="Example: A WhatsApp-first platform that lets neighbourhood kirana stores accept repeat orders, reconcile UPI payments and offer local delivery." className="w-full rounded-2xl border border-[#293445] bg-[#0b1017] px-4 py-4 outline-none placeholder:text-[#536176] focus:border-[#77e2c1]"/></div>
  <div className="grid gap-5 md:grid-cols-4"><Select label="Sector" value={form.sector} options={sectors} onChange={v=>setForm({...form,sector:v})}/><Select label="Stage" value={form.stage} options={['Idea / pre-launch','Pilot','Early revenue','Scaling']} onChange={v=>setForm({...form,stage:v})}/><Field label="Primary geography" value={form.geography} onChange={v=>setForm({...form,geography:v})} placeholder="India"/><Select label="Report language" value={form.language} options={['Simple English','Hinglish']} onChange={v=>setForm({...form,language:v})}/></div>
  {err&&<div className="rounded-xl border border-red-900/60 bg-red-950/20 p-3 text-sm text-red-300">{err}</div>}
  <div className="flex flex-col gap-4 rounded-2xl border border-[#202938] bg-[#0b1017] p-5 md:flex-row md:items-center md:justify-between"><div><div className="font-medium">Instant venture audit</div><div className="mt-1 text-sm text-[#7f8da3]">₹99 one-time · no subscription · export anytime</div></div><button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#77e2c1] px-5 py-3 font-semibold text-[#07110d] disabled:opacity-60">{busy?<><Loader2 className="animate-spin" size={17}/> Checking…</>:<>Continue <ArrowRight size={17}/></>}</button></div>
 </form>
}
function ScopeOption({active,onClick,title,desc}:{active:boolean;onClick:()=>void;title:string;desc:string}){return <button type="button" onClick={onClick} className={`rounded-xl border p-4 text-left ${active?'border-[#77e2c1] bg-[#0d1a16]':'border-[#293445]'}`}><div className="font-medium">{title}</div><div className="mt-1 text-xs leading-5 text-[#93a0b5]">{desc}</div></button>}
function Field({label,value,onChange,placeholder,type='text'}:{label:string;value:string;onChange:(v:string)=>void;placeholder:string;type?:string}){return <div><label className="mb-2 block text-sm font-medium">{label}</label><input required value={value} type={type} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-[#293445] bg-[#0b1017] px-4 py-3 outline-none placeholder:text-[#536176] focus:border-[#77e2c1]"/></div>}
function Select({label,value,options,onChange}:{label:string;value:string;options:string[];onChange:(v:string)=>void}){return <div><label className="mb-2 block text-sm font-medium">{label}</label><select value={value} onChange={e=>onChange(e.target.value)} className="w-full rounded-xl border border-[#293445] bg-[#0b1017] px-4 py-3 outline-none focus:border-[#77e2c1]">{options.map(o=><option key={o}>{o}</option>)}</select></div>}
