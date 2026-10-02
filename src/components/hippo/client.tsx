'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCw } from 'lucide-react';

export async function post<T = Record<string, unknown>>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong. Please try again.') as Error & { status?: number; retryable?: boolean }; e.status = r.status; e.retryable = j.retryable; throw e; }
  return j as T;
}

export const btn = {
  primary: 'inline-flex items-center justify-center gap-2 rounded-2xl bg-[#0B1533] px-5 py-3 text-sm font-bold text-white hover:bg-[#1A2A6B] disabled:opacity-50',
  accent: 'inline-flex items-center justify-center gap-2 rounded-2xl bg-[#FF8A1F] px-5 py-3 text-sm font-bold text-[#0B1533] hover:bg-[#FF9C3F] disabled:opacity-50',
  ghost: 'inline-flex items-center justify-center gap-2 rounded-2xl border border-[#D9D0BF] bg-white px-5 py-3 text-sm font-semibold text-[#0B1533] hover:border-[#0B1533] disabled:opacity-50',
};

/** A button that POSTs, shows progress, refreshes server data on success, and offers RETRY on failure. */
export function ActionButton({ url, body, label, busyLabel, variant = 'primary', onDone, icon }: { url: string; body?: unknown; label: string; busyLabel?: string; variant?: keyof typeof btn; onDone?: (j: Record<string, unknown>) => void; icon?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function run() {
    setBusy(true); setErr('');
    try { const j = await post(url, body); onDone ? onDone(j) : router.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }
  return <div>
    <button type="button" onClick={run} disabled={busy} className={btn[variant]}>{busy ? <><Loader2 size={16} className="animate-spin"/>{busyLabel || 'Working…'}</> : <>{icon}{label}</>}</button>
    {err && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-[#FDE8E6] px-4 py-3 text-sm text-[#7A1D12]">{err}<button type="button" onClick={run} className="inline-flex items-center gap-1 font-bold underline"><RotateCw size={14}/>RETRY</button></div>}
  </div>;
}

export function ErrorNote({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  if (!msg) return null;
  return <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-[#FDE8E6] px-4 py-3 text-sm text-[#7A1D12]">{msg}{onRetry && <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-bold underline"><RotateCw size={14}/>RETRY</button>}</div>;
}
