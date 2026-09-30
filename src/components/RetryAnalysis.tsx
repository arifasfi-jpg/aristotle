'use client';
import { useState } from 'react';
import { Loader2, RotateCw } from 'lucide-react';

/**
 * Re-runs /api/payments/verify for this audit WITHOUT a new payment:
 *  - paid audit whose generation failed → generation is retried;
 *  - order created but the browser never reported back → the server asks Razorpay whether it was paid.
 */
export default function RetryAnalysis({ auditId, label = 'Retry Analysis' }: { auditId: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function retry() {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/payments/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auditId }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { window.location.reload(); return; }
      setMsg(r.status === 409 ? 'Aristotle is still working on this analysis. Please wait a minute and refresh.' : j.error || 'Aristotle could not complete the analysis yet. Please try again in a minute.');
    } catch { setMsg('Network error. Please try again.'); }
    setBusy(false);
  }
  return <div className="mt-6">
    <button type="button" onClick={retry} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-[#77e2c1] px-5 py-3 font-semibold text-[#07110d] disabled:opacity-60">{busy ? <><Loader2 className="animate-spin" size={17}/> Working…</> : <><RotateCw size={17}/> {label}</>}</button>
    {msg && <p className="mt-3 text-sm text-[#ffcf70]">{msg}</p>}
    <p className="mt-3 text-xs text-[#718096]">You will not be charged again.</p>
  </div>;
}
