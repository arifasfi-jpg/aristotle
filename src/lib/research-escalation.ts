// ---------------------------------------------------------------------------
// Research escalation: "no evidence found" is never the first answer.
//
// After the first pass (research.ts: one search per question), every question without a DIRECT answer is
// researched again, wider each round, before any gap is declared:
//
//   ROUND 1 · India-wide   — reformulated query, Indian regulators / government / filings, Indian company websites,
//                            Indian business press, competitor / product examples (category-specific mix of 3)
//   ROUND 2 · beyond India — global sources, industry & academic reports, international analogues, cross-industry
//                            analogues (category-specific mix of 3). Comparable cases are kept as ANALOGOUS evidence.
//   ROUND 3 · explain gaps — for every question still unanswered: closest evidence (R# ids only), what it implies
//                            (labelled inference), what remains unknown, and the cheapest experiment / interview /
//                            data request that resolves it.
//
// Same evidence rules as the first pass: source text only, verbatim quotes verified by the server, a date kept only
// if the source states it. Each round is one durable job step (research.json is the checkpoint), so escalation never
// competes with the 60 s function limit. Searches stay metered and budgeted; escalation stops widening at a share of
// the audit's cost limit (recorded and shown to the founder, never silent) so the decision memo is always affordable.
// ---------------------------------------------------------------------------
import type { UsageContext } from './ai-usage';
import { aristotleGeminiJson } from './hippo/gateway';
import {
  arr, buildExtractPrompt, EXTRACT_SCHEMA, SOURCE_CONTENT_CHARS, STORED_CONTENT_CHARS, str, tavilySearch, verifyFindings,
  type ResearchInput, type TavilyResult,
} from './research';
import {
  SEARCH_STRATEGIES,
  type EscalationState, type EvidenceGap, type Finding, type QuestionStatus, type ResearchAttempt, type ResearchCategory, type ResearchQuestion,
  type ResearchRecord, type ResearchSource, type ResolutionKind, type SearchStrategy,
} from './evidence';

export const FINAL_ROUND = 3;
/** Time a round needs to finish inside one worker invocation (job runtime minStepMs uses the same numbers). */
export const ROUND_MIN_MS: Record<number, number> = { 1: 38_000, 2: 28_000, 3: 14_000 };
const QUERIES_PER_ROUND = 3;
const RESULTS_PER_SEARCH = 5;

// Source sets for domain-restricted strategies. Search results still have to pass quote verification.
export const INDIA_PRIMARY_DOMAINS = [
  'rbi.org.in', 'sebi.gov.in', 'irdai.gov.in', 'meity.gov.in', 'mca.gov.in', 'pib.gov.in', 'data.gov.in', 'mospi.gov.in',
  'education.gov.in', 'dpiit.gov.in', 'npci.org.in', 'trai.gov.in', 'fssai.gov.in', 'cdsco.gov.in', 'indiacode.nic.in',
  'egazette.gov.in', 'india.gov.in', 'bseindia.com', 'nseindia.com',
];
export const INDIA_SECONDARY_DOMAINS = [
  'economictimes.indiatimes.com', 'livemint.com', 'business-standard.com', 'thehindubusinessline.com', 'financialexpress.com',
  'moneycontrol.com', 'inc42.com', 'yourstory.com', 'entrackr.com', 'medianama.com', 'ibef.org', 'the-ken.com',
];
export const REPORT_DOMAINS = [
  'redseer.com', 'bain.com', 'mckinsey.com', 'bcg.com', 'kpmg.com', 'pwc.in', 'pwc.com', 'ey.com', 'deloitte.com',
  'nasscom.in', 'ficci.in', 'worldbank.org', 'imf.org', 'oecd.org', 'bis.org', 'nber.org', 'ssrn.com', 'arxiv.org',
];

type StrategySpec = { scope: 'INDIA' | 'GLOBAL'; domains?: string[]; deep?: boolean; intent: string };
export const STRATEGY: Record<Exclude<SearchStrategy, 'INITIAL'>, StrategySpec> = {
  REFORMULATED: { scope: 'INDIA', intent: 'the same question in different words: synonyms, the industry’s own vocabulary, the customer’s words' },
  INDIA_PRIMARY: { scope: 'INDIA', domains: INDIA_PRIMARY_DOMAINS, deep: true, intent: 'Indian regulators, ministries, official statistics, stock-exchange filings (searched only on official domains)' },
  INDIA_COMPANIES: { scope: 'INDIA', intent: 'named Indian companies / products doing this: their pricing, product, partner and investor pages' },
  INDIA_SECONDARY: { scope: 'INDIA', domains: INDIA_SECONDARY_DOMAINS, intent: 'reputable Indian business press and research (searched only on those domains)' },
  COMPETITOR_EXAMPLES: { scope: 'INDIA', deep: true, intent: 'competitors and substitutes customers use today, with prices and terms' },
  GLOBAL: { scope: 'GLOBAL', intent: 'the same question answered anywhere in the world (no country filter)' },
  INDUSTRY_REPORTS: { scope: 'GLOBAL', domains: REPORT_DOMAINS, deep: true, intent: 'consulting, industry-body and academic reports (searched only on those domains)' },
  INTERNATIONAL_ANALOGUE: { scope: 'GLOBAL', intent: 'the same business model in another country (name the country / company type), its adoption, prices, rules' },
  CROSS_INDUSTRY_ANALOGUE: { scope: 'GLOBAL', intent: 'the same mechanism (payment model, channel, cost structure) in a different industry' },
};

type EscalationStrategy = Exclude<SearchStrategy, 'INITIAL'>;
/** The avenues tried for each kind of question, in order, per round. */
export const ROUND_STRATEGIES: Record<1 | 2, Record<ResearchCategory, EscalationStrategy[]>> = {
  1: {
    DEMAND: ['REFORMULATED', 'INDIA_SECONDARY', 'INDIA_PRIMARY'],
    ALTERNATIVES_PRICING: ['COMPETITOR_EXAMPLES', 'INDIA_COMPANIES', 'REFORMULATED'],
    REGULATION: ['INDIA_PRIMARY', 'INDIA_SECONDARY', 'REFORMULATED'],
    CHANNEL: ['INDIA_COMPANIES', 'INDIA_SECONDARY', 'REFORMULATED'],
    COST: ['INDIA_SECONDARY', 'INDIA_COMPANIES', 'REFORMULATED'],
    OPERATIONS: ['REFORMULATED', 'INDIA_SECONDARY', 'INDIA_COMPANIES'],
    OTHER: ['REFORMULATED', 'INDIA_SECONDARY', 'INDIA_COMPANIES'],
  },
  2: {
    DEMAND: ['INDUSTRY_REPORTS', 'INTERNATIONAL_ANALOGUE', 'GLOBAL'],
    ALTERNATIVES_PRICING: ['INTERNATIONAL_ANALOGUE', 'GLOBAL', 'CROSS_INDUSTRY_ANALOGUE'],
    REGULATION: ['GLOBAL', 'INTERNATIONAL_ANALOGUE', 'INDUSTRY_REPORTS'],
    CHANNEL: ['INTERNATIONAL_ANALOGUE', 'CROSS_INDUSTRY_ANALOGUE', 'INDUSTRY_REPORTS'],
    COST: ['INDUSTRY_REPORTS', 'INTERNATIONAL_ANALOGUE', 'CROSS_INDUSTRY_ANALOGUE'],
    OPERATIONS: ['INDUSTRY_REPORTS', 'INTERNATIONAL_ANALOGUE', 'CROSS_INDUSTRY_ANALOGUE'],
    OTHER: ['GLOBAL', 'INDUSTRY_REPORTS', 'INTERNATIONAL_ANALOGUE'],
  },
};

const remaining = (deadline: number) => deadline - Date.now();
const isBudgetRefusal = (e: unknown) => e instanceof Error && /AI_BUDGET_EXCEEDED/.test(e.message);
/** A question escalation keeps working on: anything without a DIRECT answer. A contradiction is evidence, not a gap to search away. */
const open = (q: ResearchQuestion) => q.status !== 'ANSWERED' && q.status !== 'CONTRADICTORY';

export type EscalationOpts = {
  usage?: UsageContext;
  /** Research spend cap: escalation stops widening once the audit's ledger cost reaches it (the memo still runs). */
  spend?: { spentInr: () => Promise<number>; capInr: number };
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Query planning (once, round 1): one model call for all open questions; deterministic fallback per strategy.
// ---------------------------------------------------------------------------
const QUERY_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, queries: { type: 'array', items: { type: 'object', properties: { strategy: { type: 'string', enum: SEARCH_STRATEGIES.filter((s) => s !== 'INITIAL') }, query: { type: 'string' } }, required: ['strategy', 'query'] } } },
        required: ['id', 'queries'],
      },
    },
  },
  required: ['questions'],
};

export function buildQueryPlanPrompt(r: ResearchRecord, input: Pick<ResearchInput, 'geography'>, targets: ResearchQuestion[]): string {
  const bm = r.businessModel;
  const wanted = (q: ResearchQuestion) => [...ROUND_STRATEGIES[1][q.category], ...ROUND_STRATEGIES[2][q.category]];
  return `You plan FOLLOW-UP web searches for Aristotle (India-first venture research). The first search for each question
below did not settle it. Write a different, better search query for each listed strategy. Do NOT answer the questions.

BUSINESS: ${bm?.summary || ''} | Customer: ${bm?.customer || ''} | Payer: ${bm?.payer || ''} | Revenue: ${bm?.revenueMechanism || ''}
Geography: ${input.geography || 'India'}

STRATEGIES:
${Object.entries(STRATEGY).map(([k, v]) => `- ${k}: ${v.intent}`).join('\n')}

QUESTIONS (with the query already tried and the strategies to plan):
${targets.map((q) => `${q.id} [${q.category}] ${q.question}\n   already tried: ${(q.attempts || []).map((a) => `"${a.query}"`).join(', ') || `"${q.query}"`}\n   plan: ${wanted(q).join(', ')}`).join('\n')}

Rules: each query under 12 words, a real web search (not a sentence), never a repeat of a query already tried.
Name concrete things where you can: industry terms, company types, the analogous country or industry, report types.
For analogue strategies, name the analogue (e.g. a country where this model exists, or the industry where the mechanism is common).
Return JSON: questions[{id, queries[{strategy, query}]}].`;
}

const STRIP_GEO = /\b(india|indian|bharat)\b/gi;
const tidy = (q: string) => q.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
/** Deterministic queries: escalation never depends on the query planner succeeding. */
export function fallbackQuery(q: Pick<ResearchQuestion, 'query' | 'question' | 'category'>, strategy: EscalationStrategy, r: Pick<ResearchRecord, 'businessModel'>): string {
  const base = tidy(q.query);
  const global = tidy(base.replace(STRIP_GEO, '')) || base;
  const words = tidy(q.question.replace(/[?]/g, '')).split(' ').slice(0, 12).join(' ');
  switch (strategy) {
    case 'REFORMULATED': return words;
    case 'INDIA_PRIMARY': return tidy(`${global} ${q.category === 'REGULATION' ? 'guidelines circular' : 'data statistics'}`);
    case 'INDIA_COMPANIES': return tidy(`${global} companies India`);
    case 'INDIA_SECONDARY': return base;
    case 'COMPETITOR_EXAMPLES': return tidy(`${global} competitors pricing India`);
    case 'GLOBAL': return global;
    case 'INDUSTRY_REPORTS': return tidy(`${global} market report`);
    case 'INTERNATIONAL_ANALOGUE': return tidy(`${global} United States OR UK OR Southeast Asia`);
    case 'CROSS_INDUSTRY_ANALOGUE': return tidy(`${r.businessModel?.revenueMechanism || global} model other industries case study`);
  }
}

export function normaliseQueryPlan(raw: unknown, targets: ResearchQuestion[], r: ResearchRecord): Record<string, { strategy: EscalationStrategy; query: string }[]> {
  const byId = new Map(arr((raw as { questions?: unknown })?.questions).map((x) => [str((x as { id?: string }).id, 10), arr((x as { queries?: unknown }).queries)]));
  const plan: Record<string, { strategy: EscalationStrategy; query: string }[]> = {};
  for (const q of targets) {
    const tried = new Set([q.query, ...(q.attempts || []).map((a) => a.query)].map((x) => x.toLowerCase()));
    const proposed = new Map<string, string>();
    for (const x of byId.get(q.id) || []) {
      const strategy = str((x as { strategy?: string }).strategy, 40); const query = tidy(str((x as { query?: string }).query, 200));
      if (query && !proposed.has(strategy)) proposed.set(strategy, query);
    }
    plan[q.id] = [...ROUND_STRATEGIES[1][q.category], ...ROUND_STRATEGIES[2][q.category]].map((strategy) => {
      let query = proposed.get(strategy) || fallbackQuery(q, strategy, r);
      if (tried.has(query.toLowerCase())) query = fallbackQuery(q, strategy, r);
      if (tried.has(query.toLowerCase())) query = tidy(`${query} ${strategy.toLowerCase().replace(/_/g, ' ')}`);
      tried.add(query.toLowerCase());
      return { strategy, query };
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Status after a round: DIRECT evidence answers; analogues inform; nothing → still open.
// ---------------------------------------------------------------------------
export function questionStatus(prior: QuestionStatus, findings: Finding[], roundSaid: QuestionStatus | null, attempts: ResearchAttempt[]): QuestionStatus {
  const direct = findings.filter((f) => f.evidenceType !== 'ANALOGOUS');
  if (prior === 'ANSWERED' || prior === 'CONTRADICTORY') return prior;
  if (roundSaid === 'CONTRADICTORY' && direct.length) return 'CONTRADICTORY';
  if (roundSaid === 'ANSWERED' && direct.some((f) => f.round && f.round > 0)) return 'ANSWERED';
  if (direct.length) return 'PARTIAL';
  if (findings.length) return 'ANALOGOUS';
  return attempts.length && attempts.every((a) => a.failed) ? 'SEARCH_FAILED' : 'NOT_FOUND';
}

// ---------------------------------------------------------------------------
// One search round (1 = India-wide, 2 = beyond India)
// ---------------------------------------------------------------------------
async function searchRound(r: ResearchRecord, input: ResearchInput, round: 1 | 2, deadline: number, opts: EscalationOpts): Promise<ResearchRecord> {
  const questions = (r.questions || []).map((q) => ({ ...q, attempts: [...(q.attempts || [])], sourceIds: [...q.sourceIds], findingIds: [...q.findingIds] }));
  const targets = questions.filter(open);
  let escalation: EscalationState = { ...(r.escalation || { roundsDone: 0, complete: false }) };
  if (!targets.length) return { ...r, questions, escalation: { ...escalation, roundsDone: round } };

  // 1. Queries (planned once in round 1, reused by round 2 and by any retry).
  if (!escalation.plan) {
    let raw: unknown = null;
    const t = Math.min(10_000, remaining(deadline) - (ROUND_MIN_MS[1] - 10_000));
    if (t >= 4_000) {
      try {
        raw = (await aristotleGeminiJson<unknown>('research-escalate', { label: 'research-escalate', prompt: buildQueryPlanPrompt(r, input, targets), schema: QUERY_PLAN_SCHEMA, maxOutputTokens: 1500, temperature: 0.2, timeoutMs: t, fastThinking: true }, opts.usage)).data;
      } catch (e) {
        if (isBudgetRefusal(e)) throw e;
        console.error(JSON.stringify({ event: 'research_escalation_plan_failed', error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      }
    }
    escalation = { ...escalation, plan: normaliseQueryPlan(raw, targets, r) };
  }
  const jobs = targets.flatMap((q) => {
    const wanted = new Set(ROUND_STRATEGIES[round][q.category]);
    const planned = (escalation.plan![q.id] || []).filter((p) => wanted.has(p.strategy as EscalationStrategy));
    const list = planned.length ? planned : ROUND_STRATEGIES[round][q.category].map((strategy) => ({ strategy, query: fallbackQuery(q, strategy, r) }));
    return list.slice(0, QUERIES_PER_ROUND).map((p) => ({ q, strategy: p.strategy as EscalationStrategy, query: p.query }));
  });

  // 2. Search (parallel).
  const searchTimeout = Math.min(12_000, remaining(deadline) - 16_000);
  if (searchTimeout < 4_000) throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: not enough time left to widen research');
  const searched = await Promise.allSettled(jobs.map((j) => {
    const spec = STRATEGY[j.strategy];
    // Domain-restricted searches (regulators, press, reports) use advanced depth for relevance; open-web widening uses
    // basic depth (half the credits) so a ₹99 report can afford to reach global sources and analogues.
    return tavilySearch(j.query, { deep: Boolean(spec.deep) || j.q.category === 'REGULATION' || j.q.category === 'ALTERNATIVES_PRICING', geography: input.geography, timeoutMs: searchTimeout, usage: opts.usage, scope: spec.scope, domains: spec.domains, maxResults: RESULTS_PER_SEARCH, depth: spec.domains ? 'advanced' : 'basic' });
  }));
  const refused = searched.find((x) => x.status === 'rejected' && isBudgetRefusal(x.reason));
  if (refused) throw (refused as PromiseRejectedResult).reason;

  const sources = [...r.sources];
  const fullText = new Map<string, string>(sources.map((s) => [s.id, s.content || s.snippet]));
  const retrievedAt = (opts.now?.() ?? new Date()).toISOString();
  const fresh = new Map<string, ResearchSource[]>(); // per question: sources this round added to it
  const attemptOf = new Map<string, ResearchAttempt>();
  jobs.forEach((j, i) => {
    const res = searched[i];
    const results: TavilyResult[] = res.status === 'fulfilled' ? res.value : [];
    const list = fresh.get(j.q.id) || [];
    let added = 0;
    for (const x of results) {
      if (!x.url) continue;
      const text = `${x.content || ''}\n${x.raw_content || ''}`.trim();
      let src = sources.find((s) => s.url === x.url);
      if (!src) {
        src = { id: `S${sources.length + 1}`, title: str(x.title, 200) || 'Untitled', url: x.url, snippet: str(x.content, 600), content: text.slice(0, STORED_CONTENT_CHARS), query: j.query, questionId: j.q.id, retrievedAt };
        sources.push(src);
        fullText.set(src.id, text.slice(0, SOURCE_CONTENT_CHARS));
      } else if (text.length > (fullText.get(src.id)?.length || 0)) fullText.set(src.id, text.slice(0, SOURCE_CONTENT_CHARS));
      if (!j.q.sourceIds.includes(src.id) && !list.includes(src)) { list.push(src); added++; }
    }
    fresh.set(j.q.id, list);
    const spec = STRATEGY[j.strategy];
    const attempt: ResearchAttempt = { round, strategy: j.strategy, query: j.query, scope: spec.scope, ...(spec.domains ? { domains: spec.domains.slice(0, 6) } : {}), sources: results.filter((x) => x.url).length, newSources: added, findings: 0, ...(res.status === 'rejected' ? { failed: true } : {}) };
    j.q.attempts.push(attempt);
    attemptOf.set(`${j.q.id}\u0000${j.query}`, attempt);
  });
  const contentOf = (s: ResearchSource) => fullText.get(s.id) || s.content || s.snippet;

  // 3. Extract (parallel; only the sources this round added to each question).
  const extractTimeout = Math.min(14_000, remaining(deadline) - 1_500);
  if (extractTimeout < 4_000) throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: not enough time left to read the new sources');
  const extracted = await Promise.allSettled(targets.map(async (q) => {
    const srcs = fresh.get(q.id) || [];
    if (!srcs.length) return null;
    return (await aristotleGeminiJson<unknown>('research-extract', { label: `extract-${q.id}-r${round}`, prompt: buildExtractPrompt(q, srcs, contentOf, { geography: input.geography, analogues: round === 2 }), schema: EXTRACT_SCHEMA, maxOutputTokens: 1500, temperature: 0, timeoutMs: extractTimeout }, opts.usage)).data;
  }));
  const refusedExtract = extracted.find((x) => x.status === 'rejected' && isBudgetRefusal(x.reason));
  if (refusedExtract) throw (refusedExtract as PromiseRejectedResult).reason;

  const findings = [...(r.findings || [])];
  targets.forEach((q, i) => {
    const srcs = fresh.get(q.id) || [];
    const ex = extracted[i];
    let said: QuestionStatus | null = null;
    if (srcs.length && ex.status === 'fulfilled' && ex.value) {
      const v = verifyFindings(ex.value, q.id, srcs, contentOf, findings.length + 1);
      said = v.status;
      for (const f of v.findings) {
        findings.push({ ...f, round });
        q.findingIds.push(f.id);
        const src = srcs.find((s) => s.id === f.sourceId);
        const a = src && attemptOf.get(`${q.id}\u0000${src.query}`);
        if (a) a.findings++;
        else { const first = q.attempts.find((x) => x.round === round && !x.failed); if (first) first.findings++; }
      }
    }
    q.sourceIds.push(...srcs.map((s) => s.id));
    const all = findings.filter((f) => f.questionId === q.id);
    q.status = questionStatus(q.status, all, said, q.attempts);
    if (q.note && !/discarded/.test(q.note)) q.note = undefined; // first-pass notes describe the first search only; keep integrity notes
  });

  return { ...r, sources, questions, findings, queries: [...r.queries, ...jobs.map((j) => j.query)], escalation: { ...escalation, roundsDone: round } };
}

// ---------------------------------------------------------------------------
// Round 3: explain what could not be established — and how to find out.
// ---------------------------------------------------------------------------
const GAP_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, closestEvidence: { type: 'string' }, closestEvidenceIds: { type: 'array', items: { type: 'string' } },
          implication: { type: 'string' }, stillUnknown: { type: 'string' },
          resolveKind: { type: 'string', enum: ['EXPERIMENT', 'INTERVIEW', 'DATA_REQUEST'] }, resolveAction: { type: 'string' },
        },
        required: ['id', 'closestEvidence', 'closestEvidenceIds', 'implication', 'stillUnknown', 'resolveKind', 'resolveAction'],
      },
    },
  },
  required: ['gaps'],
};

export function buildGapPrompt(r: ResearchRecord, targets: ResearchQuestion[]): string {
  const bm = r.businessModel;
  const findings = r.findings || [];
  return `You are Aristotle. Research could not settle the questions below from public evidence. For each, tell the founder
honestly what is and is not known, using ONLY the findings listed (never your own knowledge as evidence).

BUSINESS: ${bm?.summary || ''} | Customer: ${bm?.customer || ''} | Payer: ${bm?.payer || ''}

${targets.map((q) => `${q.id} [${q.category}] ${q.question} (status ${q.status})
   searched: ${(q.attempts || []).map((a) => `${a.strategy}: "${a.query}" → ${a.sources} results${a.failed ? ' (failed)' : ''}`).join('; ')}
   findings: ${findings.filter((f) => f.questionId === q.id).map((f) => `${f.id} [${f.evidenceType || 'DIRECT'}${f.geography ? `, ${f.geography}` : ''}] ${f.statement}${f.analogy ? ` (analogue: ${f.analogy})` : ''}`).join(' | ') || 'none'}`).join('\n')}

For each question return:
- closestEvidence: the nearest evidence found, in one or two plain sentences, citing its R# ids in closestEvidenceIds.
  If there are no findings, say plainly that no direct or analogous public evidence turned up, and leave the ids empty.
- implication: what that evidence suggests for THIS business — an inference, phrased as one ("suggests", "would mean").
- stillUnknown: the specific fact that remains unknown.
- resolveKind + resolveAction: the cheapest way to establish it within 2 weeks: EXPERIMENT (a test with a pass threshold),
  INTERVIEW (who, how many, what to ask) or DATA_REQUEST (which record / quote / dataset from whom). Be concrete.
No invented numbers, companies or sources. Simple English. JSON only.`;
}

const RESOLVE: Record<ResearchCategory, (customer: string) => { kind: ResolutionKind; action: string }> = {
  DEMAND: (c) => ({ kind: 'INTERVIEW', action: `Interview 8–10 ${c || 'target customers'} about how they handle this today and what they pay; count how many ask to try it.` }),
  ALTERNATIVES_PRICING: (c) => ({ kind: 'EXPERIMENT', action: `Show a priced offer to 10 ${c || 'target customers'} and record how many accept at that price.` }),
  REGULATION: () => ({ kind: 'DATA_REQUEST', action: 'Ask a practising lawyer in this area (or the regulator’s published FAQ / helpdesk) whether this exact activity needs a licence or registration.' }),
  CHANNEL: (c) => ({ kind: 'EXPERIMENT', action: `Run a 2-week test of this channel to reach ${c || 'target customers'} and measure cost per qualified lead.` }),
  COST: () => ({ kind: 'DATA_REQUEST', action: 'Request written quotes from 3 suppliers / partners for the main cost item.' }),
  OPERATIONS: () => ({ kind: 'EXPERIMENT', action: 'Deliver it manually for 3 customers and record the time and cost per unit.' }),
  OTHER: (c) => ({ kind: 'INTERVIEW', action: `Interview 5 ${c || 'people who would buy this'} specifically about this question.` }),
};

/** Deterministic gap: built from the research trail itself when the model call is unavailable. */
export function fallbackGap(q: ResearchQuestion, r: ResearchRecord): EvidenceGap {
  const fs = (r.findings || []).filter((f) => f.questionId === q.id);
  const best = [...fs].sort((a, b) => Number(a.evidenceType === 'ANALOGOUS') - Number(b.evidenceType === 'ANALOGOUS'))[0];
  return {
    closestEvidence: best ? `${best.statement}${best.evidenceType === 'ANALOGOUS' ? ` (analogous${best.geography ? `, ${best.geography}` : ''})` : ''}` : 'No direct or analogous public evidence turned up in these searches.',
    closestEvidenceIds: best ? [best.id] : [],
    implication: best ? 'This is the nearest available signal; treat it as an indication, not proof, for this business.' : 'Treat this as untested: any plan that depends on it needs the check below first.',
    stillUnknown: q.question,
    resolveBy: RESOLVE[q.category](r.businessModel?.customer || ''),
  };
}

export function normaliseGaps(raw: unknown, targets: ResearchQuestion[], r: ResearchRecord): Record<string, EvidenceGap> {
  const byId = new Map(arr((raw as { gaps?: unknown })?.gaps).map((g) => [str((g as { id?: string }).id, 10), g as Record<string, unknown>]));
  const out: Record<string, EvidenceGap> = {};
  for (const q of targets) {
    const g = byId.get(q.id);
    const fb = fallbackGap(q, r);
    if (!g) { out[q.id] = fb; continue; }
    const own = new Set((r.findings || []).filter((f) => f.questionId === q.id).map((f) => f.id));
    const ids = arr(g.closestEvidenceIds).map(String).filter((id) => own.has(id));
    const kind = (['EXPERIMENT', 'INTERVIEW', 'DATA_REQUEST'].includes(String(g.resolveKind)) ? g.resolveKind : fb.resolveBy.kind) as ResolutionKind;
    out[q.id] = {
      // Closest evidence must cite this question's findings; with none, it may not claim any.
      closestEvidence: ids.length ? str(g.closestEvidence, 600) || fb.closestEvidence : own.size ? fb.closestEvidence : 'No direct or analogous public evidence turned up in these searches.',
      closestEvidenceIds: ids.length ? ids : fb.closestEvidenceIds,
      implication: str(g.implication, 500) || fb.implication,
      stillUnknown: str(g.stillUnknown, 400) || fb.stillUnknown,
      resolveBy: { kind, action: str(g.resolveAction, 500) || fb.resolveBy.action },
    };
  }
  return out;
}

async function explainGaps(r: ResearchRecord, deadline: number, opts: EscalationOpts): Promise<ResearchRecord> {
  const questions = (r.questions || []).map((q) => ({ ...q }));
  const targets = questions.filter((q) => q.status !== 'ANSWERED');
  let raw: unknown = null;
  if (targets.length) {
    const t = Math.min(12_000, remaining(deadline) - 1_000);
    if (t >= 4_000) {
      try {
        raw = (await aristotleGeminiJson<unknown>('research-gap', { label: 'research-gap', prompt: buildGapPrompt(r, targets), schema: GAP_SCHEMA, maxOutputTokens: 2500, temperature: 0.2, timeoutMs: t, fastThinking: true }, opts.usage)).data;
      } catch (e) {
        if (isBudgetRefusal(e)) throw e;
        console.error(JSON.stringify({ event: 'research_gap_explain_failed', error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      }
    }
  }
  const gaps = normaliseGaps(raw, targets, r);
  for (const q of questions) if (gaps[q.id]) q.gap = gaps[q.id];
  return { ...r, questions, escalation: { ...(r.escalation || { roundsDone: 0, complete: false }), roundsDone: FINAL_ROUND, complete: true } };
}

/**
 * Runs the NEXT escalation round of complete research and returns the updated record (persist it: it is the
 * checkpoint). Call until `escalation.complete`. Throws AUDIT_TIME_BUDGET_EXCEEDED when the round cannot fit.
 */
export async function escalateResearch(r: ResearchRecord, input: ResearchInput, deadline: number, opts: EscalationOpts = {}): Promise<ResearchRecord> {
  const state = r.escalation || { roundsDone: 0, complete: false };
  if (state.complete) return r;
  let round = state.roundsDone + 1;
  if (round > FINAL_ROUND) round = FINAL_ROUND;
  if (remaining(deadline) < ROUND_MIN_MS[round]) throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: research is saved; retry to continue widening research');

  if (round < FINAL_ROUND && opts.spend) {
    const spent = await opts.spend.spentInr();
    if (spent >= opts.spend.capInr) {
      // Honest early stop: the founder sees that research stopped widening, and why.
      const stoppedReason = `Research stopped widening after ${state.roundsDone ? `escalation round ${state.roundsDone}` : 'the first searches'} because this report's research cost limit (₹${opts.spend.capInr.toFixed(0)}) was reached; the remaining gaps are explained below.`;
      return explainGaps({ ...r, escalation: { ...state, roundsDone: FINAL_ROUND - 1, stoppedReason } }, deadline, opts);
    }
  }
  // Nothing left to search (every question answered or contradicted): go straight to explaining what is not settled.
  const searchable = (r.questions || []).some(open);
  const next = round === FINAL_ROUND || !searchable ? await explainGaps(r, deadline, opts) : await searchRound(r, input, round as 1 | 2, deadline, opts);
  const stillOpen = (next.questions || []).filter((q) => q.status !== 'ANSWERED').length;
  console.log(JSON.stringify({ event: 'research_escalation_round', round, open: stillOpen, sources: next.sources.length, findings: next.findings?.length ?? 0 }));
  return next;
}
