// Hippoturtle deterministic layer: routing, grounding, costs, payments, gateway selection.
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/db', () => ({ db: {} }));
import { allowedModes, CAPABILITIES, getCapability, routeCapability } from '../src/lib/hippo/capabilities';
import { computeEstimates, normaliseEffort } from '../src/lib/hippo/costs';
import { normaliseOutput, positionQuote } from '../src/lib/hippo/execution';
import { activeProvider } from '../src/lib/hippo/gateway';
import { normaliseBrief, normalisePlan } from '../src/lib/hippo/mogli';
import { normalisePathways } from '../src/lib/hippo/pathways';
import { workPaymentPlan } from '../src/lib/hippo/payments';
import { inferSector, understandFromNumbers } from '../src/lib/hippo/aristotle';
import { advanceTo } from '../src/lib/hippo/types';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('Capability registry and routing', () => {
  it('registers the organisation (13 named capabilities + planned ones) without exposing agent choice', () => {
    for (const n of ['Mogli', 'Aristotle', 'Galileo', 'Aaira Studio', 'Marcus', 'Kuber', 'Garg', 'Eagle', 'Minerva', 'Sherlock', 'Xeno', 'Olympus', 'Sia']) expect(CAPABILITIES.some((c) => c.internalName === n)).toBe(true);
    expect(CAPABILITIES.filter((c) => !c.enabled).map((c) => c.label)).toEqual(expect.arrayContaining(['HR', 'Payroll', 'Fundraising', 'Cybersecurity']));
  });
  it('unknown or disabled capabilities route to Strategy & Research', () => {
    expect(routeCapability('nonsense').id).toBe('strategy');
    expect(routeCapability('payroll').id).toBe('strategy');
    expect(routeCapability('sales').internalName).toBe('Marcus');
  });
  it('regulated work never offers AI-only execution', () => {
    expect(allowedModes(getCapability('legal_regulatory')!)).toEqual(['HYBRID', 'HUMAN']);
    expect(allowedModes(getCapability('accounting_tax')!)).not.toContain('AI');
    expect(allowedModes(getCapability('technology')!)).toEqual(['AI', 'HUMAN', 'HYBRID']);
  });
});

describe('Pathways: ambition kept, evidence grounded', () => {
  const valid = { findings: new Set(['R1', 'R2']), facts: new Set(['F1', 'F2']) };
  const raw = { goal: 'Reach 10,000 units/month', ambitionNote: 'Needs ~7x growth', combination: 'P1 + P2', founderChecklist: ['Working capital limit'], pathways: [
    { name: 'Pharmacy network', howItWorks: 'Sell through chemists', whyPlausible: 'Pharmacies already stock glucometers', evidence: [{ statement: 'Chemists stock glucometers', refs: ['R1'] }, { statement: 'Made up', refs: ['R9'] }], economics: 'Margin per unit ₹200 [F1]', constraints: ['Credit terms'], risks: ['Returns'], firstExperiment: 'Call 20 chemists', contributionToTarget: 'Needs 500 outlets × 6 units' },
    { name: 'D2C', howItWorks: 'Own website and ads', whyPlausible: 'Online demand', evidence: [], economics: 'CAC will be ₹350 and margin 55%', constraints: [], risks: [], firstExperiment: '₹5,000 ad test', contributionToTarget: 'Needs 3,000 orders/month' },
  ] };
  it('drops evidence citing unknown refs, removes ungrounded numbers, keeps grounded ones', () => {
    const r = normalisePathways(raw, valid);
    expect(r.pathways[0].evidence).toEqual([{ statement: 'Chemists stock glucometers', refs: ['R1'] }]);
    expect(r.pathways[0].evidenceStrength).toBe('PARTIAL');
    expect(r.pathways[0].economics).toContain('[F1]');
    expect(r.pathways[1].economics).toMatch(/^Not yet established\./);
    expect(r.pathways[1].evidenceStrength).toBe('NOT_YET_ESTABLISHED');
    expect(r.goal).toBe('Reach 10,000 units/month');
  });
  it('refuses fewer than two usable pathways', () => {
    expect(() => normalisePathways({ ...raw, pathways: [raw.pathways[0]] }, valid)).toThrow(/PATHWAYS_INVALID/);
  });
});

describe('Mogli: work generation and briefs', () => {
  it('routes work to capabilities and never marks regulated work AI-executable', () => {
    const p = normalisePlan({ headline: 'h', work: [
      { title: 'GTM plan', description: 'd', deliverable: 'A GTM plan', capability: 'marketing', priority: 1, pathwayId: 'P1', whyNow: 'x', aiExecutable: true },
      { title: 'CDSCO checklist', description: 'd', deliverable: 'Checklist', capability: 'legal_regulatory', priority: 9, pathwayId: 'bad', whyNow: 'x', aiExecutable: true },
      { title: 'Mystery', description: 'd', deliverable: 'x', capability: 'quantum', priority: 2, pathwayId: '', whyNow: '', aiExecutable: true },
    ] });
    expect(p.work.map((w) => [w.capability, w.aiExecutable, w.priority, w.pathwayId])).toEqual([['marketing', true, 1, 'P1'], ['legal_regulatory', false, 5, undefined], ['strategy', true, 2, undefined]]);
  });
  it('brief inputs marked KNOWN without a value become NEEDED; unset budget stays "Not set by founder"', () => {
    const raw = { objective: 'o', deliverable: 'd', inputs: [{ item: 'Price', status: 'KNOWN', value: '' }, { item: 'Volume', status: 'KNOWN', value: '1,400/month' }], constraints: { geography: 'India' }, successCriteria: ['c'], expectedOutput: 'e', outOfScope: [], effort: {} };
    const b = normaliseBrief(raw, getCapability('legal_regulatory')!, { objectiveText: 'We sell 1,400 units a month.', facts: [], findings: [], approvals: [] });
    expect(b.inputs.map((i) => i.status)).toEqual(['NEEDED', 'KNOWN']);
    // Without founder provenance the model's "KNOWN" is not trusted: it is an AI proposal.
    expect(normaliseBrief(raw, getCapability('legal_regulatory')!).inputs.map((i) => i.status)).toEqual(['NEEDED', 'PROPOSED']);
    expect(b.constraints.budget).toBe('Not set by founder');
    expect(b.constraints.regulatory).toMatch(/professional/i);
  });
});

describe('Cost intelligence is deterministic and labelled', () => {
  const cap = getCapability('marketing')!;
  it('AI cost from model rates + 10% margin; human/agency/hybrid labelled as benchmarks', () => {
    const effort = normaliseEffort({ aiFeasible: true, aiOutputTokens: 6000, specialist: 'Marketer', humanHours: { low: 8, high: 12 }, hourlyRateInr: { low: 500, high: 800 }, hybridReviewHours: { low: 1, high: 2 }, agencyMultiplier: { low: 1.5, high: 2 }, costDrivers: ['Revisions'], rateBasis: 'assumed freelance rate' }, cap);
    const e = Object.fromEntries(computeEstimates(effort, cap, 4000).map((x) => [x.mode, x]));
    expect(e.AI.label).toBe('COMPUTED');
    expect(e.AI.breakdown['Platform margin (₹)']).toBeCloseTo((e.AI.breakdown['AI / API cost (₹)'] as number) * 0.1, 2);
    expect([e.HUMAN.low, e.HUMAN.high]).toEqual([4000, 9600]);
    expect([e.AGENCY.low, e.AGENCY.high]).toEqual([6000, 19200]);
    expect(e.HUMAN.label).toBe('AI_BENCHMARK');
    expect(e.HYBRID.low).toBeGreaterThan(500);
  });
  it('without a rate there is no human figure at all (never invented)', () => {
    const effort = normaliseEffort({ humanHours: { low: 8, high: 12 }, hourlyRateInr: { low: 0, high: 0 } } as never, cap);
    expect(computeEstimates(effort, cap, 1000).map((e) => e.mode)).toEqual(['AI']);
  });
  it('regulated capability: no AI estimate', () => {
    const legal = getCapability('legal_regulatory')!;
    const effort = normaliseEffort({ aiFeasible: true, humanHours: { low: 2, high: 4 }, hourlyRateInr: { low: 2000, high: 4000 } } as never, legal);
    expect(computeEstimates(effort, legal, 1000).map((e) => e.mode)).toEqual(['HUMAN', 'AGENCY', 'HYBRID']);
  });
  it('honest broker positions a quote against the benchmark', () => {
    expect(positionQuote(13500, { low: 8000, high: 12000 })).toMatchObject({ position: 'ABOVE', deltaPct: 35 });
    expect(positionQuote(5000, { low: 8000, high: 12000 }).position).toBe('BELOW');
    expect(positionQuote(5000, null).position).toBe('NO_BENCHMARK');
  });
});

describe('Payments are never faked', () => {
  it('early access: AI not charged; human payments pending integration; razorpay setting blocks execution', () => {
    expect(workPaymentPlan('AI')).toMatchObject({ required: false, status: 'INCLUDED_EARLY_ACCESS' });
    expect(workPaymentPlan('HUMAN').status).toBe('PENDING_INTEGRATION');
    process.env.HIPPO_WORK_PAYMENTS = 'razorpay';
    expect(workPaymentPlan('AI')).toMatchObject({ required: true, status: 'PENDING_INTEGRATION' });
    expect(['PAID']).not.toContain(workPaymentPlan('AI').status);
  });
});

describe('Model gateway selection', () => {
  it('uses whichever provider is configured, explicit preference wins, none → null', () => {
    delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.HIPPO_AI_PROVIDER;
    expect(activeProvider()).toBeNull();
    process.env.ANTHROPIC_API_KEY = 'a';
    expect(activeProvider()?.provider).toBe('anthropic');
    process.env.GEMINI_API_KEY = 'g';
    expect(activeProvider()?.provider).toBe('gemini');
    process.env.HIPPO_AI_PROVIDER = 'anthropic';
    expect(activeProvider()?.provider).toBe('anthropic');
  });
});

describe('Understanding, workflow and outputs', () => {
  it('restates the founder objective from their own numbers without shrinking the target', () => {
    const u = understandFromNumbers('We currently sell approximately 1,400 glucometers per month through IndiaMART. We want to reach 10,000 units per month.');
    expect(u.target).toContain('10,000');
    expect(u.currentState).toContain('1,400');
    expect(u.source).toBe('FOUNDER_NUMBERS');
    expect(inferSector('glucometers for diabetics')).toBe('Healthtech');
  });
  it('stages only move forward', () => {
    expect(advanceTo('EXECUTION', 'DECISION')).toBe('EXECUTION');
    expect(advanceTo('DECISION', 'PATHWAYS')).toBe('PATHWAYS');
  });
  it('regulated or hybrid output is always flagged for professional/human review; empty output rejected', () => {
    expect(normaliseOutput({ summary: 's', markdown: 'x'.repeat(300), assumptions: [], founderInputsNeeded: [], professionalReviewRequired: false }, getCapability('legal_regulatory')!, 'HYBRID').professionalReviewRequired).toBe(true);
    expect(() => normaliseOutput({ markdown: 'short' }, getCapability('marketing')!, 'AI')).toThrow(/EXECUTION_INVALID/);
  });
});

describe('Identity: Hippoturtle is never the founder\'s business', () => {
  it('every Hippoturtle prompt names the founder\'s business and forbids treating Hippoturtle as it', async () => {
    const { identityBlock, businessName, isGenericOrgName, DEMO_COMPANY_NAME } = await import('../src/lib/hippo/types');
    const { understandPrompt } = await import('../src/lib/hippo/aristotle');
    const { planPrompt, briefPrompt } = await import('../src/lib/hippo/mogli');
    const { executePrompt } = await import('../src/lib/hippo/execution');
    const { pathwaysPrompt } = await import('../src/lib/hippo/pathways');
    const company = DEMO_COMPANY_NAME;
    const cap = getCapability('marketing')!;
    const brief = { objective: 'o', deliverable: 'd', inputs: [], constraints: { budget: '', deadline: '', geography: '', brand: '', technology: '', regulatory: '' }, successCriteria: ['c'], expectedOutput: 'e', outOfScope: [], effort: {} };
    const prompts = [
      understandPrompt('grow glucometers', company),
      pathwaysPrompt({ objective: 'grow', understanding: null, facts: [], research: null, report: {} as never, company }),
      planPrompt({ objective: 'grow', understanding: null, pathways: [], experiments: [], thirtyDayPlan: [], memory: '', company }),
      briefPrompt({ work: { title: 't', description: 'd', deliverable: 'x' }, cap, objective: 'grow', memory: '', timeCommitment: null, company }),
      executePrompt({ title: 't', brief, cap, mode: 'AI', memory: '', research: '', company }),
    ];
    for (const p of prompts) { expect(p).toContain(`"${company}"`); expect(p).toContain('Hippoturtle is NOT the founder\'s business'); }
    expect(identityBlock(null)).toContain('call it "your business"');
    expect(businessName('Hippoturtle')).toBeNull();
    expect(businessName('My company')).toBeNull();
    expect(businessName('GlucoseCare India')).toBe('GlucoseCare India');
    expect(isGenericOrgName('HippoTurtle Labs')).toBe(true);
    expect(DEMO_COMPANY_NAME).not.toMatch(/hippo/i);
  });
});

