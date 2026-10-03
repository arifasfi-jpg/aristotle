// Research escalation: a failed or empty first search never becomes "no evidence found".
// Product rule under test: before a question is declared UNKNOWN, Aristotle demonstrably widens the research
// (reformulated, Indian primary / company / press sources, then global sources, reports and analogues), separates
// DIRECT from ANALOGOUS evidence, and explains every remaining gap with what was searched and how to resolve it.
// Tavily and Gemini are replaced by a fake HTTP layer; everything else is the real engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAudit } from '../src/lib/ai';
import { deterministicAudit } from '../src/lib/audit';
import type { ResearchQuestion, ResearchRecord } from '../src/lib/evidence';
import { gapExplanation, researchBrief, researchBusiness } from '../src/lib/research';
import { escalateResearch, fallbackQuery, INDIA_SECONDARY_DOMAINS, REPORT_DOMAINS } from '../src/lib/research-escalation';

const IDEA = 'A lending service provider that offers no-cost EMI to students of Indian edtech companies, funded by NBFC partners with a first-loss default guarantee.';

const PLAN = {
  businessModel: { summary: 'An LSP that arranges NBFC-funded EMI loans for edtech course fees.', customer: 'Students buying edtech courses', payer: 'Edtech company (subvention) and student (EMI)', offering: 'Course-fee EMI at checkout', revenueMechanism: 'Subvention fee from edtech per loan', keyActivities: ['Loan sourcing'], regulatedActivities: [{ activity: 'Acting as a lending service provider with default loss guarantee', whyRegulated: 'RBI digital lending rules' }] },
  questions: [
    { category: 'DEMAND', question: 'How many Indian edtech buyers pay course fees through EMI?', whyItMatters: 'Size of demand', query: 'edtech course fee emi share india' },
    { category: 'ALTERNATIVES_PRICING', question: 'What do existing edtech EMI providers charge edtechs?', whyItMatters: 'Price ceiling', query: 'edtech emi subvention rate india' },
    { category: 'REGULATION', question: 'What do RBI rules say about default loss guarantees for LSPs?', whyItMatters: 'Model legality', query: 'rbi default loss guarantee lsp cap', activity: 'Acting as a lending service provider with default loss guarantee' },
    { category: 'COST', question: 'What does servicing and collections cost per education loan?', whyItMatters: 'Unit cost', query: 'education loan collection cost per account india' },
    { category: 'OPERATIONS', question: 'How quickly do edtech refund disputes turn into loan defaults?', whyItMatters: 'Loss risk', query: 'edtech refund dispute loan default timeline' },
  ],
};

const SRC = {
  rbi: { title: 'RBI DLG guidelines', url: 'https://rbi.org.in/dlg', content: 'Regulated entities shall ensure that the total amount of DLG cover on any outstanding portfolio does not exceed five per cent of the amount of that loan portfolio.' },
  inc42: { title: 'Inc42: EMI in edtech', url: 'https://inc42.com/edtech-emi', content: 'In 2024, nearly 60% of course purchases on large Indian edtech platforms were paid through no-cost EMI, according to company disclosures.' },
  propelld: { title: 'Propelld for institutes', url: 'https://propelld.com/institutes', content: 'Propelld charges partner institutes a subvention of 6 to 9 per cent of the course fee for no-cost EMI.' },
  climb: { title: 'Climb Credit servicing', url: 'https://example.com/climb-credit', content: 'In 2023 Climb Credit reported servicing costs of about 3 per cent of loan value annually for its US career-training loans.' },
};

let calls: { kind: string; body: any }[] = [];
let escalatePlanFails = false;

/** Tavily: the first-pass queries mostly fail or come back empty; widened queries find the evidence. */
function tavilyFor(body: any): unknown[] | null {
  const q: string = body.query;
  if (q === 'edtech course fee emi share india') return null;            // Q1 first search FAILS (HTTP 500)
  if (q === 'edtech emi subvention rate india') return [];                // Q2 first search EMPTY
  if (q.includes('rbi default loss guarantee')) return [SRC.rbi];       // Q3 answered first time
  if (q === 'education loan collection cost per account india') return [];
  if (body.include_domains?.includes('inc42.com') && /emi/i.test(q)) return [SRC.inc42];      // Indian business press
  if (/propelld|competitors pricing/i.test(q) && body.country === 'india') return [SRC.propelld]; // competitor examples
  if (/climb|united states|income share/i.test(q) && !body.country) return [SRC.climb];      // international analogue
  return [];
}

function extractFor(prompt: string) {
  if (prompt.includes('How many Indian edtech buyers')) return { status: 'ANSWERED', findings: [{ statement: 'About 60% of course purchases on large Indian edtech platforms used no-cost EMI in 2024.', sourceId: idOf(prompt, SRC.inc42.url), quote: 'nearly 60% of course purchases on large Indian edtech platforms were paid through no-cost EMI', confidence: 'MEDIUM', evidenceType: 'DIRECT', geography: 'India', sourceDate: '2024' }] };
  if (prompt.includes('What do existing edtech EMI providers charge')) return { status: 'ANSWERED', findings: [{ statement: 'Propelld charges institutes 6–9% subvention for no-cost EMI.', sourceId: idOf(prompt, SRC.propelld.url), quote: 'Propelld charges partner institutes a subvention of 6 to 9 per cent of the course fee', confidence: 'HIGH', evidenceType: 'DIRECT', geography: 'India', sourceDate: '' }] };
  if (prompt.includes('What do RBI rules say')) return { status: 'ANSWERED', findings: [{ statement: 'DLG cover may not exceed 5% of the loan portfolio.', sourceId: 'S1', quote: 'does not exceed five per cent of the amount of that loan portfolio', confidence: 'HIGH', evidenceType: 'DIRECT', geography: 'India', sourceDate: '' }] };
  if (prompt.includes('What does servicing and collections cost') && prompt.includes(SRC.climb.url)) return { status: 'PARTIAL', findings: [
    { statement: 'A US career-training lender reports servicing costs of about 3% of loan value a year.', sourceId: idOf(prompt, SRC.climb.url), quote: 'Climb Credit reported servicing costs of about 3 per cent of loan value annually', confidence: 'MEDIUM', evidenceType: 'ANALOGOUS', geography: 'United States', sourceDate: '2023', analogy: 'US education lender, not Indian edtech EMI' },
    { statement: 'Same lender, invented date.', sourceId: idOf(prompt, SRC.climb.url), quote: 'servicing costs of about 3 per cent of loan value annually for its US career-training loans', confidence: 'LOW', evidenceType: 'ANALOGOUS', geography: 'United States', sourceDate: '2019' },
  ] };
  return { status: 'NOT_FOUND', findings: [] };
}
const idOf = (prompt: string, url: string) => (prompt.match(new RegExp(`\\[(S\\d+)\\][^\\n]*\\nURL: ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`)) || [])[1] || 'S?';

const GAP = (prompt: string) => ({ gaps: ['Q4', 'Q5'].filter((id) => prompt.includes(`${id} [`)).map((id) => id === 'Q4'
  ? { id, closestEvidence: 'A US education lender spends about 3% of loan value a year on servicing.', closestEvidenceIds: [...(prompt.match(/R\d+ \[ANALOGOUS/g) || []).map((x) => x.split(' ')[0]), 'R99'], implication: 'Suggests servicing could be a few per cent of loan value, if Indian costs are similar.', stillUnknown: 'Indian servicing cost per EMI loan', resolveKind: 'DATA_REQUEST', resolveAction: 'Ask 2 NBFC partners for their servicing cost per education loan.' }
  : { id, closestEvidence: 'Something invented', closestEvidenceIds: ['R1'], implication: 'Unknown', stillUnknown: 'Refund-to-default timeline', resolveKind: 'INTERVIEW', resolveAction: 'Interview 5 NBFC collections heads about edtech refund disputes.' }) });

const reply = (data: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }), { status: 200 });

async function fakeFetch(url: string, init?: RequestInit) {
  const body = JSON.parse(String(init?.body || '{}'));
  if (url.includes('tavily')) {
    calls.push({ kind: 'tavily', body });
    const results = tavilyFor(body);
    return results === null ? new Response('upstream error', { status: 500 }) : new Response(JSON.stringify({ results }), { status: 200 });
  }
  const prompt: string = body.contents[0].parts[0].text;
  const kind = prompt.includes('research planner') ? 'plan' : prompt.includes('You extract evidence for ONE research question') ? 'extract'
    : prompt.includes('FOLLOW-UP web searches') ? 'escalate' : prompt.includes('Research could not settle') ? 'gap' : 'decision';
  calls.push({ kind, body });
  if (kind === 'plan') return reply(PLAN);
  if (kind === 'escalate') {
    if (escalatePlanFails) return new Response('overloaded', { status: 503 });
    return reply({ questions: [
      { id: 'Q1', queries: [{ strategy: 'INDIA_SECONDARY', query: 'no-cost emi edtech course purchases share' }] },
      { id: 'Q2', queries: [{ strategy: 'COMPETITOR_EXAMPLES', query: 'propelld institute subvention no-cost emi' }] },
      { id: 'Q4', queries: [{ strategy: 'INTERNATIONAL_ANALOGUE', query: 'climb credit servicing cost career training loans' }] },
    ] });
  }
  if (kind === 'extract') return reply(extractFor(prompt));
  if (kind === 'gap') return reply(GAP(prompt));
  return reply({ ...deterministicAudit({ idea: IDEA, sector: 'Fintech' }), oneLineVerdict: 'Test verdict' });
}

const saved = { ...process.env };
beforeEach(() => {
  calls = []; escalatePlanFails = false;
  process.env.GEMINI_API_KEY = 'g'; process.env.TAVILY_API_KEY = 't';
  vi.stubGlobal('fetch', vi.fn((u: string, i?: RequestInit) => fakeFetch(u, i)));
});
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

const INPUT = { idea: IDEA, sector: 'Fintech', geography: 'India' };
const deadline = () => Date.now() + 54_000;
const firstPass = () => researchBusiness(INPUT, deadline());
async function escalated(first?: ResearchRecord) {
  let r = first ?? await firstPass();
  while (!r.escalation?.complete) r = await escalateResearch(r, INPUT, deadline());
  return r;
}
const byId = (r: ResearchRecord) => Object.fromEntries((r.questions || []).map((q) => [q.id, q])) as Record<string, ResearchQuestion>;

describe('A failed first search is not the end of research', () => {
  it('first pass alone is NOT a final answer: research is marked as needing escalation', async () => {
    const r = await firstPass();
    const q = byId(r);
    expect(q.Q1.status).toBe('SEARCH_FAILED');
    expect(q.Q2.status).toBe('NOT_FOUND');
    expect(r.escalation).toEqual({ roundsDone: 0, complete: false });
    expect(q.Q1.gap).toBeUndefined(); // no gap is declared before escalation
  });

  it('REGRESSION: a FAILED first search is retried wider and the question gets answered from Indian business press', async () => {
    const q = byId(await escalated());
    expect(q.Q1.status).toBe('ANSWERED');
    expect(q.Q1.attempts![0]).toMatchObject({ round: 0, strategy: 'INITIAL', failed: true });
    const press = q.Q1.attempts!.find((a) => a.strategy === 'INDIA_SECONDARY')!;
    expect(press).toMatchObject({ round: 1, scope: 'INDIA', findings: 1 });
    const call = calls.find((c) => c.kind === 'tavily' && c.body.query === press.query)!;
    expect(call.body.include_domains).toEqual(INDIA_SECONDARY_DOMAINS); // really searched the Indian press, not just "the web"
    expect(call.body).toMatchObject({ country: 'india', search_depth: 'advanced', max_results: 5 });
    // Open-web widening runs at basic depth (1 credit) so the report's budget reaches global sources and analogues too.
    const open = calls.find((c) => c.kind === 'tavily' && c.body.query === q.Q1.attempts!.find((a) => a.strategy === 'REFORMULATED')!.query)!;
    expect(open.body).toMatchObject({ search_depth: 'basic' });
    expect(open.body.chunks_per_source).toBeUndefined();
  });

  it('REGRESSION: an EMPTY first search is reformulated and answered from competitor / company sources', async () => {
    const r = await escalated();
    const q = byId(r);
    expect(q.Q2.status).toBe('ANSWERED');
    expect(q.Q2.attempts!.map((a) => a.strategy)).toEqual(['INITIAL', 'COMPETITOR_EXAMPLES', 'INDIA_COMPANIES', 'REFORMULATED']);
    const f = r.findings!.find((x) => x.questionId === 'Q2')!;
    expect(f).toMatchObject({ evidenceType: 'DIRECT', geography: 'India', round: 1 });
    expect(new Set(q.Q2.attempts!.map((a) => a.query.toLowerCase())).size).toBe(4); // never the same query twice
  });

  it('only analogues → ANALOGOUS (not answered, not "no evidence"); geography kept; an unstated date is dropped', async () => {
    const r = await escalated();
    const q = byId(r);
    expect(q.Q4.status).toBe('ANALOGOUS');
    const fs = r.findings!.filter((x) => x.questionId === 'Q4');
    expect(fs[0]).toMatchObject({ evidenceType: 'ANALOGOUS', geography: 'United States', sourceDate: '2023', analogy: expect.stringMatching(/not Indian/), round: 2 });
    expect(fs[1].sourceDate).toBeUndefined(); // "2019" is not in the source text: the model may not date a fact
    expect(q.Q4.attempts!.find((a) => a.strategy === 'INTERNATIONAL_ANALOGUE')).toMatchObject({ round: 2, scope: 'GLOBAL' });
    const global = calls.find((c) => c.kind === 'tavily' && /climb credit/.test(c.body.query))!;
    expect(global.body.country).toBeUndefined(); // global search really drops the India filter
  });

  it('UNKNOWN only after exhausting reasonable avenues — and then explained, never a bare "no evidence found"', async () => {
    const r = await escalated();
    const q5 = byId(r).Q5;
    expect(q5.status).toBe('NOT_FOUND');
    expect(q5.attempts).toHaveLength(7); // 1 initial + 3 India-wide + 3 beyond India
    const strategies = q5.attempts!.map((a) => a.strategy);
    expect(strategies.slice(1, 4).every((s) => ['REFORMULATED', 'INDIA_PRIMARY', 'INDIA_COMPANIES', 'INDIA_SECONDARY', 'COMPETITOR_EXAMPLES'].includes(s))).toBe(true);
    expect(strategies.slice(4)).toEqual(['INDUSTRY_REPORTS', 'INTERNATIONAL_ANALOGUE', 'CROSS_INDUSTRY_ANALOGUE']);
    const reports = calls.find((c) => c.kind === 'tavily' && c.body.query === q5.attempts![4].query)!;
    expect(reports.body.include_domains).toEqual(REPORT_DOMAINS);
    // The gap: what was searched, closest evidence (none → it may not cite another question's finding), how to resolve.
    expect(q5.gap).toMatchObject({ closestEvidenceIds: [], stillUnknown: 'Refund-to-default timeline', resolveBy: { kind: 'INTERVIEW', action: expect.stringMatching(/Interview 5 NBFC/) } });
    expect(q5.gap!.closestEvidence).toMatch(/No direct or analogous public evidence/);
    const g = gapExplanation(q5, r)!;
    expect(g.lead).toBe('I couldn’t establish this from public evidence.');
    expect(g.checked).toMatch(/^I checked 7 searches \(first search, .*industry & academic reports, international analogues, cross-industry analogues\)/);
    expect(g.resolve).toBe('Interviews: Interview 5 NBFC collections heads about edtech refund disputes.');
  });

  it('closest evidence for an analogue-only gap cites only that question’s own findings', async () => {
    const r = await escalated();
    const q4 = byId(r).Q4;
    const own = r.findings!.filter((f) => f.questionId === 'Q4').map((f) => f.id);
    expect(q4.gap!.closestEvidenceIds.length).toBeGreaterThan(0);
    expect(q4.gap!.closestEvidenceIds.every((id) => own.includes(id))).toBe(true); // R99 (invented) dropped
    expect(q4.gap!.resolveBy).toEqual({ kind: 'DATA_REQUEST', action: 'Ask 2 NBFC partners for their servicing cost per education loan.' });
  });

  it('answered questions are not re-searched (no wasted spend)', async () => {
    const q = byId(await escalated());
    expect(q.Q3.status).toBe('ANSWERED');
    expect(q.Q3.attempts).toHaveLength(1);
    expect(q.Q3.gap).toBeUndefined();
  });

  it('the follow-up query planner failing does not stop escalation: deterministic queries are searched instead', async () => {
    escalatePlanFails = true;
    const r = await escalated();
    const q = byId(r);
    expect(q.Q5.attempts).toHaveLength(7);
    expect(q.Q2.attempts![1]).toMatchObject({ strategy: 'COMPETITOR_EXAMPLES', query: fallbackQuery(q.Q2, 'COMPETITOR_EXAMPLES', r) });
    expect(q.Q2.status).toBe('ANSWERED'); // "edtech emi subvention rate competitors pricing India" still reaches the competitor source
  });

  it('a research spend cap stops widening honestly: recorded, explained, never silent', async () => {
    const first = await firstPass();
    const before = calls.filter((c) => c.kind === 'tavily').length;
    const r = await escalateResearch(first, INPUT, deadline(), { spend: { spentInr: async () => 50, capInr: 45 } });
    expect(calls.filter((c) => c.kind === 'tavily').length).toBe(before); // no further searches
    expect(r.escalation).toMatchObject({ complete: true, roundsDone: 3, stoppedReason: expect.stringMatching(/research cost limit \(₹45\)/) });
    expect(byId(r).Q1.gap).toBeDefined();
    expect(researchBrief(r)).toContain('NOTE: Research stopped widening');
  });
});

describe('The decision memo is only written on escalated research', () => {
  it('runAudit widens research before deciding; the brief shows what was searched and never says "NO EVIDENCE FOUND"', async () => {
    const { research, report } = await runAudit({ idea: IDEA, sector: 'Fintech', geography: 'India', founderFacts: [], scope: 'NEW_IDEA' });
    expect(research.escalation).toMatchObject({ complete: true, roundsDone: 3 });
    const kinds = calls.map((c) => c.kind);
    expect(kinds.lastIndexOf('tavily')).toBeLessThan(kinds.indexOf('decision'));
    expect(kinds.indexOf('gap')).toBeLessThan(kinds.indexOf('decision'));
    const prompt: string = calls.find((c) => c.kind === 'decision')!.body.contents[0].parts[0].text;
    expect(prompt).not.toContain('NO EVIDENCE FOUND');
    expect(prompt).toMatch(/Q4 \[COST\][\s\S]*STATUS: ANALOGOUS[\s\S]*ANALOGOUS · United States · 2023[\s\S]*Cheapest way to find out \(DATA_REQUEST\)/);
    expect(prompt).toContain('ANALOGOUS findings (another country, segment or industry) may support an\nINFERENCE');
    expect(report).toBeTruthy();
  });

  it('job steps: RESEARCH stops after the first pass; each ESCALATE step runs exactly one round', async () => {
    const opts = { stopAfter: 'RESEARCH' as const };
    const input = { idea: IDEA, sector: 'Fintech' as const, geography: 'India', founderFacts: [], scope: 'NEW_IDEA' as const };
    let r = (await runAudit(input, opts)).research;
    expect(r.escalation).toEqual({ roundsDone: 0, complete: false });
    const rounds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const step = await runAudit(input, { existingResearch: r, stopAfter: 'ESCALATE' });
      expect(step.report).toBeNull();
      r = step.research; rounds.push(r.escalation!.roundsDone);
    }
    expect(rounds).toEqual([1, 2, 3]);
    expect(r.escalation!.complete).toBe(true);
    expect(calls.some((c) => c.kind === 'decision')).toBe(false);
  });

  it('a FACT backed only by an analogue is downgraded to INFERENCE', async () => {
    const { validateEvidence } = await import('../src/lib/evidence');
    const r = await escalated();
    const analogue = r.findings!.find((f) => f.evidenceType === 'ANALOGOUS')!.id;
    const direct = r.findings!.find((f) => f.questionId === 'Q3')!.id;
    const { report } = validateEvidence({ evidence: [
      { claim: 'Servicing costs 3% of loan value.', type: 'FACT', sourceIds: [analogue], confidence: 'MEDIUM', validation: '' },
      { claim: 'DLG is capped at 5%.', type: 'FACT', sourceIds: [direct], confidence: 'HIGH', validation: '' },
    ] }, r);
    expect(report.evidence![0]).toMatchObject({ type: 'INFERENCE', note: expect.stringMatching(/analogous/) });
    expect(report.evidence![1]).toMatchObject({ type: 'FACT' });
  });
});
