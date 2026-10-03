// Stage 1 — the Move rules (pure): reading constraints from the founder's words, the authorization boundary (model can
// never lower it), validation against constraints/preferences/history, and the deterministic conversation controls.
import { describe, expect, it } from 'vitest';
import {
  consequentialReasons, emptyCapacity, fallbackMove, materialChange, mergeCapacity, mergeProfile, movingControl, normaliseMove,
  readFounderSignals, readSignal, validateMove, type MoveContext, type ProposedMove,
} from '../src/lib/hippo/moves';

const move = (o: Partial<ProposedMove> = {}): ProposedMove => ({
  kind: 'TEST', owner: 'FOUNDER', title: 'Give a 10-question sample to 5 friends', why: 'See if kids enjoy it', bet: 'Kids finish and want more',
  hippoWill: 'Make a printable sample', needs: ['Write 10 questions'], costInr: 0, costBasis: 'free', expectedSignal: 'How many finish it',
  artifactType: 'DOCUMENT', artifactBrief: 'printable sample', routeKey: 'friends-sample-test', consequential: false, researchJustification: '',
  alternative: null, reply: 'Let’s do it.', beliefs: [], ...o,
});
const ctx = (o: Partial<MoveContext> = {}): MoveContext => ({
  objective: 'Quiz books for kids', constraints: [], knownFacts: [], unknowns: [], preferences: [], profile: {}, capacity: emptyCapacity(),
  beliefs: [], history: [], signals: [], reason: 'START', blockedRoutes: [], ...o,
});

describe('reading the founder (no questionnaire)', () => {
  it('age → minor; casual style; guardian', () => {
    expect(readFounderSignals('I am 10 years old bro. I want to start a business of quiz books for kids.').profile).toMatchObject({ age: 10, minor: true, casual: true });
    expect(readFounderSignals('Yes, my mum is helping').profile.guardian).toBe('YES');
    expect(readFounderSignals('I have run two companies before').profile.experience).toBe('EXPERIENCED');
    expect(readFounderSignals('keep it short please').profile.density).toBe('LIGHT');
  });
  it('money, customers, access and what they will not do', () => {
    expect(readFounderSignals('I only have ₹2,000.').capacity.budgetInr).toBe(2000);
    expect(readFounderSignals('I can put in ₹10,000 and 10 hours a week').capacity).toMatchObject({ budgetInr: 10000, hoursPerWeek: 10 });
    expect(readFounderSignals("I can't do this — I don't want to give it to friends").capacity.avoid).toEqual(['give it to friends']);
    expect(readFounderSignals("I can't do this.").capacity.avoid).toBeUndefined();
    expect(readFounderSignals('my budget is ₹1.5 lakh').capacity.budgetInr).toBe(150000);
    expect(readFounderSignals('I already have 5,000 customers').capacity.existingCustomers).toBe(5000);
    expect(readFounderSignals('I can get access to three schools').capacity.assets).toEqual(['three schools']);
    expect(readFounderSignals("I don't want to build an app.").capacity.avoid).toEqual(['build app']);
    expect(readFounderSignals("I don't want to approach shops").capacity.avoid).toEqual(['approach shops']);
    expect(readFounderSignals('We sell 5,000 books').capacity.budgetInr).toBeUndefined(); // a quantity is not money
  });
  it('merging keeps founder statements and flags material change', () => {
    const before = emptyCapacity();
    const after = mergeCapacity(before, { budgetInr: 2000 });
    expect(materialChange(before, after, {}, {})).toBe(true);
    expect(mergeProfile({ casual: true }, { age: 16 })).toMatchObject({ casual: true, age: 16, minor: true });
  });
});

describe('the authorization boundary is deterministic and only goes up', () => {
  it('money, public pages, personal data, legal steps and minors need an OK', () => {
    expect(consequentialReasons(move({ costInr: 500 }))).toContain('MONEY');
    expect(consequentialReasons(move({ artifactType: 'PUBLIC_PAGE', owner: 'HIPPO' }))).toEqual(expect.arrayContaining(['PUBLIC', 'PERSONAL_DATA']));
    expect(consequentialReasons(move({ title: 'Sign the printer contract' }))).toContain('LEGAL');
    expect(consequentialReasons(move({ owner: 'HIPPO', title: 'Hippo sends the message to 20 shops' }))).toContain('EXTERNAL');
    expect(consequentialReasons(move({ artifactType: 'PUBLIC_PAGE', owner: 'HIPPO' }), { minor: true })).toContain('MINOR');
  });
  it('a founder doing it themselves is their own act — except a minor talking to people outside', () => {
    expect(consequentialReasons(move({ title: 'Share the sample with 5 friends' }))).toEqual([]);
    expect(consequentialReasons(move({ title: 'Share the sample with 5 friends' }), { minor: true })).toEqual(['EXTERNAL', 'MINOR']);
  });
  it('the model can never lower it: consequential=false is ignored when the rule says otherwise', () => {
    const m = move({ costInr: 300, consequential: false });
    expect(validateMove(m, ctx()).consequentialReasons).toContain('MONEY');
    expect(consequentialReasons(move({ consequential: true }))).toEqual(['FLAGGED']); // ...but it can raise it
  });
  it('thinking and drafting never ask', () => {
    expect(consequentialReasons(move({ kind: 'BUILD', owner: 'HIPPO', title: 'Draft three cover ideas', hippoWill: 'Write three options' }))).toEqual([]);
  });
});

describe('validation: constraints, preferences, known facts and history', () => {
  it('a Move over budget is rejected', () => {
    const v = validateMove(move({ costInr: 15000 }), ctx({ capacity: { ...emptyCapacity(), budgetInr: 2000 } }));
    expect(v.ok).toBe(false); expect(v.problems[0]).toMatch(/EXCEEDS_BUDGET/);
  });
  it('a Move the founder said they will not do is rejected', () => {
    const v = validateMove(move({ title: 'Build a simple app for orders' }), ctx({ capacity: { ...emptyCapacity(), avoid: ['build app'] } }));
    expect(v.problems.join()).toMatch(/CONTRADICTS_PREFERENCE/);
    expect(validateMove(move({ title: 'Talk to three local shops' }), ctx({ capacity: { ...emptyCapacity(), avoid: ['approach shops'] } })).ok).toBe(false);
    expect(validateMove(move({ title: 'Put up a pre-order page' }), ctx({ capacity: { ...emptyCapacity(), avoid: ['approach shops'] } })).ok).toBe(true);
  });
  it('a failed or declined route is not repeated; something already done is not redone', () => {
    const history = [{ title: 'Give a 10-question sample to 5 friends', kind: 'TEST', routeKey: 'friends-sample-test', status: 'FAILED' }];
    expect(validateMove(move(), ctx({ history })).problems.join()).toMatch(/REPEATS_FAILED_ROUTE/);
    expect(validateMove(move({ routeKey: 'other', title: 'Give the 10 question sample to five friends' }), ctx({ history })).ok).toBe(false); // same route, reworded
    const done = [{ ...history[0], status: 'DONE' }];
    expect(validateMove(move(), ctx({ history: done })).problems.join()).toMatch(/ALREADY_DONE/);
    expect(validateMove(move(), ctx({ history: [{ ...history[0], status: 'SIGNALLED', negative: true }] })).ok).toBe(false); // "no one replied"
    expect(validateMove(move(), ctx({ blockedRoutes: ['friends-sample-test'] })).ok).toBe(false); // "try another way"
  });
  it('research is not the default answer; known facts are not ignored', () => {
    expect(validateMove(move({ kind: 'RESEARCH', title: 'Research competitors' }), ctx()).problems.join()).toMatch(/RESEARCH_NOT_JUSTIFIED/);
    expect(validateMove(move({ kind: 'RESEARCH', title: 'Check printer prices', researchJustification: 'We must pick a printer before paying anything' }), ctx()).ok).toBe(true);
    expect(validateMove(move({ title: 'Find your first 10 customers' }), ctx({ capacity: { ...emptyCapacity(), existingCustomers: 5000 } })).problems.join()).toMatch(/IGNORES_KNOWN_FACT/);
  });
  it('public pages are hosted by Hippo; the fallback Move is always valid and free', () => {
    expect(validateMove(move({ artifactType: 'PUBLIC_PAGE', owner: 'FOUNDER' }), ctx()).problems.join()).toMatch(/WRONG_OWNER/);
    const f = fallbackMove(ctx({ profile: { minor: true } }));
    expect(validateMove(f, ctx()).ok).toBe(true);
    expect(f.costInr).toBe(0);
  });
  it('normaliseMove rejects shapeless output and never trusts a negative cost', () => {
    expect(normaliseMove({})).toBeNull();
    expect(normaliseMove({ move: { title: 'x', costInr: -5 }, reply: '', beliefs: [] })!.costInr).toBeNull();
  });
});

describe('conversation controls and signals (no model needed)', () => {
  it('escape routes and quick replies', () => {
    expect(['Yes', 'Not now', 'Help me do this', 'Try another way', "I can't do this", 'This failed', 'I sent it', "What's next?", 'Why?'].map(movingControl))
      .toEqual(['YES', 'NOT_NOW', 'HELP', 'ANOTHER_WAY', 'CANT', 'FAILED', 'DID_IT', 'NEXT', 'WHY']);
    expect(movingControl('I sold 3 books to my neighbours')).toBeNull();
  });
  it('what happened → a signal, with strength and proof', () => {
    expect(readSignal('No one replied.')).toMatchObject({ polarity: 'NEGATIVE', rung: 4 });
    expect(readSignal('Three parents replied!')).toMatchObject({ polarity: 'POSITIVE', rung: 4 });
    expect(readSignal('One person paid ₹149')).toMatchObject({ polarity: 'POSITIVE', rung: 5, moneyInr: 149 });
    expect(readSignal('The printer quoted ₹70 a copy')).toMatchObject({ polarity: 'NEUTRAL', rung: 4 });
    expect(readSignal('Everyone hated the sample')).toMatchObject({ polarity: 'NEGATIVE' });
    expect(readSignal('posted here https://instagram.com/p/abc')?.proof ?? readSignal('they replied https://wa.me/x')?.proof).toMatch(/^https:/);
    expect(readSignal('hmm ok')).toBeNull();
  });
});
