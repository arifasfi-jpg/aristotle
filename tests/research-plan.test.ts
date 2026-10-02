// Research-plan stage: fast, bounded, and never repeated on retry.
// Reproduces the Preview failure "GEMINI_ERROR (research-plan): timed out after 12s" with simulated time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAudit } from '../src/lib/ai';
import { deterministicAudit } from '../src/lib/audit';
import type { ResearchRecord } from '../src/lib/evidence';
import { fastThinkingConfig } from '../src/lib/gemini';
import { isPlanCheckpoint, PLAN_MAX_OUTPUT_TOKENS, planTimeoutMs } from '../src/lib/research';

const IDEA = 'Aaira Books: we publish illustrated children’s books in Hindi and English and sell about 300 copies a month through Amazon and school book fairs in Pune. We want to reach 3,000 copies a month.';
const PLAN = {
  businessModel: { summary: 'Publishes bilingual illustrated children’s books sold online and at school fairs.', customer: 'Parents and schools', payer: 'Parents, schools', offering: 'Children’s books', revenueMechanism: 'Per-copy sales', keyActivities: ['Publishing', 'Printing', 'Distribution'], regulatedActivities: [{ activity: 'Selling to schools', whyRegulated: 'School procurement rules' }] },
  questions: [
    { category: 'DEMAND', question: 'Do Pune parents buy bilingual Hindi-English picture books?', whyItMatters: 'Core demand', query: 'bilingual hindi english picture books demand india' },
    { category: 'ALTERNATIVES_PRICING', question: 'What do comparable Indian children’s picture books cost?', whyItMatters: 'Price ceiling', query: 'indian children picture book price pratham tulika' },
    { category: 'CHANNEL', question: 'How do school book fairs choose publishers?', whyItMatters: 'Channel access', query: 'school book fair publishers india how selected' },
    { category: 'COST', question: 'What does short-run colour printing cost in India?', whyItMatters: 'Unit cost', query: 'short run colour book printing cost india' },
    { category: 'REGULATION', question: 'What rules apply when selling books to schools?', whyItMatters: 'Compliance', query: 'school book procurement rules maharashtra', activity: 'Selling to schools' },
    { category: 'CHANNEL', question: 'How do children’s books rank on Amazon India?', whyItMatters: 'Online channel', query: 'amazon india children books bestseller hindi' },
  ],
};
const SOURCE = { title: 'Children’s publishing in India', url: 'https://example.org/kids-books', content: 'Bilingual picture books in Hindi and English are increasingly requested by urban parents.' };

let calls: { kind: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let planDelayMs = 0;
let tavilyDown = false;
let rejectThinking = false;

const reply = (data: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 400 } }), { status: 200 });
const delay = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});

async function fakeFetch(url: string, init?: RequestInit) {
  const body = JSON.parse(String(init?.body || '{}'));
  if (url.includes('tavily')) {
    calls.push({ kind: 'tavily', body });
    return tavilyDown ? new Response('down', { status: 500 }) : new Response(JSON.stringify({ results: [SOURCE] }), { status: 200 });
  }
  const prompt: string = body.contents[0].parts[0].text;
  const kind = prompt.includes('research planner') ? 'plan' : prompt.includes('You extract evidence for ONE research question') ? 'extract' : 'decision';
  calls.push({ kind, body });
  if (kind === 'plan') {
    if (rejectThinking && body.generationConfig.thinkingConfig) return new Response('{"error":{"message":"thinking_level is not supported for this model"}}', { status: 400 });
    await delay(planDelayMs, init?.signal);
    return reply(PLAN);
  }
  if (kind === 'extract') return reply(prompt.includes('Do Pune parents buy') ? { status: 'ANSWERED', findings: [{ statement: 'Urban parents request bilingual picture books.', sourceId: 'S1', quote: 'Bilingual picture books in Hindi and English are increasingly requested by urban parents', confidence: 'MEDIUM' }] } : { status: 'NOT_FOUND', findings: [] });
  return reply({ ...deterministicAudit({ idea: IDEA, sector: 'D2C / Consumer' }), oneLineVerdict: 'Test verdict' });
}

const saved = { ...process.env };
beforeEach(() => {
  calls = []; planDelayMs = 0; tavilyDown = false; rejectThinking = false;
  process.env.GEMINI_API_KEY = 'g'; process.env.TAVILY_API_KEY = 't'; delete process.env.GEMINI_MODEL; delete process.env.GEMINI_FAST_THINKING;
  vi.stubGlobal('fetch', vi.fn((u: string, i?: RequestInit) => fakeFetch(u, i)));
});
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); vi.useRealTimers(); });

const run = (opts: Parameters<typeof runAudit>[1] = {}) => runAudit({ idea: IDEA, sector: 'D2C / Consumer', geography: 'India', founderFacts: [], scope: 'GROWTH_PLAN' }, opts);

describe('Research plan: reproduces and fixes the 12s timeout', () => {
  it('a planner taking 13s (old hard cap 12s) now completes, and the whole audit stays inside the 54s budget', async () => {
    vi.useFakeTimers();
    planDelayMs = 13_000;
    const started = Date.now();
    const p = run();
    await vi.advanceTimersByTimeAsync(14_000);
    const r = await p;
    expect(r.research!.questions!.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
    expect(r.research!.findings!.map((f) => f.id)).toEqual(['R1']);
    expect(r.research!.stage).toBeUndefined(); // complete research, not a checkpoint
    expect(Date.now() - started).toBeLessThan(54_000);
  });

  it('the planner request is small and deterministic: lean prompt, capped output, minimal thinking, JSON schema', async () => {
    await run();
    const plan = calls.find((c) => c.kind === 'plan')!.body;
    const prompt: string = plan.contents[0].parts[0].text;
    expect(prompt.length).toBeLessThan(2600);
    expect(plan.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, temperature: 0.1, thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(plan.generationConfig.responseSchema.required).toEqual(['businessModel', 'questions']);
    expect(PLAN_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(1500);
    // The decision stage is unchanged: no thinking override there.
    expect(calls.find((c) => c.kind === 'decision')!.body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('thinking setting matches the configured model family and can be disabled', () => {
    expect(fastThinkingConfig('gemini-3.5-flash-lite')).toEqual({ thinkingLevel: 'minimal' });
    expect(fastThinkingConfig('gemini-3.5-flash')).toEqual({ thinkingLevel: 'low' });
    expect(fastThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(fastThinkingConfig('gemini-2.5-pro')).toEqual({ thinkingBudget: 128 });
    expect(fastThinkingConfig('some-other-model')).toBeUndefined();
    process.env.GEMINI_FAST_THINKING = 'off';
    expect(fastThinkingConfig('gemini-3.5-flash-lite')).toBeUndefined();
  });

  it('a model that rejects the thinking setting still plans (one retry without it)', async () => {
    rejectThinking = true;
    const r = await run();
    expect(r.research!.questions).toHaveLength(6);
    const plans = calls.filter((c) => c.kind === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[1].body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('timeout budget: planner gets at most 20s and always leaves 30s for search, extraction and decision', () => {
    expect(planTimeoutMs(54_000)).toBe(20_000);
    expect(54_000 - planTimeoutMs(54_000)).toBeGreaterThanOrEqual(30_000);
    expect(planTimeoutMs(40_000)).toBe(10_000);
  });

  it('a planner slower than its timeout fails cleanly and retryably — nothing is fabricated or saved', async () => {
    vi.useFakeTimers();
    planDelayMs = 60_000;
    const onResearch = vi.fn(async () => {});
    const p = run({ onResearch });
    const assertion = expect(p).rejects.toThrow(/GEMINI_ERROR \(research-plan\): timed out after 20s \(model gemini-3\.5-flash-lite\)/);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    expect(onResearch).not.toHaveBeenCalled();
    expect(calls.some((c) => c.kind === 'tavily' || c.kind === 'decision')).toBe(false);
  });

  it('not enough time left to plan → retryable budget error before calling Gemini', async () => {
    await expect(run({ budgetMs: 35_000 })).rejects.toThrow(/AUDIT_TIME_BUDGET_EXCEEDED: not enough time left to plan research/);
    expect(calls).toHaveLength(0);
  });
});

describe('Research plan checkpoint: retry never repeats a completed stage', () => {
  it('the plan is saved as soon as it exists; a retry resumes from search without planning again', async () => {
    tavilyDown = true;
    const savedRecords: ResearchRecord[] = [];
    await expect(run({ onResearch: async (r) => { savedRecords.push(r); } })).rejects.toThrow(/RESEARCH_FAILED/);
    expect(savedRecords).toHaveLength(1);
    const checkpoint = savedRecords[0];
    expect(isPlanCheckpoint(checkpoint)).toBe(true);
    expect(checkpoint).toMatchObject({ version: 2, stage: 'PLANNED', sources: [] });
    expect(checkpoint.plan!.questions).toHaveLength(6);
    expect(checkpoint.findings).toBeUndefined(); // no findings without search — nothing invented

    tavilyDown = false;
    const before = calls.length;
    const r = await run({ existingResearch: checkpoint, onResearch: async (x) => { savedRecords.push(x); } });
    const after = calls.slice(before).map((c) => c.kind);
    expect(after).not.toContain('plan');
    expect(after.filter((k) => k === 'tavily')).toHaveLength(6);
    expect(r.research!.questions!.map((q) => q.query)).toEqual(PLAN.questions.map((q) => q.query));
    expect(savedRecords.at(-1)!.stage).toBeUndefined(); // complete research replaces the checkpoint
  });

  it('complete research is still reused as before (decision-only retry)', async () => {
    const first = await run();
    const before = calls.length;
    await run({ existingResearch: first.research });
    expect(calls.slice(before).map((c) => c.kind)).toEqual(['decision']);
  });
});
