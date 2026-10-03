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
//
// All stages run under a shared deadline so the whole audit fits the serverless time limit.
// ---------------------------------------------------------------------------
import { fetchFailurePhase, sent, type UsageContext } from './ai-usage';
import { aristotleGeminiJson, meteredSearch } from './hippo/gateway';
import {
  CONFIDENCE, QUESTION_STATUS, RESEARCH_CATEGORIES,
  type BusinessModel, type Confidence, type Finding, type QuestionStatus, type ResearchCategory, type ResearchQuestion, type ResearchRecord, type ResearchSource,
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
const SOURCE_CONTENT_CHARS = 6000;   // per source, sent to the extractor
const STORED_CONTENT_CHARS = 2500;   // per source, persisted in research.json for traceability

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

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
type TavilyResult = { title?: string; url?: string; content?: string; raw_content?: string | null };

export async function tavilySearch(query: string, opts: { deep: boolean; geography?: string; timeoutMs: number; usage?: UsageContext }): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('AI_ENGINE_NOT_CONFIGURED: TAVILY_API_KEY is missing');
  // Every request is budget-checked and metered (2 credits: advanced depth). A request that was sent and then failed or
  // timed out is booked at its credits (ESTIMATED); one that never reached Tavily is booked at ₹0.
  return meteredSearch({ provider: 'tavily', depth: 'advanced' }, opts.usage, () => tavilyRequest(key, query, opts));
}

async function tavilyRequest(key: string, query: string, opts: { deep: boolean; geography?: string; timeoutMs: number }): Promise<TavilyResult[]> {
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
        search_depth: 'advanced',
        chunks_per_source: 3,
        max_results: 3,
        include_answer: false,
        include_raw_content: opts.deep ? 'text' : false,
        ...(/india/i.test(opts.geography || 'India') ? { country: 'india' } : {}),
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
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ANSWERED', 'PARTIAL', 'NOT_FOUND', 'CONTRADICTORY'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { statement: { type: 'string' }, sourceId: { type: 'string' }, quote: { type: 'string' }, confidence: { type: 'string', enum: [...CONFIDENCE] } },
        required: ['statement', 'sourceId', 'quote', 'confidence'],
      },
    },
  },
  required: ['status', 'findings'],
};

export function buildExtractPrompt(q: Pick<ResearchQuestion, 'question' | 'whyItMatters'>, sources: ResearchSource[], contentOf: (s: ResearchSource) => string): string {
  return `You extract evidence for ONE research question, using ONLY the source texts below.
You must NOT use your own knowledge. If the sources do not answer the question, return status NOT_FOUND and no findings.

QUESTION: ${q.question}
WHY IT MATTERS: ${q.whyItMatters}

${sources.map((s) => `[${s.id}] ${s.title}\nURL: ${s.url}\nTEXT:\n${contentOf(s)}`).join('\n\n----\n\n')}

Rules:
- Each finding: a short plain-English statement relevant to the question, the sourceId it comes from, and a
  "quote" copied EXACTLY (verbatim, 8–40 words) from that source's TEXT that supports the statement.
- Prefer concrete facts: named competitors, prices (₹), counts, dates, legal requirements, stated customer behaviour.
- Never generalise beyond what the quote says. Never combine sources into one finding.
- status: ANSWERED (clearly answered), PARTIAL (only partly), CONTRADICTORY (sources disagree), NOT_FOUND.
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
    findings.push({
      id: `R${startIndex + findings.length}`, questionId, statement: str(f.statement, 400), sourceId: src.id, quote: quote.slice(0, 400),
      confidence: (CONFIDENCE.includes(f.confidence as Confidence) ? f.confidence : 'MEDIUM') as Confidence,
    });
  }
  let status = (QUESTION_STATUS.includes(r.status as QuestionStatus) ? r.status : 'NOT_FOUND') as QuestionStatus;
  if (findings.length === 0) status = 'NOT_FOUND';
  else if (status === 'NOT_FOUND') status = 'PARTIAL';
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
    const r = await aristotleGeminiJson<unknown>('research-extract', { label: `extract-${q.id}`, prompt: buildExtractPrompt(q, srcs, contentOf), schema: EXTRACT_SCHEMA, maxOutputTokens: 1500, temperature: 0, timeoutMs: extractTimeout }, opts.usage);
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
    findings.push(...qFindings);
    return { ...q, status, sourceIds: srcs.map((s) => s.id), findingIds: qFindings.map((f) => f.id), ...(note ? { note } : {}) };
  });

  return { version: 2, retrievedAt, queries: planned.map((q) => q.query), sources, businessModel, questions, findings, usage };
}

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
    for (const f of (r.findings || []).filter((x) => x.questionId === q.id)) {
      const s = r.sources.find((x) => x.id === f.sourceId);
      lines.push(`   ${f.id} (${f.confidence}, from ${f.sourceId}${s ? ` — ${s.title}` : ''}): ${f.statement}`);
    }
    if (q.status !== 'ANSWERED' && !(r.findings || []).some((x) => x.questionId === q.id)) lines.push('   NO EVIDENCE FOUND — this is an open question.');
  }
  return lines.join('\n');
}
