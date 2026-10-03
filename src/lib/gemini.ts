// Minimal Gemini structured-output client shared by the research planner, evidence extractor and
// decision stage. Every call has an explicit timeout so the whole audit fits the serverless limit.
// Errors are marked NOT_SENT / SENT (+ httpStatus, + measured usage when Gemini reported it) so the ledger can tell a
// call that cost nothing from one that may have been billed (see accountFailure in ai-usage.ts).
import { fetchFailurePhase, notSent, sent } from './ai-usage';

/** Token counts as Gemini bills them: cached prompt tokens are a subset of inputTokens; thinking tokens are billed as output. */
export type GeminiResult<T> = { data: T; inputTokens: number; outputTokens: number; cachedTokens: number; thinkingTokens: number; retries: number; model: string };

export function cleanJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
}

export const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

/**
 * Lowest-latency thinking setting the configured model accepts (thinking tokens add latency and count against
 * maxOutputTokens). Gemini 3.x uses thinkingLevel ("minimal" only on Flash-Lite); Gemini 2.5 uses thinkingBudget
 * (Pro cannot go to 0). Unknown models: send nothing. GEMINI_FAST_THINKING=off disables this entirely.
 */
export function fastThinkingConfig(model: string): Record<string, unknown> | undefined {
  if (process.env.GEMINI_FAST_THINKING === 'off') return undefined;
  const m = model.toLowerCase();
  if (/^gemini-3/.test(m)) return { thinkingLevel: m.includes('flash-lite') ? 'minimal' : 'low' };
  if (/^gemini-2\.5/.test(m)) return { thinkingBudget: m.includes('pro') ? 128 : 0 };
  return undefined;
}

export async function callGeminiJson<T>(opts: { prompt: string; schema: unknown; timeoutMs: number; maxOutputTokens: number; temperature?: number; label: string; fastThinking?: boolean; model?: string }): Promise<GeminiResult<T>> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw notSent(new Error('AI_ENGINE_NOT_CONFIGURED: GEMINI_API_KEY is missing'));
  const model = opts.model || geminiModel();
  const thinking = opts.fastThinking ? fastThinkingConfig(model) : undefined;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, opts.timeoutMs));
  const send = (withThinking: boolean) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: controller.signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: opts.schema,
        maxOutputTokens: opts.maxOutputTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(withThinking && thinking ? { thinkingConfig: thinking } : {}),
      },
    }),
  });
  let res: Response;
  let retries = 0;
  try {
    res = await send(true);
    // A model that rejects the thinking setting must not break the call: retry once without it (same deadline).
    if (res.status === 400 && thinking) {
      const body = await res.clone().text();
      if (/thinking/i.test(body)) { retries = 1; res = await send(false); }
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    const err = new Error(`GEMINI_ERROR (${opts.label}): ${aborted ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s (model ${model})` : e instanceof Error ? e.message : String(e)}`, { cause: e });
    throw aborted || fetchFailurePhase(e) === 'SENT' ? sent(err) : notSent(err);
  } finally {
    clearTimeout(timeout);
  }
  if (opts.fastThinking) console.log(JSON.stringify({ event: 'gemini_call', label: opts.label, model, ms: Date.now() - started, status: res.status }));
  if (!res.ok) throw sent(new Error(`GEMINI_ERROR (${opts.label}): HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`), { httpStatus: res.status });
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number } };
  const u = json.usageMetadata || {};
  // A billed-but-unusable response still cost tokens: the error carries them so the ledger records the spend.
  const billed = (e: Error) => sent(e, { measured: { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, cachedTokens: u.cachedContentTokenCount || 0, reasoningTokens: u.thoughtsTokenCount || 0, retries } });
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw billed(new Error(`GEMINI_ERROR (${opts.label}): empty response`));
  let data: T;
  try { data = JSON.parse(cleanJson(text)) as T; } catch { throw billed(new Error(`GEMINI_ERROR (${opts.label}): response was not valid JSON (possibly truncated)`)); }
  return { data, inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, cachedTokens: u.cachedContentTokenCount || 0, thinkingTokens: u.thoughtsTokenCount || 0, retries, model };
}
