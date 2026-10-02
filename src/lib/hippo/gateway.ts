// Model gateway. Hippoturtle tasks ask for a TASK, not a model: provider, model, temperature,
// token budget and timeout are configuration. Server-only (keys never reach the browser).
import { callGeminiJson, cleanJson } from '../gemini';
import { estimateCompute } from '../pricing';

export type AiProvider = 'gemini' | 'openai' | 'anthropic';
export type AiTask = 'understand' | 'pathways' | 'plan' | 'brief' | 'execute' | 'compare' | 'explore';

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

export async function generateJson<T>(task: AiTask, prompt: string, schema: unknown, overrides: Partial<(typeof TASK_CONFIG)[AiTask]> = {}): Promise<GatewayResult<T>> {
  const active = activeProvider();
  if (!active) throw new AiNotConfiguredError();
  const cfg = { ...TASK_CONFIG[task], ...overrides };
  const started = Date.now();
  let data: T; let inputTokens = 0; let outputTokens = 0;

  if (active.provider === 'gemini') {
    const r = await callGeminiJson<T>({ prompt, schema, timeoutMs: cfg.timeoutMs, maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature, label: `hippo:${task}` });
    ({ data, inputTokens, outputTokens } = r);
  } else if (active.provider === 'openai') {
    const j = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: active.model, temperature: cfg.temperature, max_completion_tokens: cfg.maxOutputTokens, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: `Reply with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` }, { role: 'user', content: prompt }] }),
    }, cfg.timeoutMs, `hippo:${task}`);
    data = parse<T>(j.choices?.[0]?.message?.content || '', task);
    inputTokens = j.usage?.prompt_tokens || 0; outputTokens = j.usage?.completion_tokens || 0;
  } else {
    const j = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: active.model, max_tokens: cfg.maxOutputTokens, temperature: cfg.temperature,
        system: `Reply with ONLY one JSON object matching this JSON Schema, no prose:\n${JSON.stringify(schema)}`, messages: [{ role: 'user', content: prompt }] }),
    }, cfg.timeoutMs, `hippo:${task}`);
    data = parse<T>((j.content || []).map((c: { text?: string }) => c.text || '').join(''), task);
    inputTokens = j.usage?.input_tokens || 0; outputTokens = j.usage?.output_tokens || 0;
  }
  const costInr = Math.round(estimateCompute(inputTokens, outputTokens).computeInr * 100) / 100;
  return { data, provider: active.provider, model: active.model, task, inputTokens, outputTokens, costInr, ms: Date.now() - started };
}

/** Safe metadata for logs: never prompts, keys or outputs. */
export const aiMeta = (r: GatewayResult<unknown>) => ({ provider: r.provider, model: r.model, task: r.task, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costInr: r.costInr, ms: r.ms });
