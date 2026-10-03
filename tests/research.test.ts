// Research-first audit engine: PLAN → SEARCH → EXTRACT → DECIDE, with server-side verification.
// Tavily and Gemini are replaced by a fake HTTP layer; everything else is the real engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAudit } from '../src/lib/ai';
import { deterministicAudit } from '../src/lib/audit';
import type { ResearchRecord } from '../src/lib/evidence';
import { confirmFounderFacts, extractFounderFacts } from '../src/lib/founder-facts';
import { normalisePlan, verifyFindings } from '../src/lib/research';

const IDEA = 'An AI-powered platform that helps Indian small businesses manage their GST compliance. We plan to charge ₹999/month.';
const FACTS = confirmFounderFacts(extractFounderFacts(IDEA).facts); // F1 = proposed price ₹999/month

const PLAN = {
  businessModel: {
    summary: 'Subscription software that prepares and files GST returns for Indian MSMEs using AI.',
    customer: 'Owners and accountants of small GST-registered businesses', payer: 'The business owner', offering: 'GST return preparation and reconciliation software',
    revenueMechanism: 'Monthly subscription', keyActivities: ['Reading invoices', 'Reconciling GSTR-2B', 'Filing returns via GSTN APIs'],
    regulatedActivities: [{ activity: 'Filing GST returns on behalf of taxpayers through GSTN APIs', whyRegulated: 'API access to GSTN is restricted to licensed GST Suvidha Providers' }],
  },
  questions: [
    { category: 'DEMAND', question: 'How many small businesses in India must file GST returns every month?', whyItMatters: 'Size of the addressable base', query: 'number of GST registered taxpayers India monthly GSTR-3B filers 2025' },
    { category: 'ALTERNATIVES_PRICING', question: 'What do existing GST software tools for MSMEs charge?', whyItMatters: 'Sets the price ceiling', query: 'GST return filing software pricing India MSME per month' },
    { category: 'REGULATION', question: 'What licence is required to file GST returns through GSTN APIs?', whyItMatters: 'Filing may require GSP status', query: 'GST Suvidha Provider GSP licence requirements GSTN', activity: 'Filing GST returns on behalf of taxpayers through GSTN APIs' },
    { category: 'CHANNEL', question: 'Do small businesses choose GST software themselves or through their chartered accountant?', whyItMatters: 'Decides the acquisition channel', query: 'how MSMEs choose GST software chartered accountant India' },
    { category: 'COST', question: 'What does a GSP charge software companies per GST return API call?', whyItMatters: 'Main variable cost', query: 'GSP API pricing per return India' },
    { category: 'OPERATIONS', question: 'How often do GSTR-2B reconciliation mismatches occur for small businesses?', whyItMatters: 'Size of the pain point', query: 'GSTR-2B mismatch frequency small business India' },
    { category: 'OTHER', question: 'Duplicate query should be removed', whyItMatters: 'x', query: 'GSP API pricing per return India' },
  ],
};

const SRC = {
  demand: { title: 'GSTN annual statistics', url: 'https://example.org/gstn-stats', content: 'According to GSTN, around 1.4 crore taxpayers are registered under GST, and most small businesses file GSTR-3B every month.' },
  pricing: { title: 'Zoho Books pricing', url: 'https://example.org/zoho-pricing', content: 'Zoho Books Standard plan costs ₹749 per organisation per month when billed annually and includes GST return filing.' },
  gsp: { title: 'GST Suvidha Providers', url: 'https://www.gst.gov.in/gsp', content: 'Only GST Suvidha Providers (GSPs) licensed by GSTN can access GST system APIs. Application Service Providers must connect through a GSP.' },
  channel: { title: 'Blog on MSME accounting', url: 'https://example.org/msme-blog', content: 'Many owners rely on accountants for bookkeeping.' },
};

let calls: { kind: string; body: any }[] = [];
let decisionFails = 0;

function tavilyFor(query: string) {
  if (query.includes('taxpayers')) return [SRC.demand];
  if (query.includes('software pricing')) return [SRC.pricing];
  if (query.includes('Suvidha')) return [SRC.gsp];
  if (query.includes('chartered accountant')) return [SRC.channel];
  if (query.includes('mismatch')) return [];
  return null; // → HTTP 500 (search failure)
}

function extractFor(prompt: string) {
  if (prompt.includes('must file GST returns')) return { status: 'ANSWERED', findings: [{ statement: 'About 1.4 crore businesses are registered under GST.', sourceId: 'S1', quote: 'around 1.4 crore taxpayers are registered under GST', confidence: 'HIGH' }] };
  if (prompt.includes('existing GST software')) return { status: 'ANSWERED', findings: [{ statement: 'Zoho Books Standard costs ₹749/month (billed annually) and includes GST filing.', sourceId: 'S2', quote: 'Zoho Books Standard plan costs ₹749 per organisation per month when billed annually', confidence: 'HIGH' }] };
  if (prompt.includes('What licence is required')) return { status: 'ANSWERED', findings: [{ statement: 'Only GSTN-licensed GSPs can access GST APIs; app providers must connect through a GSP.', sourceId: 'S3', quote: 'Only GST Suvidha Providers (GSPs) licensed by GSTN can access GST system APIs', confidence: 'HIGH' }] };
  // Model "knowledge" that is NOT in the source: must be rejected by quote verification.
  if (prompt.includes('chartered accountant')) return { status: 'ANSWERED', findings: [{ statement: '80% of MSMEs let their CA choose GST software.', sourceId: 'S4', quote: '80% of MSMEs let their chartered accountant choose the GST software', confidence: 'HIGH' }] };
  return { status: 'NOT_FOUND', findings: [] };
}

function decisionReport() {
  const base = deterministicAudit({ idea: IDEA, sector: 'B2B SaaS' });
  return {
    ...base,
    oneLineVerdict: 'Real demand, but you must work through a GSP and undercut ₹749/month competitors.',
    decisionMemo: {
      decisionQuestion: 'Can an AI GST tool win MSMEs at ₹999/month against ₹749/month incumbents while filing through a GSP?',
      criticalAssumptions: [
        { assumption: 'Customers must be willing to pay.', whyItMatters: 'generic', evidenceStatus: 'UNKNOWN', evidence: 'None', evidenceIds: [], basedOnQuestions: [], cheapestTest: 'Ask', experimentIndex: 1 },
        { assumption: 'Owners, not their CAs, will choose the software.', whyItMatters: 'Decides whether you sell to owners or to CAs', evidenceStatus: 'UNKNOWN', evidence: 'No evidence found in research', evidenceIds: [], basedOnQuestions: ['Q4'], cheapestTest: 'Pitch 10 owners and 10 CAs', experimentIndex: 2 },
        { assumption: 'There are enough GST filers.', whyItMatters: 'market', evidenceStatus: 'SUPPORTED', evidence: '1.4 crore registered', evidenceIds: ['R1'], basedOnQuestions: ['Q1'], cheapestTest: 'n/a', experimentIndex: 3 },
        { assumption: 'MSMEs will pay ₹999/month when Zoho charges ₹749.', whyItMatters: 'Your price is above a known incumbent', evidenceStatus: 'CONTRADICTED', evidence: 'Zoho Books charges ₹749/month including GST filing', evidenceIds: ['R2'], basedOnQuestions: ['Q2'], cheapestTest: 'Pre-sell at ₹999', experimentIndex: 4 },
      ],
      proceedIf: ['5 of 20 owners pre-pay ₹999'], changeModelIf: ['CAs control the choice in most cases'], evidenceStillRequired: ['GSP API cost per return'],
    },
    evidence: [
      { claim: 'Zoho Books charges ₹749/month including GST filing.', type: 'FACT', sourceIds: ['R2'], confidence: 'HIGH', validation: 'Zoho pricing page' },
      { claim: 'The GST software market is worth ₹10,000 crore.', type: 'FACT', sourceIds: ['S9'], confidence: 'HIGH', validation: '' },
    ],
    unitEconomics: [
      { metric: 'Competitor price (Zoho Books Standard)', conservative: 749, base: 749, upside: 749, unit: '₹ / month', commentary: '', assumption: 'RESEARCHED', concept: 'selling_price', timeframe: 'CURRENT', provenance: 'EXTERNAL', inputs: ['R2'] },
      { metric: 'Price premium over Zoho', conservative: 250, base: 250, upside: 250, unit: '₹ / month', commentary: '', assumption: 'CALCULATED', concept: 'other', timeframe: 'PROJECTION', provenance: 'CALCULATED', inputs: [FACTS[0].id, 'Competitor price (Zoho Books Standard)'] },
      { metric: 'Gross margin', conservative: 50, base: 55, upside: 60, unit: '%', commentary: '', assumption: 'ASSUMPTION: typical SaaS', concept: 'margin', timeframe: 'ASSUMPTION', provenance: 'ASSUMPTION', basis: 'Run a 5-customer pilot and measure GSP cost per return' },
      { metric: 'Customer acquisition cost', conservative: 455, base: 350, upside: 263, unit: '₹ / customer', commentary: '', assumption: 'ASSUMPTION', concept: 'cac', timeframe: 'ASSUMPTION', provenance: 'ASSUMPTION' },
    ],
    unknownEconomics: [{ metric: 'GSP cost per return', whyUnknown: 'Research found no published GSP pricing', howToEstablish: 'Request quotes from 3 GSPs' }],
    regulatory: [
      { name: 'GST Suvidha Provider route', status: 'Likely', rationale: 'Filing via GSTN APIs', action: 'Partner with a licensed GSP', source: 'https://made-up.example/gsp', activity: 'Filing GST returns on behalf of taxpayers through GSTN APIs', requirement: 'API access only via a GSTN-licensed GSP', sourceIds: ['R3'] },
      { name: 'DPDP Act', status: 'Likely', rationale: 'Personal data', action: 'Privacy policy', source: '', activity: 'Storing invoice data', requirement: 'Consent', sourceIds: [] },
      { name: 'MSME / Udyam', status: 'Likely', rationale: 'Default', action: 'Register', source: '', activity: '', requirement: '', sourceIds: [] },
    ],
  };
}

function fakeFetch(url: string, init?: RequestInit) {
  const body = JSON.parse(String(init?.body || '{}'));
  if (url.includes('tavily')) {
    calls.push({ kind: 'tavily', body });
    const results = tavilyFor(body.query);
    if (results === null) return new Response('upstream error', { status: 500 });
    return new Response(JSON.stringify({ results }), { status: 200 });
  }
  const prompt: string = body.contents[0].parts[0].text;
  // Research escalation (follow-up query planning, gap explanations) is its own kind of call, never the decision.
  const kind = prompt.includes('research planner') ? 'plan' : prompt.includes('You extract evidence for ONE research question') ? 'extract'
    : prompt.includes('FOLLOW-UP web searches') ? 'escalate' : prompt.includes('Research could not settle') ? 'gap' : 'decision';
  calls.push({ kind, body });
  if (kind === 'decision' && decisionFails > 0) { decisionFails--; return new Response('overloaded', { status: 503 }); }
  if (kind === 'escalate' || kind === 'gap') return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }), { status: 200 });
  const data = kind === 'plan' ? PLAN : kind === 'extract' ? extractFor(prompt) : decisionReport();
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }), { status: 200 });
}

const saved = { ...process.env };
beforeEach(() => {
  calls = []; decisionFails = 0;
  process.env.GEMINI_API_KEY = 'g'; process.env.TAVILY_API_KEY = 't';
  vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => fakeFetch(u, i)));
});
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

const run = (opts: Parameters<typeof runAudit>[1] = {}) => runAudit({ idea: IDEA, sector: 'B2B SaaS', geography: 'India', founderFacts: FACTS, scope: 'NEW_IDEA' }, opts);

describe('1–2. Plan, then one targeted search per business-specific question', () => {
  it('plans the business model and searches each question (deduplicated), in advanced depth', async () => {
    const r = await run();
    const research = r.research!;
    expect(research.version).toBe(2);
    expect(research.businessModel).toMatchObject({ payer: 'The business owner', revenueMechanism: 'Monthly subscription' });
    expect(research.businessModel!.regulatedActivities[0].activity).toMatch(/GSTN APIs/);
    expect(research.questions!.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']); // duplicate query dropped
    // First pass: exactly one India search per planned question; escalation searches follow (see research-escalation.test.ts).
    const tavily = calls.filter((c) => c.kind === 'tavily').slice(0, 6);
    expect(tavily.map((c) => c.body.query)).toEqual(research.queries.slice(0, 6));
    expect(tavily.every((c) => c.body.search_depth === 'advanced' && c.body.country === 'india')).toBe(true);
    expect(research.questions!.map((q) => q.attempts![0])).toEqual(research.questions!.map((q) => expect.objectContaining({ round: 0, strategy: 'INITIAL', query: q.query })));
    expect(tavily.every((c) => !c.body.query.includes(IDEA))).toBe(true); // never the founder's sentence as an exact phrase
    expect(tavily.find((c) => c.body.query.includes('Suvidha'))!.body.include_raw_content).toBe('text'); // regulation: full text
    expect(tavily.find((c) => c.body.query.includes('taxpayers'))!.body.include_raw_content).toBe(false);
  });
});

describe('3. Evidence extraction: source text only, verified quotes, explicit NOT FOUND', () => {
  it('keeps real findings, rejects model knowledge, marks gaps', async () => {
    const q = Object.fromEntries((await run()).research!.questions!.map((x) => [x.id, x]));
    const research = (await run()).research!;
    expect(research.findings!.map((f) => [f.id, f.questionId, f.sourceId])).toEqual([['R1', 'Q1', 'S1'], ['R2', 'Q2', 'S2'], ['R3', 'Q3', 'S3']]);
    expect(q.Q1.status).toBe('ANSWERED');
    expect(q.Q4.status).toBe('NOT_FOUND'); // "80% of MSMEs…" is not in the source → rejected
    expect(q.Q4.note).toMatch(/quote could not be found/);
    expect(q.Q5.status).toBe('SEARCH_FAILED');
    expect(q.Q6.status).toBe('NOT_FOUND'); // no sources → no extraction call
    expect(calls.filter((c) => c.kind === 'extract')).toHaveLength(2 * 4); // Q1–Q4 only, twice (two runs)
    expect(research.sources.find((s) => s.id === 'S3')!.content).toContain('Only GST Suvidha Providers');
  });

  it('verifyFindings rejects findings citing a source from another question', () => {
    const srcs = [{ id: 'S1', title: 't', url: 'u', snippet: '', query: 'q', retrievedAt: '' }];
    const v = verifyFindings({ status: 'ANSWERED', findings: [{ statement: 's', sourceId: 'S2', quote: 'a quote that is long enough', confidence: 'HIGH' }] }, 'Q1', srcs, () => 'a quote that is long enough here', 1);
    expect(v).toMatchObject({ status: 'NOT_FOUND', findings: [], rejected: 1 });
  });

  it('the planner may not return generic or too few questions', () => {
    expect(() => normalisePlan({ businessModel: PLAN.businessModel, questions: PLAN.questions.slice(0, 2) })).toThrow(/RESEARCH_PLAN_INVALID/);
    const p = normalisePlan({ businessModel: PLAN.businessModel, questions: [...PLAN.questions.slice(0, 4), { category: 'DEMAND', question: 'x', whyItMatters: 'y', query: `"${IDEA}"` }] });
    expect(p.questions[4].query.startsWith('"')).toBe(false);
  });
});

describe('4. Decision analysis is fed research findings, and assumptions come from research gaps', () => {
  it('the decision prompt contains the research brief with statuses and findings', async () => {
    await run();
    const prompt: string = calls.find((c) => c.kind === 'decision')!.body.contents[0].parts[0].text;
    expect(prompt).toContain('RESEARCH BRIEF');
    expect(prompt).toContain('R2 (HIGH, DIRECT, from S2 — Zoho Books pricing): Zoho Books Standard costs ₹749/month');
    expect(prompt).toMatch(/Q4 \[CHANNEL\][\s\S]*STATUS: NOT_FOUND/);
    // A gap reaches the decision only after widening, with what was searched and how to resolve it.
    expect(prompt).not.toContain('NO EVIDENCE FOUND');
    expect(prompt).toMatch(/Q4 \[CHANNEL\][\s\S]*RESEARCHED: \d+ searches[\s\S]*NOT ESTABLISHED FROM PUBLIC EVIDENCE[\s\S]*Cheapest way to find out \(EXPERIMENT\)/);
    expect(prompt).not.toContain('80% of MSMEs'); // rejected model "knowledge" never reaches the decision
  });

  it('generic assumptions and ones not tied to a research gap are removed', async () => {
    const memo = (await run()).report.decisionMemo!;
    expect(memo.criticalAssumptions.map((a) => a.assumption)).toEqual([
      'Owners, not their CAs, will choose the software.',
      'MSMEs will pay ₹999/month when Zoho charges ₹749.',
    ]);
    expect(memo.criticalAssumptions[1]).toMatchObject({ evidenceStatus: 'CONTRADICTED', evidenceIds: ['R2'] });
  });

  it('a FACT citing an unknown source is downgraded; a FACT citing a verified finding stays', async () => {
    const ev = (await run()).report.evidence!;
    expect(ev[0]).toMatchObject({ type: 'FACT', sourceIds: ['R2'] });
    expect(ev[1]).toMatchObject({ type: 'INFERENCE', sourceIds: [] });
  });
});

describe('5. Economics: founder, researched or calculated — otherwise NOT YET ESTABLISHED', () => {
  it('drops sector-style guesses (55% margin, ₹350 CAC) into unknowns and keeps grounded numbers', async () => {
    const { report } = await run();
    const metrics = report.unitEconomics.map((r) => r.metric);
    expect(report.unitEconomics.find((r) => r.metric === 'External benchmark: Competitor price (Zoho Books Standard)')).toMatchObject({ base: 749, provenance: 'EXTERNAL', differsFromFounder: true });
    expect(report.unitEconomics.find((r) => r.metric === 'Price premium over Zoho')).toMatchObject({ base: 250, provenance: 'CALCULATED' });
    expect(report.unitEconomics.find((r) => r.factId === FACTS[0].id)).toMatchObject({ base: 999, provenance: 'FOUNDER_STATED' });
    expect(metrics).not.toContain('Gross margin');
    expect(metrics).not.toContain('Customer acquisition cost');
    expect(JSON.stringify(report.unitEconomics)).not.toMatch(/"base":55|"base":350/);
    expect(report.unknownEconomics!.map((u) => u.metric)).toEqual(['GSP cost per return', 'Gross margin', 'Customer acquisition cost']);
  });
});

describe('6. Regulation: activity → requirement → source', () => {
  it('keeps sourced, activity-specific regulation; removes unsourced and default items', async () => {
    const { report } = await run();
    expect(report.regulatory).toHaveLength(1);
    expect(report.regulatory[0]).toMatchObject({ name: 'GST Suvidha Provider route', activity: expect.stringMatching(/GSTN APIs/), requirement: expect.stringMatching(/GSP/), sourceIds: ['R3'], source: 'https://www.gst.gov.in/gsp' });
    expect(report.decisionMemo!.evidenceStillRequired.some((x) => /DPDP Act/.test(x) && /Storing invoice data/.test(x))).toBe(true);
    expect(report.decisionMemo!.evidenceStillRequired.join(' ')).toMatch(/MSME \/ Udyam/);
  });
});

describe('7. Demo Mode and credentials', () => {
  it('missing keys fail even in Demo Mode — never a template', async () => {
    delete process.env.TAVILY_API_KEY; process.env.DEMO_MODE = 'true'; process.env.VERCEL_ENV = 'preview';
    await expect(run()).rejects.toThrow(/AI_ENGINE_NOT_CONFIGURED/);
    expect(calls).toHaveLength(0);
  });
});

describe('Time budget, research persistence and retry', () => {
  it('research is saved before the decision stage; a retry reuses it without searching again', async () => {
    decisionFails = 1;
    let saved: ResearchRecord | null = null;
    await expect(run({ onResearch: async (r) => { saved = r; } })).rejects.toThrow(/GEMINI_ERROR \(decision\)/);
    expect(saved!.findings).toHaveLength(3);
    const before = calls.length;
    const r = await run({ existingResearch: saved });
    const newCalls = calls.slice(before).map((c) => c.kind);
    expect(newCalls).toEqual(['decision']); // no plan, no Tavily, no extraction on retry
    expect(r.report.regulatory[0].sourceIds).toEqual(['R3']);
  });

  it('not enough time for research or decision → retryable budget error, never a partial template', async () => {
    await expect(run({ budgetMs: 16_000 })).rejects.toThrow(/AUDIT_TIME_BUDGET_EXCEEDED/);
    const research = (await run()).research!;
    await expect(run({ existingResearch: research, budgetMs: 10_000 })).rejects.toThrow(/AUDIT_TIME_BUDGET_EXCEEDED: research is saved/);
  });
});
