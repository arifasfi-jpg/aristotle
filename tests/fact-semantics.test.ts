// Founder numbers are bound to what they MEAN, not to whatever is nearby.
// Exact reproduced case (Aaira Books): unit economics showed "Founder age | 5,000 number | Founder stated".
import { describe, expect, it } from 'vitest';
import { deterministicAudit, type UnitEconomicsRow } from '../src/lib/audit';
import { classifyClaim, narrativeProvenance } from '../src/lib/claim-provenance';
import { confirmFounderFacts, describeFact, extractFounderFacts, type FounderFact } from '../src/lib/founder-facts';
import { validateReport } from '../src/lib/report-validation';

const AAIRA = 'I am 10 years old and I want to write a quiz book for kids aged 8 to 15... Sell 5,000 physical books... Sell 1,000 digital books.';
const facts = confirmFounderFacts(extractFounderFacts(AAIRA).facts);
const byConcept = (c: string, subject?: string) => facts.find((f) => f.concept === c && (!subject || f.subject === subject))!;
const row = (r: Partial<UnitEconomicsRow>): UnitEconomicsRow => ({ metric: 'x', conservative: 0, base: 0, upside: 0, unit: '', commentary: '', assumption: '', ...r });
const validate = (rows: UnitEconomicsRow[], f: FounderFact[] = facts) => validateReport({ ...deterministicAudit({ idea: AAIRA, sector: 'Other' }), unitEconomics: rows }, f);

describe('Extraction: each number gets its own meaning (exact Aaira Books statement)', () => {
  it('founder age 10, audience 8–15, 5,000 physical-book target, 1,000 digital-book target — nothing else', () => {
    expect(byConcept('founder_age')).toMatchObject({ value: 10, unit: 'years', subject: 'founder' });
    expect(byConcept('audience_age')).toMatchObject({ low: 8, high: 15, subject: 'kids' });
    expect(byConcept('volume', 'physical books')).toMatchObject({ value: 5000, timeframe: 'TARGET' });
    expect(byConcept('volume', 'digital books')).toMatchObject({ value: 1000, timeframe: 'TARGET' });
    expect(facts).toHaveLength(4);
    expect(facts.some((f) => f.concept === 'other')).toBe(false);               // no meaningless "other number"
    expect(facts.filter((f) => f.value === 5000).map((f) => f.subject)).toEqual(['physical books']);
    expect(facts.filter((f) => f.value === 1000).map((f) => f.subject)).toEqual(['digital books']);
    expect(facts.map(describeFact)).toEqual([
      'Founder age: 10 years',
      'Target audience age (kids): 8–15 years',
      'Target volume: 5,000 physical books',
      'Target volume: 1,000 digital books',
    ]);
  });

  it('the subject survives founder confirmation (it is part of the locked fact)', () => {
    expect(confirmFounderFacts(extractFounderFacts(AAIRA).facts).find((f) => f.value === 5000)!.subject).toBe('physical books');
  });

  it('the mechanism is general, not Aaira-specific', () => {
    const f = extractFounderFacts('I\'m 34, I run a bakery selling 200 cakes a month and want to reach 1,000 cakes a month for children 5-12 years old.').facts;
    expect(f.find((x) => x.concept === 'founder_age')!.value).toBe(34);
    expect(f.find((x) => x.concept === 'audience_age')).toMatchObject({ low: 5, high: 12, subject: 'children' });
    expect(f.filter((x) => x.concept === 'volume').map((x) => [x.timeframe, x.value, x.subject])).toEqual([['CURRENT', 200, 'cakes'], ['TARGET', 1000, 'cakes']]);
    // Unchanged for existing phrasing (glucometer demo).
    const g = extractFounderFacts('We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month.').facts;
    expect(g.filter((x) => x.concept === 'volume').map((x) => [x.timeframe, x.value])).toEqual([['CURRENT', 1400], ['TARGET', 10000]]);
  });
});

describe('Unit economics: a founder number only attaches to a row about the same thing', () => {
  const physical = byConcept('volume', 'physical books');
  const digital = byConcept('volume', 'digital books');

  it('reproduced bug: "Founder age" claiming the 5,000 fact is never shown — ages are not unit economics', () => {
    const { report } = validate([row({ metric: 'Founder age', conservative: 5000, base: 5000, upside: 5000, unit: 'number', concept: 'other', timeframe: 'CURRENT', provenance: 'FOUNDER_STATED', factId: physical.id })]);
    expect(report.unitEconomics.some((r) => /age/i.test(r.metric))).toBe(false);
    expect(report.unitEconomics.find((r) => r.base === 5000)).toMatchObject({ factId: physical.id, metric: 'Target volume — physical books (founder-stated)' });
  });

  it('a row citing the wrong product is re-attached to the right one (digital ↔ physical)', () => {
    const { report } = validate([
      row({ metric: 'Digital books target', conservative: 5000, base: 5000, upside: 5000, unit: 'books', concept: 'volume', timeframe: 'TARGET', provenance: 'FOUNDER_STATED', factId: physical.id }),
      row({ metric: 'Physical books target', conservative: 1000, base: 1000, upside: 1000, unit: 'books', concept: 'volume', timeframe: 'TARGET', provenance: 'FOUNDER_STATED', factId: digital.id }),
    ]);
    expect(report.unitEconomics.find((r) => r.metric === 'Digital books target')).toMatchObject({ base: 1000, factId: digital.id, provenance: 'FOUNDER_STATED' });
    expect(report.unitEconomics.find((r) => r.metric === 'Physical books target')).toMatchObject({ base: 5000, factId: physical.id, provenance: 'FOUNDER_STATED' });
  });

  it('an ambiguous row ("Target volume" with two book targets) is never guessed onto either fact', () => {
    const { report, log } = validate([row({ metric: 'Target volume', conservative: 3000, base: 3000, upside: 3000, unit: 'books', concept: 'volume', timeframe: 'TARGET', provenance: 'FOUNDER_STATED' })]);
    expect(report.unitEconomics.find((r) => r.metric === 'Target volume')).toMatchObject({ provenance: 'ASSUMPTION', base: 3000 });
    expect(log.downgraded.some((d) => d.metric === 'Target volume')).toBe(true);
    // Both founder targets are still shown, each with its own value and subject.
    expect(report.unitEconomics.filter((r) => r.provenance === 'FOUNDER_STATED').map((r) => [r.metric, r.base])).toEqual(
      expect.arrayContaining([['Target volume — physical books (founder-stated)', 5000], ['Target volume — digital books (founder-stated)', 1000]]));
  });

  it('facts already stored by the old extractor ("other" numbers with no meaning) can never become a founder age', () => {
    const legacy = confirmFounderFacts([
      { concept: 'other', timeframe: 'CURRENT', value: 15, unit: 'number', raw: '15' },
      { concept: 'other', timeframe: 'CURRENT', value: 5000, unit: 'number', raw: '5,000' },
      { concept: 'other', timeframe: 'CURRENT', value: 1000, unit: 'number', raw: '1,000' },
    ]);
    const { report } = validate([row({ metric: 'Founder age', conservative: 5000, base: 5000, upside: 5000, unit: 'number', provenance: 'FOUNDER_STATED', factId: 'F2' }), row({ metric: 'Monthly book sales', conservative: 15, base: 15, upside: 15, unit: 'number', provenance: 'FOUNDER_STATED', factId: 'F1' })], legacy);
    expect(report.unitEconomics.some((r) => /age/i.test(r.metric))).toBe(false);
    expect(report.unitEconomics.find((r) => r.metric === 'Monthly book sales')).toMatchObject({ provenance: 'ASSUMPTION' }); // "other" never matched by concept alone
  });
});

describe('Narrative claims are labelled unless research supports them', () => {
  const valid = { research: new Set(['R1', 'S1']), facts: new Set(['F1']) };
  it('"This problem occurs daily" without evidence is a hypothesis, not a fact', () => {
    expect(classifyClaim('Parents struggle to find age-appropriate quiz books. This problem occurs daily.', valid)).toMatchObject({ label: 'HYPOTHESIS' });
  });
  it('"established publishers lack personalization or localized content" without research is a hypothesis', () => {
    const c = classifyClaim('Established publishers lack direct personalization or localized content.', valid);
    expect(c.label).toBe('HYPOTHESIS');
    expect(c.reason).toMatch(/competitors or the market do not do/);
  });
  it('the same claim citing verified research is sourced; unknown citations do not count', () => {
    expect(classifyClaim('Established publishers lack localized content [R1].', valid)).toMatchObject({ label: 'SOURCED', refs: ['R1'] });
    expect(classifyClaim('Established publishers lack localized content [R9].', valid).label).toBe('HYPOTHESIS');
  });
  it('neutral reasoning is an inference; every prose field of a report gets a label', () => {
    expect(classifyClaim('Parents may prefer books that match their child\'s school level.', valid).label).toBe('INFERENCE');
    const p = narrativeProvenance({ customer: { problem: 'This problem occurs daily.', willingnessToPay: 'Unknown.' }, marketView: { competition: 'Publishers lack personalization.', demandSignal: 'Quiz books are popular [R1].' } }, valid);
    expect(p['customer.problem']!.label).toBe('HYPOTHESIS');
    expect(p['marketView.competition']!.label).toBe('HYPOTHESIS');
    expect(p['marketView.demandSignal']!.label).toBe('SOURCED');
  });
});
