import { describe, expect, it } from 'vitest';
import { confirmFounderFacts, extractFounderFacts, type FounderFact } from '../src/lib/founder-facts';

const facts = (t: string) => extractFounderFacts(t).facts;
const find = (fs: FounderFact[], concept: string, timeframe?: string) => fs.find((f) => f.concept === concept && (!timeframe || f.timeframe === timeframe));

describe('Founder-fact extraction', () => {
  it('₹1,499/month in a launch plan is PROPOSED pricing, not revenue; 200 pharmacies by March is a target', () => {
    const fs = facts('I want to launch a pharmacy SaaS at ₹1,499/month and target 200 pharmacies by March.');
    expect(find(fs, 'selling_price')).toMatchObject({ value: 1499, timeframe: 'PROPOSED', period: 'month' });
    expect(fs.some((f) => f.concept === 'revenue')).toBe(false);
    expect(find(fs, 'customers')).toMatchObject({ value: 200, timeframe: 'TARGET', deadline: 'March' });
  });

  it('"Started in 2019 and want ₹1 crore by Diwali": 2019 is operating history, ₹1 crore a revenue target, Diwali the deadline', () => {
    const fs = facts('Started in 2019 and want ₹1 crore by Diwali.');
    expect(find(fs, 'start_year')).toMatchObject({ value: 2019, timeframe: 'HISTORICAL' });
    expect(find(fs, 'revenue')).toMatchObject({ value: 10000000, timeframe: 'TARGET', deadline: 'Diwali' });
    expect(fs.some((f) => f.deadline === '2019' || f.deadline?.includes('2019'))).toBe(false);
  });

  it('"₹60 per pack" is a selling price', () => {
    expect(find(facts('₹60 per pack.'), 'selling_price')).toMatchObject({ value: 60, unit: 'INR/pack' });
    expect(find(facts('We sell directly to gyms at ₹60 per pack.'), 'selling_price')).toMatchObject({ value: 60, timeframe: 'CURRENT' });
    expect(find(facts('Our cost is ₹60 per pack.'), 'unit_cost')).toMatchObject({ value: 60 });
  });

  it('"Current sales are 900 units a month at a cost of ₹450 each"', () => {
    const fs = facts('Current sales are 900 units a month at a cost of ₹450 each.');
    expect(find(fs, 'volume')).toMatchObject({ value: 900, timeframe: 'CURRENT', period: 'month', timeframeEvidence: 'explicit' });
    expect(find(fs, 'unit_cost')).toMatchObject({ value: 450, timeframe: 'CURRENT', unit: 'INR/unit' });
  });

  it('glucometer example keeps every explicit value', () => {
    const fs = facts('Glucometer business: currently selling 1,400 units/month. Cost is ₹500 per item. Average order quantity is 2. Margin is 10–12%. At 10,000 units margin could reach 15%.');
    expect(find(fs, 'volume', 'CURRENT')).toMatchObject({ value: 1400, period: 'month' });
    expect(find(fs, 'unit_cost')).toMatchObject({ value: 500 });
    expect(find(fs, 'order_quantity')).toMatchObject({ value: 2 });
    expect(fs.find((f) => f.concept === 'margin' && f.timeframe !== 'CONDITIONAL')).toMatchObject({ low: 10, high: 12 });
    expect(fs.find((f) => f.concept === 'margin' && f.timeframe === 'CONDITIONAL')).toMatchObject({ value: 15, condition: 'at 10,000 units' });
    expect(fs.find((f) => f.concept === 'volume' && f.value === 10000)?.timeframe).not.toBe('CURRENT');
  });

  it('founder brief: target stays a target, AOV = 2 units, shipping paid by customer', () => {
    const fs = facts('Cost = ₹500. Current sales = 1,400 units/month. Target = 10,000 units in October. Margin = 10–12%, potentially 15% at 10K. AOV = 2 units. Shipping paid by customer.');
    expect(find(fs, 'volume', 'CURRENT')).toMatchObject({ value: 1400 });
    expect(find(fs, 'volume', 'TARGET')).toMatchObject({ value: 10000, deadline: 'October' });
    expect(fs.filter((f) => f.concept === 'volume' && f.timeframe === 'CURRENT').map((f) => f.value)).toEqual([1400]);
    expect(fs.some((f) => f.concept === 'revenue')).toBe(false); // a volume target never becomes revenue
    expect(find(fs, 'order_quantity')).toMatchObject({ value: 2 });
    expect(fs.find((f) => f.concept === 'margin' && f.timeframe === 'CONDITIONAL')).toMatchObject({ value: 15, condition: 'at 10K' });
    expect(find(fs, 'shipping')?.text).toMatch(/paid by customer/i);
  });

  it('₹8L/month in sales is CURRENT revenue', () => {
    expect(find(facts('Doing ₹8L/month in sales on Meesho, want to open a second warehouse.'), 'revenue')).toMatchObject({ value: 800000, timeframe: 'CURRENT', timeframeEvidence: 'explicit' });
  });

  it('estimates are PROPOSED, never current', () => {
    expect(find(facts('Planning to start a tiffin service; each office would order around 40 meals/day.'), 'volume')).toMatchObject({ value: 40, timeframe: 'PROPOSED', period: 'day' });
  });

  it('channels come only from current selling, not launch plans', () => {
    const fs = facts("We've been selling sarees on Instagram for 2 years, now want to launch our website.");
    expect(fs.filter((f) => f.concept === 'channel').map((f) => f.text)).toEqual(['Instagram']);
    expect(fs.some((f) => f.value === 2)).toBe(false); // "2 years" is a duration, not a commercial number
  });

  it('extracted facts are NOT locked until the founder confirms them', () => {
    const fs = facts('Cost is ₹500 per item.');
    expect(fs[0]).toMatchObject({ source: 'FOUNDER_STATED', locked: false, confirmedByFounder: false });
    const confirmed = confirmFounderFacts(fs);
    expect(confirmed[0]).toMatchObject({ value: 500, source: 'FOUNDER_STATED', locked: true, confirmedByFounder: true });
  });

  it('founder corrections are authoritative and validated', () => {
    const [f] = confirmFounderFacts([{ concept: 'selling_price', timeframe: 'PROPOSED', value: 1499, unit: 'INR/month', raw: '₹1,499/month' }]);
    expect(f).toMatchObject({ id: 'F1', concept: 'selling_price', value: 1499, locked: true });
    expect(() => confirmFounderFacts([{ concept: 'nonsense', timeframe: 'CURRENT', value: 1 }])).toThrow();
    expect(() => confirmFounderFacts([{ concept: 'margin', timeframe: 'CURRENT', low: 12, high: 10 }])).toThrow();
    expect(() => confirmFounderFacts([{ concept: 'volume', timeframe: 'CURRENT' }])).toThrow();
  });
});
