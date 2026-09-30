// Minimal Gemini structured-output client shared by the research planner, evidence extractor and
// decision stage. Every call has an explicit timeout so the whole audit fits the serverless limit.

export type GeminiResult<T> = { data: T; inputTokens: number; outputTokens: number };

export function cleanJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
}

export async function callGeminiJson<T>(opts: { prompt: string; schema: unknown; timeoutMs: number; maxOutputTokens: number; temperature?: number; label: string }): Promise<GeminiResult<T>> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('AI_ENGINE_NOT_CONFIGURED: GEMINI_API_KEY is missing');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, opts.timeoutMs));
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'}:generateContent`, {
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
        },
      }),
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new Error(`GEMINI_ERROR (${opts.label}): ${aborted ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s` : e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`GEMINI_ERROR (${opts.label}): HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`GEMINI_ERROR (${opts.label}): empty response`);
  let data: T;
  try { data = JSON.parse(cleanJson(text)) as T; } catch { throw new Error(`GEMINI_ERROR (${opts.label}): response was not valid JSON (possibly truncated)`); }
  return { data, inputTokens: json.usageMetadata?.promptTokenCount || 0, outputTokens: json.usageMetadata?.candidatesTokenCount || 0 };
}
