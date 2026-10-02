import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { routeCapability } from '@/lib/hippo/capabilities';
import { classifyWork } from '@/lib/hippo/work-classification';
import { stageIndex, STAGES } from '@/lib/hippo/types';
import { inr, WorkStatus } from './ui';

const LABEL: Record<string, string> = { FOUNDER_OBJECTIVE: 'Objective', UNDERSTAND: 'Understand', RESEARCH: 'Research', DECISION: 'Decision', PATHWAYS: 'Pathways', WORK_GENERATION: 'Work', EXECUTION: 'Execution', OUTCOME: 'Outcome' };

export function Stepper({ stage }: { stage: string }) {
  const at = stageIndex(stage);
  return <ol className="flex gap-1 overflow-x-auto pb-1">{STAGES.map((s, i) => <li key={s} className="flex min-w-[88px] flex-1 flex-col gap-1.5">
    <span className={`h-1.5 rounded-full ${i < at ? 'bg-[#4F46E5]' : i === at ? 'bg-[#FF8A1F]' : 'bg-[#E9E2D4]'}`}/>
    <span className={`text-[11px] font-semibold ${i <= at ? 'text-[#0B1533]' : 'text-[#A9A291]'}`}>{LABEL[s]}</span>
  </li>)}</ol>;
}

type W = { id: string; title: string; description: string; deliverable?: string; capability: string; status: string; priority: number; estimatedCost: number | null; executionMode: string | null; aiExecutable: boolean };

export function WorkCard({ w, n }: { w: W; n: number }) {
  const c = classifyWork(w);
  const cap = routeCapability(c.capabilityId);
  const badge = { AI_DELIVERABLE: ['bg-[#E3F6EC] text-[#14663D]', 'AI can prepare'], AI_WITH_INTEGRATION: ['bg-[#E3F6EC] text-[#14663D]', 'AI prepares · you publish'], AI_WITH_HUMAN_REVIEW: ['bg-[#FFF1DF] text-[#9A4B00]', 'AI drafts · professional review'], HUMAN_EXECUTION: ['bg-[#EFEBE2] text-[#4A5268]', 'Needs a person · AI prepares'], PROFESSIONAL_APPROVAL: ['bg-[#FFF1DF] text-[#9A4B00]', 'Professional sign-off'] }[c.executionClass];
  return <Link href={`/work/${w.id}`} className="ht-card group flex flex-col p-5 hover:border-[#4F46E5]">
    <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-bold uppercase tracking-[.16em] text-[#C9BFAE]">Work {n}</span><WorkStatus status={w.status}/></div>
    <h4 className="mt-2 text-[17px] font-extrabold leading-snug">{w.title}</h4>
    <p className="mt-1 line-clamp-2 text-sm text-[#5B6478]">{w.description.split('\n')[0]}</p>
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full bg-[#EEF0FF] px-2.5 py-1 font-semibold text-[#3730A3]">{cap.label}</span>
      <span className={`rounded-full px-2.5 py-1 font-semibold ${badge[0]}`}>{badge[1]}</span>
      {w.executionMode && <span className="rounded-full bg-[#0B1533] px-2.5 py-1 font-semibold text-white">{w.executionMode}</span>}
    </div>
    <div className="mt-auto flex items-center justify-between pt-4 text-sm"><span className="text-[#6B7389]">{w.estimatedCost !== null ? <>Est. {inr(w.estimatedCost, w.estimatedCost < 100 ? 2 : 0)}</> : 'Open for brief & estimate'}</span><ArrowRight size={16} className="text-[#4F46E5] transition group-hover:translate-x-0.5"/></div>
  </Link>;
}
