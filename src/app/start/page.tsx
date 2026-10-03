import { Shell } from '@/components/hippo/ui';
import StartFlow from '@/components/hippo/StartFlow';
import HippoChat from '@/components/hippo/HippoChat';
import { isDemoMode } from '@/lib/payments';
import { findPreviewDemoObjective } from '@/lib/hippo/preview';
import { getCurrentUser } from '@/lib/session';
import { viewConversation } from '@/lib/hippo/conversation-service';

export const dynamic = 'force-dynamic';
export default async function Start() {
  const demo = await findPreviewDemoObjective(); // null in Production (and when no paid demo objective exists)
  const user = await getCurrentUser();
  const conversation = await viewConversation(user?.id ?? null); // survives refresh and navigation
  return <Shell active="start">
    <div className="mx-auto max-w-3xl">
      <div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#4F46E5]">Hippoturtle</div>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">Talk to Hippo.</h1>
      <p className="mt-2 text-sm leading-6 text-[#5B6478]">Say it the way you’d tell a friend. Hippo asks what matters, keeps your numbers exactly as you said them, and only starts research when you say go.</p>
      <div className="mt-5"><HippoChat initial={conversation} demoCheckout={isDemoMode()} /></div>

      {/* Secondary testing paths (kept): the Preview demo objective and the classic objective form with the demo example. */}
      {demo && <form method="post" action="/api/hippo/preview/demo-objective" className="mt-8 flex flex-col gap-3 rounded-2xl border border-dashed border-[#D9670A] bg-[#FFF8EE] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm"><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#D9670A]">Preview test / demo only</div><div className="mt-1 font-semibold">Open the existing paid demo objective</div><div className="text-xs text-[#6B7389]">Signs this browser into the demo account. No new objective, audit or payment. Not available in Production.</div></div>
        <button type="submit" className="shrink-0 rounded-2xl bg-[#0B1533] px-5 py-3 text-sm font-bold text-white">Open Demo Objective</button>
      </form>}
      <details className="mt-6 rounded-2xl border border-[#E9E2D4] bg-white/60 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-[#3A4359]">Prefer a form? Use the classic objective form (includes the demo example)</summary>
        <div className="mt-4"><StartFlow demoCheckout={isDemoMode()} /></div>
      </details>
    </div>
  </Shell>;
}
