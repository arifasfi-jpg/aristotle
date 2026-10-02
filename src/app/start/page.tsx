import { Shell } from '@/components/hippo/ui';
import StartFlow from '@/components/hippo/StartFlow';
import { isDemoMode } from '@/lib/payments';
import { findPreviewDemoObjective } from '@/lib/hippo/preview';

export const dynamic = 'force-dynamic';
export default async function Start() {
  const demo = await findPreviewDemoObjective(); // null in Production (and when no paid demo objective exists)
  return <Shell active="start">
    <div className="mx-auto max-w-3xl">
      <div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#4F46E5]">Hippoturtle</div>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Tell me what you want to build.</h1>
      <p className="mt-3 leading-7 text-[#5B6478]">Write it the way you’d tell a co-founder. Include numbers if you have them — Hippoturtle will treat them as yours and never change them.</p>
      {demo && <form method="post" action="/api/hippo/preview/demo-objective" className="mt-6 flex flex-col gap-3 rounded-2xl border border-dashed border-[#D9670A] bg-[#FFF8EE] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm"><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#D9670A]">Preview test / demo only</div><div className="mt-1 font-semibold">Open the existing paid demo objective</div><div className="text-xs text-[#6B7389]">Signs this browser into the demo account. No new objective, audit or payment. Not available in Production.</div></div>
        <button type="submit" className="shrink-0 rounded-2xl bg-[#0B1533] px-5 py-3 text-sm font-bold text-white">Open Demo Objective</button>
      </form>}
      <div className="mt-8"><StartFlow demoCheckout={isDemoMode()} /></div>
    </div>
  </Shell>;
}
