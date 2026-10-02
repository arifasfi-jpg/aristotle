import { Shell } from '@/components/hippo/ui';
import StartFlow from '@/components/hippo/StartFlow';
import { isDemoMode } from '@/lib/payments';

export const dynamic = 'force-dynamic';
export default function Start() {
  return <Shell active="start">
    <div className="mx-auto max-w-3xl">
      <div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#4F46E5]">Hippoturtle</div>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Tell me what you want to build.</h1>
      <p className="mt-3 leading-7 text-[#5B6478]">Write it the way you’d tell a co-founder. Include numbers if you have them — Hippoturtle will treat them as yours and never change them.</p>
      <div className="mt-8"><StartFlow demoCheckout={isDemoMode()} /></div>
    </div>
  </Shell>;
}
