// Aristotle · "HOW COULD WE ACTUALLY ACHIEVE THIS?"
// Generates several plausible pathways to the founder's FULL objective, grounded in research and founder facts.
// Aristotle may challenge assumptions, but never shrinks the founder's ambition without evidence.
import type { AuditReport } from '../audit';
import type { ResearchRecord } from '../evidence';
import { buildFounderFactsBlock, type FounderFact } from '../founder-facts';
import { researchBrief } from '../research';
import { identityBlock, NOT_ESTABLISHED, type Pathway, type PathwaysResult, type Understanding } from './types';

export const PATHWAYS_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    ambitionNote: { type: 'string' },
    pathways: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, howItWorks: { type: 'string' }, whyPlausible: { type: 'string' },
          evidence: { type: 'array', items: { type: 'object', properties: { statement: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } }, required: ['statement', 'refs'] } },
          economics: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } },
          firstExperiment: { type: 'string' }, contributionToTarget: { type: 'string' },
        },
        required: ['name', 'howItWorks', 'whyPlausible', 'evidence', 'economics', 'constraints', 'risks', 'firstExperiment', 'contributionToTarget'],
      },
    },
    combination: { type: 'string' },
    founderChecklist: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'ambitionNote', 'pathways', 'combination', 'founderChecklist'],
};

export function pathwaysPrompt(input: { objective: string; understanding: Understanding | null; facts: FounderFact[]; research: ResearchRecord | null; report: AuditReport; company?: string | null }): string {
  const memo = input.report.decisionMemo;
  return `You are Aristotle, the strategy capability of Hippoturtle. The founder's objective is NOT up for negotiation.
${identityBlock(input.company ?? null)}
Your job: lay out the plausible pathways to achieve the FULL objective, and what each would require.

FOUNDER OBJECTIVE (verbatim): """${input.objective}"""
Target: ${input.understanding?.target || 'Not stated'} | Current state: ${input.understanding?.currentState || 'Not stated'}

${buildFounderFactsBlock(input.facts)}

${input.research ? researchBrief(input.research) : 'RESEARCH BRIEF: none available.'}

DECISION MEMO SO FAR:
Verdict: ${input.report.oneLineVerdict || input.report.verdict || ''}
Decision question: ${memo?.decisionQuestion || ''}
Critical assumptions: ${(memo?.criticalAssumptions || []).map((a) => `${a.assumption} [${a.evidenceStatus}]`).join(' | ')}

RULES (strict):
1. Produce 5–7 genuinely different pathways (channels / business models / partnerships), specific to THIS business in India.
   Example of the spirit: for "grow glucometer sales from 1,400 to 10,000 units/month" pathways could include B2B marketplaces,
   pharmacy networks, distributors, D2C, doctors/clinics, corporate wellness, creators/affiliates — but derive them from this business.
2. NEVER tell the founder to lower the target. If evidence suggests it is hard, say what would have to be true to reach it.
3. evidence: only statements supported by the research brief or founder facts. refs must be R# finding ids or F# founder fact ids
   from above. If nothing supports a pathway, return an empty evidence list — do NOT invent support.
4. economics: use numbers ONLY from F# facts or R# findings and cite them in brackets like [F1] [R2]. If unknown, write "${NOT_ESTABLISHED}" and say what must be measured.
5. contributionToTarget: phrase as a REQUIREMENT, never a forecast. E.g. "To deliver 3,000 units/month this way you would need roughly 300 outlets selling 10 units each."
6. firstExperiment: the cheapest test (≤ 2 weeks) that would show whether this pathway works.
7. No invented market sizes, statistics, prices or competitor names that are not in the research brief.
8. combination: how 2–3 pathways could combine to reach the full target, as requirements.
9. founderChecklist: 5–8 decisions only the founder can make (budget, risk appetite, channels to try first, working capital, hiring).
10. goal: the founder's objective in one line, unchanged. ambitionNote: one honest sentence on what reaching it demands.
Simple English. Return JSON only.`;
}

const REF = /^(R|F)\d+$/;

/** Deterministic grounding: refs must exist; unsupported numbers in economics are replaced with "Not yet established." */
export function normalisePathways(raw: unknown, valid: { findings: Set<string>; facts: Set<string> }): PathwaysResult {
  const r = (raw || {}) as Record<string, unknown>;
  const str = (v: unknown, max = 1200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const arr = (v: unknown, n = 8) => (Array.isArray(v) ? v.map((x) => str(x, 400)).filter(Boolean).slice(0, n) : []);
  const ok = (ref: string) => REF.test(ref) && (ref.startsWith('R') ? valid.findings.has(ref) : valid.facts.has(ref));
  const pathways: Pathway[] = (Array.isArray(r.pathways) ? r.pathways : []).slice(0, 7).map((p: Record<string, unknown>, i: number): Pathway => {
    const evidence = (Array.isArray(p.evidence) ? p.evidence : [])
      .map((e: Record<string, unknown>) => ({ statement: str(e?.statement, 400), refs: (Array.isArray(e?.refs) ? e.refs : []).map(String).filter(ok) }))
      .filter((e: { statement: string; refs: string[] }) => e.statement && e.refs.length > 0);
    let economics = str(p.economics, 800) || NOT_ESTABLISHED;
    const cited = (economics.match(/\b[RF]\d+\b/g) || []).filter(ok);
    const withoutRefs = economics.replace(/\[?\b[RF]\d+\b\]?/g, '');
    if (/\d/.test(withoutRefs) && cited.length === 0) economics = `${NOT_ESTABLISHED} The figures proposed were not supported by your numbers or by research, so they were removed.`;
    return {
      id: `P${i + 1}`, name: str(p.name, 120) || `Pathway ${i + 1}`, howItWorks: str(p.howItWorks), whyPlausible: str(p.whyPlausible),
      evidence, economics, constraints: arr(p.constraints, 6), risks: arr(p.risks, 6), firstExperiment: str(p.firstExperiment, 600) || NOT_ESTABLISHED,
      contributionToTarget: str(p.contributionToTarget, 600) || NOT_ESTABLISHED,
      evidenceStrength: evidence.length >= 2 ? 'SUPPORTED' : evidence.length === 1 ? 'PARTIAL' : 'NOT_YET_ESTABLISHED',
    };
  }).filter((p) => p.howItWorks);
  if (pathways.length < 2) throw new Error('PATHWAYS_INVALID: fewer than two usable pathways were produced');
  return { goal: str(r.goal, 400), ambitionNote: str(r.ambitionNote, 600), pathways, combination: str(r.combination, 1200), founderChecklist: arr(r.founderChecklist, 10) };
}
