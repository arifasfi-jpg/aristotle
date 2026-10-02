// Assumption promotion guard: an AI proposal never becomes "Known" / founder-stated without the founder.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/db', () => ({ db: {} }));
import { confirmFounderFacts, extractFounderFacts } from '../src/lib/founder-facts';
import { getCapability } from '../src/lib/hippo/capabilities';
import { executePrompt } from '../src/lib/hippo/execution';
import { briefPrompt, normaliseBrief } from '../src/lib/hippo/mogli';
import { classifyInputs, matchFounderFact, proposedLabel, type ProvenanceContext } from '../src/lib/hippo/provenance';

const OBJECTIVE = 'Aaira Books publishes illustrated children’s books. We sell about 300 printed books a month and want to sell 1,000 digital books a month by March 2027.';
const facts = confirmFounderFacts(extractFounderFacts(OBJECTIVE).facts); // F1 current 300, F2 target 1,000
const ctx: ProvenanceContext = { objectiveText: OBJECTIVE, facts, findings: [{ code: 'R1', statement: 'Comparable children’s e-books sell for ₹149 on Amazon India.', quote: 'e-books priced at ₹149' }], approvals: [] };
const get = (rows: ReturnType<typeof classifyInputs>, item: string) => rows.find((r) => r.item === item)!;

describe('Aaira Books: ₹99 digital price is an AI proposal, not a founder fact', () => {
  // What the Work 2 brief model returned: it saw "Price digital books at ₹99" in an Aristotle validation experiment.
  const modelInputs = [
    { item: 'Digital book price', status: 'KNOWN', value: '₹99', sourceRef: 'OBJECTIVE' },
    { item: 'Target digital books per month', status: 'NEEDED', value: '', sourceRef: '' },
    { item: 'Current monthly printed book sales', status: 'KNOWN', value: '300 printed books a month', sourceRef: 'F1' },
    { item: 'Bundle price', status: 'KNOWN', value: '₹1,000', sourceRef: 'F2' },
    { item: 'Comparable e-book price', status: 'KNOWN', value: '₹149', sourceRef: 'R1' },
    { item: 'Pricing test variant', status: 'PROPOSED', value: '₹79 vs ₹99', sourceRef: 'AI' },
  ];

  it('₹99 is "AI-proposed validation price — not founder-approved", even when the model claims it is known', () => {
    const r = classifyInputs(modelInputs, ctx);
    expect(get(r, 'Digital book price')).toMatchObject({ status: 'PROPOSED', value: '₹99', source: 'AI' });
    expect(proposedLabel('Digital book price', '₹99')).toBe('AI-proposed validation price — not founder-approved');
    expect(get(r, 'Pricing test variant').status).toBe('PROPOSED');
  });

  it('a price never traces to an unrelated founder number (₹1,000 is not "1,000 digital books")', () => {
    expect(get(classifyInputs(modelInputs, ctx), 'Bundle price').status).toBe('PROPOSED');
  });

  it('the 1,000 digital-book target is filled from the founder objective instead of being asked for again', () => {
    const t = get(classifyInputs(modelInputs, ctx), 'Target digital books per month');
    expect(t).toMatchObject({ status: 'KNOWN', source: 'FOUNDER', sourceRef: facts.find((f) => f.timeframe === 'TARGET')!.id });
    expect(t.value).toMatch(/1,000/);
    expect(matchFounderFact('How many digital books do you want to sell (target)?', facts)?.timeframe).toBe('TARGET');
    expect(matchFounderFact('Brand colours', facts)).toBeUndefined();
  });

  it('founder-stated and research-sourced values stay known, with their provenance', () => {
    const r = classifyInputs(modelInputs, ctx);
    expect(get(r, 'Current monthly printed book sales')).toMatchObject({ status: 'KNOWN', source: 'FOUNDER' });
    expect(get(r, 'Comparable e-book price')).toMatchObject({ status: 'KNOWN', source: 'RESEARCH', sourceRef: 'R1' });
  });

  it('a brief stored before this fix ("₹99 — KNOWN", no provenance) is corrected when read', () => {
    const legacy = [{ item: 'Digital book price', status: 'KNOWN', value: '₹99' }, { item: 'Target', status: 'KNOWN', value: '1,000 digital books a month' }];
    const r = classifyInputs(legacy, ctx);
    expect(r[0].status).toBe('PROPOSED');
    expect(r[1]).toMatchObject({ status: 'KNOWN', source: 'FOUNDER' });
  });

  it('only an explicit founder approval makes the proposal founder-approved', () => {
    const r = classifyInputs(modelInputs, { ...ctx, approvals: [{ item: 'digital book price', value: '₹99' }] });
    expect(get(r, 'Digital book price')).toMatchObject({ status: 'KNOWN', source: 'FOUNDER_APPROVED' });
    expect(get(classifyInputs(modelInputs, { ...ctx, approvals: [{ item: 'Digital book price', value: '₹79' }] }), 'Digital book price').status).toBe('PROPOSED');
  });

  it('normaliseBrief applies the rule; prompts carry provenance to the brief writer and the executor', () => {
    const cap = getCapability('strategy')!;
    const brief = normaliseBrief({ objective: 'Validate digital pricing', deliverable: 'Pricing test plan', inputs: modelInputs, constraints: {}, successCriteria: ['c'], expectedOutput: 'e', outOfScope: [], effort: {} }, cap, ctx);
    expect(get(brief.inputs, 'Digital book price').status).toBe('PROPOSED');
    const bp = briefPrompt({ work: { title: 'Digital pricing test', description: 'd', deliverable: 'x' }, cap, objective: OBJECTIVE, memory: '', timeCommitment: null, company: 'Aaira Books', facts, findings: ctx.findings });
    expect(bp).toContain('PROPOSED for any value that only appears in Aristotle\'s validation experiments');
    expect(bp).toMatch(/F2: Target .*1,000/);
    expect(bp).toContain('Never mark as NEEDED something the founder objective or facts already state');
    const ep = executePrompt({ title: 't', brief, cap, mode: 'AI', memory: '', research: '', company: 'Aaira Books' });
    expect(ep).toContain('Digital book price: ₹99 — AI-PROPOSED, NOT founder-approved');
    expect(ep).toMatch(/Target digital books per month: 1,000.*\(founder stated\)/);
  });
});
