import Link from 'next/link';
import { TRUTH_LABEL, type TruthStatus } from '@/lib/hippo/types';
import { movesEnabled } from '@/lib/hippo/moves';

export function Logo({ light = false }: { light?: boolean }) {
  return <Link href="/" className="flex items-center gap-2.5">
    <span className="grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br from-[#FF8A1F] to-[#FFB067] text-[15px] font-extrabold text-[#0B1533] shadow-sm">H</span>
    <span className={`text-[17px] font-extrabold tracking-tight ${light ? 'text-white' : 'text-[#0B1533]'}`}>Hippoturtle</span>
  </Link>;
}

export function Shell({ children, active }: { children: React.ReactNode; active?: 'company' | 'memory' | 'start' }) {
  const nav = (href: string, label: string, key: string) => <Link href={href} className={`whitespace-nowrap rounded-full px-2.5 py-2 text-sm font-medium sm:px-3.5 ${active === key ? 'bg-[#0B1533] text-white' : 'text-[#3A4359] hover:bg-[#EFE8DA]'}`}>{label}</Link>;
  return <div className="min-h-screen">
    <header className="sticky top-0 z-40 border-b border-[#E9E2D4] bg-[#FBF7EF]/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Logo />
        {movesEnabled()
          ? <nav className="flex items-center gap-1">{nav('/start', 'Hippo', 'start')}{nav('/memory', 'Ledger', 'memory')}</nav>
          : <nav className="flex items-center gap-1">{nav('/company', 'My company', 'company')}{nav('/memory', 'Memory', 'memory')}<Link href="/start" className="ml-1 hidden rounded-full bg-[#FF8A1F] px-4 py-2 text-sm font-semibold text-[#0B1533] hover:bg-[#FF9C3F] sm:inline-flex">New objective</Link></nav>}
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    <Footer />
  </div>;
}

export function Footer() {
  return <footer className="border-t border-[#E9E2D4] py-8"><div className="mx-auto max-w-6xl px-4 text-xs leading-6 text-[#6B7389] sm:px-6">
    Hippoturtle is a company-building organisation, not a lawyer, chartered accountant, doctor or regulated financial adviser. Regulated work is prepared by AI and must be reviewed by a qualified professional where the law requires. Estimates are labelled as estimates; they are not market prices or quotes.
  </div></footer>;
}

export const inr = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}`);
export const inrRange = (lo: number, hi: number) => (lo < 10 || hi < 10 ? `${inr(lo, 2)}–${inr(hi, 2)}` : lo === hi ? inr(lo) : `${inr(lo)}–${inr(hi)}`);
export const when = (d: Date | string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const day = (d: Date | string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export function Eyebrow({ children, tone = 'indigo' }: { children: React.ReactNode; tone?: 'indigo' | 'saffron' | 'muted' }) {
  const c = { indigo: 'text-[#4F46E5]', saffron: 'text-[#D9670A]', muted: 'text-[#6B7389]' }[tone];
  return <div className={`text-[11px] font-bold uppercase tracking-[.16em] ${c}`}>{children}</div>;
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`ht-card p-5 sm:p-6 ${className}`}>{children}</div>;
}

const BADGE: Record<string, string> = {
  green: 'bg-[#E3F6EC] text-[#14663D]', amber: 'bg-[#FFF1DF] text-[#9A4B00]', red: 'bg-[#FDE8E6] text-[#A3271B]', blue: 'bg-[#E7EBFF] text-[#3730A3]', grey: 'bg-[#EFEBE2] text-[#4A5268]', navy: 'bg-[#0B1533] text-white',
};
export function Badge({ children, tone = 'grey' }: { children: React.ReactNode; tone?: keyof typeof BADGE }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${BADGE[tone]}`}>{children}</span>;
}

const TRUTH_TONE: Record<TruthStatus, keyof typeof BADGE> = { VERIFIED_FACT: 'green', FOUNDER_STATED: 'blue', ASSUMPTION: 'amber', HYPOTHESIS: 'amber', INFERENCE: 'grey', UNKNOWN: 'red', RECORD: 'navy' };
export function TruthBadge({ status }: { status: string }) {
  const s = (status in TRUTH_LABEL ? status : 'INFERENCE') as TruthStatus;
  return <Badge tone={TRUTH_TONE[s]}>{TRUTH_LABEL[s]}</Badge>;
}

const WORK_TONE: Record<string, keyof typeof BADGE> = { DRAFT: 'grey', READY: 'blue', AWAITING_DECISION: 'amber', APPROVED: 'blue', IN_PROGRESS: 'amber', WAITING_FOR_INPUT: 'amber', COMPLETED: 'green', CANCELLED: 'grey' };
export const WORK_LABEL: Record<string, string> = { DRAFT: 'Draft', READY: 'Ready for brief', AWAITING_DECISION: 'Awaiting your decision', APPROVED: 'Approved', IN_PROGRESS: 'Work in progress', WAITING_FOR_INPUT: 'Waiting for input', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
export function WorkStatus({ status }: { status: string }) { return <Badge tone={WORK_TONE[status] || 'grey'}>{WORK_LABEL[status] || status}</Badge>; }

export function NotYet({ children = 'Not yet established.' }: { children?: React.ReactNode }) {
  return <span className="italic text-[#8A6A3B]">{children}</span>;
}

export function List({ items, empty = 'Not produced for this analysis.' }: { items?: string[] | null; empty?: string }) {
  if (!items?.length) return <p className="text-sm"><NotYet>{empty}</NotYet></p>;
  return <ul className="space-y-1.5 text-sm leading-6 text-[#2A3248]">{items.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#FF8A1F]"/>{x}</li>)}</ul>;
}
