// Unit economics = semantic metric selection. Founder facts appear only where they are economic quantities,
// keep their subject, are never duplicated as assumptions, and AI-proposed values stay assumptions.
import { describe, expect, it } from 'vitest';
import { deterministicAudit, type UnitEconomicsRow } from '../src/lib/audit';
import { confirmFounderFacts, extractFounderFacts, type FounderFact } from '../src/lib/founder-facts';
import { validateReport } from '../src/lib/report-validation';

const confirmed = (text: string) => confirmFounderFacts(JSON.parse(JSON.stringify(extractFounderFacts(text).facts))); // as sent back by the confirm screen
const row = (r: Partial<UnitEconomicsRow>): UnitEconomicsRow => ({ metric: 'x', conservative: r.base ?? 0, base: 0, upside: r.base ?? 0, unit: '', commentary: '', assumption: '', ...r });
const run = (text: string, facts: FounderFact[], rows: UnitEconomicsRow[]) => validateReport({ ...deterministicAudit({ idea: text, sector: 'Other' }), unitEconomics: rows }, facts).report.unitEconomics;
const view = (rows: UnitEconomicsRow[]) => rows.map((r) => [r.metric, r.base, r.provenance]);
/** Each founder fact appears at most once, and never as an assumption. */
function assertNoDuplicates(rows: UnitEconomicsRow[], facts: FounderFact[]) {
  for (const f of facts.filter((x) => x.value !== undefined)) {
    const same = rows.filter((r) => r.base === f.value && r.conservative === f.value && r.upside === f.value);
    expect(same.filter((r) => r.provenance === 'FOUNDER_STATED').length).toBeLessThanOrEqual(1);
    if (same.some((r) => r.provenance === 'FOUNDER_STATED')) expect(same.filter((r) => r.provenance !== 'FOUNDER_STATED' && r.provenance !== 'CALCULATED')).toEqual([]);
  }
}

const AAIRA = 'I am 10 years old and I want to write a quiz book for kids aged 8 to 15... Sell 5,000 physical books... Sell 1,000 digital books.';

describe('Aaira Books (exact statement)', () => {
  const facts = confirmed(AAIRA);
  const id = (c: string, subject?: string) => facts.find((f) => f.concept === c && (!subject || f.subject === subject))!.id;
  // Typical decision-model output: restatements under natural names, one wrongly tagged as an assumption, AI prices.
  const model = [
    row({ metric: 'Physical book sales target', base: 5000, unit: 'books', concept: 'other', timeframe: 'TARGET', provenance: 'FOUNDER_STATED', factId: id('volume', 'physical books') }),
    row({ metric: 'Digital book sales target', base: 1000, unit: 'books', concept: 'other', timeframe: 'TARGET', provenance: 'ASSUMPTION' }),
    row({ metric: 'Founder age', base: 10, unit: 'years', provenance: 'FOUNDER_STATED', factId: id('founder_age') }),
    row({ metric: 'Physical book price', base: 299, unit: '₹ / book', concept: 'selling_price', timeframe: 'PROPOSED', provenance: 'ASSUMPTION', basis: 'AI-proposed validation price, not founder-approved' }),
    row({ metric: 'Digital book price', base: 149, unit: '₹ / book', concept: 'selling_price', timeframe: 'PROPOSED', provenance: 'ASSUMPTION', basis: 'AI-proposed validation price, not founder-approved' }),
    row({ metric: 'Revenue at physical target', base: 1495000, unit: '₹', concept: 'revenue', timeframe: 'PROJECTION', provenance: 'CALCULATED', inputs: [id('volume', 'physical books'), 'Physical book price'] }),
  ];

  it('facts: founder age 10, audience 8–15, physical 5,000, digital 1,000', () => {
    expect(facts.find((f) => f.concept === 'founder_age')!.value).toBe(10);
    expect(facts.find((f) => f.concept === 'audience_age')).toMatchObject({ low: 8, high: 15 });
    expect(facts.find((f) => f.subject === 'physical books')).toMatchObject({ value: 5000, timeframe: 'TARGET' });
    expect(facts.find((f) => f.subject === 'digital books')).toMatchObject({ value: 1000, timeframe: 'TARGET' });
  });

  it('unit economics: semantic rows only, no ages, no generic rows, no founder/assumption duplicates', () => {
    const ue = run(AAIRA, facts, model);
    expect(view(ue)).toEqual([
      ['Physical book sales target', 5000, 'FOUNDER_STATED'],
      ['Digital book sales target', 1000, 'FOUNDER_STATED'], // the model called it an assumption; it is the founder's target
      ['Physical book price', 299, 'ASSUMPTION'],             // AI-proposed: stays an assumption
      ['Digital book price', 149, 'ASSUMPTION'],
      ['Revenue at physical target', 1495000, 'CALCULATED'],  // using a founder target in a calculation does not demote it
    ]);
    expect(ue.find((r) => r.base === 5000)!.factId).toBe(id('volume', 'physical books'));
    expect(ue.find((r) => r.base === 1000)!.factId).toBe(id('volume', 'digital books'));
    expect(ue.some((r) => /age|stated figure/i.test(r.metric))).toBe(false);
    assertNoDuplicates(ue, facts);
  });

  it('with no model rows, each economic fact is added once under its semantic name; ages never', () => {
    expect(view(run(AAIRA, facts, []))).toEqual([
      ['Target volume — physical books (founder-stated)', 5000, 'FOUNDER_STATED'],
      ['Target volume — digital books (founder-stated)', 1000, 'FOUNDER_STATED'],
    ]);
  });

  it('display re-validation is idempotent: running it again changes nothing and adds no assumption duplicates', () => {
    const once = run(AAIRA, facts, model);
    const twice = run(AAIRA, facts, once);
    expect(view(twice)).toEqual(view(once));
    expect(view(run(AAIRA, facts, run(AAIRA, facts, [])))).toEqual(view(run(AAIRA, facts, [])));
  });

  it('a stored report from before 3cd9d4e (generic "Current stated figure" rows over meaningless facts) shows no generic rows or duplicates', () => {
    const legacyFacts = confirmFounderFacts([10, 5000, 1000].map((v) => ({ concept: 'other', timeframe: 'CURRENT', value: v, unit: 'number', raw: String(v) })));
    const stored = [10, 5000, 1000].map((v, i) => row({ metric: 'Current stated figure (founder-stated)', base: v, unit: 'number', assumption: `FOUNDER-STATED (LOCKED) F${i + 1}: "${v}"`, provenance: 'FOUNDER_STATED', factId: `F${i + 1}`, concept: 'other', timeframe: 'CURRENT' }));
    const shown = run(AAIRA, legacyFacts, stored);
    expect(shown.some((r) => /stated figure/i.test(r.metric))).toBe(false);
    expect(shown.filter((r) => r.provenance === 'ASSUMPTION')).toEqual([]);
    // The confirmed facts themselves are untouched (still visible as founder facts elsewhere).
    expect(legacyFacts.map((f) => f.value)).toEqual([10, 5000, 1000]);
  });

  it('a stored restatement of an economic fact is refreshed with its semantic label, not demoted', () => {
    const stored = run(AAIRA, facts, []);
    const relabelled = stored.map((r) => ({ ...r, metric: 'Current stated figure (founder-stated)' }));
    expect(view(run(AAIRA, facts, relabelled))).toEqual(view(stored));
  });
});

describe('General: glucometer and bakery', () => {
  it('glucometer: current 1,400 and target 10,000 are founder figures once each; AI price stays assumption', () => {
    const text = 'We currently sell approximately 1,400 glucometers per month through IndiaMART and local pharmacies. We want to reach 10,000 units per month.';
    const facts = confirmed(text);
    const ue = run(text, facts, [
      row({ metric: 'Current monthly sales', base: 1400, unit: 'units / month', concept: 'volume', timeframe: 'CURRENT', provenance: 'ASSUMPTION' }),
      row({ metric: 'Target monthly units', base: 10000, unit: 'units / month', concept: 'volume', timeframe: 'TARGET', provenance: 'FOUNDER_STATED' }),
      row({ metric: 'Glucometer price', base: 1200, unit: '₹ / unit', concept: 'selling_price', timeframe: 'PROPOSED', provenance: 'ASSUMPTION', basis: 'AI-proposed, to validate' }),
    ]);
    expect(view(ue)).toEqual([['Current monthly sales', 1400, 'FOUNDER_STATED'], ['Target monthly units', 10000, 'FOUNDER_STATED'], ['Glucometer price', 1200, 'ASSUMPTION']]);
    assertNoDuplicates(ue, facts);
  });

  it('bakery: founder age 34 and children 5–12 never appear; cakes keep their subject', () => {
    const text = 'I\'m 34, I run a bakery selling 200 cakes a month and want to reach 1,000 cakes a month for children 5-12 years old.';
    const facts = confirmed(text);
    expect(facts.find((f) => f.concept === 'founder_age')!.value).toBe(34);
    const ue = run(text, facts, [row({ metric: 'Founder age', base: 34, unit: 'years', provenance: 'FOUNDER_STATED' }), row({ metric: 'Cakes sold per month', base: 200, unit: 'cakes / month', concept: 'other', timeframe: 'CURRENT', provenance: 'ASSUMPTION' })]);
    expect(view(ue)).toEqual(expect.arrayContaining([['Cakes sold per month', 200, 'FOUNDER_STATED'], ['Target volume — cakes (founder-stated)', 1000, 'FOUNDER_STATED']]));
    expect(ue).toHaveLength(2);
    assertNoDuplicates(ue, facts);
  });
});
