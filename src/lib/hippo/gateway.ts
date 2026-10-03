// Model gateway + router. Hippoturtle code asks for a TASK, never a provider or model: the router picks the model,
// and every call (model or search) is metered into the AiUsage ledger with that model's own price.
// Server-only (keys never reach the browser).
import { AiBudgetError, callCeilingInr, freeDailyCapInr, maxCallCostInr, metered, priceFor, recordUsage, spentTodayInr, type CallSpec, type ModelTier, type UsageContext, type UsagePurpose } from '../ai-usage';
import { callGeminiJson, cleanJson, geminiModel, type GeminiResult } from '../gemini';

export type AiProvider = 'gemini' | 'openai' | 'anthropic';
export type AiTask = 'understand' | 'pathways' | 'plan' | 'brief' | 'execute' | 'compare' | 'explore';
/** Aristotle engine calls (always Gemini: its prompts rely on Gemini response schemas and thinking settings). */
export type AristotleTask = 'research-plan' | 'research-extract' | 'decision' | 'scope-classifier';

/**
 * Purpose + tier per task. Purpose separates spend by product area in the ledger; tier is the reasoning level the task
 * needs (0 cheap … 3 orchestration). `free`: reachable before any payment, so it counts against the platform's daily
 * free-tier cap. Later phases add CONVERSATION / THINK_TANK tasks here; nothing else needs to change.
 */
export const TASK_ROUTE: Record<AiTask | AristotleTask | 'research-search', { purpose: UsagePurpose; tier: ModelTier; free?: boolean }> = {
  understand: { purpose: 'ARISTOTLE', tier: 0, free: true },
  'scope-classifier': { purpose: 'ARISTOTLE', tier: 0, free: true },
  explore: { purpose: 'OPPORTUNITY', tier: 1, free: true },
  'research-plan': { purpose: 'RESEARCH', tier: 1 },
  'research-extract': { purpose: 'RESEARCH', tier: 0 },
  'research-search': { purpose: 'RESEARCH', tier: 0 },
  decision: { purpose: 'ARISTOTLE', tier: 2 },
  pathways: { purpose: 'ARISTOTLE', tier: 2 },
  plan: { purpose: 'WORK', tier: 1 },
  brief: { purpose: 'WORK', tier: 1 },
  execute: { purpose: 'WORK', tier: 1 },
  compare: { purpose: 'WORK', tier: 0 },
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

export type GatewayResult<T> = { data: T; provider: AiProvider; model: string; task: AiTask; inputTokens: number; outputTokens: number; costInr: number; ms: number };

export class AiNotConfiguredError extends Error { constructor() { super('AI_ENGINE_NOT_CONFIGURED: no AI provider key is configured'); } }

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`AI_ERROR (${label}): HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`AI_ERROR (${label}): timed out`);
    throw e;
  } finally { clearTimeout(t); }
}

function parse<T>(text: string, label: string): T {
  try { return JSON.parse(cleanJson(text)) as T; } catch { throw new Error(`AI_ERROR (${label}): response was not valid JSON`); }
}

/** Refuses (and records) a call whose worst case exceeds the per-call ceiling, or a free-tier call over today's cap. */
async function guard(spec: CallSpec, free: boolean, promptChars: number, maxOutputTokens: number, context?: UsageContext) {
  const price = await priceFor(spec.provider, spec.model);
  const worst = maxCallCostInr(promptChars, maxOutputTokens, price);
  let refusal: string | null = worst > callCeilingInr() ? `call ceiling ₹${callCeilingInr()} < worst case ₹${worst.toFixed(2)} for ${spec.provider}/${spec.model}` : null;
  if (!refusal && free) {
    try {
      const spent = await spentTodayInr(FREE_TASKS);
      if (spent >= freeDailyCapInr()) refusal = `free-tier daily cap ₹${freeDailyCapInr()} reached (₹${spent.toFixed(2)} spent today)`;
    } catch (e) { console.error(JSON.stringify({ event: 'free_cap_check_failed', error: e instanceof Error ? e.message : String(e) })); }
  }
  if (refusal) {
    await recordUsage({ ...spec, costInr: 0, estimatedInr: worst, price, durationMs: 0, outcome: 'REFUSED_BUDGET', error: refusal, context });
    throw new AiBudgetError(refusal);
  }
  return worst;
}

export async function generateJson<T>(task: AiTask, prompt: string, schema: unknown, overrides: Partial<(typeof TASK_CONFIG)[AiTask]> = {}, usage?: UsageContext): Promise<GatewayResult<T>> {
  const route = TASK_ROUTE[task];
  const active = routeModel(route.tier);
  if (!active) throw new AiNotConfiguredError();
  const cfg = { ...TASK_CONFIG[task], ...overrides };
  const spec: CallSpec = { kind: 'MODEL', purpose: route.purpose, task, tier: route.tier, provider: active.provider, model: active.model };
  const worst = await guard(spec, Boolean(route.free), prompt.length + JSON.stringify(schema).length, cfg.maxOutputTokens, usage);

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
      try { return { result: parse<T>(j.choices?.[0]?.message?.content || '', task), measured }; } catch (e) { throw Object.assign(e as Error, { measured }); }
    }
    const j = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: active.model, max_tokens: cfg.maxOutputTokens, temperature: cfg.temperature,
        system: `Reply with ONLY one JSON object matching this JSON Schema, no prose:\n${JSON.stringify(schema)}`, messages: [{ role: 'user', content: prompt }] }),
    }, cfg.timeoutMs, `hippo:${task}`);
    // Anthropic reports cache reads/writes separately from input_tokens; the ledger counts all prompt tokens as input.
    const cacheRead = j.usage?.cache_read_input_tokens || 0;
    const measured = { inputTokens: (j.usage?.input_tokens || 0) + cacheRead + (j.usage?.cache_creation_input_tokens || 0), outputTokens: j.usage?.output_tokens || 0, cachedTokens: cacheRead };
    try { return { result: parse<T>((j.content || []).map((c: { text?: string }) => c.text || '').join(''), task), measured }; } catch (e) { throw Object.assign(e as Error, { measured }); }
  }, worst);
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
  const worst = await guard(spec, Boolean(route.free), opts.prompt.length + JSON.stringify(opts.schema).length, opts.maxOutputTokens, usage);
  const { result } = await metered<GeminiResult<T>>(spec, usage, async () => {
    const r = await callGeminiJson<T>({ ...opts, model });
    return { result: r, measured: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, reasoningTokens: r.thinkingTokens, retries: r.retries } };
  }, worst);
  return result;
}

/** One web-search request, metered by credits (Tavily: basic = 1, advanced = 2). Failed requests are recorded at no cost. */
export async function meteredSearch<T>(opts: { provider: 'tavily'; depth: 'basic' | 'advanced'; task?: 'research-search' }, usage: UsageContext | undefined, run: () => Promise<T>): Promise<T> {
  const task = opts.task ?? 'research-search';
  const credits = opts.depth === 'advanced' ? 2 : 1;
  const spec: CallSpec = { kind: 'SEARCH', purpose: TASK_ROUTE[task].purpose, task, tier: TASK_ROUTE[task].tier, provider: opts.provider, model: 'search' };
  const { result } = await metered<T>(spec, usage, async () => ({ result: await run(), measured: { searchCalls: 1, searchCredits: credits } }));
  return result;
}

/** Safe metadata for logs: never prompts, keys or outputs. */
export const aiMeta = (r: GatewayResult<unknown>) => ({ provider: r.provider, model: r.model, task: r.task, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costInr: r.costInr, ms: r.ms });
