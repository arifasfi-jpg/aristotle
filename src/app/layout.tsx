import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import './globals.css';

export const metadata: Metadata = { title: 'Aristotle — Venture Audit', description: 'Transparent venture screening and cost-plus building for Indian founders.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><header className="sticky top-0 z-50 border-b border-[#202938] bg-[#070a0f]/90 backdrop-blur"><div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4"><Link href="/" className="flex items-center gap-3 font-semibold tracking-tight"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#77e2c1] text-[#07110d]"><ShieldCheck size={20}/></span><span className="text-lg">Aristotle</span><span className="hidden rounded-full border border-[#2a3545] px-2 py-0.5 text-[10px] uppercase tracking-[.18em] text-[#93a0b5] sm:inline">venture OS</span></Link><nav className="flex items-center gap-5 text-sm text-[#93a0b5]"><Link className="hover:text-white" href="/history">Audit history</Link><Link className="rounded-lg bg-white px-4 py-2 font-medium text-black hover:bg-[#77e2c1]" href="/audit/new">Audit an idea · ₹99</Link></nav></div></header>{children}<footer className="border-t border-[#202938] py-10"><div className="mx-auto max-w-6xl px-6 text-xs text-[#718096]">Aristotle is a decision-support product, not a legal, tax, financial or investment adviser. Regulatory signals are screening prompts and should be independently verified before launch.</div></footer></body></html>;
}
