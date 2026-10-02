import type { Understanding } from '@/lib/hippo/types';

export function UnderstandingCard({ u }: { u: Understanding }) {
  const tiles: [string, string][] = [['Objective', u.objective], ['Target', u.target], ['Current state', u.currentState], ['Key question', u.keyQuestion]];
  return <div className="ht-card overflow-hidden">
    <div className="grid sm:grid-cols-2">{tiles.map(([k, v], i) => <div key={k} className={`p-5 sm:p-6 ${i % 2 === 0 ? 'sm:border-r' : ''} ${i < 2 ? 'border-b' : ''} border-[#E9E2D4] ${k === 'Key question' ? 'bg-[#0B1533] text-white' : ''}`}>
      <div className={`text-[11px] font-bold uppercase tracking-[.16em] ${k === 'Key question' ? 'text-[#FFB067]' : 'text-[#4F46E5]'}`}>{k}</div>
      <div className={`mt-2 leading-7 ${k === 'Target' ? 'text-xl font-extrabold' : 'text-[15px] font-semibold'} ${v === 'Not stated yet' ? 'italic text-[#8A6A3B]' : ''}`}>{v}</div>
    </div>)}</div>
    {u.source === 'FOUNDER_NUMBERS' && <div className="border-t border-[#E9E2D4] bg-[#FBF7EF] px-5 py-2 text-xs text-[#6B7389]">Restated from your own words and numbers (AI understanding was unavailable).</div>}
  </div>;
}
