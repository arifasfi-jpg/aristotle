'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCw } from 'lucide-react';
import { btn } from './client';

/** Re-renders server data every few seconds while background work is running. */
export function AutoRefresh({ ms = 8000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => { const t = setInterval(() => router.refresh(), ms); return () => clearInterval(t); }, [ms, router]);
  return null;
}

/** Retries Aristotle via the existing verify route: never a second payment; research already done is reused. */
export function RetryAristotle({ auditId, label = 'RETRY' }: { auditId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function retry() {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/payments/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auditId }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { router.refresh(); return; }
      setMsg(r.status === 409 ? 'Aristotle is still working on this. Please wait a minute.' : j.error || 'Analysis could not be completed yet. Please retry in a minute.');
    } catch { setMsg('Network error. Please retry.'); }
    setBusy(false); router.refresh();
  }
  return <div>
    <button type="button" onClick={retry} disabled={busy} className={btn.accent}>{busy ? <><Loader2 size={16} className="animate-spin"/>Aristotle is working…</> : <><RotateCw size={16}/>{label}</>}</button>
    {msg && <p className="mt-2 text-sm text-[#A3271B]">{msg}</p>}
    <p className="mt-2 text-xs text-[#6B7389]">You will not be charged again. Research already completed is kept.</p>
  </div>;
}
