// REGRESSION (live test): the founder said "MSME BNPL" and Hippo turned it into "salary advance brokerage for blue-collar
// workers". Founder fact > Business State inference > model hypothesis: the founder's stated business is never replaced.
import { describe, expect, it } from 'vitest';
import { applyTurn, emptyState, parseModelTurn } from '../src/lib/hippo/conversation';
import { offObjective, statesBusiness, vagueDomain } from '../src/lib/hippo/founder-objective';
import { emptyCapacity, validateMove, type MoveContext, type ProposedMove } from '../src/lib/hippo/moves';

// A model that "knows better" and rewrites the business every time.
const hostile = (o: Record<string, unknown> = {}) => parseModelTurn({ intent: 'OBJECTIVE', reply: 'Interesting!', ready_to_propose: false, objective: 'Salary advance brokerage for blue-collar workers in Mumbai', ...o });
const objectiveAfter = (text: string, ai = hostile()) => applyTurn(emptyState(), 'DISCOVER', 'ACTIVE', text, ai).state.objective;

describe('the founder\'s stated business stays theirs', () => {
  it('1. "MSME BNPL" remains MSME BNPL (even when the model rewrites it)', () => {
    expect(objectiveAfter('I want to build MSME BNPL')).toEqual({ value: 'I want to build MSME BNPL', provenance: 'FOUNDER' });
    expect(objectiveAfter('I want to build a msme buynow paylater busienss')).toEqual({ value: 'I want to build a msme buynow paylater busienss', provenance: 'FOUNDER' });
  });
  it('2. "MSME lending" does not become salary advance', () => {
    expect(objectiveAfter('I want to start MSME lending in Mumbai')!.value).toBe('I want to start MSME lending in Mumbai');
  });
  it('3. "Salary advance" remains salary advance', () => {
    const ai = hostile({ objective: 'BNPL for MSMEs' });
    expect(objectiveAfter('I want to start a salary advance business for factory workers', ai)!.value).toBe('I want to start a salary advance business for factory workers');
  });
  it('4. "BNPL for employees" remains employee BNPL', () => {
    expect(objectiveAfter('I want to build BNPL for employees', hostile({ objective: 'MSME BNPL' }))!.value).toBe('I want to build BNPL for employees');
  });
  it('5. an ambiguous "something in lending" is a question, not a choice made for them', () => {
    expect(vagueDomain('I want to do something in lending')).toBe('lending');
    expect(statesBusiness('I want to do something in lending')).toBe(false);
    expect(vagueDomain('I want to build MSME BNPL')).toBeNull();
    expect(statesBusiness('I want to make ₹1 lakh a month')).toBe(false); // a money goal is not a business
    expect(statesBusiness("I have 2–3 hours a day. I want to make ₹20,000/month from home. I don't know what business to start.")).toBe(false);
    expect(statesBusiness('I want to start a business')).toBe(false);
  });
  it('a later answer that is not a business ("Mumbai first") never replaces it; a founder correction does', () => {
    const s1 = applyTurn(emptyState(), 'DISCOVER', 'ACTIVE', 'I want to build MSME BNPL', hostile()).state;
    const s2 = applyTurn(s1, 'DISCOVER', 'ACTIVE', 'Yes Mumbai 1st and India later', hostile()).state;
    expect(s2.objective).toEqual({ value: 'I want to build MSME BNPL', provenance: 'FOUNDER' });
    const s3 = applyTurn(s2, 'DISCOVER', 'ACTIVE', 'No — I want to build BNPL for kirana stores only', hostile({ intent: 'CORRECTION' })).state;
    expect(s3.objective!.value).toBe('No — I want to build BNPL for kirana stores only');
  });
});

describe('6. an alternative opportunity cannot overwrite the founder objective', () => {
  const move = (o: Partial<ProposedMove>): ProposedMove => ({ kind: 'TALK', owner: 'FOUNDER', title: '', why: 'test it', bet: 'b', hippoWill: 'h', needs: [], costInr: 0, costBasis: 'free', expectedSignal: 'replies', artifactType: 'DOCUMENT', artifactBrief: '', routeKey: 'r', consequential: false, researchJustification: '', alternative: null, reply: '', beliefs: [], ...o });
  const ctx: MoveContext = { objective: 'I want to build MSME BNPL', constraints: [], knownFacts: [], unknowns: [], preferences: [], profile: {}, capacity: emptyCapacity(), beliefs: [], history: [], signals: [], reason: 'START', blockedRoutes: [] };
  it('a Move for a different customer is refused; the same idea as an "alternative" is allowed', () => {
    expect(validateMove(move({ title: 'Ask 10 blue-collar workers if they would take a salary advance' }), ctx).problems.join()).toMatch(/OFF_OBJECTIVE/);
    expect(validateMove(move({ title: 'Ask 5 kirana shop owners if they would buy stock on 30-day credit' }), ctx).ok).toBe(true);
    expect(validateMove(move({ title: 'Ask 5 suppliers who sell to MSMEs about credit terms', alternative: { title: 'Salary advances for workers', why: 'faster to test' } }), ctx).ok).toBe(true);
  });
  it('segments match by meaning, not spelling', () => {
    expect(offObjective('MSME BNPL', 'Talk to 5 merchants in Dadar')).toBeNull();
    expect(offObjective('salary advance for factory workers', 'Talk to 3 HR managers about employee payday needs')).toBeNull();
    expect(offObjective('BNPL for employees', 'Pitch MSME owners on stock credit')).toMatch(/serves employees/);
    expect(offObjective('a tiffin service', 'Talk to 3 office workers')).toBeNull(); // no stated segment → nothing to protect
  });
});
