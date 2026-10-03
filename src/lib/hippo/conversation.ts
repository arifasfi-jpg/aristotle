// Hippo conversation — the founder-facing front door (Phase 3A, first slice).
//
//   founder message → (deterministic controls: stop / approve) → cheap model turn through the metered gateway →
//   merge into the minimum business state (founder facts protected) → Hippo reply → after ≤3 probing questions, a
//   concrete proposal → ONLY on explicit approval, hand off to the existing Aristotle/Mogli pipeline (createObjective).
//
// The pure function `applyTurn` holds every rule (testable without a database or a model). The route does I/O.
import { extractFounderFacts, type FounderFact } from '../founder-facts';
import type { DirectionChoice } from './explore';
import type { Capacity, FounderProfile } from './moves';

export const MAX_PROBES = 3;
export const OPENING = 'Alright bro. What are you trying to build or achieve?';

export type Provenance = 'FOUNDER' | 'HIPPO';
export type Field = { value: string; provenance: Provenance } | null;
/** A fact the founder stated. Only ever written from the founder's own words; never by an AI assumption. */
export type KnownFact = { key: string; value: string; quote: string; provenance: 'FOUNDER'; at: string; said?: string /* the founder's full sentence */ };
export type BusinessState = {
  objective: Field;
  target: Field;
  current_state: Field;
  constraints: string[];
  known_facts: KnownFact[];
  unknowns: string[];
  founder_preferences: string[];
  conversation_summary: string;
  // bookkeeping
  probes: number;                                  // probing questions asked since the objective was set
  previous_objectives: { objective: string; known_facts: KnownFact[]; at: string }[];
  // Moves (HIPPO_MOVES) — optional so stored conversations from before stay valid.
  profile?: FounderProfile;                        // read from the founder's words, never a questionnaire
  capacity?: Capacity;                             // money, time, things they won't do, access, existing customers
  noIdea?: boolean;                                // "I don't know what to do" — Hippo helps choose before any Move
  ideaQuestions?: number;                          // questions asked while choosing (at most 2)
  directions?: DirectionChoice[];                  // the three directions offered
  recommended?: number; recommendWhy?: string;
  signals?: { summary: string; polarity: string; source: string; at: string; moveId: string }[];
};
export const emptyState = (): BusinessState => ({ objective: null, target: null, current_state: null, constraints: [], known_facts: [], unknowns: [], founder_preferences: [], conversation_summary: '', probes: 0, previous_objectives: [] });

export type Phase = 'DISCOVER' | 'PROPOSED' | 'HANDED_OFF' | 'MOVING';
export type Status = 'ACTIVE' | 'PAUSED' | 'HANDED_OFF' | 'ARCHIVED';
export type Intent = 'OBJECTIVE' | 'ANSWER' | 'DONT_KNOW' | 'CORRECTION' | 'CHANGE_OBJECTIVE' | 'STOP' | 'APPROVE' | 'CHALLENGE' | 'OTHER';
export const INTENTS: Intent[] = ['OBJECTIVE', 'ANSWER', 'DONT_KNOW', 'CORRECTION', 'CHANGE_OBJECTIVE', 'STOP', 'APPROVE', 'CHALLENGE', 'OTHER'];

/** What the model returns for one turn (validated before use). */
export type ModelTurn = {
  intent: Intent; reply: string; ready_to_propose: boolean;
  objective?: string; target?: string; current_state?: string;
  constraints?: string[]; unknowns?: string[]; founder_preferences?: string[];
  founder_facts?: { key: string; value: string; quote: string }[];
  conversation_summary?: string;
};

// ---------------------------------------------------------------- deterministic controls
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const STOP_RE = /^(stop|pause|wait|hold on|cancel|enough|leave it|forget it|not now)\b|\bi don'?t want to do (this|it)\b|\blet'?s stop\b/;
const APPROVE_RE = /^(yes|yeah|yep|yup|ya|haan|ha+n?|sure|ok(ay)?|go( ahead)?|do it|dig in|let'?s (go|do it|dig in)|please do|proceed|chalo|absolutely|definitely|go for it)\b/;
const NEGATION_RE = /\b(no|not|don'?t|wait|but|stop|change|actually)\b/;
const DONT_KNOW_RE = /^(i )?(don'?t|dont|do not) know\b|^no idea\b|^not sure\b|^idk\b|^pata nahi\b/;
const CORRECTION_RE = /^(no|nope|nah|not really|that'?s not right|wrong)\b/;
const CHANGE_RE = /\b(actually|instead|forget|scrap that|change of plan)\b.*\b(want|sell|build|start|do|make|open|launch)\b/;

export const isStop = (t: string) => STOP_RE.test(norm(t));
/** Explicit approval: an affirmative, short, with no hedge or new instruction in it. */
export const isApproval = (t: string) => { const n = norm(t); return n.length <= 60 && APPROVE_RE.test(n) && !NEGATION_RE.test(n.replace(APPROVE_RE, '')); };

// ---------------------------------------------------------------- founder facts (provenance-protected)
function factKey(f: FounderFact): string {
  const when = f.timeframe === 'TARGET' ? 'target' : f.timeframe === 'CURRENT' ? 'current' : f.timeframe.toLowerCase();
  const per = f.period === 'month' ? 'monthly' : f.period === 'year' ? 'annual' : f.period === 'week' ? 'weekly' : f.period === 'day' ? 'daily' : '';
  return [when, per, f.concept].filter(Boolean).join('_');
}
const factValue = (f: FounderFact) => (f.value !== undefined ? String(f.value) : f.low !== undefined ? `${f.low}-${f.high}` : f.text || f.raw);

/** Numbers and named facts in the founder's own message (deterministic, exact founder wording). */
export function founderFactsFrom(text: string, at: string): KnownFact[] {
  return extractFounderFacts(text).facts.filter((f) => f.concept !== 'other' || f.value !== undefined).map((f) => ({ key: factKey(f), value: factValue(f), quote: f.raw, provenance: 'FOUNDER' as const, at, said: f.context.trim().slice(0, 300) }));
}
/** Model-reported facts are accepted ONLY when their quote is verbatim in what the founder just wrote. */
export function verifiedModelFacts(founderText: string, facts: ModelTurn['founder_facts'], at: string): KnownFact[] {
  const hay = norm(founderText);
  return (facts || []).filter((f) => f && typeof f.quote === 'string' && f.quote.trim().length >= 3 && hay.includes(norm(f.quote)) && typeof f.key === 'string' && typeof f.value === 'string')
    .map((f) => ({ key: f.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60), value: f.value.trim().slice(0, 200), quote: f.quote.trim().slice(0, 200), provenance: 'FOUNDER' as const, at }));
}
/** A newer founder statement replaces an older one with the same key (the founder corrected themselves). */
function mergeFacts(old: KnownFact[], incoming: KnownFact[]): KnownFact[] {
  const out = [...old];
  for (const f of incoming) { const i = out.findIndex((x) => x.key === f.key); if (i >= 0) out[i] = f; else out.push(f); }
  return out.slice(-30);
}
/** Hippo may fill or refine a field only while it is Hippo's own reading; a founder-stated field is never overwritten by AI. */
const setByHippo = (cur: Field, v: string | undefined): Field => (cur?.provenance === 'FOUNDER' || !v || !v.trim() || /^not (stated|known)/i.test(v.trim()) ? cur : { value: v.trim().slice(0, 300), provenance: 'HIPPO' });
const list = (cur: string[], v: string[] | undefined, max = 8) => (Array.isArray(v) ? [...new Set([...cur, ...v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200))])].slice(-max) : cur);

// ---------------------------------------------------------------- one turn
export type TurnResult = { state: BusinessState; phase: Phase; status: Status; reply: string; intent: Intent; handoff: boolean };

/** Summary shown when Hippo proposes the next step. Founder-stated facts are quoted, not paraphrased. */
export function proposal(s: BusinessState): string {
  const lines = [
    s.objective && `• Goal: ${s.objective.value}`,
    s.target && `• Target: ${s.target.value}`,
    s.current_state && `• Where you are today: ${s.current_state.value}`,
    ...s.known_facts.slice(0, 5).map((f) => `• You told me: “${f.quote}”`),
    s.constraints.length ? `• Constraints: ${s.constraints.slice(0, 3).join('; ')}` : null,
  ].filter(Boolean);
  return `Got it. I understand what you're trying to achieve.\n\nHere's what I think we're solving:\n${lines.join('\n')}\n\nI can now investigate the opportunity, economics and possible routes. Want me to dig in?`;
}

/** Deterministic Hippo when the model is unavailable (no key, budget refusal, outage): still useful, never invents. */
export function fallbackTurn(s: BusinessState, text: string): ModelTurn {
  const n = norm(text);
  if (s.objective && CORRECTION_RE.test(n)) return { intent: 'CORRECTION', ready_to_propose: Boolean(s.target && s.current_state), founder_facts: [{ key: 'founder_correction', value: text.trim(), quote: text.trim() }], reply: "Good — that changes things. Noted as fact, not a guess. What's the main thing standing between you and the goal right now?" };
  if (DONT_KNOW_RE.test(n)) return { intent: 'DONT_KNOW', ready_to_propose: false, reply: "No problem. Let's work it out. Are you more interested in making money quickly, building something big over time, or solving a problem you personally understand?" };
  const change = s.objective && CHANGE_RE.test(n);
  const objective = !s.objective || change ? text.trim().slice(0, 300) : undefined;
  const missing = !s.target && !objective?.match(/\d/) ? 'target' : !s.current_state ? 'current' : 'blocker';
  const reply = missing === 'target' ? "Love it. What does success look like for you — a number, a timeline, a first milestone?"
    : missing === 'current' ? "Where are you today with this — just an idea, or already selling something? Numbers help if you have them."
    : "What's actually stopping you today: not enough demand, not enough distribution, working capital, or something else? Your own words are fine.";
  return { intent: change ? 'CHANGE_OBJECTIVE' : s.objective ? 'ANSWER' : 'OBJECTIVE', ready_to_propose: false, reply, ...(objective ? { objective } : {}) };
}

/**
 * Applies one founder message. `ai` is the model's turn (or null → deterministic fallback). Rules enforced here, not
 * by the model: stop always stops; research is handed off ONLY from a PROPOSED phase on explicit approval; at most
 * MAX_PROBES probing questions before a proposal; founder facts are protected; changing the objective archives the old
 * one instead of forcing it.
 */
export function applyTurn(state: BusinessState, phase: Phase, status: Status, founderText: string, ai: ModelTurn | null, now = new Date()): TurnResult {
  const at = now.toISOString();
  let s: BusinessState = structuredClone(state);
  if (phase === 'HANDED_OFF') phase = 'DISCOVER'; // a new message after a handoff starts the next conversation cycle

  if (isStop(founderText)) {
    return { state: s, phase: phase === 'PROPOSED' ? 'DISCOVER' : phase, status: 'PAUSED', intent: 'STOP', handoff: false,
      reply: "Stopped. Nothing is running and nothing will start without you. When you want to pick this up — or go somewhere completely different — just tell me." };
  }
  status = 'ACTIVE';
  if (phase === 'PROPOSED' && isApproval(founderText)) {
    return { state: s, phase: 'HANDED_OFF', status: 'HANDED_OFF', intent: 'APPROVE', handoff: true, reply: "On it. I'm handing this to the research team now — they'll dig into the opportunity, the economics and the possible routes, with sources. I'll explain what they find in plain words." };
  }

  const t = ai ?? fallbackTurn(s, founderText);
  const intent: Intent = INTENTS.includes(t.intent) ? t.intent : 'OTHER';
  // The model may say APPROVE, but only explicit approval (above) triggers research.

  if (intent === 'CHANGE_OBJECTIVE' && s.objective) {
    s.previous_objectives = [...s.previous_objectives, { objective: s.objective.value, known_facts: s.known_facts, at }].slice(-5);
    s = { ...emptyState(), previous_objectives: s.previous_objectives, founder_preferences: s.founder_preferences };
    phase = 'DISCOVER';
  }

  // Founder facts: deterministic numbers + verbatim-quoted model facts. Both are the founder's own words.
  const facts = [...founderFactsFrom(founderText, at), ...verifiedModelFacts(founderText, t.founder_facts, at)];
  s.known_facts = mergeFacts(s.known_facts, facts);
  const withPeriod = (f: FounderFact) => `${f.raw}${f.period && !new RegExp(f.period, 'i').test(f.raw) ? ` a ${f.period}` : ''}`;
  const extracted = extractFounderFacts(founderText).facts;
  const tgt = extracted.filter((f) => f.timeframe === 'TARGET').map((f) => `${withPeriod(f)}${f.deadline ? ` by ${f.deadline}` : ''}`);
  const cur = extracted.filter((f) => f.timeframe === 'CURRENT').map(withPeriod);
  if (tgt.length) s.target = { value: tgt.join('; '), provenance: 'FOUNDER' };
  if (cur.length) s.current_state = { value: cur.join('; '), provenance: 'FOUNDER' };
  // A correction is the founder speaking: their restated field replaces even a founder field.
  const correcting = intent === 'CORRECTION';
  if (!s.objective && !t.objective && intent !== 'DONT_KNOW') s.objective = { value: founderText.trim().slice(0, 300), provenance: 'FOUNDER' };
  s.objective = correcting && t.objective ? { value: t.objective.trim().slice(0, 300), provenance: 'FOUNDER' } : setByHippo(s.objective, t.objective) ?? s.objective;
  if (!tgt.length) s.target = correcting && t.target && !/^not /i.test(t.target) ? { value: t.target.trim().slice(0, 300), provenance: 'FOUNDER' } : setByHippo(s.target, t.target);
  if (!cur.length) s.current_state = correcting && t.current_state && !/^not /i.test(t.current_state) ? { value: t.current_state.trim().slice(0, 300), provenance: 'FOUNDER' } : setByHippo(s.current_state, t.current_state);
  s.constraints = list(s.constraints, t.constraints);
  s.unknowns = list(s.unknowns, t.unknowns);
  s.founder_preferences = list(s.founder_preferences, t.founder_preferences);
  if (t.conversation_summary?.trim()) s.conversation_summary = t.conversation_summary.trim().slice(0, 800);

  const reply = (t.reply || '').trim().slice(0, 1200);
  const asked = /\?/.test(reply);
  const enough = Boolean(s.objective) && intent !== 'DONT_KNOW' && intent !== 'STOP' && (t.ready_to_propose || s.probes >= MAX_PROBES || (asked && s.probes + 1 > MAX_PROBES));

  if (phase === 'PROPOSED' && (intent === 'CHALLENGE' || intent === 'OTHER')) {
    // Hippo engages with the challenge; the proposal stays open and nothing starts without a clear yes.
    return { state: s, phase: 'PROPOSED', status, intent, handoff: false, reply: `${reply || "Fair challenge."}\n\nWhen you're happy with the direction, just say "dig in" and I'll start. Or tell me what to change.` };
  }
  if (enough || (phase === 'PROPOSED' && intent === 'CORRECTION')) {
    return { state: s, phase: 'PROPOSED', status, intent, handoff: false, reply: proposal(s) };
  }
  if (asked) s.probes += 1;
  return { state: s, phase: 'DISCOVER', status, intent, handoff: false, reply: reply || "Tell me a bit more — what are you trying to make happen?" };
}

// ---------------------------------------------------------------- model prompt
export const TURN_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    reply: { type: 'string' },
    ready_to_propose: { type: 'boolean' },
    objective: { type: 'string' }, target: { type: 'string' }, current_state: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    founder_preferences: { type: 'array', items: { type: 'string' } },
    founder_facts: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, quote: { type: 'string' } }, required: ['key', 'value', 'quote'] } },
    conversation_summary: { type: 'string' },
  },
  required: ['intent', 'reply', 'ready_to_propose'],
};

export function turnPrompt(s: BusinessState, phase: Phase, history: { role: string; text: string }[], founderText: string): string {
  const view = { objective: s.objective, target: s.target, current_state: s.current_state, constraints: s.constraints, unknowns: s.unknowns, founder_preferences: s.founder_preferences, summary: s.conversation_summary };
  const facts = s.known_facts.map((f) => `- ${f.key} = ${f.value} (founder said: "${f.quote}")`).join('\n') || '- none yet';
  return `You are Hippo — the founder's brilliant best friend and slightly mischievous elder brother who is commercially sharp.
Always on the founder's side, but not always on their side of the argument. Warm, energetic, concise, direct. Light "bro" is fine.
Never corporate or consulting-speak, never a motivational coach, never a form. Never mention agents, models, tools or internal teams.

Your job in this conversation: understand what the founder is trying to achieve well enough to hand it to research.
Ask the MINIMUM useful follow-up: ONE short question per reply (offer 2–4 quick options when it helps, plus "or just tell me in your own words").
Probing questions already asked: ${s.probes} of at most ${MAX_PROBES}. Set ready_to_propose=true as soon as you know the goal and roughly where they are today
(or when ${MAX_PROBES} questions are used). Do NOT write the proposal yourself — just set ready_to_propose.
If the founder already gave numbers, use them — don't lecture or ask for what they told you.
If they say they don't know: "No problem. Let's work it out." and help them choose (money quickly / something big over time / a problem they know).
If they correct you, accept it as fact (intent CORRECTION). If they switch to a different business, intent CHANGE_OBJECTIVE.
If they challenge you or ask for a different route, engage honestly in 1–3 sentences (intent CHALLENGE). Disagree when it's warranted.
Do not invent market data, prices or statistics. Do not promise research results.

Fields: objective/target/current_state = your short reading of what the founder said ("Not stated yet" if unknown).
founder_facts: ONLY things the founder literally said in their LAST message, each with "quote" copied word-for-word from it.
unknowns: what still needs to be found out. conversation_summary: 1–2 sentences of the whole conversation so far.
Phase: ${phase}.
FOUNDER FACTS (authoritative — never contradict or change them):
${facts}
CURRENT BUSINESS STATE:
${JSON.stringify(view)}
RECENT CONVERSATION:
${history.slice(-10).map((m) => `${m.role === 'HIPPO' ? 'Hippo' : 'Founder'}: ${m.text}`).join('\n')}
FOUNDER'S LAST MESSAGE:
"""${founderText}"""`;
}

/** Validates the model output into a ModelTurn (anything malformed → null → deterministic fallback). */
export function parseModelTurn(d: unknown): ModelTurn | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.reply !== 'string' || !o.reply.trim()) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  return {
    intent: INTENTS.includes(o.intent as Intent) ? (o.intent as Intent) : 'OTHER', reply: o.reply, ready_to_propose: o.ready_to_propose === true,
    objective: str(o.objective), target: str(o.target), current_state: str(o.current_state), constraints: arr(o.constraints), unknowns: arr(o.unknowns),
    founder_preferences: arr(o.founder_preferences), conversation_summary: str(o.conversation_summary),
    founder_facts: Array.isArray(o.founder_facts) ? (o.founder_facts as ModelTurn['founder_facts']) : undefined,
  };
}

/** Objective text handed to the existing engine: Hippo's reading plus the founder's facts in their exact words. */
export function handoffText(s: BusinessState): string {
  const parts = [s.objective?.value || ''];
  if (s.target) parts.push(`Target: ${s.target.value}.`);
  if (s.current_state) parts.push(`Today: ${s.current_state.value}.`);
  // The founder's own sentences, verbatim, so the engine sees every number with its unit, period and meaning.
  const said = [...new Set(s.known_facts.map((f) => (f.said || f.quote).trim()))].filter((q) => q && !parts.join(' ').includes(q));
  if (said.length) parts.push(`In my words: ${said.map((q) => q.replace(/[.!?]+$/, '')).join('. ')}.`);
  if (s.constraints.length) parts.push(`Constraints: ${s.constraints.join('; ')}.`);
  const text = parts.filter(Boolean).join(' ').replace(/\.\./g, '.').trim();
  return text.length >= 20 ? text.slice(0, 5000) : `${text} — founder objective from conversation with Hippo.`;
}
