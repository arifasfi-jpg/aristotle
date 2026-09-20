'use client';
import { useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

const sectors = ['Quick Commerce','D2C / Consumer','B2B SaaS','Digital Agency','Fintech','Healthtech','Edtech','Marketplace','Manufacturing','Other'];
export default function AuditForm(){
 const [form,setForm]=useState({name:'',email:'',idea:'',sector:'B2B SaaS',stage:'Idea / pre-launch',geography:'India',language:'Simple English'}); const [busy,setBusy]=useState(false); const [err,setErr]=useState('');
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setErr('');try{
  const r=await fetch('/api/audits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});const j=await r.json();if(!r.ok)throw new Error(j.error||'Unable to create audit');
  const o=await fetch('/api/payments/create-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auditId:j.id})});const order=await o.json();if(!o.ok)throw new Error(order.error||'Unable to create payment');
  if(order.demo){await complete(j.id,{demo:true});return;}
  const script=await loadRazorpay();if(!script)throw new Error('Razorpay checkout could not load');
  const rz=new (window as any).Razorpay({key:order.keyId,amount:order.amount,currency:order.currency,name:'Aristotle',description:'Venture audit',order_id:order.orderId,handler:async (response:any)=>complete(j.id,response),prefill:{name:form.name,email:form.email},theme:{color:'#77e2c1'}});rz.open();
 }catch(e:any){setErr(e.message)}finally{setBusy(false)}}
 async function complete(auditId:string,payment:any){setBusy(true);const r=await fetch('/api/payments/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auditId,...payment})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Payment verification failed');window.location.href=`/audit/${auditId}`;}
 function loadRazorpay(){return new Promise<boolean>(resolve=>{if((window as any).Razorpay)return resolve(true);const s=document.createElement('script');s.src='https://checkout.razorpay.com/v1/checkout.js';s.onload=()=>resolve(true);s.onerror=()=>resolve(false);document.body.appendChild(s)})}

 return <form onSubmit={submit} className="space-y-6">
  <div className="grid gap-5 md:grid-cols-2"><Field label="Founder name" value={form.name} onChange={v=>setForm({...form,name:v})} placeholder="Your name"/><Field label="Email" type="email" value={form.email} onChange={v=>setForm({...form,email:v})} placeholder="you@company.com"/></div>
  <div><label className="mb-2 block text-sm font-medium">What are you building?</label><textarea required minLength={20} value={form.idea} onChange={e=>setForm({...form,idea:e.target.value})} rows={7} placeholder="Example: A WhatsApp-first platform that lets neighbourhood kirana stores accept repeat orders, reconcile UPI payments and offer local delivery." className="w-full rounded-2xl border border-[#293445] bg-[#0b1017] px-4 py-4 outline-none placeholder:text-[#536176] focus:border-[#77e2c1]"/></div>
  <div className="grid gap-5 md:grid-cols-4"><Select label="Sector" value={form.sector} options={sectors} onChange={v=>setForm({...form,sector:v})}/><Select label="Stage" value={form.stage} options={['Idea / pre-launch','Pilot','Early revenue','Scaling']} onChange={v=>setForm({...form,stage:v})}/><Field label="Primary geography" value={form.geography} onChange={v=>setForm({...form,geography:v})} placeholder="India"/><Select label="Report language" value={form.language} options={['Simple English','Hinglish']} onChange={v=>setForm({...form,language:v})}/></div>
  {err&&<div className="rounded-xl border border-red-900/60 bg-red-950/20 p-3 text-sm text-red-300">{err}</div>}
  <div className="flex flex-col gap-4 rounded-2xl border border-[#202938] bg-[#0b1017] p-5 md:flex-row md:items-center md:justify-between"><div><div className="font-medium">Instant venture audit</div><div className="mt-1 text-sm text-[#7f8da3]">₹99 one-time · no subscription · export anytime</div></div><button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#77e2c1] px-5 py-3 font-semibold text-[#07110d] disabled:opacity-60">{busy?<><Loader2 className="animate-spin" size={17}/> Auditing…</>:<>Pay ₹99 & audit <ArrowRight size={17}/></>}</button></div>
 </form>
}
function Field({label,value,onChange,placeholder,type='text'}:{label:string;value:string;onChange:(v:string)=>void;placeholder:string;type?:string}){return <div><label className="mb-2 block text-sm font-medium">{label}</label><input required value={value} type={type} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-[#293445] bg-[#0b1017] px-4 py-3 outline-none placeholder:text-[#536176] focus:border-[#77e2c1]"/></div>}
function Select({label,value,options,onChange}:{label:string;value:string;options:string[];onChange:(v:string)=>void}){return <div><label className="mb-2 block text-sm font-medium">{label}</label><select value={value} onChange={e=>onChange(e.target.value)} className="w-full rounded-xl border border-[#293445] bg-[#0b1017] px-4 py-3 outline-none focus:border-[#77e2c1]">{options.map(o=><option key={o}>{o}</option>)}</select></div>}
