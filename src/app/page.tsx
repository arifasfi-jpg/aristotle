import Link from 'next/link';
import { ArrowRight, Database, Download, IndianRupee, LockKeyhole, Radar, Scale, Sparkles } from 'lucide-react';

const cards = [
  ['01','Idea audit','Turn a rough idea into a structured venture brief with economics, risks and a launch path.'],
  ['02','India compliance radar','Screen GST, Udyam/MSME, BIS, DPDP and sector-specific obligations.'],
  ['03','Cost-plus build','See disclosed compute/token cost plus exactly 10% platform margin.'],
  ['04','No lock-in','Export your audit, data and project files whenever you want.']
];

export default function Home() {
  return <main>
    <section className="mx-auto max-w-6xl px-6 pb-20 pt-20 md:pt-28">
      <div className="max-w-4xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#2a3545] bg-[#0d121a] px-3 py-1.5 text-xs text-[#aab5c6]"><Sparkles size={14} className="text-[#77e2c1]"/> Built for non-technical founders in India</div>
        <h1 className="text-5xl font-semibold leading-[1.02] tracking-[-.04em] md:text-7xl">Pressure-test the idea.<br/><span className="text-[#77e2c1]">Own the output.</span></h1>
        <p className="mt-7 max-w-2xl text-lg leading-8 text-[#93a0b5]">Aristotle audits anything from a kirana quick-commerce brand to B2B SaaS, then shows the economics, regulatory surface and vulnerabilities before you spend serious money building it.</p>
        <div className="mt-9 flex flex-wrap gap-3"><Link href="/audit/new" className="inline-flex items-center gap-2 rounded-xl bg-[#77e2c1] px-5 py-3 font-semibold text-[#07110d]">Run my ₹99 audit <ArrowRight size={18}/></Link><a href="#how" className="rounded-xl border border-[#2a3545] px-5 py-3 font-medium text-white">See how it works</a></div>
      </div>
      <div className="mt-16 grid gap-3 md:grid-cols-4">{cards.map(([n,t,d])=><div key={n} className="rounded-2xl border border-[#202938] bg-[#0d121a] p-5"><div className="text-xs text-[#77e2c1]">{n}</div><h3 className="mt-10 font-medium">{t}</h3><p className="mt-2 text-sm leading-6 text-[#7f8da3]">{d}</p></div>)}</div>
    </section>
    <section id="how" className="border-y border-[#202938] bg-[#0a0e14]"><div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 md:grid-cols-2 md:items-center"><div><div className="text-sm font-medium text-[#77e2c1]">TRANSPARENT BY DESIGN</div><h2 className="mt-3 text-3xl font-semibold tracking-tight">The ₹99 audit is the product. Building is cost-plus.</h2><p className="mt-4 leading-7 text-[#93a0b5]">If Aristotle later uses AI or compute to build something for you, the report exposes the estimated base model cost, token usage and a flat 10% platform margin. No opaque “AI fee”.</p></div><div className="grid gap-3 sm:grid-cols-2">{[[IndianRupee,'₹99','one-time audit fee'],[Radar,'Audit','economics + risks'],[Scale,'10%','flat platform margin'],[Download,'Export','data + project files']].map(([Icon,b,c])=>{const I=Icon as any;return <div key={b as string} className="rounded-2xl border border-[#202938] bg-[#0d121a] p-5"><I size={19} className="text-[#77e2c1]"/><div className="mt-5 text-xl font-semibold">{b as string}</div><div className="mt-1 text-sm text-[#7f8da3]">{c as string}</div></div>})}</div></div></section>
    <section className="mx-auto max-w-6xl px-6 py-20"><div className="rounded-3xl border border-[#202938] bg-gradient-to-br from-[#101923] to-[#0b1017] p-8 md:p-12"><div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between"><div><div className="text-sm text-[#77e2c1]">LOCK-AND-BARREL EXPORT</div><h2 className="mt-3 max-w-2xl text-3xl font-semibold">Your startup data should never be held hostage.</h2><p className="mt-4 max-w-xl leading-7 text-[#93a0b5]">Download a portable bundle containing the audit JSON, assumptions, pricing ledger and every project file Aristotle has stored for you.</p></div><Link href="/audit/new" className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[#3a4657] px-5 py-3 font-medium hover:border-[#77e2c1]"><LockKeyhole size={17}/> Start with an audit</Link></div></div></section>
  </main>;
}
