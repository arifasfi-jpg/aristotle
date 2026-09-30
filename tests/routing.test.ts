import { describe, expect, it } from 'vitest';
import { extractFounderFacts } from '../src/lib/founder-facts';
import { PAYABLE_SCOPES, SCOPE_PRICE_PAISE, suggestScope } from '../src/lib/routing';

const suggest = (idea: string, stage?: string) => suggestScope({ idea, stage, facts: extractFounderFacts(idea).facts });

describe('Routing suggestions (the founder confirms; these are only suggestions)', () => {
  it('1. pharmacy SaaS with pricing + target → NEW_IDEA', () => {
    expect(suggest('I want to launch a pharmacy SaaS at ₹1,499/month and target 200 pharmacies by March.').suggestion).toBe('NEW_IDEA');
  });
  it('2. tiffin service with estimated volume → NEW_IDEA', () => {
    expect(suggest('Planning to start a tiffin service; each office would order around 40 meals/day.').suggestion).toBe('NEW_IDEA');
  });
  it('3. D2C pitch that says "we sell" → NEW_IDEA', () => {
    expect(suggest('A D2C millet snack brand. We sell directly to gyms and cafes at ₹60 per pack.').suggestion).toBe('NEW_IDEA');
  });
  it('4. selling sarees for 2 years → GROWTH_PLAN', () => {
    expect(suggest("We've been selling sarees on Instagram for 2 years, now want to launch our website.").suggestion).toBe('GROWTH_PLAN');
  });
  it('5. doing ₹8L/month on Meesho → GROWTH_PLAN', () => {
    expect(suggest('Doing ₹8L/month in sales on Meesho, want to open a second warehouse.').suggestion).toBe('GROWTH_PLAN');
  });
  it('6. Stage = Scaling + "launch in Pune next" → GROWTH_PLAN', () => {
    expect(suggest('I want to launch in Pune next.', 'Scaling').suggestion).toBe('GROWTH_PLAN');
  });

  it('never treats pricing, targets, launch plans, estimates or "would order" as operating history', () => {
    for (const idea of [
      'We will charge ₹999/month per clinic and target 500 clinics by December.',
      'Planning to start a bakery; expected revenue ₹5 lakh/month in year one.',
      'I want to reach sales of ₹1 crore by Diwali with a new candle brand.',
      'Each gym would order around 200 packs a month once we launch.',
    ]) expect(suggest(idea).suggestion).toBe('NEW_IDEA');
  });

  it('recognises real operating history', () => {
    for (const idea of [
      'Currently selling 1,400 glucometers a month on Amazon.',
      'Current sales are 900 units a month at a cost of ₹450 each.',
      'We have 300 paying customers and want to expand to Bengaluru.',
      'Running since 2019, we want to open a second outlet.',
    ]) expect(suggest(idea).suggestion).toBe('GROWTH_PLAN');
  });

  it('suggests OUT_OF_SCOPE for personal investment, tax filing, medical advice and build requests', () => {
    expect(suggest('Should I invest my savings in mutual funds or stocks this year?').outOfScopeCategory).toBe('personal_investment');
    expect(suggest('Please help me file my ITR for this financial year.').outOfScopeCategory).toBe('tax_filing');
    expect(suggest('I have had fever and headache for 3 days, what medicine should I take?').outOfScopeCategory).toBe('medical_advice');
    expect(suggest('Can you build me a website for my coaching classes?').outOfScopeCategory).toBe('build_request');
  });

  it('both paid scopes cost exactly ₹99; OUT_OF_SCOPE is free and not payable', () => {
    expect(SCOPE_PRICE_PAISE).toEqual({ NEW_IDEA: 9900, GROWTH_PLAN: 9900, OUT_OF_SCOPE: 0 });
    expect(PAYABLE_SCOPES).not.toContain('OUT_OF_SCOPE');
  });
});
