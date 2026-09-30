import { afterEach, describe, expect, it, vi } from 'vitest';
import { deterministicAudit } from '../src/lib/audit';
import { toResearchRecord, validateEvidence, type CriticalAssumption, type EvidenceClaim } from '../src/lib/evidence';
import { confirmFounderFacts, extractFounderFacts } from '../src/lib/founder-facts';
import { runAudit } from '../src/lib/ai';

const RESEARCH = toResearchRecord([
  { query: 'pharmacy whatsapp india competitors', results: [
    { title: 'Pharmacy SaaS pricing in India', url: 'https://example.org/pharmacy-saas-pricing', content: 'Most tools charge ₹999–₹2,499 per month.' },
    { title: 'Duplicate', url: 'https://example.org/pharmacy-saas-pricing', content: 'dup' },
  ] },
  { query: 'pharmacy regulation india', results: [{ title: 'CDSCO', url: 'https://cdsco.gov.in/opencms/opencms/en/Home/', content: 'Drugs and Cosmetics Act' }] },
]);
const FACTS = confirmFounderFacts(extractFounderFacts('I want to launch a pharmacy SaaS at ₹1,499/month and target 200 pharmacies by March.').facts);

describe('Research record', () => {
  it('gives every unique source a stable id', () => {
    expect(RESEARCH.sources.map((s) => [s.id, s.url])).toEqual([['S1', 'https://example.org/pharmacy-saas-pricing'], ['S2', 'https://cdsco.gov.in/opencms/opencms/en/Home/']]);
    expect(RESEARCH.queries).toHaveLength(2);
  });
});

describe('Evidence validation (server-side, citations are never trusted)', () => {
  const base = () => ({ ...deterministicAudit({ idea: 'x', sector: 'Healthtech' }) });

  it('removes invented source ids and downgrades an unsourced FACT to INFERENCE', () => {
    const { report, log } = validateEvidence({ ...base(), evidence: [
      { claim: 'Pharmacy SaaS tools charge ₹999–₹2,499/month.', type: 'FACT', sourceIds: ['S1'], confidence: 'HIGH', validation: 'Check vendor sites' },
      { claim: 'India has 9 lakh pharmacies.', type: 'FACT', sourceIds: ['S7', 'made-up'], confidence: 'HIGH', validation: '' },
      { claim: 'Price is ₹1,499/month.', type: 'FOUNDER', sourceIds: [FACTS[0].id], confidence: 'HIGH', validation: '' },
      { claim: 'Churn will be 3%.', type: 'FOUNDER', sourceIds: [], confidence: 'MEDIUM', validation: '' },
    ] }, RESEARCH, FACTS);
    const [sourced, invented, founder, fakeFounder] = report.evidence! as EvidenceClaim[];
    expect(sourced).toMatchObject({ type: 'FACT', sourceIds: ['S1'], verified: true });
    expect(invented).toMatchObject({ type: 'INFERENCE', confidence: 'LOW', sourceIds: [], verified: false });
    expect(invented.note).toMatch(/No verifiable source/);
    expect(founder).toMatchObject({ type: 'FOUNDER', sourceIds: [FACTS[0].id] });
    expect(fakeFounder.type).toBe('ASSUMPTION');
    expect(log).toMatchObject({ droppedSourceIds: 2, downgradedFacts: 1 });
  });

  it('a critical assumption marked SUPPORTED needs real evidence, otherwise it is UNKNOWN', () => {
    const { report } = validateEvidence({ ...base(), decisionMemo: {
      decisionQuestion: 'Should I build this?',
      criticalAssumptions: [
        { assumption: 'Pharmacies will pay ₹1,499/month', whyItMatters: 'price', evidenceStatus: 'SUPPORTED', evidence: 'Competitors charge similar', evidenceIds: ['S1'], cheapestTest: 'Pre-sell 10', experimentIndex: 2 },
        { assumption: 'Owners use WhatsApp daily', whyItMatters: 'channel', evidenceStatus: 'SUPPORTED', evidence: 'Everyone knows', evidenceIds: ['S99'], cheapestTest: 'Survey', experimentIndex: 9 },
        { assumption: 'Repeat purchases are frequent', whyItMatters: 'retention', evidenceStatus: 'UNKNOWN', evidence: 'No evidence yet', evidenceIds: [], cheapestTest: 'Pilot', experimentIndex: 3 },
      ],
      proceedIf: ['3 of 10 pay'], changeModelIf: ['0 of 10 pay'], evidenceStillRequired: ['Willingness to pay'],
    } }, RESEARCH, FACTS);
    const [a, b, c] = report.decisionMemo!.criticalAssumptions as CriticalAssumption[];
    expect(a).toMatchObject({ evidenceStatus: 'SUPPORTED', evidenceIds: ['S1'], experimentIndex: 2 });
    expect(b).toMatchObject({ evidenceStatus: 'UNKNOWN', evidenceIds: [] });
    expect(b.note).toMatch(/without verifiable evidence/);
    expect(b.experimentIndex).toBeUndefined(); // there is no experiment 9
    expect(c.evidenceStatus).toBe('UNKNOWN');
  });

  it('regulatory sources must be researched or official; unverifiable links are removed', () => {
    const { report, log } = validateEvidence({ ...base(), regulatory: [
      { name: 'Drugs & Cosmetics Act', status: 'Likely', rationale: 'Dispensing medicines', action: 'Check licence', source: 'https://cdsco.gov.in/opencms/opencms/en/Home/', trigger: 'Pharmacies dispensing medicines' },
      { name: 'Made-up Act', status: 'Likely', rationale: 'Because', action: 'x', source: 'https://random-blog.example.com/act' },
      { name: 'GST', status: 'Conditional', rationale: 'Taxable supplies', action: 'Register', source: 'https://www.gst.gov.in/' },
    ] }, RESEARCH, FACTS);
    expect(report.regulatory.map((r) => r.source)).toEqual(['https://cdsco.gov.in/opencms/opencms/en/Home/', '', 'https://www.gst.gov.in/']);
    expect(report.regulatory[1].trigger).toBe('Because'); // falls back to the stated rationale
    expect(log.unverifiedRegSources).toBe(1);
  });
});

describe('Audit engine: a paying founder never receives a template', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  it('outside Demo Mode, missing AI credentials fail (retryable) instead of returning a template', async () => {
    delete process.env.GEMINI_API_KEY; delete process.env.TAVILY_API_KEY; delete process.env.DEMO_MODE;
    await expect(runAudit({ idea: 'An AI WhatsApp platform for pharmacies', sector: 'Healthtech' })).rejects.toThrow(/AI_ENGINE_NOT_CONFIGURED/);
    process.env.DEMO_MODE = 'true'; process.env.VERCEL_ENV = 'production';
    await expect(runAudit({ idea: 'An AI WhatsApp platform for pharmacies', sector: 'Healthtech' })).rejects.toThrow(/AI_ENGINE_NOT_CONFIGURED/);
  });

  it('Demo Mode template is honest: every critical assumption UNKNOWN, no default regulations', async () => {
    delete process.env.GEMINI_API_KEY; delete process.env.TAVILY_API_KEY;
    process.env.DEMO_MODE = 'true'; process.env.VERCEL_ENV = 'preview';
    const r = await runAudit({ idea: 'A consulting service for small agencies', sector: 'Digital Agency' });
    expect(r.research).toBeNull();
    expect(r.report.decisionMemo!.criticalAssumptions.every((a) => a.evidenceStatus === 'UNKNOWN')).toBe(true);
    expect(r.report.regulatory.map((x) => x.name)).not.toContain('MSME / Udyam');
    expect(r.report.regulatory.every((x) => (x.trigger || '').length > 0)).toBe(true);
  });

  it('full pipeline: Tavily sources get ids, Gemini citations are verified, fabricated ones removed', async () => {
    process.env.GEMINI_API_KEY = 'g'; process.env.TAVILY_API_KEY = 't'; delete process.env.DEMO_MODE;
    const gemReport = {
      ...deterministicAudit({ idea: 'x', sector: 'Healthtech' }),
      decisionMemo: { decisionQuestion: 'Build it?', criticalAssumptions: [
        { assumption: 'Pharmacies pay ₹1,499', whyItMatters: 'price', evidenceStatus: 'SUPPORTED', evidence: 'Similar tools', evidenceIds: ['S1'], cheapestTest: 'Pre-sell', experimentIndex: 1 },
        { assumption: 'Huge market', whyItMatters: 'size', evidenceStatus: 'SUPPORTED', evidence: 'A famous report', evidenceIds: ['S42'], cheapestTest: 'n/a', experimentIndex: 2 },
        { assumption: 'Repeat buying', whyItMatters: 'retention', evidenceStatus: 'UNKNOWN', evidence: 'None', evidenceIds: [], cheapestTest: 'Pilot', experimentIndex: 3 },
      ], proceedIf: ['x'], changeModelIf: ['y'], evidenceStillRequired: ['z'] },
      evidence: [{ claim: 'Market is ₹5,000 crore', type: 'FACT', sourceIds: ['S42'], confidence: 'HIGH', validation: '' }],
    };
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('tavily')) return new Response(JSON.stringify({ results: [{ title: 'Pricing', url: 'https://example.org/p', content: 'c' }] }), { status: 200 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemReport) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runAudit({ idea: 'An AI WhatsApp platform for pharmacies', sector: 'Healthtech' });
    expect(r.research!.sources.map((s) => s.id)).toEqual(['S1']);
    const prompt = JSON.parse((fetchSpy.mock.calls.find((c) => String(c[0]).includes('generativelanguage'))![1]!).body as string).contents[0].parts[0].text as string;
    expect(prompt).toContain('[S1] TITLE: Pricing');
    expect(prompt).toContain('EVIDENCE DISCIPLINE');
    const [a, b] = r.report.decisionMemo!.criticalAssumptions;
    expect(a.evidenceStatus).toBe('SUPPORTED');
    expect(b.evidenceStatus).toBe('UNKNOWN');
    expect(r.report.evidence![0]).toMatchObject({ type: 'INFERENCE', confidence: 'LOW', sourceIds: [] });
  });
});
