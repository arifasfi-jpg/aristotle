// Phase 1 — cost observability foundation. Pure-function tests of the production ledger maths, the router table and a
// static guarantee that no code outside the gateway talks to a model or search provider.
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { costOf, maxCallCostInr, outcomeOf, PURPOSES, type Price } from '../src/lib/ai-usage';
import { FREE_TASKS, routeModel, TASK_ROUTE } from '../src/lib/hippo/gateway';
import { clientIp, guardIp, hashIp, sameOrigin } from '../src/lib/rate-limit';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

const price = (p: Partial<Price>): Price => ({ id: 'x', inputUsdPerMTok: 0, outputUsdPerMTok: 0, cachedInputUsdPerMTok: 0, usdPerCredit: 0, source: 'MODEL_PRICE', ...p });

describe('Rupee cost per actual model', () => {
  it('the same tokens cost different amounts on different models (no single global rate)', () => {
    const tokens = { inputTokens: 10_000, outputTokens: 2_000 };
    const lite = costOf(tokens, price({ inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 }), 88);
    const pro = costOf(tokens, price({ inputUsdPerMTok: 2.5, outputUsdPerMTok: 15 }), 88);
    expect(lite).toBeCloseTo((10_000 * 0.2 + 2_000 * 1.2) / 1e6 * 88, 4); // ₹0.3872
    expect(pro).toBeCloseTo((10_000 * 2.5 + 2_000 * 15) / 1e6 * 88, 4);   // ₹4.84
    expect(pro / lite).toBeGreaterThan(12);
  });
  it('cached input at the cached rate; reasoning ("thinking") tokens billed as output', () => {
    const p = price({ inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.25, outputUsdPerMTok: 4 });
    expect(costOf({ inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 0 }, p, 1)).toBeCloseTo(0.6 + 0.1, 6);
    expect(costOf({ outputTokens: 100_000, reasoningTokens: 50_000 }, p, 1)).toBeCloseTo(0.6, 6);
    expect(costOf({ inputTokens: 1_000_000, cachedTokens: 5_000_000 }, p, 1)).toBeCloseTo(0.25, 6); // cached is capped at the input count
  });
  it('search calls are costed by credits (Tavily advanced = 2 credits × $0.008)', () => {
    expect(costOf({ searchCalls: 1, searchCredits: 2 }, price({ usdPerCredit: 0.008 }), 88)).toBeCloseTo(1.408, 4);
  });
  it('worst-case pre-call bound grows with the output budget and the model price', () => {
    const p = price({ inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 });
    expect(maxCallCostInr(30_000, 12_000, p)).toBeGreaterThan(maxCallCostInr(30_000, 1_500, p));
    expect(maxCallCostInr(1000, 2000, price({ inputUsdPerMTok: 15, outputUsdPerMTok: 75 }))).toBeGreaterThan(10);
  });
  it('outcomes are classified from the provider error', () => {
    expect(outcomeOf(new Error('GEMINI_ERROR (x): timed out after 8s'))).toBe('TIMEOUT');
    expect(outcomeOf(new Error('TAVILY_TIMEOUT after 15s'))).toBe('TIMEOUT');
    expect(outcomeOf(new Error('GEMINI_ERROR (x): response was not valid JSON (possibly truncated)'))).toBe('INVALID_OUTPUT');
    expect(outcomeOf(new Error('AI_BUDGET_EXCEEDED: cap'))).toBe('REFUSED_BUDGET');
    expect(outcomeOf(new Error('GEMINI_ERROR (x): HTTP 503'))).toBe('ERROR');
  });
});

describe('Router: every task has a purpose and a tier; models are configuration', () => {
  it('purposes distinguish Aristotle, research, opportunity, work (and reserve conversation / Think Tank)', () => {
    expect(PURPOSES).toEqual(['CONVERSATION', 'ARISTOTLE', 'RESEARCH', 'OPPORTUNITY', 'THINK_TANK', 'WORK', 'OTHER']);
    expect(Object.fromEntries(Object.entries(TASK_ROUTE).map(([t, r]) => [t, r.purpose]))).toEqual({
      understand: 'ARISTOTLE', 'scope-classifier': 'ARISTOTLE', explore: 'OPPORTUNITY', 'research-plan': 'RESEARCH', 'research-extract': 'RESEARCH', 'research-search': 'RESEARCH',
      decision: 'ARISTOTLE', pathways: 'ARISTOTLE', plan: 'WORK', brief: 'WORK', execute: 'WORK', compare: 'WORK',
    });
    expect(FREE_TASKS.sort()).toEqual(['explore', 'scope-classifier', 'understand']); // reachable before any payment
  });
  it('a tier can be moved to another model by configuration only (provider key required)', () => {
    process.env.GEMINI_API_KEY = 'k'; delete process.env.OPENAI_API_KEY; delete process.env.HIPPO_AI_PROVIDER; process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
    expect(routeModel(1)).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash-lite' });
    process.env.HIPPO_TIER1_MODEL = 'gemini:gemini-3.5-pro';
    expect(routeModel(1)).toEqual({ provider: 'gemini', model: 'gemini-3.5-pro' });
    expect(routeModel(0)).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash-lite' });
    process.env.HIPPO_TIER2_MODEL = 'openai:gpt-x'; // no OpenAI key → ignored, never a broken route
    expect(routeModel(2)).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash-lite' });
  });
});

describe('No unmetered provider calls anywhere in the app', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p); } };
  walk(path.join(__dirname, '../src'));
  const rel = (f: string) => path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');
  const offenders = (re: RegExp, allowed: string[]) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8')) && !allowed.includes(rel(f))).map(rel);
  it('model provider endpoints are only called by the provider clients behind the gateway', () => {
    expect(offenders(/generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/, ['src/lib/gemini.ts', 'src/lib/hippo/gateway.ts'])).toEqual([]);
  });
  it('the raw Gemini client is only used by the metered gateway', () => {
    expect(offenders(/callGeminiJson\s*[<(]/, ['src/lib/gemini.ts', 'src/lib/hippo/gateway.ts'])).toEqual([]);
  });
  it('the search provider is only called inside the metered search wrapper', () => {
    expect(offenders(/api\.tavily\.com/, ['src/lib/research.ts'])).toEqual([]);
    const research = fs.readFileSync(path.join(__dirname, '../src/lib/research.ts'), 'utf8');
    expect(research).toMatch(/return meteredSearch\(\{ provider: 'tavily', depth: 'advanced' \}, opts\.usage, \(\) => tavilyRequest\(/);
    expect((research.match(/tavilyRequest\(/g) || []).length).toBe(2); // the definition + the single metered call
  });
  it('no legacy engine copies remain', () => {
    expect(files.map(rel).filter((f) => /ai-(old|backup|current|v1|gpt|nemitron|nvidia|glm)|route-(backup|current)/.test(f))).toEqual([]);
  });
});

describe('Request guard helpers', () => {
  const r = (h: Record<string, string>) => new Request('https://hippo.example/api/hippo/explore', { method: 'POST', headers: h });
  it('cross-site browser requests are refused; same-site and non-browser requests pass', () => {
    expect(sameOrigin(r({ host: 'hippo.example', origin: 'https://hippo.example' }))).toBe(true);
    expect(sameOrigin(r({ host: 'hippo.example', origin: 'https://evil.example' }))).toBe(false);
    expect(sameOrigin(r({ host: 'hippo.example' }))).toBe(true);
  });
  it('a request with no client IP is not throttled as one shared "unknown" visitor (would block everyone)', async () => {
    expect(await guardIp(r({}), 'explore')).toEqual({ ok: true }); // no database touched: no shared bucket exists
    expect(await guardIp(r({ host: 'hippo.example', origin: 'https://evil.example' }), 'explore')).toMatchObject({ ok: false, status: 403 });
  });
  it('client IP is read from the platform headers and only ever stored hashed', () => {
    expect(clientIp(r({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(r({ 'x-vercel-forwarded-for': '198.51.100.1, 10.0.0.1', 'x-real-ip': '1.1.1.1' }))).toBe('198.51.100.1');
    expect(hashIp('203.0.113.9')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIp('203.0.113.9')).not.toContain('203');
  });
});
