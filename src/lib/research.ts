// ---------------------------------------------------------------------------
// Research engine: Aristotle researches the specific business BEFORE the decision memo is written.
//
//   1. PLAN     — one Gemini call: business model (customer, payer, offering, revenue mechanism,
//                 key + regulated activities) and 6–8 business-specific research questions with queries.
//   2. SEARCH   — one Tavily search per question, in parallel, advanced depth, longer extracts
//                 (full page text for regulation / pricing questions, capped).
//   3. EXTRACT  — one Gemini call per question, in parallel, SOURCE TEXT ONLY. Every finding must carry a
//                 verbatim quote; the server keeps a finding only if that quote really appears in the cited
//                 source retrieved for that question. General model knowledge cannot become "evidence".
//   4. ESCALATE — (research-escalation.ts) a question the first search did not answer is NOT closed as "no
//                 evidence": it is searched again, wider each round (reformulated, Indian primary / company /
//                 secondary sources, then global, industry reports and analogues) before any gap is declared.
//
// All stages run under a shared deadline so the whole audit fits the serverless time limit.
// ---------------------------------------------------------------------------
import { fetchFailurePhase, sent, type UsageContext } from './ai-usage';
import { aristotleGeminiJson, meteredSearch } from './hippo/gateway';
import {
  CONFIDENCE, EVIDENCE_TYPES, QUESTION_STATUS, RESEARCH_CATEGORIES,
  type BusinessModel, type Confidence, type EvidenceType, type Finding, type QuestionStatus, type ResearchCategory, type ResearchQuestion, type ResearchRecord, type ResearchSource,
} from './evidence';

export type ResearchInput = { idea: string; sector: string; stage?: string; geography?: string; founderFactsText?: string };
export type Usage = { inputTokens: number; outputTokens: number; tavilySearches: number };

const MIN_QUESTIONS = 4;
const MAX_QUESTIONS = 8;
const PLAN_QUESTIONS = 6;            // asked for; 4–8 accepted
const PLAN_IDEA_CHARS = 2500;        // founder text sent to the planner
export const PLAN_MAX_OUTPUT_TOKENS = 1500;
/** Planner timeout: up to 20s, but always leaving 30s for search + extraction + decision. */
export const PLAN_TIMEOUT_MAX_MS = 20_000;
export const PLAN_RESERVE_MS = 30_000;
export const PLAN_MIN_MS = 8_000;
export const planTimeoutMs = (remainingMs: number) => Math.min(PLAN_TIMEOUT_MAX_MS, remainingMs - PLAN_RESERVE_MS);
export const SOURCE_CONTENT_CHARS = 6000;   // per source, sent to the extractor
export const STORED_CONTENT_CHARS = 2500;   // per source, persisted in research.json for traceability

export const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
export const arr = (v: unknown) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// 1. PLAN
// ---------------------------------------------------------------------------
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    businessModel: {
      type: 'object',
      properties: {
        summary: { type: 'string' }, customer: { type: 'string' }, payer: { type: 'string' }, offering: { type: 'string' },
        revenueMechanism: { type: 'string' },
        keyActivities: { type: 'array', items: { type: 'string' } },
        regulatedActivities: { type: 'array', items: { type: 'object', properties: { activity: { type: 'string' }, whyRegulated: { type: 'string' } }, required: ['activity', 'whyRegulated'] } },
      },
      required: ['summary', 'customer', 'payer', 'offering', 'revenueMechanism', 'keyActivities', 'regulatedActivities'],
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...RESEARCH_CATEGORIES] },
          question: { type: 'string' }, whyItMatters: { type: 'string' }, query: { type: 'string' }, activity: { type: 'string' },
        },
        required: ['category', 'question', 'whyItMatters', 'query'],
      },
    },
  },
  required: ['businessModel', 'questions'],
};

export function buildPlanPrompt(input: ResearchInput): string {
  // Planning only: understand the business and choose what to search. No evaluation, no prose — short fields
  // keep the response small so this call stays fast (the evidence comes from search + extraction, not from here).
  return `You are the research planner for Aristotle (India-first venture research). Plan what to search; do NOT evaluate the idea.

BUSINESS (founder's words): """${input.idea.slice(0, PLAN_IDEA_CHARS)}"""
Sector: ${input.sector}. Stage: ${input.stage || 'not stated'}. Geography: ${input.geography || 'India'}.
${input.founderFactsText ? `Founder-confirmed facts:\n${input.founderFactsText.slice(0, 1200)}\n` : ''}
Return JSON. Be terse: plain phrases, no sentences longer than 20 words.
businessModel: summary (max 25 words), customer, payer (who pays, may differ), offering, revenueMechanism (each max 12 words),
  keyActivities (max 4, short), regulatedActivities (only activities that plausibly need a licence/regulation in this geography,
  e.g. personal data, payments, lending, health devices/medicine, food, tax filing for others; each with whyRegulated, max 15 words).
questions: exactly ${PLAN_QUESTIONS} questions specific to THIS business (never generic like "is there demand?").
  Cover DEMAND, ALTERNATIVES_PRICING, CHANNEL, COST, and one REGULATION question per regulated activity (set "activity").
  question max 20 words; whyItMatters max 12 words;
  query = a real web search query under 12 words (product type, customer segment, India/city, year if useful). Never quote the whole idea.`;
}

export type ResearchPlan = { businessModel: BusinessModel; questions: Omit<ResearchQuestion, 'status' | 'sourceIds' | 'findingIds'>[] };

export function normalisePlan(raw: unknown): ResearchPlan {
  const r = (raw ?? {}) as { businessModel?: Partial<BusinessModel>; questions?: unknown[] };
  const bm = r.businessModel ?? {};
  const businessModel: BusinessModel = {
    summary: str(bm.summary, 600), customer: str(bm.customer, 300), payer: str(bm.payer, 300), offering: str(bm.offering, 300),
    revenueMechanism: str(bm.revenueMechanism, 300),
    keyActivities: arr(bm.keyActivities).map((x) => str(x, 200)).filter(Boolean).slice(0, 8),
    regulatedActivities: arr(bm.regulatedActivities).map((x) => ({ activity: str((x as { activity?: string })?.activity, 200), whyRegulated: str((x as { whyRegulated?: string })?.whyRegulated, 300) })).filter((x) => x.activity).slice(0, 6),
  };
  const seen = new Set<string>();
  const questions = arr(r.questions).map((q) => q as Record<string, unknown>).map((q) => ({
    category: (RESEARCH_CATEGORIES.includes(q.category as ResearchCategory) ? q.category : 'OTHER') as ResearchCategory,
    question: str(q.question, 300), whyItMatters: str(q.whyItMatters, 300),
    // Never search the founder's whole sentence as an exact phrase.
    query: str(q.query, 200).replace(/^"(.*)"$/, '$1'),
    ...(str(q.activity, 200) ? { activity: str(q.activity, 200) } : {}),
  })).filter((q) => q.question && q.query && !seen.has(q.query.toLowerCase()) && (seen.add(q.query.toLowerCase()), true))
    .slice(0, MAX_QUESTIONS)
    .map((q, i) => ({ id: `Q${i + 1}`, ...q }));
  if (!businessModel.summary || questions.length < MIN_QUESTIONS) throw new Error(`RESEARCH_PLAN_INVALID: planner returned ${questions.length} usable questions`);
  return { businessModel, questions };
}

// ---------------------------------------------------------------------------
// 2. SEARCH
// ---------------------------------------------------------------------------
export type TavilyResult = { title?: string; url?: string; content?: string; raw_content?: string | null; published_date?: string };
/**
 * deep: full page text (regulation / pricing). scope GLOBAL drops the country filter (global sources, analogues).
 * domains: restrict to a source set (Indian regulators, Indian business press, industry reports). maxResults ≤ 5.
 */
export type SearchOpts = { deep: boolean; geography?: string; timeoutMs: number; usage?: UsageContext; scope?: 'INDIA' | 'GLOBAL'; domains?: string[]; maxResults?: number; depth?: 'basic' | 'advanced' };

export async function tavilySearch(query: string, opts: SearchOpts): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('AI_ENGINE_NOT_CONFIGURED: TAVILY_API_KEY is missing');
  // Every request is budget-checked and metered (advanced depth = 2 credits, basic = 1). A request that was sent and then failed or
  // timed out is booked at its credits (ESTIMATED); one that never reached Tavily is booked at ₹0.
  return meteredSearch({ provider: 'tavily', depth: opts.depth ?? 'advanced' }, opts.usage, () => tavilyRequest(key, query, opts));
}

async function tavilyRequest(key: string, query: string, opts: SearchOpts): Promise<TavilyResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, opts.timeoutMs));
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: opts.depth ?? 'advanced',
        ...((opts.depth ?? 'advanced') === 'advanced' ? { chunks_per_source: 3 } : {}),
        max_results: Math.min(5, opts.maxResults ?? 3),
        include_answer: false,
        include_raw_content: opts.deep ? 'text' : false,
        ...(opts.scope !== 'GLOBAL' && /india/i.test(opts.geography || 'India') ? { country: 'india' } : {}),
        ...(opts.domains?.length ? { include_domains: opts.domains } : {}),
      }),
    });
    if (!res.ok) throw sent(new Error(`TAVILY_ERROR ${res.status}: ${(await res.text()).slice(0, 200)}`), { httpStatus: res.status });
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw sent(new Error(`TAVILY_TIMEOUT after ${Math.round(opts.timeoutMs / 1000)}s`));
    if (e instanceof Error && !(e as { providerPhase?: string }).providerPhase) Object.assign(e, { providerPhase: fetchFailurePhase(e) });
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// 3. EXTRACT (source text only) + server-side quote verification
// ---------------------------------------------------------------------------
export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ANSWERED', 'PARTIAL', 'NOT_FOUND', 'CONTRADICTORY'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' }, sourceId: { type: 'string' }, quote: { type: 'string' }, confidence: { type: 'string', enum: [...CONFIDENCE] },
          evidenceType: { type: 'string', enum: [...EVIDENCE_TYPES] }, geography: { type: 'string' }, sourceDate: { type: 'string' }, analogy: { type: 'string' },
        },
        required: ['statement', 'sourceId', 'quote', 'confidence', 'evidenceType', 'geography'],
      },
    },
  },
  required: ['status', 'findings'],
};

/** `analogues`: escalation rounds that searched beyond direct evidence — comparable cases are then worth keeping. */
export function buildExtractPrompt(q: Pick<ResearchQuestion, 'question' | 'whyItMatters'>, sources: ResearchSource[], contentOf: (s: ResearchSource) => string, opts: { geography?: string; analogues?: boolean } = {}): string {
  const geo = opts.geography || 'India';
  return `You extract evidence for ONE research question, using ONLY the source texts below.
You must NOT use your own knowledge. If the sources do not answer the question, return status NOT_FOUND and no findings.

QUESTION: ${q.question}
WHY IT MATTERS: ${q.whyItMatters}
TARGET GEOGRAPHY: ${geo}

${sources.map((s) => `[${s.id}] ${s.title}\nURL: ${s.url}\nTEXT:\n${contentOf(s)}`).join('\n\n----\n\n')}

Rules:
- Each finding: a short plain-English statement relevant to the question, the sourceId it comes from, and a
  "quote" copied EXACTLY (verbatim, 8–40 words) from that source's TEXT that supports the statement.
- Prefer concrete facts: named competitors, prices (₹), counts, dates, legal requirements, stated customer behaviour.
- Never generalise beyond what the quote says. Never combine sources into one finding.
- evidenceType: DIRECT if the source speaks to this question for ${geo} and this kind of business;
  ANALOGOUS if it describes a comparable case (another country, customer segment or industry) that only informs it.
  ${opts.analogues ? 'Analogous evidence IS wanted here: keep the closest comparable cases (named companies, prices, adoption, rules), and for each fill "analogy" with what the case is and why it is only an analogue.' : 'Prefer DIRECT evidence; keep an analogue only if it is clearly relevant, and explain it in "analogy".'}
- geography: the country / region the finding is about, as the source states it (e.g. "India", "United States", "Global").
- sourceDate: a date or year the source TEXT itself states for this fact (e.g. "2024", "March 2025"), else "".
- status: ANSWERED (clearly answered with DIRECT evidence), PARTIAL (only partly, or only analogues), CONTRADICTORY (sources disagree), NOT_FOUND.
- At most 5 findings.`;
}

export const normaliseForMatch = (s: string) => s.toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/[^a-z0-9₹%.]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Keep only findings whose verbatim quote really appears in the cited source retrieved for this question. */
export function verifyFindings(raw: unknown, questionId: string, sources: ResearchSource[], contentOf: (s: ResearchSource) => string, startIndex: number): { status: QuestionStatus; findings: Finding[]; rejected: number } {
  const r = (raw ?? {}) as { status?: string; findings?: unknown[] };
  const byId = new Map(sources.map((s) => [s.id, s]));
  let rejected = 0;
  const findings: Finding[] = [];
  for (const x of arr(r.findings).slice(0, 5)) {
    const f = x as Record<string, unknown>;
    const src = byId.get(str(f.sourceId, 10));
    const quote = str(f.quote, 600);
    const nq = normaliseForMatch(quote);
    if (!src || nq.length < 12 || !normaliseForMatch(contentOf(src)).includes(nq) || !str(f.statement, 400)) { rejected++; continue; }
    const evidenceType = (EVIDENCE_TYPES.includes(f.evidenceType as EvidenceType) ? f.evidenceType : 'DIRECT') as EvidenceType;
    // A date is kept only if the source text really states it: the model may not date a fact on its own.
    const date = str(f.sourceDate, 40);
    const sourceDate = date && normaliseForMatch(contentOf(src)).includes(normaliseForMatch(date)) ? date : undefined;
    const geography = str(f.geography, 60) || undefined;
    const analogy = evidenceType === 'ANALOGOUS' ? str(f.analogy, 300) || undefined : undefined;
    findings.push({
      id: `R${startIndex + findings.length}`, questionId, statement: str(f.statement, 400), sourceId: src.id, quote: quote.slice(0, 400),
      confidence: (CONFIDENCE.includes(f.confidence as Confidence) ? f.confidence : 'MEDIUM') as Confidence,
      evidenceType, ...(geography ? { geography } : {}), ...(sourceDate ? { sourceDate } : {}), ...(analogy ? { analogy } : {}),
    });
  }
  let status = (QUESTION_STATUS.includes(r.status as QuestionStatus) ? r.status : 'NOT_FOUND') as QuestionStatus;
  if (findings.length === 0) status = 'NOT_FOUND';
  else if (!findings.some((f) => f.evidenceType !== 'ANALOGOUS')) status = 'ANALOGOUS'; // an analogue never answers a question
  else if (status === 'NOT_FOUND' || status === 'ANALOGOUS' || status === 'SEARCH_FAILED') status = 'PARTIAL';
  return { status, findings, rejected };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
const remaining = (deadline: number) => deadline - Date.now();

/** A research.json checkpoint written right after planning, so a retry never repeats a completed plan. */
const isBudgetRefusal = (e: unknown) => e instanceof Error && /AI_BUDGET_EXCEEDED/.test(e.message);

export const isPlanCheckpoint = (r: ResearchRecord | null | undefined): r is ResearchRecord & { stage: 'PLANNED'; plan: ResearchPlan } => r?.version === 2 && r.stage === 'PLANNED' && Boolean(r.plan);
export const planCheckpoint = (plan: ResearchPlan, at: Date): ResearchRecord => ({ version: 2, stage: 'PLANNED', retrievedAt: at.toISOString(), queries: plan.questions.map((q) => q.query), sources: [], businessModel: plan.businessModel, plan });

export async function researchBusiness(input: ResearchInput, deadline: number, now = () => new Date(), opts: { plan?: ResearchPlan | null; onPlan?: (checkpoint: ResearchRecord) => Promise<void>; usage?: UsageContext; planOnly?: boolean } = {}): Promise<ResearchRecord> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, tavilySearches: 0 };

  // 1. PLAN (or reuse the plan saved by an earlier attempt)
  let planResult = opts.plan ?? null;
  if (!planResult) {
    const timeoutMs = planTimeoutMs(remaining(deadline));
    if (timeoutMs < PLAN_MIN_MS) throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: not enough time left to plan research');
    const plan = await aristotleGeminiJson<unknown>('research-plan', { label: 'research-plan', prompt: buildPlanPrompt(input), schema: PLAN_SCHEMA, maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, temperature: 0.1, timeoutMs, fastThinking: true }, opts.usage);
    usage.inputTokens += plan.inputTokens; usage.outputTokens += plan.outputTokens;
    planResult = normalisePlan(plan.data);
    if (opts.onPlan) await opts.onPlan(planCheckpoint(planResult, now()));
  }
  // Job runtime: stop at the durable plan checkpoint so the next step starts in a fresh time budget.
  if (opts.planOnly) return planCheckpoint(planResult, now());
  const { businessModel, questions: planned } = planResult;

  // 2. SEARCH (parallel)
  const searchTimeout = Math.min(15000, remaining(deadline) - 22000);
  if (searchTimeout < 4000) throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: not enough time left to research');
  const searched = await Promise.allSettled(planned.map((q) => tavilySearch(q.query, { deep: q.category === 'REGULATION' || q.category === 'ALTERNATIVES_PRICING', geography: input.geography, timeoutMs: searchTimeout, usage: opts.usage })));
  usage.tavilySearches = planned.length;
  // A search refused by the cost governor is not a "failed search": research would silently lose quality. Stop instead.
  const refusedSearch = searched.find((x) => x.status === 'rejected' && isBudgetRefusal(x.reason));
  if (refusedSearch) throw (refusedSearch as PromiseRejectedResult).reason;
  if (searched.every((s) => s.status === 'rejected')) {
    throw new Error(`RESEARCH_FAILED: all searches failed (${(searched[0] as PromiseRejectedResult).reason instanceof Error ? ((searched[0] as PromiseRejectedResult).reason as Error).message : 'unknown'})`);
  }

  const sources: ResearchSource[] = [];
  const fullText = new Map<string, string>();
  const perQuestion = new Map<string, ResearchSource[]>();
  const retrievedAt = now().toISOString();
  planned.forEach((q, i) => {
    const res = searched[i];
    const list: ResearchSource[] = [];
    if (res.status === 'fulfilled') {
      for (const r of res.value) {
        if (!r.url) continue;
        let src = sources.find((s) => s.url === r.url);
        const text = `${r.content || ''}\n${r.raw_content || ''}`.trim();
        if (!src) {
          src = { id: `S${sources.length + 1}`, title: str(r.title, 200) || 'Untitled', url: r.url, snippet: str(r.content, 600), content: text.slice(0, STORED_CONTENT_CHARS), query: q.query, questionId: q.id, retrievedAt };
          sources.push(src);
          fullText.set(src.id, text.slice(0, SOURCE_CONTENT_CHARS));
        } else if (text.length > (fullText.get(src.id)?.length || 0)) {
          fullText.set(src.id, text.slice(0, SOURCE_CONTENT_CHARS));
        }
        if (!list.includes(src)) list.push(src);
      }
    }
    perQuestion.set(q.id, list);
  });
  const contentOf = (s: ResearchSource) => fullText.get(s.id) || s.content || s.snippet;

  // 3. EXTRACT (parallel, source text only)
  const extractTimeout = Math.min(15000, remaining(deadline) - 16000);
  if (extractTimeout < 4000) throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: not enough time left to extract evidence');
  const extracted = await Promise.allSettled(planned.map(async (q) => {
    const srcs = perQuestion.get(q.id)!;
    if (srcs.length === 0) return null; // nothing to read → NOT FOUND without an AI call
    const r = await aristotleGeminiJson<unknown>('research-extract', { label: `extract-${q.id}`, prompt: buildExtractPrompt(q, srcs, contentOf, { geography: input.geography }), schema: EXTRACT_SCHEMA, maxOutputTokens: 1500, temperature: 0, timeoutMs: extractTimeout }, opts.usage);
    usage.inputTokens += r.inputTokens; usage.outputTokens += r.outputTokens;
    return r.data;
  }));

  const refusedExtract = extracted.find((x) => x.status === 'rejected' && isBudgetRefusal(x.reason));
  if (refusedExtract) throw (refusedExtract as PromiseRejectedResult).reason;

  const findings: Finding[] = [];
  const questions: ResearchQuestion[] = planned.map((q, i) => {
    const srcs = perQuestion.get(q.id)!;
    const searchFailed = searched[i].status === 'rejected';
    const ex = extracted[i];
    let status: QuestionStatus = searchFailed ? 'SEARCH_FAILED' : 'NOT_FOUND';
    let qFindings: Finding[] = [];
    let note: string | undefined;
    if (!searchFailed && srcs.length && ex.status === 'fulfilled' && ex.value) {
      const v = verifyFindings(ex.value, q.id, srcs, contentOf, findings.length + 1);
      status = v.status; qFindings = v.findings;
      if (v.rejected) note = `${v.rejected} extracted statement(s) were discarded because their quote could not be found in the source.`;
    } else if (!searchFailed && srcs.length && ex.status === 'rejected') {
      status = 'NOT_FOUND'; note = 'Evidence extraction failed for this question.';
    } else if (searchFailed) {
      note = 'The search for this question failed.';
    } else {
      note = 'The search returned no sources.';
    }
    findings.push(...qFindings.map((f) => ({ ...f, round: 0 })));
    const attempts = [{ round: 0, strategy: 'INITIAL' as const, query: q.query, scope: 'INDIA' as const, sources: srcs.length, newSources: srcs.length, findings: qFindings.length, ...(searchFailed ? { failed: true } : {}) }];
    return { ...q, status, sourceIds: srcs.map((s) => s.id), findingIds: qFindings.map((f) => f.id), attempts, ...(note ? { note } : {}) };
  });

  // Not the end of research: unanswered questions are escalated before the decision memo (research-escalation.ts).
  return { version: 2, retrievedAt, queries: planned.map((q) => q.query), sources, businessModel, questions, findings, usage, escalation: { roundsDone: 0, complete: false } };
}

/** Complete (searched) v2 research whose escalation has not finished — including research saved before escalation existed. */
export const needsEscalation = (r: ResearchRecord | null | undefined): boolean => Boolean(r && r.version === 2 && !r.stage && !r.escalation?.complete);

/** Compact, citation-ready research brief for the decision stage. */
export function researchBrief(r: ResearchRecord): string {
  const bm = r.businessModel;
  const lines: string[] = [];
  if (bm) {
    lines.push(`BUSINESS MODEL (as understood before research)`, `Summary: ${bm.summary}`, `Customer: ${bm.customer} | Payer: ${bm.payer}`, `Offering: ${bm.offering} | Revenue: ${bm.revenueMechanism}`,
      `Key activities: ${bm.keyActivities.join('; ') || '—'}`, `Regulated activities: ${bm.regulatedActivities.map((a) => `${a.activity} (${a.whyRegulated})`).join('; ') || 'none identified'}`, '');
  }
  for (const q of r.questions || []) {
    lines.push(`${q.id} [${q.category}${q.activity ? ` · activity: ${q.activity}` : ''}] ${q.question}`, `   STATUS: ${q.status}${q.note ? ` (${q.note})` : ''}`);
    if (q.attempts?.length) lines.push(`   RESEARCHED: ${researchTrail(q, r)}`);
    for (const f of (r.findings || []).filter((x) => x.questionId === q.id)) {
      const s = r.sources.find((x) => x.id === f.sourceId);
      const tags = [f.evidenceType || 'DIRECT', f.geography, f.sourceDate].filter(Boolean).join(' · ');
      lines.push(`   ${f.id} (${f.confidence}, ${tags}, from ${f.sourceId}${s ? ` — ${s.title}` : ''}): ${f.statement}${f.analogy ? ` [analogue: ${f.analogy}]` : ''}`);
    }
    if (q.gap) {
      lines.push(`   NOT ESTABLISHED FROM PUBLIC EVIDENCE. Closest evidence: ${q.gap.closestEvidence}`, `   Implication (inference): ${q.gap.implication}`,
        `   Still unknown: ${q.gap.stillUnknown}`, `   Cheapest way to find out (${q.gap.resolveBy.kind}): ${q.gap.resolveBy.action}`);
    } else if (q.status !== 'ANSWERED' && !(r.findings || []).some((x) => x.questionId === q.id)) {
      lines.push('   OPEN: not yet established by the searches so far.');
    }
  }
  if (r.escalation?.stoppedReason) lines.push('', `NOTE: ${r.escalation.stoppedReason}`);
  return lines.join('\n');
}

const STRATEGY_LABEL: Record<string, string> = {
  INITIAL: 'first search', REFORMULATED: 'reformulated query', INDIA_PRIMARY: 'Indian regulators / government / filings',
  INDIA_COMPANIES: 'Indian company websites', INDIA_SECONDARY: 'Indian business press', COMPETITOR_EXAMPLES: 'competitor / product examples',
  GLOBAL: 'global sources', INDUSTRY_REPORTS: 'industry & academic reports', INTERNATIONAL_ANALOGUE: 'international analogues',
  CROSS_INDUSTRY_ANALOGUE: 'cross-industry analogues',
};
export const strategyLabel = (s: string) => STRATEGY_LABEL[s] || s.toLowerCase();

/** One line: how many searches, which avenues, how many distinct sources were read. */
export function researchTrail(q: Pick<ResearchQuestion, 'attempts' | 'sourceIds'>, r?: Pick<ResearchRecord, 'sources'>): string {
  const attempts = q.attempts || [];
  const avenues = [...new Set(attempts.map((a) => strategyLabel(a.strategy)))];
  const failed = attempts.filter((a) => a.failed).length;
  const srcCount = new Set(q.sourceIds).size;
  const hosts = r ? [...new Set(q.sourceIds.map((id) => r.sources.find((s) => s.id === id)?.url).filter(Boolean).map((u) => { try { return new URL(u!).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean))].slice(0, 6) : [];
  return `${attempts.length} search${attempts.length === 1 ? '' : 'es'} (${avenues.join(', ')})${failed ? `, ${failed} failed` : ''}; ${srcCount} source${srcCount === 1 ? '' : 's'} read${hosts.length ? ` (${hosts.join(', ')})` : ''}`;
}

export type GapExplanation = { lead: string; checked: string; closest?: string; closestIds: string[]; implication?: string; resolve?: string; stopped?: string };
const RESOLVE_LABEL: Record<string, string> = { EXPERIMENT: 'Experiment', INTERVIEW: 'Interviews', DATA_REQUEST: 'Data request' };

/**
 * What Hippo tells the founder about a question research could not settle — never a bare "no evidence found":
 * what was checked, the closest evidence, what it implies, and the cheapest way to find out. Null when answered.
 */
export function gapExplanation(q: ResearchQuestion, r: Pick<ResearchRecord, 'sources' | 'escalation'>): GapExplanation | null {
  if (q.status === 'ANSWERED') return null;
  const lead = q.status === 'ANALOGOUS' ? 'I couldn’t find direct evidence for this business here — only comparable cases.'
    : q.status === 'PARTIAL' ? 'I could only partly establish this from public evidence.'
    : q.status === 'CONTRADICTORY' ? 'Public sources disagree on this.'
    : 'I couldn’t establish this from public evidence.';
  const checked = q.attempts?.length ? `I checked ${researchTrail(q, r)}.` : `I searched “${q.query}”.`;
  if (!q.gap) {
    return { lead, checked: `${checked} This report was produced before Aristotle widened research automatically, so only the first search was made.`, closestIds: [] };
  }
  return {
    lead, checked, closest: q.gap.closestEvidence, closestIds: q.gap.closestEvidenceIds, implication: q.gap.implication,
    resolve: `${RESOLVE_LABEL[q.gap.resolveBy.kind] || 'Next step'}: ${q.gap.resolveBy.action}`,
    ...(r.escalation?.stoppedReason ? { stopped: r.escalation.stoppedReason } : {}),
  };
}
