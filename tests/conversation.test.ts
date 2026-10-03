// Phase 3A — Hippo conversation rules (pure; no database, no model). The model's turn is scripted so each rule the
// server enforces is tested deterministically: probing limit, stop, approval-only handoff, founder-fact protection,
// changing the objective, "I don't know", corrections — and the deterministic fallback when the model is unavailable.
import { describe, expect, it } from 'vitest';
import { applyTurn, emptyState, fallbackTurn, handoffText, isApproval, isStop, MAX_PROBES, parseModelTurn, turnPrompt, type BusinessState, type ModelTurn, type Phase, type Status } from '../src/lib/hippo/conversation';

const T = (p: Partial<ModelTurn>): ModelTurn => ({ intent: 'ANSWER', reply: 'What is stopping you today?', ready_to_propose: false, ...p });
type Run = { state: BusinessState; phase: Phase; status: Status };
const start = (): Run => ({ state: emptyState(), phase: 'DISCOVER', status: 'ACTIVE' });
function say(r: Run, text: string, ai: ModelTurn | null) { const t = applyTurn(r.state, r.phase, r.status, text, ai); return { run: { state: t.state, phase: t.phase, status: t.status }, t }; }

describe('1 + 2. objective conversation: vague → one clarifying question; numbers are kept as founder facts', () => {
  it('a vague objective gets a single follow-up question, no proposal, no research', () => {
    const { run, t } = say(start(), 'I want to start a clothing business.', T({ intent: 'OBJECTIVE', objective: 'Start a clothing business', reply: "Nice. Who's it for — and is it for money quickly or something big over time? Or just tell me in your own words." }));
    expect(t).toMatchObject({ handoff: false, intent: 'OBJECTIVE' });
    expect(run.phase).toBe('DISCOVER');
    expect(t.reply).toMatch(/\?/);
    expect(run.state.objective).toEqual({ value: 'Start a clothing business', provenance: 'HIPPO' });
    expect(run.state.probes).toBe(1);
  });
  it('the glucometer founder: current volume and target become founder facts; Hippo proposes when ready; approval hands off', () => {
    let r = start();
    let x = say(r, 'I want to build a business selling glucometers and reach 10,000 units a month. We currently sell 1,400 units a month.', T({ intent: 'OBJECTIVE', objective: 'Scale a glucometer business', target: '5,000 units', reply: "You're already at 1,400, so no generic lecture. What's actually stopping you today: demand, distribution, working capital, or something else?" }));
    r = x.run;
    expect(r.state.known_facts.find((f) => f.key === 'current_monthly_volume')).toMatchObject({ value: '1400', provenance: 'FOUNDER' });
    expect(r.state.known_facts.find((f) => f.key === 'target_monthly_volume')).toMatchObject({ value: '10000', provenance: 'FOUNDER' });
    expect(r.state.target).toMatchObject({ provenance: 'FOUNDER' });
    expect(r.state.target!.value).toMatch(/10,000/); // the model's "5,000 units" never replaced the founder's number
    x = say(r, 'Mostly distribution — pharmacies take months to onboard.', T({ intent: 'ANSWER', constraints: ['Pharmacy onboarding is slow'], ready_to_propose: true, reply: 'Got it.' }));
    r = x.run;
    expect(r.phase).toBe('PROPOSED');
    expect(x.t.reply).toMatch(/Here's what I think we're solving/);
    expect(x.t.reply).toMatch(/Want me to dig in\?/);
    expect(x.t.reply).toMatch(/You told me: “1,400 units/); // founder's exact wording, quoted
    expect(x.t.handoff).toBe(false);
    x = say(r, 'Yes, dig in', null);
    expect(x.t).toMatchObject({ handoff: true, intent: 'APPROVE' });
    expect(x.run).toMatchObject({ phase: 'HANDED_OFF', status: 'HANDED_OFF' });
    const handed = handoffText(r.state);
    expect(handed).toContain('1,400 units a month');
    expect(handed).toMatch(/10,000/);
  });
  it(`at most ${MAX_PROBES} probing questions, then Hippo proposes a concrete next step`, () => {
    let r = start();
    for (let i = 0; i < MAX_PROBES; i++) { const x = say(r, `answer ${i} about my bakery idea`, T({ objective: 'Open a bakery', reply: `Question ${i + 1}?` })); r = x.run; expect(r.phase).toBe('DISCOVER'); }
    expect(r.state.probes).toBe(MAX_PROBES);
    const x = say(r, 'more detail', T({ reply: 'Yet another question?' }));
    expect(x.run.phase).toBe('PROPOSED');
    expect(x.t.reply).toMatch(/Want me to dig in\?/);
    // Even when the model's next reply is not a question, the probe budget is spent: Hippo proposes.
    const y = say(r, 'more detail', T({ reply: 'Interesting.' }));
    expect(y.run.phase).toBe('PROPOSED');
  });
});

describe('3. "I don\'t know" is handled naturally', () => {
  it('with the model: Hippo helps them choose; "I don\'t know" never becomes the objective', () => {
    const { run, t } = say(start(), "I don't know", T({ intent: 'DONT_KNOW', reply: "No problem. Let's work it out. Are you more interested in making money quickly, building something big over time, or solving a problem you personally understand?" }));
    expect(t.reply).toMatch(/No problem\. Let's work it out/);
    expect(run.state.objective).toBeNull();
    expect(run.phase).toBe('DISCOVER');
  });
  it('without the model (fallback): same behaviour', () => {
    const { run, t } = say(start(), "i dont know", null);
    expect(t.intent).toBe('DONT_KNOW');
    expect(t.reply).toMatch(/making money quickly, building something big over time, or solving a problem you personally understand/);
    expect(run.state.objective).toBeNull();
  });
});

describe('4 + 8. corrections are founder facts; AI never overwrites founder facts', () => {
  it('"No, I already have customers" is stored as a founder fact (verbatim quote) and changes the reading', () => {
    let r = say(start(), 'I want to sell handmade candles online.', T({ objective: 'Sell handmade candles online', current_state: 'Just an idea', reply: 'Have you sold any yet?' })).run;
    expect(r.state.current_state).toMatchObject({ value: 'Just an idea', provenance: 'HIPPO' });
    const x = say(r, 'No, I already have customers — about 40 repeat buyers.', T({ intent: 'CORRECTION', current_state: 'Already selling, about 40 repeat buyers', founder_facts: [{ key: 'has_customers', value: 'yes', quote: 'I already have customers' }], reply: 'Even better. Where do they find you?' }));
    r = x.run;
    expect(r.state.known_facts.find((f) => f.key === 'has_customers')).toMatchObject({ value: 'yes', quote: 'I already have customers', provenance: 'FOUNDER' });
    // The founder's own number in the correction is what the current state now says (Hippo's "just an idea" is gone).
    expect(r.state.current_state).toMatchObject({ provenance: 'FOUNDER', value: expect.stringMatching(/40/) });
  });
  it('a model "fact" whose quote the founder never wrote is rejected; a later AI reading cannot replace a founder field', () => {
    let r = say(start(), 'We sell 1,400 glucometers a month.', T({ objective: 'Grow glucometer sales', founder_facts: [{ key: 'cac', value: '₹300', quote: 'our CAC is ₹300' }] })).run;
    expect(r.state.known_facts.map((f) => f.key)).not.toContain('cac');
    const before = r.state.current_state;
    expect(before).toMatchObject({ provenance: 'FOUNDER' });
    r = say(r, 'Mostly through IndiaMART.', T({ current_state: 'About 1,000 units a month (estimated)', reply: 'Which channel converts best?' })).run;
    expect(r.state.current_state).toEqual(before);
    expect(r.state.known_facts.find((f) => f.key === 'current_monthly_volume')).toMatchObject({ value: '1400' });
  });
  it('a correction during the proposal re-proposes with the corrected fact (no research yet)', () => {
    const proposed: Run = { ...say(start(), 'Glucometers: we sell 1,400 a month and want 10,000 units a month.', T({ objective: 'Scale glucometers', ready_to_propose: true })).run };
    expect(proposed.phase).toBe('PROPOSED');
    const x = say(proposed, 'Actually, change the target to 20,000 units a month.', T({ intent: 'CORRECTION', reply: 'Bold. Noted.' }));
    expect(x.t.handoff).toBe(false);
    expect(x.run.phase).toBe('PROPOSED');
    expect(x.run.state.known_facts.find((f) => f.key === 'target_monthly_volume')).toMatchObject({ value: '20000', provenance: 'FOUNDER' });
    expect(x.t.reply).toMatch(/20,000/);
  });
});

describe('5. changing the objective updates it instead of forcing the old path', () => {
  it('"Actually forget clothing, I want to sell glucometers" archives clothing and starts fresh', () => {
    let r = say(start(), 'I want to start a clothing business. I have ₹2 lakh saved.', T({ objective: 'Start a clothing business', reply: 'Who for?' })).run;
    r = say(r, 'Young professionals', T({ reply: 'Online or retail?' })).run;
    expect(r.state.probes).toBe(2);
    const x = say(r, 'Actually forget clothing. I want to sell glucometers.', T({ intent: 'CHANGE_OBJECTIVE', objective: 'Sell glucometers', reply: 'Switching gears. Selling already, or starting from zero?' }));
    expect(x.run.state.objective).toEqual({ value: 'Sell glucometers', provenance: 'HIPPO' });
    expect(x.run.state.previous_objectives).toHaveLength(1);
    expect(x.run.state.previous_objectives[0].objective).toBe('Start a clothing business');
    expect(x.run.state.probes).toBe(1); // a fresh objective gets fresh questions
    expect(x.run.phase).toBe('DISCOVER');
  });
  it('fallback detects a change of direction too', () => {
    const r = say(start(), 'I want to start a clothing business.', null).run;
    const x = say(r, 'Actually forget clothing, I want to sell glucometers', null);
    expect(x.t.intent).toBe('CHANGE_OBJECTIVE');
    expect(x.run.state.objective!.value).toMatch(/glucometers/);
  });
});

describe('6 + 9 + 10. stop always stops; research only after explicit approval of a proposal', () => {
  const proposed = () => say(start(), 'We sell 1,400 glucometers a month and want 10,000 units a month.', T({ objective: 'Scale glucometers', ready_to_propose: true })).run;
  it('"Stop" pauses — from any phase — with no model call needed and no handoff', () => {
    for (const msg of ['Stop.', 'stop', "I don't want to do this", 'Wait', 'cancel that']) {
      const x = say(proposed(), msg, T({ intent: 'APPROVE', reply: 'x' }));
      expect([msg, x.t.handoff, x.run.status, x.run.phase]).toEqual([msg, false, 'PAUSED', 'DISCOVER']);
    }
    const paused = say(proposed(), 'stop', null).run;
    expect(say(paused, 'yes', null).t.handoff).toBe(false); // approval no longer pending after a stop
  });
  it('no handoff without a proposal, even if the founder says yes or the model claims APPROVE', () => {
    const r = say(start(), 'I want to start a bakery.', T({ objective: 'Bakery' })).run;
    expect(say(r, 'yes', T({ intent: 'APPROVE', reply: 'ok?' })).t.handoff).toBe(false);
    expect(say(r, 'go ahead', null).t.handoff).toBe(false);
  });
  it('a hedged or changed answer to the proposal is not approval', () => {
    for (const msg of ['yes but change the target first', 'ok wait', 'sure, actually no', 'Challenge your assumption', 'Think of a completely different route']) {
      expect([msg, say(proposed(), msg, T({ intent: 'CHALLENGE', reply: 'Fair — here is the other side.' })).t.handoff]).toEqual([msg, false]);
    }
    const c = say(proposed(), 'Challenge your assumption', T({ intent: 'CHALLENGE', reply: "Fair. I'm assuming distribution is the bottleneck; if it's conversion, ads would be wasted." }));
    expect(c.run.phase).toBe('PROPOSED');
    expect(c.t.reply).toMatch(/dig in/);
  });
  it('explicit approvals', () => {
    for (const msg of ['Yes', 'yes, dig in', 'Go ahead', "Let's go", 'haan', 'Sure', 'OK do it']) expect([msg, isApproval(msg)]).toEqual([msg, true]);
    for (const msg of ['no', 'yes but wait', 'not yet', 'I am not sure yes']) expect([msg, isApproval(msg)]).toEqual([msg, false]);
    expect(isStop("I don't want to do this anymore")).toBe(true);
    expect(isStop('Stopping by to say hi')).toBe(false);
  });
});

describe('model output is validated; the prompt carries persona, limits and protected facts', () => {
  it('malformed model output → fallback; unknown intents → OTHER', () => {
    expect(parseModelTurn(null)).toBeNull();
    expect(parseModelTurn({ intent: 'APPROVE' })).toBeNull();
    expect(parseModelTurn({ intent: 'HACK', reply: 'hi', ready_to_propose: 'yes' })).toMatchObject({ intent: 'OTHER', ready_to_propose: false });
  });
  it('prompt: Hippo persona, one question, probe budget, founder facts authoritative, no internal agents', () => {
    const s = say(start(), 'We sell 1,400 glucometers a month.', T({ objective: 'Grow glucometers' })).run.state;
    const p = turnPrompt(s, 'DISCOVER', [{ role: 'FOUNDER', text: 'hi' }], 'next');
    expect(p).toMatch(/always on the founder's side, but not always on their side of the argument/i);
    expect(p).toMatch(/ONE short question/);
    expect(p).toMatch(/Probing questions already asked: 1 of at most 3/);
    expect(p).toMatch(/current_monthly_volume = 1400 \(founder said: "1,400/);
    expect(p).toMatch(/Never mention agents, models, tools or internal teams/);
  });
  it('fallback never invents numbers', () => {
    const t = fallbackTurn(emptyState(), 'I want to open a cafe');
    expect(t.reply).not.toMatch(/\d/);
  });
});
