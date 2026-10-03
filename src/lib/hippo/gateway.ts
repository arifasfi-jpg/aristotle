// Model gateway + router. Hippoturtle code asks for a TASK, never a provider or model: the router picks the model,
// and every call (model or search) is metered into the AiUsage ledger with that model's own price.
// Server-only (keys never reach the browser).
import { AiBudgetError, allowUnpriced, ledgerEnabled, callCeilingInr, freeDailyCapInr, metered, modelCallEstimate, priceFor, recordUsage, releaseReservation, reserveBudget, searchCallEstimate, spentTodayInr, UNPRICED, type CallEstimate, type CallSpec, type ModelTier, type Price, type UsageContext, type UsagePurpose } from '../ai-usage';
import { budgetStatus, decideNext, type GovernorDecision } from '../cost-governor';
import { fetchFailurePhase, sent } from '../ai-usage';
import { callGeminiJson, cleanJson, geminiModel, type GeminiResult } from '../gemini';

export type AiProvider = 'gemini' | 'openai' | 'anthropic';
export type AiTask = 'understand' | 'pathways' | 'plan' | 'brief' | 'execute' | 'compare' | 'explore' | 'converse' | 'move' | 'move-prepare';
/** Aristotle engine calls (always Gemini: its prompts rely on Gemini response schemas and thinking settings). */
export type AristotleTask = 'research-plan' | 'research-extract' | 'research-escalate' | 'research-gap' | 'decision' | 'scope-classifier';

/**
 * Purpose + tier per task. Purpose separates spend by product area in the ledger; tier is the reasoning level the task
 * needs (0 cheap … 3 orchestration). `free`: reachable before any payment, so it counts against the platform's daily
 * free-tier cap. Later phases add CONVERSATION / THINK_TANK tasks here; nothing else needs to change.
 */
export const TASK_ROUTE: Record<AiTask | AristotleTask | 'research-search', { purpose: UsagePurpose; tier: ModelTier; free?: boolean }> = {
  understand: { purpose: 'ARISTOTLE', tier: 0, free: true },
  converse: { purpose: 'CONVERSATION', tier: 0, free: true }, // Hippo chat turns: cheapest tier, free-tier capped
  'scope-classifier': { purpose: 'ARISTOTLE', tier: 0, free: true },
  explore: { purpose: 'OPPORTUNITY', tier: 1, free: true },
  'research-plan': { purpose: 'RESEARCH', tier: 1 },
  'research-extract': { purpose: 'RESEARCH', tier: 0 },
  'research-escalate': { purpose: 'RESEARCH', tier: 1 }, // follow-up queries for questions the first search did not settle
  'research-gap': { purpose: 'RESEARCH', tier: 1 },      // what remains unknown after escalation, and how to find out
  'research-search': { purpose: 'RESEARCH', tier: 0 },
  decision: { purpose: 'ARISTOTLE', tier: 2 },
  pathways: { purpose: 'ARISTOTLE', tier: 2 },
  plan: { purpose: 'WORK', tier: 1 },
  brief: { purpose: 'WORK', tier: 1 },
  execute: { purpose: 'WORK', tier: 1 },
  compare: { purpose: 'WORK', tier: 0 },
  // Moves (HIPPO_MOVES): choosing the next Move and preparing what it needs. Free to the founder, so free-tier capped.
  move: { purpose: 'WORK', tier: 1, free: true },
  'move-prepare': { purpose: 'WORK', tier: 1, free: true },
};
export const FREE_TASKS = Object.entries(TASK_ROUTE).filter(([, r]) => r.free).map(([t]) => t);

export const TASK_CONFIG: Record<AiTask, { temperature: number; maxOutputTokens: number; timeoutMs: number }> = {
  understand: { temperature: 0.2, maxOutputTokens: 1500, timeoutMs: 15_000 },
  pathways: { temperature: 0.4, maxOutputTokens: 7000, timeoutMs: 50_000 },
  plan: { temperature: 0.3, maxOutputTokens: 4000, timeoutMs: 45_000 },
  brief: { temperature: 0.2, maxOutputTokens: 3500, timeoutMs: 40_000 },
  execute: { temperature: 0.5, maxOutputTokens: 9000, timeoutMs: 52_000 },
  compare: { temperature: 0.2, maxOutputTokens: 1200, timeoutMs: 25_000 },
  explore: { temperature: 0.8, maxOutputTokens: 2000, timeoutMs: 25_000 },
  converse: { temperature: 0.6, maxOutputTokens: 900, timeoutMs: 15_000 },
  move: { temperature: 0.4, maxOutputTokens: 2500, timeoutMs: 20_000 },
  'move-prepare': { temperature: 0.5, maxOutputTokens: 4000, timeoutMs: 22_000 },
};

const MODEL_ENV: Record<AiProvider, [string, string, string]> = {
  gemini: ['GEMINI_API_KEY', 'GEMINI_MODEL', 'gemini-3.5-flash-lite'],
  openai: ['OPENAI_API_KEY', 'OPENAI_MODEL', 'gpt-5.6-luna'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'claude-opus-5-5'],
};

/**
 * Model for a tier. `HIPPO_TIER<n>_MODEL="provider:model"` (when that provider has a key) overrides per tier, so a
 * tier can move to another model with configuration only; otherwise the active provider's configured model.
 */
export function routeModel(tier: ModelTier): { provider: AiProvider; model: string } | null {
  const raw = process.env[`HIPPO_TIER${tier}_MODEL`];
  const m = raw?.match(/^(gemini|openai|anthropic):(.+)$/);
  if (m && process.env[MODEL_ENV[m[1] as AiProvider][0]]) return { provider: m[1] as AiProvider, model: m[2].trim() };
  return activeProvider();
}

/** Explicit HIPPO_AI_PROVIDER wins; otherwise the first provider with a configured key. */
export function activeProvider(): { provider: AiProvider; model: string } | null {
  const order: AiProvider[] = ['gemini', 'openai', 'anthropic'];
  const pref = process.env.HIPPO_AI_PROVIDER as AiProvider | undefined;
  const list = pref && order.includes(pref) ? [pref] : order;
  for (const p of list) {
    const [key, modelVar, def] = MODEL_ENV[p];
    if (process.env[key]) return { provider: p, model: process.env[modelVar] || def };
  }
  return null;
}

/** ModelPrice of the model that would execute WORK today (used for AI cost estimates; same price the ledger uses). */
export async function executionPrice(): Promise<Price> {
  const m = routeModel(TASK_ROUTE.execute.tier);
  return m ? priceFor(m.provider, m.model) : UNPRICED;
}

export type GatewayResult<T> = { data: T; provider: AiProvider; model: string; task: AiTask; inputTokens: number; outputTokens: number; costInr: number; ms: number };

export class AiNotConfiguredError extends Error { constructor() { super('AI_ENGINE_NOT_CONFIGURED: no AI provider key is configured'); } }

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw sent(new Error(`AI_ERROR (${label}): HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { httpStatus: res.status });
    return await res.json();
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw sent(new Error(`AI_ERROR (${label}): timed out`));
    if (e instanceof Error && !(e as { providerPhase?: string }).providerPhase) Object.assign(e, { providerPhase: fetchFailurePhase(e) });
    throw e;
  } finally { clearTimeout(t); }
}

function parse<T>(text: string, label: string): T {
  try { return JSON.parse(cleanJson(text)) as T; } catch { throw new Error(`AI_ERROR (${label}): response was not valid JSON`); }
}

/** A refusal by the cost governor; `governor` carries the decision, state and amounts for the caller / founder. */
export class CostGovernorError extends AiBudgetError {
  constructor(detail: string, readonly governor: GovernorDecision | null) { super(detail); }
}

/**
 * Runs before every provider call. Refuses (and records, at ₹0 / NONE) a call that:
 *   - has no price and unpriced models are not allowed (it could not be budgeted),
 *   - could exceed the platform per-call ceiling (HIPPO_MAX_CALL_INR),
 *   - is a free-tier call and today's free-tier cap is spent,
 *   - would take its budget scope (audit / work / job) over its cumulative limit (cost-governor decideNext).
 * On ALLOW, the call's worst case is reserved against the scope until the call is recorded.
 */
async function guard(spec: CallSpec, free: boolean, estimateFor: (p: Price) => CallEstimate, context?: UsageContext): Promise<{ price: Price; estimate: CallEstimate; release: () => Promise<void> }> {
  const price = await priceFor(spec.provider, spec.model);
  const estimate = estimateFor(price);
  const worst = estimate.worstInr;
  let refusal: string | null = null;
  let governor: GovernorDecision | null = null;
  // With no database there is no ledger and no ModelPrice table (local runs / unit tests): nothing is recorded, so an
  // unpriced call is not refused there — but a budgeted call always needs the ledger.
  if (context?.budget && !ledgerEnabled()) refusal = 'budget ledger unavailable: a budgeted call needs the AiUsage ledger';
  else if (price.status === 'UNPRICED' && ledgerEnabled() && (!allowUnpriced() || context?.budget)) refusal = `no ModelPrice for ${spec.provider}/${spec.model}: the call cannot be budgeted`;
  if (!refusal && worst > callCeilingInr()) refusal = `call ceiling ₹${callCeilingInr()} < worst case ₹${worst.toFixed(2)} for ${spec.provider}/${spec.model}`;
  if (!refusal && free) {
    try {
      const spent = await spentTodayInr(FREE_TASKS);
      if (spent >= freeDailyCapInr()) refusal = `free-tier daily cap ₹${freeDailyCapInr()} reached (₹${spent.toFixed(2)} spent today)`;
    } catch (e) { console.error(JSON.stringify({ event: 'free_cap_check_failed', error: e instanceof Error ? e.message : String(e) })); }
  }
  let release: () => Promise<void> = async () => undefined;
  const b = context?.budget?.scope;
  if (b && ((context?.parentType && context.parentType !== b.type) || (context?.parentId && context.parentId !== b.id))) {
    throw new Error(`COST_GOVERNOR_MISCONFIGURED: usage parent ${context?.parentType}:${context?.parentId} is not budget scope ${b.type}:${b.id}`);
  }
  if (!refusal && context?.budget) {
    // A budgeted call is never made blind: if the ledger cannot be read or written, the call is refused (fail closed).
    // Check + reserve happen in ONE Postgres transaction serialised per scope (see reserveBudget).
    const policy = context.budget;
    try {
      const r = await reserveBudget(policy.scope, worst, { ...spec, priceId: price.id, priceStatus: price.status }, context, (spent, reserved) => {
        const d = decideNext(policy, budgetStatus(policy, spent, reserved), worst);
        return { allow: d.decision === 'ALLOW', decision: d };
      });
      governor = r.decision;
      if (r.reservationId) { const id = r.reservationId; release = () => releaseReservation(id); }
      else refusal = `${governor.decision} [${governor.state}]: ${governor.reason}`;
    } catch (e) { refusal = `budget ledger unavailable: ${e instanceof Error ? e.message : String(e)}`; }
  }
  if (refusal) {
    await recordUsage({ ...spec, costInr: 0, costStatus: 'NONE', estimatedInr: worst, price, durationMs: 0, outcome: 'REFUSED_BUDGET', error: refusal, context });
    throw new CostGovernorError(refusal, governor);
  }
  return { price, estimate, release };
}

export async function generateJson<T>(task: AiTask, prompt: string, schema: unknown, overrides: Partial<(typeof TASK_CONFIG)[AiTask]> = {}, usage?: UsageContext): Promise<GatewayResult<T>> {
  const route = TASK_ROUTE[task];
  const active = routeModel(route.tier);
  if (!active) throw new AiNotConfiguredError();
  const cfg = { ...TASK_CONFIG[task], ...overrides };
  const spec: CallSpec = { kind: 'MODEL', purpose: route.purpose, task, tier: route.tier, provider: active.provider, model: active.model };
  const g = await guard(spec, Boolean(route.free), (p) => modelCallEstimate(prompt.length + JSON.stringify(schema).length, cfg.maxOutputTokens, p), usage);

  const { result: data, costInr, measured, durationMs } = await metered<T>(spec, usage, async () => {
    if (active.provider === 'gemini') {
      const r = await callGeminiJson<T>({ prompt, schema, timeoutMs: cfg.timeoutMs, maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature, label: `hippo:${task}`, model: active.model });
      return { result: r.data, measured: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, reasoningTokens: r.thinkingTokens, retries: r.retries } };
    }
    if (active.provider === 'openai') {
      const j = await fetchJson('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: active.model, temperature: cfg.temperature, max_completion_tokens: cfg.maxOutputTokens, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: `Reply with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` }, { role: 'user', content: prompt }] }),
      }, cfg.timeoutMs, `hippo:${task}`);
      // completion_tokens already include reasoning tokens (billed as output); cached tokens are part of prompt_tokens.
      const measured = { inputTokens: j.usage?.prompt_tokens || 0, outputTokens: j.usage?.completion_tokens || 0, cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens || 0 };
      try { return { result: parse<T>(j.choices?.[0]?.message?.content || '', task), measured }; } catch (e) { throw sent(e as Error, { measured }); }
    }
    const j = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: active.model, max_tokens: cfg.maxOutputTokens, temperature: cfg.temperature,
        system: `Reply with ONLY one JSON object matching this JSON Schema, no prose:\n${JSON.stringify(schema)}`, messages: [{ role: 'user', content: prompt }] }),
    }, cfg.timeoutMs, `hippo:${task}`);
    // Anthropic reports cache reads/writes separately from input_tokens; the ledger counts all prompt tokens as input.
    const cacheRead = j.usage?.cache_read_input_tokens || 0;
    const measured = { inputTokens: (j.usage?.input_tokens || 0) + cacheRead + (j.usage?.cache_creation_input_tokens || 0), outputTokens: j.usage?.output_tokens || 0, cachedTokens: cacheRead };
    try { return { result: parse<T>((j.content || []).map((c: { text?: string }) => c.text || '').join(''), task), measured }; } catch (e) { throw sent(e as Error, { measured }); }
  }, g.estimate, g.price, g.release);
  return { data, provider: active.provider, model: active.model, task, inputTokens: measured.inputTokens ?? 0, outputTokens: measured.outputTokens ?? 0, costInr: Math.round(costInr * 100) / 100, ms: durationMs };
}

/**
 * Aristotle's Gemini calls (research plan, evidence extraction, decision memo, scope classifier), now metered and
 * guarded by the same ledger. Same request, same model, same result shape as calling `callGeminiJson` directly.
 */
export async function aristotleGeminiJson<T>(task: AristotleTask, opts: Parameters<typeof callGeminiJson>[0], usage?: UsageContext): Promise<GeminiResult<T>> {
  const route = TASK_ROUTE[task];
  const model = opts.model || geminiModel();
  const spec: CallSpec = { kind: 'MODEL', purpose: route.purpose, task, tier: route.tier, provider: 'gemini', model };
  const g = await guard(spec, Boolean(route.free), (p) => modelCallEstimate(opts.prompt.length + JSON.stringify(opts.schema).length, opts.maxOutputTokens, p), usage);
  const { result } = await metered<GeminiResult<T>>(spec, usage, async () => {
    const r = await callGeminiJson<T>({ ...opts, model });
    return { result: r, measured: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, reasoningTokens: r.thinkingTokens, retries: r.retries } };
  }, g.estimate, g.price, g.release);
  return result;
}

/**
 * One web-search request, budget-checked and metered by credits (Tavily: basic = 1, advanced = 2). Search cost stays
 * visible in the ledger (kind SEARCH). A request that was sent and failed is booked at its credits (ESTIMATED).
 */
export async function meteredSearch<T>(opts: { provider: 'tavily'; depth: 'basic' | 'advanced'; task?: 'research-search' }, usage: UsageContext | undefined, run: () => Promise<T>): Promise<T> {
  const task = opts.task ?? 'research-search';
  const credits = opts.depth === 'advanced' ? 2 : 1;
  const spec: CallSpec = { kind: 'SEARCH', purpose: TASK_ROUTE[task].purpose, task, tier: TASK_ROUTE[task].tier, provider: opts.provider, model: 'search' };
  const g = await guard(spec, false, (p) => searchCallEstimate(credits, p), usage);
  const { result } = await metered<T>(spec, usage, async () => ({ result: await run(), measured: { searchCalls: 1, searchCredits: credits } }), g.estimate, g.price, g.release);
  return result;
}

/** Safe metadata for logs: never prompts, keys or outputs. */
export const aiMeta = (r: GatewayResult<unknown>) => ({ provider: r.provider, model: r.model, task: r.task, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costInr: r.costInr, ms: r.ms });
