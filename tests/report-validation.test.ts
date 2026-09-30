import { describe, expect, it } from 'vitest';
import { deterministicAudit, type AuditReport, type UnitEconomicsRow } from '../src/lib/audit';
import { confirmFounderFacts, extractFounderFacts } from '../src/lib/founder-facts';
import { validateReport } from '../src/lib/report-validation';

// Founder-confirmed facts: F1 cost ₹500, F2 current 1,400 units/month, F3 target 10,000 by October,
// F4 margin 10–12%, F5 conditional 15% at 10K, F6 AOV 2 units, F7 shipping paid by customer.
const FACTS = confirmFounderFacts(extractFounderFacts(
  'Cost = ₹500. Current sales = 1,400 units/month. Target = 10,000 units in October. Margin = 10–12%, potentially 15% at 10K. AOV = 2 units. Shipping paid by customer.',
).facts);
const id = (concept: string, timeframe?: string) => FACTS.find((f) => f.concept === concept && (!timeframe || f.timeframe === timeframe))!.id;

const baseReport = () => ({ ...deterministicAudit({ idea: 'x', sector: 'Healthtech' }), executiveSummary: 'A focused growth plan.', unitEconomics: [] as UnitEconomicsRow[] }) as AuditReport;
const row = (r: Partial<UnitEconomicsRow>): UnitEconomicsRow => ({ metric: 'x', conservative: 0, base: 0, upside: 0, unit: '', commentary: '', assumption: '', ...r });
const run = (rows: UnitEconomicsRow[], extra: Partial<AuditReport> = {}) => validateReport({ ...baseReport(), ...extra, unitEconomics: rows }, FACTS);
const vals = (r?: UnitEconomicsRow) => (r ? [r.conservative, r.base, r.upside] : undefined);

describe('Report validation: founder facts cannot be changed by the model', () => {
  it('11. founder cost ₹500 wins over Gemini ₹432, even if the row is renamed', () => {
    const { report, log } = run([
      row({ metric: 'Cost per glucometer', conservative: 432, base: 432, upside: 432, unit: '₹ / device', concept: 'unit_cost', timeframe: 'CURRENT', provenance: 'ASSUMPTION' }),
    ]);
    const r = report.unitEconomics.find((x) => x.concept === 'unit_cost')!;
    expect(vals(r)).toEqual([500, 500, 500]);
    expect(r).toMatchObject({ provenance: 'FOUNDER_STATED', factId: id('unit_cost') });
    expect(log.corrected).toHaveLength(1);
  });

  it('11b. untagged legacy row "Unit cost" ₹450 is still caught', () => {
    const { report } = run([row({ metric: 'Unit cost', conservative: 450, base: 450, upside: 450, unit: '₹ / unit' })]);
    expect(vals(report.unitEconomics.find((x) => x.concept === 'unit_cost'))).toEqual([500, 500, 500]);
  });

  it('12. founder current volume 1,400 wins over Gemini 1,000 (including a mislabelled "projection")', () => {
    for (const tf of ['CURRENT', 'PROJECTION'] as const) {
      const { report } = run([row({ metric: 'Sales volume', conservative: 1000, base: 1000, upside: 1000, unit: 'units / month', concept: 'volume', timeframe: tf, provenance: 'ASSUMPTION' })]);
      expect(vals(report.unitEconomics.find((x) => x.metric === 'Sales volume'))).toEqual([1400, 1400, 1400]);
    }
  });

  it('13. margin 10–12% wins over 55%, unless 55% is explicitly a labelled external/assumption scenario with a basis', () => {
    const plain = run([row({ metric: 'Gross margin', conservative: 50, base: 55, upside: 60, unit: '%', concept: 'margin', timeframe: 'CURRENT', provenance: 'ASSUMPTION' })]);
    const m = plain.report.unitEconomics.find((x) => x.metric === 'Gross margin')!;
    expect([m.conservative, m.upside]).toEqual([10, 12]);
    expect(m.provenance).toBe('FOUNDER_STATED');

    const scenario = run([row({ metric: 'Industry gross margin', conservative: 55, base: 55, upside: 55, unit: '%', concept: 'margin', timeframe: 'CURRENT', provenance: 'EXTERNAL', basis: 'Typical margin for branded glucometers in Indian retail research' })]);
    const s = scenario.report.unitEconomics.find((x) => x.metric.includes('Industry gross margin'))!;
    expect(s.metric).toBe('External benchmark: Industry gross margin');
    expect(s).toMatchObject({ base: 55, provenance: 'EXTERNAL', differsFromFounder: true });
    expect(s.provenance).not.toBe('FOUNDER_STATED');
    // The founder's 10–12% is still present as its own locked row.
    expect(scenario.report.unitEconomics.find((x) => x.factId === id('margin', 'CURRENT'))).toMatchObject({ conservative: 10, upside: 12, provenance: 'FOUNDER_STATED' });
  });

  it('a TARGET stays a target and never becomes current', () => {
    const { report } = run([row({ metric: 'Target monthly units', conservative: 8000, base: 9000, upside: 10000, unit: 'units / month', concept: 'volume', timeframe: 'TARGET', provenance: 'ASSUMPTION' })]);
    expect(vals(report.unitEconomics.find((x) => x.metric === 'Target monthly units'))).toEqual([10000, 10000, 10000]);
    expect(vals(report.unitEconomics.find((x) => x.factId === id('volume', 'CURRENT')))).toEqual([1400, 1400, 1400]);
  });

  it('a row claiming FOUNDER_STATED without a real founder fact is downgraded', () => {
    const { report, log } = run([row({ metric: 'Customer acquisition cost', conservative: 300, base: 250, upside: 200, unit: '₹ / customer', concept: 'cac', timeframe: 'CURRENT', provenance: 'FOUNDER_STATED', assumption: 'FOUNDER-STATED: CAC' })]);
    expect(report.unitEconomics.find((x) => x.concept === 'cac')!.provenance).toBe('ASSUMPTION');
    expect(log.downgraded[0].reason).toMatch(/no confirmed founder fact/);
  });

  it('calculated rows must trace to founder facts or labelled assumptions', () => {
    const ok = run([row({ metric: 'Monthly gross profit at current volume', conservative: 1, base: 2, upside: 3, unit: '₹ / month', concept: 'contribution', timeframe: 'PROJECTION', provenance: 'CALCULATED', inputs: [id('unit_cost'), id('volume', 'CURRENT'), id('margin', 'CURRENT')] })]);
    expect(ok.report.unitEconomics.find((x) => x.concept === 'contribution')!.provenance).toBe('CALCULATED');
    const bad = run([row({ metric: 'Monthly gross profit', conservative: 1, base: 2, upside: 3, unit: '₹ / month', concept: 'contribution', timeframe: 'PROJECTION', provenance: 'CALCULATED', inputs: ['F99', 'made-up number'] })]);
    expect(bad.report.unitEconomics.find((x) => x.concept === 'contribution')!.provenance).toBe('ASSUMPTION');
    const none = run([row({ metric: 'Profit', conservative: 1, base: 2, upside: 3, unit: '₹', concept: 'contribution', timeframe: 'PROJECTION', provenance: 'CALCULATED' })]);
    expect(none.report.unitEconomics.find((x) => x.metric === 'Profit')!.provenance).toBe('ASSUMPTION');
    // A legitimate projection of volume at target (calculated from facts) is allowed to differ from current.
    const proj = run([row({ metric: 'Projected monthly units after 3 months', conservative: 2000, base: 3000, upside: 4000, unit: 'units / month', concept: 'volume', timeframe: 'PROJECTION', provenance: 'CALCULATED', inputs: [id('volume', 'CURRENT'), id('volume', 'TARGET')] })]);
    expect(vals(proj.report.unitEconomics.find((x) => x.metric.startsWith('Projected')))).toEqual([2000, 3000, 4000]);
  });

  it('counts never carry ₹ (e.g. "Orders per active customer per month")', () => {
    const { report } = run([row({ metric: 'Orders per active customer per month', conservative: 200, base: 400, upside: 800, unit: '₹ / customer / month', concept: 'volume', timeframe: 'ASSUMPTION', provenance: 'ASSUMPTION', basis: 'No founder data; pilot assumption for new customers' })]);
    const r = report.unitEconomics.find((x) => x.metric.includes('Orders per active customer'))!;
    expect(r.unit).not.toMatch(/₹/);
    expect(vals(r)).toEqual([200, 400, 800]);
  });

  it('every numeric founder fact appears in unit economics', () => {
    const { report } = run([]);
    for (const f of FACTS.filter((f) => f.value !== undefined || f.low !== undefined)) {
      expect(report.unitEconomics.some((r) => r.factId === f.id && r.provenance === 'FOUNDER_STATED')).toBe(true);
    }
  });

  it('narrative that contradicts a founder figure is flagged', () => {
    const { report, log } = run([], { executiveSummary: 'Current sales are 900 units a month at a cost of ₹450 each, with a 55% gross margin.' });
    expect(log.proseConflicts.length).toBeGreaterThanOrEqual(2);
    expect(report.assumptions.some((a) => a.startsWith('FOUNDER FIGURE TAKES PRECEDENCE'))).toBe(true);
  });
});

describe('14. proposed pricing is never converted into revenue', () => {
  const PRICE = confirmFounderFacts(extractFounderFacts('I want to launch a pharmacy SaaS at ₹1,499/month and target 200 pharmacies by March.').facts);
  it('a "Target revenue" row equal to the ₹1,499 price is turned back into the founder price', () => {
    const { report, log } = validateReport({ ...baseReport(), unitEconomics: [row({ metric: 'Target monthly revenue', conservative: 1499, base: 1499, upside: 1499, unit: '₹ / month', concept: 'revenue', timeframe: 'TARGET', provenance: 'ASSUMPTION' })] }, PRICE);
    expect(log.converted).toContain('Target monthly revenue');
    expect(report.unitEconomics.some((r) => r.concept === 'revenue' && r.base === 1499)).toBe(false);
    expect(report.unitEconomics.find((r) => r.concept === 'selling_price')).toMatchObject({ base: 1499, provenance: 'FOUNDER_STATED', timeframe: 'PROPOSED' });
  });
  it('a CALCULATED revenue projection from price × customers is allowed', () => {
    const [price, cust] = PRICE;
    const { report } = validateReport({ ...baseReport(), unitEconomics: [row({ metric: 'Projected MRR at target', conservative: 299800, base: 299800, upside: 299800, unit: '₹ / month', concept: 'revenue', timeframe: 'PROJECTION', provenance: 'CALCULATED', inputs: [price.id, cust.id] })] }, PRICE);
    expect(report.unitEconomics.find((r) => r.metric === 'Projected MRR at target')).toMatchObject({ base: 299800, provenance: 'CALCULATED' });
  });
});

describe('Report skeleton (never shown to a founder) has no sector defaults', () => {
  it('contains only founder facts and calculations from them — no sector price, margin or CAC', () => {
    const r = deterministicAudit({ idea: 'x', sector: 'Quick Commerce', founderFacts: FACTS, scope: 'GROWTH_PLAN' });
    const { report } = validateReport(r, FACTS);
    expect(vals(report.unitEconomics.find((x) => x.factId === id('unit_cost')))).toEqual([500, 500, 500]);
    expect(report.unitEconomics.every((x) => x.provenance === 'FOUNDER_STATED' || x.provenance === 'CALCULATED')).toBe(true);
    expect(JSON.stringify(report.unitEconomics)).not.toMatch(/Sector-default|Gross margin estimated|Acquisition cost/);
  });
  it('with no founder numbers there are no numbers at all', () => {
    const r = deterministicAudit({ idea: 'I want to launch a pharmacy platform in Pune.', sector: 'Healthtech' });
    expect(r.unitEconomics).toEqual([]);
    expect(validateReport(r, []).report.unitEconomics).toEqual([]);
  });
});
