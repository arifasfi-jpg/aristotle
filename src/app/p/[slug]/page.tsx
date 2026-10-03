import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import Markdown from '@/components/hippo/Markdown';

// The native public surface: one simple page per offer, hosted by Hippoturtle. Not a website builder. The founder's
// own visits are never counted; a draft is visible only to its owner (as a preview).
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

export default async function PublicPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams?: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const q = (await searchParams) ?? {};
  const page = await db.publicPage.findUnique({ where: { slug } });
  if (!page) notFound();
  const user = await getCurrentUser().catch(() => null);
  const owner = user ? (await db.organization.count({ where: { id: page.organizationId, founder: { userId: user.id } } })) > 0 : false;
  if (page.status !== 'PUBLISHED' && !owner) notFound();
  if (page.status === 'PUBLISHED' && !owner && !q.thanks) await db.publicPage.update({ where: { id: page.id }, data: { views: { increment: 1 } } });
  return <main className="min-h-screen bg-[#FBF7EF] px-4 py-10 text-[#0B1533]">
    <div className="mx-auto max-w-xl">
      {owner && <div className="mb-4 rounded-xl bg-[#FFF1DF] px-4 py-2 text-xs font-semibold text-[#9A4B00]">{page.status === 'PUBLISHED' ? 'Your live page — your own visits and test responses are not counted.' : 'Preview — only you can see this until you say yes.'}</div>}
      <h1 className="text-3xl font-extrabold leading-tight tracking-tight">{page.headline}</h1>
      {page.subhead && <p className="mt-2 text-lg leading-7 text-[#3A4359]">{page.subhead}</p>}
      <div className="mt-5 rounded-2xl border border-[#E9E2D4] bg-white p-5 text-[15px] leading-7"><Markdown>{page.body}</Markdown>{page.priceInr ? <p className="mt-3 font-bold">₹{page.priceInr.toLocaleString('en-IN')}</p> : null}</div>
      {q.thanks ? <div className="mt-5 rounded-2xl bg-[#E3F6EC] p-5 font-semibold text-[#14663D]">Thank you — you'll hear back soon.</div>
        : <form method="post" action={`/api/p/${encodeURIComponent(page.slug)}`} className="mt-5 space-y-3 rounded-2xl border border-[#E9E2D4] bg-white p-5">
          {q.error && <p className="text-sm font-semibold text-[#B42318]">{q.error}</p>}
          <label className="block text-sm font-semibold">Your name<input name="name" maxLength={100} className="mt-1 w-full rounded-xl border border-[#E1D8C6] px-3 py-2" /></label>
          <label className="block text-sm font-semibold">Email or phone<input name="contact" required maxLength={200} className="mt-1 w-full rounded-xl border border-[#E1D8C6] px-3 py-2" /></label>
          <label className="block text-sm font-semibold">Anything you'd like to say (optional)<textarea name="message" maxLength={1000} rows={3} className="mt-1 w-full rounded-xl border border-[#E1D8C6] px-3 py-2" /></label>
          <input name="website" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" />
          <button type="submit" className="w-full rounded-2xl bg-[#0B1533] px-5 py-3 font-bold text-white">{page.cta}</button>
          <p className="text-xs text-[#6B7389]">No payment is taken. Your details go only to the person behind this page.</p>
        </form>}
      <p className="mt-8 text-center text-xs text-[#A9A291]">Hosted by Hippoturtle</p>
    </div>
  </main>;
}
