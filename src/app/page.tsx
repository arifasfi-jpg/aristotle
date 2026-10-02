import Link from 'next/link';
import { ArrowRight, BadgeCheck, Brain, Building2, FileText, Handshake, Microscope, Route, Scale, Sparkles, UserCheck, Workflow } from 'lucide-react';
import { Footer, Logo } from '@/components/hippo/ui';
import { enabledCapabilities } from '@/lib/hippo/capabilities';

const LOOP = [
  { icon: Sparkles, t: 'Tell us the objective', d: '“I want to build this” or “I want to reach that.” One conversation, not fourteen tools.' },
  { icon: Microscope, t: 'Test it with evidence', d: 'Aristotle researches your business before it concludes anything. Every claim is sourced, assumed, or marked unknown.' },
  { icon: Route, t: 'See how to actually get there', d: 'Several real pathways to your full ambition — never a smaller target without evidence.' },
  { icon: Workflow, t: 'Turn it into work', d: 'Mogli, your chief of staff, converts the plan into work packages with precise briefs.' },
  { icon: Scale, t: 'Know what it should cost', d: 'AI, human or hybrid — with the estimate, the assumptions and the margin shown.' },
  { icon: Brain, t: 'Remember everything', d: 'Decisions, costs, quotes and outcomes become your company’s memory.' },
];

export default function Home() {
  const caps = enabledCapabilities();
  return <div>
    <section className="ht-hero text-white">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex items-center justify-between py-5"><Logo light /><nav className="flex items-center gap-2 text-sm"><Link href="/company" className="rounded-full px-3.5 py-2 text-white/80 hover:bg-white/10">My company</Link><Link href="/start" className="rounded-full bg-white px-4 py-2 font-semibold text-[#0B1533]">Start</Link></nav></div>
        <div className="max-w-4xl pb-20 pt-14 sm:pb-28 sm:pt-20">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/80"><Building2 size={14} className="text-[#FFB067]"/> An organisation in your pocket</div>
          <h1 className="mt-6 text-[44px] font-extrabold leading-[1.02] tracking-[-.035em] sm:text-7xl">Build your company.<br/><span className="ht-grad-text">Without building a huge team.</span></h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/75">Think of an idea. Test it with evidence. Turn it into a plan. Get the work done with AI, humans, or both.</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/start" className="inline-flex items-center gap-2 rounded-2xl bg-[#FF8A1F] px-6 py-3.5 font-bold tracking-wide text-[#0B1533] shadow-lg shadow-orange-500/20 hover:bg-[#FF9C3F]">START WITH AN IDEA <ArrowRight size={18}/></Link>
            <a href="#how" className="rounded-2xl border border-white/20 px-6 py-3.5 font-semibold tracking-wide text-white hover:bg-white/10">SEE HOW IT WORKS</a>
          </div>
          <p className="mt-6 text-sm text-white/55">Evidence-based analysis ₹99 · Execution pay-as-you-go · No subscription</p>
        </div>
      </div>
    </section>

    <section id="how" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="max-w-2xl"><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#4F46E5]">How it works</div><h2 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">You bring the ambition. Hippoturtle brings the organisation.</h2><p className="mt-4 leading-7 text-[#5B6478]">You never pick tools or agents. You state an objective; Hippoturtle works out what has to happen, who or what should do it, what it should cost — and you decide.</p></div>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{LOOP.map(({ icon: I, t, d }, i) => <div key={t} className="ht-card p-6"><div className="flex items-center justify-between"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#EEF0FF] text-[#4F46E5]"><I size={19}/></span><span className="text-xs font-bold text-[#C9BFAE]">0{i + 1}</span></div><h3 className="mt-5 font-bold">{t}</h3><p className="mt-2 text-sm leading-6 text-[#5B6478]">{d}</p></div>)}</div>
    </section>

    <section className="border-y border-[#E9E2D4] bg-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.2fr] lg:items-center">
        <div><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#D9670A]">One organisation</div><h2 className="mt-3 text-3xl font-extrabold tracking-tight">AI where AI is best. Humans where humans are better. Professionals where the law requires.</h2><p className="mt-4 leading-7 text-[#5B6478]">Behind one interface, Hippoturtle runs capabilities like a company runs departments. You always keep the final decision.</p>
          <div className="mt-6 space-y-3 text-sm">{[[Sparkles, 'AI executes', 'Landing pages, GTM plans, outreach scripts, pricing tests.'], [UserCheck, 'Humans review', 'Brand, sales calls, creative judgement — when you want it.'], [BadgeCheck, 'Professionals sign', 'Legal agreements, GST filing, compliance — AI prepares, a qualified professional approves.']].map(([I, t, d]) => { const Icon = I as typeof Sparkles; return <div key={t as string} className="flex gap-3"><Icon size={18} className="mt-0.5 shrink-0 text-[#4F46E5]"/><div><span className="font-semibold">{t as string}.</span> <span className="text-[#5B6478]">{d as string}</span></div></div>; })}</div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{caps.map((c) => <div key={c.id} className="rounded-2xl border border-[#E9E2D4] bg-[#FBF7EF] p-4"><div className="text-sm font-bold">{c.label}</div><div className="mt-1 text-xs leading-5 text-[#6B7389]">{c.description}</div>{c.requiresProfessional && <div className="mt-2 text-[10px] font-bold uppercase tracking-wider text-[#D9670A]">Professional sign-off</div>}</div>)}</div>
      </div>
    </section>

    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="ht-card p-7"><FileText className="text-[#4F46E5]" size={22}/><h3 className="mt-4 text-lg font-bold">Evidence over confidence</h3><p className="mt-2 text-sm leading-6 text-[#5B6478]">Every important claim carries a source, a date and a confidence — or it says “Not yet established.” No invented statistics.</p></div>
        <div className="ht-card p-7"><Handshake className="text-[#4F46E5]" size={22}/><h3 className="mt-4 text-lg font-bold">An honest broker</h3><p className="mt-2 text-sm leading-6 text-[#5B6478]">Every external quote is compared with Hippoturtle’s own estimate, and we explain why it differs. We never steer you for commission.</p></div>
        <div className="ht-card p-7"><Scale className="text-[#4F46E5]" size={22}/><h3 className="mt-4 text-lg font-bold">Economics in the open</h3><p className="mt-2 text-sm leading-6 text-[#5B6478]">AI cost, human effort and our 10% platform margin are shown. Estimates are labelled as estimates.</p></div>
      </div>
      <div className="mt-10 overflow-hidden rounded-[28px] ht-hero p-8 text-white sm:p-12"><div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between"><div><h2 className="max-w-xl text-3xl font-extrabold tracking-tight">What are you trying to build or achieve?</h2><p className="mt-3 max-w-xl text-white/70">Start with one sentence. Hippoturtle will take it from there.</p></div><Link href="/start" className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-[#FF8A1F] px-6 py-3.5 font-bold text-[#0B1533]">START WITH AN IDEA <ArrowRight size={18}/></Link></div></div>
    </section>
    <Footer />
  </div>;
}
