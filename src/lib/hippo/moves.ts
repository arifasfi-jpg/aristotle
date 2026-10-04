// Moves — the founder-level unit of business progress (V1, behind HIPPO_MOVES=on).
//
// A Move is "the smallest action that materially changes the state of this business now": what, why, the bet it tests,
// who performs the external step, what Hippo prepares, what it costs, what Hippo needs from the founder, and the signal
// we are watching for. The model PROPOSES a Move from structured state; this file DECIDES whether it is acceptable
// (constraints, preferences, budget, failed routes, known facts) and whether it needs the founder's OK. The
// consequential-action rule is deterministic and can only ever be raised by the model, never lowered.
//
// Pure functions only (no database, no model calls): everything here is unit-testable.
import { MARKETING_CLAIM_RULES } from './claims';

// On when HIPPO_MOVES=on; on by default in Vercel Preview (HIPPO_MOVES=off restores the previous experience). Production
// only with an explicit HIPPO_MOVES=on.
export const movesEnabled = (env: Record<string, string | undefined> = process.env) => env.HIPPO_MOVES === 'on' || (env.HIPPO_MOVES !== 'off' && env.VERCEL_ENV === 'preview');

export const MOVE_KINDS = ['RESEARCH', 'BUILD', 'SELL', 'TALK', 'TEST', 'PRICE', 'BUY', 'CONTACT', 'PUBLISH', 'DECIDE', 'STOP', 'PIVOT', 'VALIDATE', 'EXECUTE'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];
export const ARTIFACT_TYPES = ['NONE', 'DOCUMENT', 'PUBLIC_PAGE', 'DEEP_RESEARCH'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
/** A Move in one of these states is "the current Move" (database-enforced: at most one per objective). */
export const CURRENT_STATUSES = ['PROPOSED', 'PREPARING', 'READY', 'APPROVED', 'LIVE', 'SIGNALLED', 'PARKED'] as const;
export const DEEP_RESEARCH_PRICE_INR = 99;

// ---------------------------------------------------------------- founder profile & capacity (read from their words)
export type FounderProfile = {
  age?: number; minor?: boolean; guardian?: 'YES' | 'NO' | 'UNKNOWN';
  experience?: 'NEW' | 'SOME' | 'EXPERIENCED'; density?: 'LIGHT' | 'STANDARD' | 'DENSE';
  casual?: boolean; brutal?: boolean; bigger?: boolean;
};
export type Capacity = { budgetInr?: number; hoursPerWeek?: number; avoid: string[]; assets: string[]; existingCustomers?: number };
export const emptyCapacity = (): Capacity => ({ avoid: [], assets: [] });

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const n0 = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const amount = (num: string, unit?: string) => {
  const v = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(v)) return undefined;
  const u = (unit || '').toLowerCase();
  return Math.round(v * (u === 'k' || u === 'thousand' ? 1_000 : /^(lakh|lac|l)$/.test(u) ? 100_000 : u === 'crore' ? 10_000_000 : 1));
};

/**
 * What the founder's own words say about them and their capacity. Deterministic and conservative: only explicit
 * statements count ("I am 10 years old", "I only have ₹2,000", "I don't want to build an app"). The model may add more
 * from the conversation, but never overwrites these.
 */
export function readFounderSignals(text: string): { profile: FounderProfile; capacity: Partial<Capacity> } {
  const t = n0(text);
  const profile: FounderProfile = {};
  const capacity: Partial<Capacity> = {};
  const age = t.match(/\b(?:i am|i'm|im)\s+(\d{1,2})\s*(?:years?|yrs?|yo)\b/) || t.match(/\b(\d{1,2})\s*(?:years?|yrs?)\s*old\b/) || t.match(/\bage\s*(?:is\s*)?(\d{1,2})\b/);
  if (age) { profile.age = Number(age[1]); profile.minor = profile.age < 18; }
  if (/\b(bro|bruh|dude|yaar|bhai)\b/.test(t)) profile.casual = true;
  if (/\b(my )?(mum|mom|mother|dad|father|parents?|guardian)\b[^.!?]{0,20}\b(is|are|will be)\s+(helping|with me|ok|okay|on board|in)\b|\b(a )?parent is helping\b|\byes,? (my )?(mum|mom|dad|parent)/.test(t)) profile.guardian = 'YES';
  if (/\b(keep it short|short version|tl;?dr|less detail|too long)\b/.test(t)) profile.density = 'LIGHT';
  if (/\b(explain more|more detail|in detail|go deeper|give me (the )?numbers)\b/.test(t)) profile.density = 'DENSE';
  if (/\bbrutal\b/.test(t)) profile.brutal = true;
  if (/\bthink bigger\b/.test(t)) profile.bigger = true;
  if (/\b(\d+)\s*\+?\s*years? (of experience|in (the )?(industry|business|trade))|\bi(?:'ve| have) (run|built|started|scaled) (a|my|two|three|\d+|several)\b/.test(t)) profile.experience = 'EXPERIENCED';
  else if (/\b(first business|never (done|started|run)|new to (this|business)|first time|i know nothing|know nothing|don'?t know anything|no experience|zero experience|complete beginner|i'?m a beginner)\b/.test(t)) profile.experience = 'NEW';

  const budget = t.match(/\b(?:only have|have only|i have|i've got|i got|got|budget(?: is| of)?|can spend|can invest|can put in|put in|invest|can afford|afford|max(?:imum)?(?: of)?)\s*(?:of |around |about |just )?(?:₹|rs\.?\s?|inr\s?)(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lac|crore)?\b/)
    || t.match(/\b(?:only have|have only|i have|budget(?: is| of)?|can spend|can invest)\s*(?:of |around |about |just )?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lac)?\s*(?:rupees|rs|inr)\b/)
    || t.match(/(?:₹|rs\.?\s?)(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lac)?\s*(?:budget|to spend|to invest)\b/);
  if (budget) capacity.budgetInr = amount(budget[1], budget[2]);
  const hours = t.match(/\b(\d{1,3})(?:\s*(?:-|–|to)\s*\d{1,3})?\s*(?:hours?|hrs?)\s*(?:a|per|every)\s*(week|day)\b/); // a range counts its low end
  if (hours) capacity.hoursPerWeek = Number(hours[1]) * (hours[2] === 'day' ? 7 : 1);
  const customers = t.match(/\b(?:already\s+)?(?:have|got|serve|with)\s+(?:about\s+|around\s+|over\s+)?(\d[\d,]*)\s+(?:existing\s+|paying\s+|regular\s+|loyal\s+)?(?:customers|clients|buyers|subscribers|users)\b/);
  if (customers) capacity.existingCustomers = amount(customers[1]);
  const access = [...t.matchAll(/\b(?:can get|have|got)\s+access to\s+([^.!?;]{3,60})/g)].map((m) => m[1].trim());
  if (access.length) capacity.assets = access;
  const avoid: string[] = [];
  for (const m of t.matchAll(/\b(?:i\s+)?(?:don't|dont|do not|won't|will not|can't|cannot|never|refuse to|hate to)\s+(?:want to\s+|wanna\s+|like to\s+|going to\s+)?(build|make|approach|cold[- ]call|call|talk to|visit|go to|sell to|use|run|do|create|develop|spend on|post on|be on|give|send|show|share|ask)\s+(?:an?\s+|any\s+|the\s+|my\s+)?([a-z][a-z0-9 \-]{1,40}?)(?=[.,!?;]|$| because| but| and| since)/g)) {
    if (!/^(this|that|it|so|anything|much|more)$/.test(m[2].trim())) avoid.push(`${m[1]} ${m[2]}`.trim());
  }
  if (avoid.length) capacity.avoid = avoid;
  return { profile, capacity };
}

/** Founder statements win over earlier ones; lists accumulate. */
export function mergeProfile(cur: FounderProfile | undefined, add: FounderProfile | undefined): FounderProfile {
  const out: FounderProfile = { ...(cur || {}) };
  for (const [k, v] of Object.entries(add || {})) if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  if (out.age !== undefined) out.minor = out.age < 18;
  return out;
}
export function mergeCapacity(cur: Capacity | undefined, add: Partial<Capacity> | undefined): Capacity {
  const c = { ...emptyCapacity(), ...(cur || {}) };
  const a = add || {};
  return {
    ...c,
    ...(a.budgetInr !== undefined ? { budgetInr: a.budgetInr } : {}),
    ...(a.hoursPerWeek !== undefined ? { hoursPerWeek: a.hoursPerWeek } : {}),
    ...(a.existingCustomers !== undefined ? { existingCustomers: a.existingCustomers } : {}),
    avoid: [...new Set([...c.avoid, ...(a.avoid || [])].map((x) => x.trim()).filter(Boolean))].slice(-12),
    assets: [...new Set([...c.assets, ...(a.assets || [])].map((x) => x.trim()).filter(Boolean))].slice(-12),
  };
}
/** Did this message change something a Move depends on (money, preferences, customers, access, a minor)? */
export function materialChange(before: Capacity, after: Capacity, pBefore: FounderProfile, pAfter: FounderProfile): boolean {
  return before.budgetInr !== after.budgetInr || before.existingCustomers !== after.existingCustomers || after.avoid.length > before.avoid.length
    || after.assets.length > before.assets.length || pBefore.minor !== pAfter.minor;
}

// ---------------------------------------------------------------- the Move as proposed by the model
export type BeliefUpdate = { key: string; statement: string; confidence: 'LOW' | 'MEDIUM' | 'HIGH'; evidence: string; disprovedIf: string };
export type ProposedMove = {
  kind: MoveKind; owner: 'HIPPO' | 'FOUNDER'; title: string; why: string; bet: string; hippoWill: string; needs: string[];
  costInr: number | null; costBasis: string; expectedSignal: string; artifactType: ArtifactType; artifactBrief: string;
  routeKey: string; consequential: boolean; researchJustification: string; alternative: { title: string; why: string } | null;
  reply: string; beliefs: BeliefUpdate[];
};

const MOVE_PROPS = {
  kind: { type: 'string', enum: [...MOVE_KINDS] }, owner: { type: 'string', enum: ['HIPPO', 'FOUNDER'] },
  title: { type: 'string' }, why: { type: 'string' }, bet: { type: 'string' }, hippoWill: { type: 'string' },
  needs: { type: 'array', items: { type: 'string' } }, costInr: { type: 'number' }, costBasis: { type: 'string' },
  expectedSignal: { type: 'string' }, artifactType: { type: 'string', enum: [...ARTIFACT_TYPES] }, artifactBrief: { type: 'string' },
  routeKey: { type: 'string' }, consequential: { type: 'boolean' }, researchJustification: { type: 'string' },
};
export const MOVE_SCHEMA = {
  type: 'object',
  properties: {
    move: { type: 'object', properties: MOVE_PROPS, required: ['kind', 'owner', 'title', 'why', 'bet', 'hippoWill', 'needs', 'costInr', 'costBasis', 'expectedSignal', 'artifactType', 'artifactBrief', 'routeKey', 'consequential'] },
    alternative: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } } },
    reply: { type: 'string' },
    beliefs: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, statement: { type: 'string' }, confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] }, evidence: { type: 'string' }, disprovedIf: { type: 'string' } }, required: ['key', 'statement', 'confidence', 'evidence', 'disprovedIf'] } },
  },
  required: ['move', 'reply', 'beliefs'],
};

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, n) : '');
export const routeKeyOf = (s: string) => n0(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Model output → a ProposedMove, or null when it is not even shaped like one. */
export function normaliseMove(raw: unknown): ProposedMove | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const m = (r.move ?? {}) as Record<string, unknown>;
  const title = str(m.title, 160);
  if (!title) return null;
  const cost = typeof m.costInr === 'number' && Number.isFinite(m.costInr) && m.costInr > 0 ? Math.round(m.costInr * 100) / 100 : m.costInr === 0 ? 0 : null;
  const alt = r.alternative as Record<string, unknown> | undefined;
  const beliefs = (Array.isArray(r.beliefs) ? r.beliefs : []).slice(0, 5).map((b) => b as Record<string, unknown>).map((b): BeliefUpdate => ({
    key: routeKeyOf(str(b.key, 60) || str(b.statement, 60)), statement: str(b.statement, 300),
    confidence: (['LOW', 'MEDIUM', 'HIGH'].includes(String(b.confidence)) ? b.confidence : 'LOW') as BeliefUpdate['confidence'],
    evidence: str(b.evidence, 400), disprovedIf: str(b.disprovedIf, 300),
  })).filter((b) => b.key && b.statement);
  return {
    kind: (MOVE_KINDS.includes(m.kind as MoveKind) ? m.kind : 'TEST') as MoveKind,
    owner: m.owner === 'HIPPO' ? 'HIPPO' : 'FOUNDER',
    title, why: str(m.why, 400), bet: str(m.bet, 300), hippoWill: str(m.hippoWill, 400),
    needs: (Array.isArray(m.needs) ? m.needs : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 3),
    costInr: cost, costBasis: str(m.costBasis, 200) || (cost ? 'estimate' : 'free'), expectedSignal: str(m.expectedSignal, 300),
    artifactType: (ARTIFACT_TYPES.includes(m.artifactType as ArtifactType) ? m.artifactType : 'NONE') as ArtifactType,
    artifactBrief: str(m.artifactBrief, 600), routeKey: routeKeyOf(str(m.routeKey, 80) || title),
    consequential: m.consequential === true, researchJustification: str(m.researchJustification, 300),
    alternative: alt && str(alt.title, 160) ? { title: str(alt.title, 160), why: str(alt.why, 300) } : null,
    reply: str(r.reply, 600), beliefs,
  };
}

// ---------------------------------------------------------------- the authorization boundary (server-side, authoritative)
export const CONSEQUENCE_LABEL: Record<string, string> = {
  MONEY: 'it spends money', PUBLIC: 'it goes public', COMMERCIAL: 'it involves selling or buying', EXTERNAL: 'it speaks to people in your name',
  LEGAL: 'it commits you or involves legal/regulatory steps', PERSONAL_DATA: "it collects people's contact details", IRREVERSIBLE: "it can't be undone",
  FLAGGED: 'Hippo thinks it needs your say', MINOR: "you're under 18, so a parent or guardian must OK it",
};
const EXTERNAL_RE = /\b(send|sends|sending|message|messages|messaging|email|emails|whatsapp|dm|dms|call|calls|calling|post|posts|posting|share|shares|sharing|publish|publishes|list|listing|advertis\w*|reach out|contact|contacts|pitch|pitches|outreach|distribute|hand out)\b/;
const LEGAL_RE = /\b(sign|signs|signing|contract|agreement|register|registration|incorporat\w*|licen[cs]e\w*|gst|trademark|file|filing|apply for|loan|lease|deposit)\b/;
const DATA_RE = /\b(email address(es)?|phone numbers?|contact details|addresses|personal data|collect (emails|numbers|names|contacts))\b/;
const IRREVERSIBLE_RE = /\b(irreversible|non-?refundable|delete|shut (it )?down|quit (your|my) job|resign)\b/;

/** Why this Move needs the founder's OK (empty = Hippo may simply do it). Deterministic; the model can only add. */
export function consequentialReasons(m: Pick<ProposedMove, 'kind' | 'owner' | 'title' | 'hippoWill' | 'needs' | 'artifactType' | 'artifactBrief' | 'costInr' | 'consequential'>, profile: FounderProfile = {}): string[] {
  const text = n0([m.title, m.hippoWill, ...m.needs, m.artifactBrief].join(' '));
  const r = new Set<string>();
  if ((m.costInr ?? 0) > 0 || m.artifactType === 'DEEP_RESEARCH') r.add('MONEY');
  if (m.artifactType === 'PUBLIC_PAGE' || m.kind === 'PUBLISH') r.add('PUBLIC');
  if (m.artifactType === 'PUBLIC_PAGE') r.add('PERSONAL_DATA'); // the page collects responders' contact details
  if (m.kind === 'SELL' || m.kind === 'BUY') r.add('COMMERCIAL');
  // Hippo speaking/acting externally in the founder's name. When the founder performs it, it is their own act —
  // except for a minor, where any contact with people outside needs a parent's OK.
  if (EXTERNAL_RE.test(text) && (m.owner === 'HIPPO' || profile.minor)) r.add('EXTERNAL');
  if (LEGAL_RE.test(text)) r.add('LEGAL');
  if (DATA_RE.test(text)) r.add('PERSONAL_DATA');
  if (IRREVERSIBLE_RE.test(text)) r.add('IRREVERSIBLE');
  if (m.consequential) r.add('FLAGGED');
  if (profile.minor && r.size) r.add('MINOR');
  return [...r];
}

// ---------------------------------------------------------------- validation against state and history
export type PastMove = { title: string; kind: string; routeKey: string; status: string; closeReason?: string | null; negative?: boolean };
export type MoveContext = {
  objective: string; target?: string; today?: string; constraints: string[]; knownFacts: { key: string; quote: string }[]; unknowns: string[];
  preferences: string[]; profile: FounderProfile; capacity: Capacity; beliefs: { statement: string; confidence: string; evidence: string }[];
  history: PastMove[]; signals: { summary: string; polarity: string; source: string; at: string; rung?: number }[];
  reason: string; reasonCode?: string; instruction?: string; blockedRoutes: string[]; research?: string; company?: string | null;
};

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'with', 'on', 'in', 'at', 'by', 'any', 'my', 'your', 'our', 'build', 'make', 'approach', 'call', 'talk', 'visit', 'go', 'sell', 'use', 'run', 'do', 'create', 'develop', 'spend', 'post', 'be', 'cold']);
const words = (s: string) => n0(s).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
const stem = (w: string) => w.replace(/(ies|es|s)$/, '');
const mentions = (text: string, w: string) => new RegExp(`\\b${stem(w)}(s|es|ies|y)?\\b`).test(n0(text));
const similar = (a: string, b: string) => { const A = new Set(words(a).map(stem)); const B = new Set(words(b).map(stem)); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / Math.min(A.size, B.size); };

// ---------------------------------------------------------------- what the world has told us so far (internal)
const DEMAND_RE = /\b(price|pricing|how much|cost|rates?|book(ed|ing)?|order(ed)?|pre-?order|pay|paid|sign(ed)? up|trial|when can|where can i)\b/;
/** Where the business is, read from its signals: is the problem evidenced, is there demand, has anyone paid, and did the last
 *  route get nothing? Founder-reported evidence counts (as evidence for this business, not as a market fact). */
export function learningStage(signals: MoveContext['signals'], history: MoveContext['history'] = []) {
  const pos = signals.filter((x) => x.polarity !== 'NEGATIVE');
  const paid = signals.some((x) => x.rung === 5 && x.polarity !== 'NEGATIVE');
  const demand = paid || pos.some((x) => DEMAND_RE.test(n0(x.summary)));
  const problem = demand || pos.some((x) => x.polarity === 'POSITIVE' || /\b(need|needs|needed|problem|struggle|hard|pain|frustrat\w*|no time|(don'?t|do not) have (the )?time|discomfort|uncomfortable|expensive|costly|cost|travel|difficult|hate|annoying|wish)\b/.test(n0(x.summary)));
  const last = history.filter((h) => !['SUPERSEDED', 'PROPOSED', 'PREPARING', 'READY'].includes(h.status)).at(-1);
  const lastNegative = Boolean(last && (last.negative || last.status === 'FAILED'));
  const stage = paid ? 'PAID' : demand ? 'DEMAND' : problem ? 'PROBLEM_EVIDENCED' : 'UNTESTED';
  return { stage, problem, demand, paid, lastNegative, lastTitle: last?.title };
}
const STAGE_GUIDE: Record<string, string> = {
  UNTESTED: 'Nothing from the real world yet. The first job is a real reaction to the problem or offer.',
  PROBLEM_EVIDENCED: 'The founder has already heard the problem from real people (above). Do NOT ask them to rediscover it: no more generic interviews, surveys or "ask a few people what they think" unless one specific unresolved question blocks the next action (then name it in researchJustification). Next: the cheapest way to prove we can actually DELIVER the solution — by hand, for a few real customers (a concierge test: find the supply, deliver manually, test the logistics and the price) — and whether they will book or pay. No app, platform or website build yet.',
  DEMAND: 'Real people are asking about price, booking or ordering. Do NOT go back to awareness outreach or more interviews. Next: turn interest into a commitment — a concrete offer with a price, a paid trial, a booking, or the first delivery — and learn what it takes to deliver.',
  PAID: 'Someone has paid. Next: deliver it well, learn what delivery really takes, get the next paying customer, and only then automate what hurts.',
};
const DISCOVERY_RE = /\b(interview|survey|questionnaire|ask (\w+ ){0,4}(about|what|whether|if|them|people|women|users|customers|potential)|talk to (\w+ ){0,4}(about|users|customers|people|women|potential)|find out (what|whether|if)|frustrations|pain points|understand (what|their)|potential users|feedback on the idea|validate (the )?(problem|idea))\b/;
const SOFTWARE_RE = /\b(app|platform|software|website|marketplace|mvp|portal|code)\b/;
const MORE_OF_SAME_RE = /\b(\d{2,}\s+more|more (\w+ ){0,2}(cafes|people|customers|shops|groups|contacts|messages|outreach)|again|another round|bigger list|wider)\b/;

/**
 * Accepts or rejects a proposed Move against the founder's constraints and the business's history, and sets its
 * authorization requirement. Problems are fed back to the model for one retry; then a safe fallback is used.
 */
export function validateMove(m: ProposedMove, ctx: MoveContext): { ok: boolean; problems: string[]; consequentialReasons: string[] } {
  const problems: string[] = [];
  const text = [m.title, m.hippoWill, ...m.needs, m.artifactBrief, m.why].join(' ');
  if (!m.why || !m.expectedSignal) problems.push('MISSING_WHY_OR_SIGNAL: every Move needs a why and the signal we are watching for.');
  if (m.costInr !== null && m.costInr < 0) problems.push('IMPOSSIBLE_COST: cost cannot be negative.');
  const cost = m.artifactType === 'DEEP_RESEARCH' ? DEEP_RESEARCH_PRICE_INR : m.costInr ?? 0;
  if (ctx.capacity.budgetInr !== undefined && cost > ctx.capacity.budgetInr) problems.push(`EXCEEDS_BUDGET: costs ₹${cost} but the founder has ₹${ctx.capacity.budgetInr}.`);
  for (const a of ctx.capacity.avoid) {
    const ws = words(a);
    if (ws.length && ws.every((w) => mentions(text, w))) problems.push(`CONTRADICTS_PREFERENCE: the founder does not want to "${a}".`);
  }
  if (m.artifactType === 'PUBLIC_PAGE' && m.owner !== 'HIPPO') problems.push('WRONG_OWNER: Hippo hosts public pages itself (owner HIPPO).');
  if (m.kind === 'RESEARCH' && !m.researchJustification) problems.push('RESEARCH_NOT_JUSTIFIED: prefer a Move that reaches a real person; research only when it is clearly the highest-leverage step (say why).');
  if ((ctx.capacity.existingCustomers ?? 0) > 0 && /\b(first|initial)\s+(\d+\s+)?(customers?|buyers?|sales?|users?)\b/.test(n0(text))) problems.push(`IGNORES_KNOWN_FACT: the founder already has ${ctx.capacity.existingCustomers} customers.`);
  // Learning: what the world already said changes what the next Move may be.
  const L = learningStage(ctx.signals, ctx.history);
  const said = n0([m.title, m.hippoWill, m.artifactBrief].join(' '));
  const commercial = /(₹|\b(price|pricing|pay|paid|book|booking|order|pre-?order|trial|deliver|delivery|pickup|sell|offer|charge)\b)/.test(said);
  if (L.problem && !L.paid && DISCOVERY_RE.test(said) && !commercial && !m.researchJustification)
    problems.push('REDISCOVERY: the founder already reported what real people said about the problem — do not ask them to find it out again. Use it: test whether we can deliver the solution for a few real customers and whether they will book or pay.');
  if (L.problem && !L.paid && m.kind === 'BUILD' && SOFTWARE_RE.test(said)) problems.push('PREMATURE_SOFTWARE: prove the solution can be delivered by hand and that people pay before building an app, platform or website.');
  if (L.demand && MORE_OF_SAME_RE.test(said) && !/\b(price|offer|trial|book|pay|order)\b/.test(said)) problems.push('AWARENESS_AFTER_DEMAND: people are already asking about price or booking — move to an offer, price, trial or booking, not more outreach.');
  if (L.lastNegative && L.lastTitle && MORE_OF_SAME_RE.test(said) && similar(L.lastTitle, m.title) >= 0.3) problems.push(`MORE_OF_THE_SAME: "${L.lastTitle}" got no response — change the approach or the offer instead of doing more of it.`);
  const blocked = new Set(ctx.blockedRoutes);
  for (const p of ctx.history) {
    const failed = ['FAILED', 'DECLINED'].includes(p.status) || p.negative;
    // After "I can't" / "another way" / "it failed", the same activity reworded (other channel, same thing) is not a new route.
    const code = ctx.reasonCode ?? ctx.reason;
    const rerouting = ['CANT', 'ANOTHER_WAY', 'FAILED'].includes(code) && (blocked.has(p.routeKey) || ['FAILED', 'DECLINED'].includes(p.status));
    const sameRoute = p.routeKey === m.routeKey || similar(p.title, m.title) >= (rerouting ? 0.6 : 0.8);
    if (sameRoute && (failed || blocked.has(p.routeKey))) problems.push(`REPEATS_FAILED_ROUTE: "${p.title}" already ${p.status === 'DECLINED' ? 'was declined by the founder' : 'did not work'}; choose a different route.`);
    else if (sameRoute && ['DONE', 'LIVE', 'SIGNALLED'].includes(p.status) && code !== 'HELP') problems.push(`ALREADY_DONE: "${p.title}" has already been done.`);
  }
  if (blocked.has(m.routeKey) && !problems.some((p) => p.startsWith('REPEATS_FAILED_ROUTE'))) problems.push('BLOCKED_ROUTE: the founder asked for a different way than this route.');
  return { ok: problems.length === 0, problems: [...new Set(problems)], consequentialReasons: consequentialReasons(m, ctx.profile) };
}

/** A safe Move when the model is unavailable or keeps proposing invalid ones: Hippo prepares, the founder hands it over. */
export function fallbackMove(ctx: MoveContext): ProposedMove {
  const minor = Boolean(ctx.profile.minor);
  if (learningStage(ctx.signals, ctx.history).problem) return {
    kind: 'TEST', owner: 'FOUNDER', title: 'Deliver it by hand for one real customer this week',
    why: 'People already told you the problem is real — now find out if we can actually solve it for someone, before building anything.',
    bet: 'One real customer will take it up, and doing it by hand shows what delivery really needs.',
    hippoWill: 'Write the offer, a simple step-by-step of how you deliver it by hand, a price to try, and what to note while doing it.',
    needs: [minor ? 'Do it with a parent' : 'Offer it to one of the people who said they need it', 'Deliver it and note what was hard'],
    costInr: 0, costBasis: 'free', expectedSignal: 'Whether they take it up, what they would pay, and what was hard to deliver',
    artifactType: 'DOCUMENT', artifactBrief: 'Offer, by-hand delivery steps, a price to try, and a notes table.',
    routeKey: 'deliver by hand once', consequential: false, researchJustification: '', alternative: null,
    reply: "You've already heard the problem from real people. Let's see if we can actually solve it for one of them.", beliefs: [],
  };
  return {
    kind: 'TALK', owner: 'FOUNDER', title: 'Show your idea to 3 people who might buy it and note what they say',
    why: "The fastest way to learn if this is worth your time is a real person's reaction — before spending anything.",
    bet: 'People who match your buyer will show real interest when they see a simple description.',
    hippoWill: 'Write a short description of your idea and the 3 exact questions to ask, plus a place to note answers.',
    needs: [minor ? 'Pick 3 people you know (ask a parent first)' : 'Pick 3 people who could buy this', 'Show them the description and ask the 3 questions'],
    costInr: 0, costBasis: 'free', expectedSignal: 'How many of the 3 say they would want it, and what they ask about',
    artifactType: 'DOCUMENT', artifactBrief: 'A 5-line description of the offer, 3 questions to ask, and a 3-row table to note the answers.',
    routeKey: 'three-person-reaction-check', consequential: false, researchJustification: '', alternative: null,
    reply: "Let's get a real reaction first — I've lined up the simplest way to do that.", beliefs: [],
  };
}

// ---------------------------------------------------------------- prompts
const STYLE = (p: FounderProfile) => p.minor ? 'very short sentences and simple words a 10-year-old understands; warm, never childish'
  : p.density === 'LIGHT' ? 'very short and plain' : p.density === 'DENSE' || p.experience === 'EXPERIENCED' ? 'dense and specific; numbers welcome' : 'short and plain';

/** The founder never claims what they haven't told us. Used by the Move engine, the artifact writer and the output check. */
export const FOUNDER_TRUTH_RULES = `SPEAKING AS THE FOUNDER (strict): anything written for the founder to send or say must be true of them. Never make them claim
experience, customers, clients, credentials, results, expertise, a team, or that they run or own a business/agency/service unless they
said so. If they are new to this, write it honest and low-ego: offer something specific and useful, no pitch, and ask permission
(e.g. "I noticed a couple of simple things that might help bring in more weekend customers — I put together a one-page idea sheet. Want me to send it?").`;
const CLAIM_RE = /[^.!?\n]*\b(?:(?:i|we) (?:run|own|have|manage) (?:a|an|my|our)\b[^.!?\n]{0,40}\b(?:agency|business|company|studio|firm|service|team)|our (?:clients|customers|team|agency|company)|years of experience|(?:i|we)(?:'ve| have) helped|i'?m an? (?:expert|specialist|professional|consultant)|i speciali[sz]e)\b[^.!?\n]*[.!?]?/gi;
/** Sentences that make the founder claim credentials they never stated (empty when the founder said they are experienced). */
export function inventedClaims(text: string, profile: FounderProfile, capacity?: Capacity): string[] {
  if (profile.experience === 'EXPERIENCED' || (capacity?.existingCustomers ?? 0) > 0) return [];
  return [...text.matchAll(CLAIM_RE)].map((m) => m[0].trim()).filter(Boolean);
}
export const stripClaims = (text: string, claims: string[]) => claims.reduce((t, c) => t.split(c).join(''), text).replace(/[ \t]{2,}/g, ' ');

export function movePrompt(ctx: MoveContext, problems: string[] = []): string {
  const p = ctx.profile; const c = ctx.capacity;
  const profile = [p.age !== undefined && `age ${p.age}${p.minor ? ' (UNDER 18)' : ''}`, p.minor && `parent/guardian helping: ${p.guardian || 'UNKNOWN'}`, p.experience && `experience: ${p.experience}`, p.brutal && 'wants the brutal version', p.bigger && 'wants to think bigger'].filter(Boolean).join('; ') || 'nothing stated';
  const cap = [c.budgetInr !== undefined ? `money available: ₹${c.budgetInr}` : 'money available: not stated (prefer free Moves)', c.hoursPerWeek !== undefined && `time: ${c.hoursPerWeek} hours/week`,
    c.existingCustomers !== undefined && `already has ${c.existingCustomers} customers`, c.assets.length && `access/assets: ${c.assets.join('; ')}`].filter(Boolean).join('\n- ');
  return `MOVE ENGINE — Hippoturtle. You are Hippo's operating brain. Decide the ONE next Move for this founder's business.
A Move is an executable unit of business progress: the smallest action that materially changes the state of this business now.
Prefer Moves that put something real in front of a real buyer, user, supplier or partner and bring back a response (a signal).
A research-only Move is allowed only when it is clearly the highest-leverage step (then fill researchJustification).
Hippo does every part it can. If the founder must do something in person (talk, hand over, send from their phone), Hippo prepares
the exact thing (sample, script, message, questions, tracking sheet) so the founder only has to hand it over. Never assign homework.
${ctx.company ? `Business name: ${ctx.company}\n` : ''}
FOUNDER: ${profile}
CAPACITY & CONSTRAINTS:
- ${cap}
- NEVER propose anything the founder said they will not do: ${c.avoid.length ? c.avoid.map((a) => `"${a}"`).join(', ') : 'none stated'}
${ctx.constraints.length ? `- other constraints: ${ctx.constraints.join('; ')}\n` : ''}
BUSINESS (founder's words are authoritative):
- objective: ${ctx.objective}
- target: ${ctx.target || 'not stated'} | today: ${ctx.today || 'not stated'}
- founder said: ${ctx.knownFacts.map((f) => `"${f.quote}"`).join('; ') || 'nothing quantified yet'}
- unknowns: ${ctx.unknowns.join('; ') || 'none listed'}
WORKING BELIEFS (Hippo's current hypotheses — update them):
${ctx.beliefs.map((b) => `- [${b.confidence}] ${b.statement} (evidence: ${b.evidence || 'none yet'})`).join('\n') || '- none yet'}
WHAT HAS HAPPENED (most recent last):
${ctx.history.map((h) => `- Move "${h.title}" [${h.kind}] → ${h.status}${h.closeReason ? ` (${h.closeReason})` : ''}`).join('\n') || '- nothing yet (this is the first Move)'}
WHAT THE WORLD SAID (founder reported = real people told the founder: meaningful evidence for this business, not a market fact; seen by Hippo = observed directly; paid = verified commercial outcome):
${ctx.signals.map((s) => `- ${s.rung === 5 && s.polarity !== 'NEGATIVE' ? 'PAID / committed' : s.source === 'SYSTEM_OBSERVED' ? 'seen by Hippo' : 'founder reported'}: ${s.summary} (${s.polarity.toLowerCase()})`).join('\n') || '- no signals yet'}
WHERE THIS BUSINESS IS NOW (internal — never name stages to the founder): ${STAGE_GUIDE[learningStage(ctx.signals, ctx.history).stage]}
The order is: real problem → can we deliver it (by hand) → will they pay → what delivery really takes → improve → only then software → scale. Never step backwards to a stage the evidence has already passed.
DO NOT REPEAT THESE ROUTES (failed, declined or the founder asked for another way): ${[...new Set([...ctx.blockedRoutes, ...ctx.history.filter((h) => ['FAILED', 'DECLINED'].includes(h.status) || h.negative).map((h) => h.routeKey)])].join(', ') || 'none'}
WHY A NEW MOVE NOW: ${ctx.reason}${ctx.instruction ? ` — founder said: "${ctx.instruction}"` : ''}
${ctx.research ? `RESEARCH EVIDENCE (use it to sharpen the Move; do not turn the Move into research):\n${ctx.research.slice(0, 4000)}\n` : ''}
HIPPO'S CAPABILITIES TODAY (nothing else exists):
- DOCUMENT: write any document — sample, script, message, questions, tracking sheet, offer, listing text (free).
- PUBLIC_PAGE: host a simple public page on Hippoturtle with the offer and a "tell me when it's ready" / pre-order interest form
  (no payment is taken). Hippo sees every response automatically. Owner must be HIPPO. Needs the founder's OK to publish.
- DEEP_RESEARCH: a full sourced analysis for ₹${DEEP_RESEARCH_PRICE_INR} — only when a costly or irreversible decision genuinely needs evidence.
- NONE: no artifact needed.
Hippo cannot send messages, post on social media, run ads, take payments, buy anything or sign anything itself.
RULES:
- Exactly one Move; optionally one genuinely different alternative.
- owner: HIPPO when Hippo performs the external step (public page), FOUNDER when the founder must hand something over.
- costInr: real money the founder must spend (0 if free). costBasis: where the number comes from ("free", "estimate: …"). Never invent prices or statistics.
- Respect every constraint and the money available. If the founder is under 18, a parent or guardian must be involved for anything
  with money, public pages or strangers — say so in needs.
- needs: what Hippo needs from the founder; at most 3; each doable in minutes.
- Never ask the founder to choose between options (which customers, which channel, which product first): pick the sensible default
  yourself and say it ("we'll start with cafes"). The founder can always say "try another way".
- ${FOUNDER_TRUTH_RULES}
- expectedSignal: the concrete response from the world we are watching for. bet: the hypothesis this tests.
- routeKey: 2–5 word label of the approach. title: plain words, max 12 words. why: one sentence.
- beliefs: up to 5 working beliefs, updated from what happened; evidence = what supports it; disprovedIf = what would show it wrong.
- reply: 1–3 sentences in Hippo's voice introducing the Move. If something has happened, start from it ("Given what they told you — X — the next thing is …"). Style: ${STYLE(p)}. Never use the words task, workflow, hypothesis,
  belief, rung, methodology. ${p.casual ? 'Casual is fine.' : 'No slang.'}
- consequential: true if it spends money, goes public, speaks to people in the founder's name, commits them, collects personal data,
  or involves a minor in any of these.
${problems.length ? `YOUR PREVIOUS PROPOSAL WAS REJECTED. Fix every problem:\n${problems.map((x) => `- ${x}`).join('\n')}\n` : ''}JSON only.`;
}

// ---------------------------------------------------------------- preparing the artifact
export const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }, markdown: { type: 'string' },
    page: { type: 'object', properties: { headline: { type: 'string' }, subhead: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' }, priceInr: { type: 'number' } } },
  },
  required: ['title', 'markdown'],
};
export type Prepared = { title: string; markdown: string; page: { headline: string; subhead: string; body: string; cta: string; priceInr: number | null } | null };

export function preparePrompt(move: { title: string; why: string; hippoWill: string; artifactType: string; artifactBrief: string; needs: string[]; expectedSignal: string }, ctx: Pick<MoveContext, 'objective' | 'knownFacts' | 'profile' | 'company'>, problems: string[] = []): string {
  const page = move.artifactType === 'PUBLIC_PAGE';
  return `PREPARE ARTIFACT — Hippoturtle. Produce the COMPLETE thing for this Move, ready to use as-is (not an outline, not advice).
Business: ${ctx.objective}${ctx.company ? ` (${ctx.company})` : ''}
Founder said: ${ctx.knownFacts.map((f) => `"${f.quote}"`).join('; ') || 'nothing quantified'}
${ctx.profile.minor ? 'The founder is a child: make it something they would be proud of; a parent will see it.\n' : ''}MOVE: ${move.title}
Why: ${move.why}
What Hippo said it would make: ${move.hippoWill}
Artifact brief: ${move.artifactBrief}
What we are watching for: ${move.expectedSignal}
${page ? `This is a PUBLIC PAGE hosted by Hippoturtle. Fill "page": headline (max 10 words), subhead (max 20 words), body (short markdown,
max 150 words: what it is, who it's for, what happens next), cta (e.g. "Tell me when it's ready" or "Pre-order — no payment now"),
priceInr only if the founder stated a price. The page collects a name and email/phone; say "No payment is taken." Also put a short
summary in markdown.` : 'Put the full artifact in markdown. Include exactly what the founder hands over and, where useful, a simple table to note responses.'}
${MARKETING_CLAIM_RULES}
${FOUNDER_TRUTH_RULES}
${ctx.profile.experience === 'NEW' ? 'This founder is NEW to this and said so: nothing they send may sound like an established business.\n' : ''}${problems.length ? `YOUR PREVIOUS VERSION WAS REJECTED — it made the founder claim things they never said:\n${problems.map((p) => `- "${p}"`).join('\n')}\nRewrite without them.\n` : ''}Never leave a choice for the founder to make: if a target is needed (which customers first), pick it and say so.
JSON only.`;
}

export function normalisePrepared(raw: unknown, type: string): Prepared | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const markdown = typeof r.markdown === 'string' ? r.markdown.trim().slice(0, 20_000) : '';
  const pg = (r.page ?? null) as Record<string, unknown> | null;
  const page = type === 'PUBLIC_PAGE' && pg && str(pg.headline, 120) ? {
    headline: str(pg.headline, 120), subhead: str(pg.subhead, 200), body: typeof pg.body === 'string' ? pg.body.trim().slice(0, 3000) : '',
    cta: str(pg.cta, 60) || "Tell me when it's ready", priceInr: typeof pg.priceInr === 'number' && pg.priceInr > 0 ? Math.round(pg.priceInr) : null,
  } : null;
  if (type === 'PUBLIC_PAGE' && !page) return null;
  if (!markdown && !page) return null;
  return { title: str(r.title, 160) || 'Prepared by Hippo', markdown: markdown || (page ? `# ${page.headline}\n\n${page.body}` : ''), page };
}

// ---------------------------------------------------------------- what the founder says while a Move is on the table
export type MoveControl = 'YES' | 'NOT_NOW' | 'HELP' | 'ANOTHER_WAY' | 'CANT' | 'FAILED' | 'DID_IT' | 'NEXT' | 'WHY' | 'RESUME';
/** Deterministic controls (quick replies and their natural-language equivalents). No model call needed. */
export function movingControl(text: string): MoveControl | null {
  const t = n0(text).replace(/[.!]+$/, '');
  if (/^(yes|yeah|yep|ok|okay|sure|fine|alright|all right|sounds good|go|go ahead|do it|let'?s do it|let'?s go|approve|approved|publish( it)?|yes,? (publish|do) it|haan|chalo|theek hai)$/.test(t)) return 'YES';
  if (/^(not now|later|park it|maybe later|not today)\b/.test(t)) return 'NOT_NOW';
  if (/^(bring it back|resume|let'?s continue|continue)\b/.test(t)) return 'RESUME';
  if (/^(help me( do (this|it))?|how do i do (this|it)|i don'?t know how( to do (this|it))?)\b/.test(t)) return 'HELP';
  if (/^(try )?(another|a different|some other|other) (way|route|approach)\b|^something else\b/.test(t)) return 'ANOTHER_WAY';
  if (/^(this|it) (failed|didn'?t work|did not work)\b|^(failed|didn'?t work)\b/.test(t)) return 'FAILED';
  if (/^(i can'?t|i cannot|i won'?t|i will not|i can'?t( or won'?t)? do this|i'?m not comfortable|no,? i don'?t want to)\b/.test(t)) return 'CANT';
  if (/^(done|did it|i did it|i sent( it)?|sent( it)?|i posted( it)?|posted( it)?|i shared( it)?|shared( it)?|i gave it( out)?|gave it( out)?|handed (it )?out)\b/.test(t)) return 'DID_IT';
  if (/^(what'?s next|what next|next|now what|what now)\b/.test(t)) return 'NEXT';
  if (/^why\b/.test(t)) return 'WHY';
  return null;
}

export type ReadSignal = { summary: string; polarity: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; rung: 4 | 5; proof?: string; moneyInr?: number };
const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
export const proofIn = (text: string) => text.match(URL_RE)?.[0];
/**
 * A plain-language report of what happened ("No one replied", "3 parents replied", "One person paid ₹149", "The printer
 * quoted ₹70") → a Signal. Deterministic first pass; the model refines nuance. Money received is a verified outcome
 * only with proof; otherwise it stays founder-reported.
 */
/** The founder reports what real people told them ("I talked to 3 women, they said …"). */
export function readEvidence(text: string): boolean {
  const t = n0(text);
  return /\b(talked|spoke|spoken|asked|met|called|interviewed|showed|surveyed|chatted)\b[^.]{0,60}\b(they|she|he|all|everyone|people|women|men|customers|users|parents|owners|most|some|\d+|three|two|five)\b/.test(t)
    || /\b(they|she|he|people|customers|women|men|users|parents|owners|everyone|all of them)\b[^.]{0,25}\b(said|say|says|told me|mentioned|complained)\b/.test(t);
}
/** A different business entirely — not pushback on the current one ("build the platform", "just make the app"). */
export function isNewBusiness(text: string, objective: string): boolean {
  const t = n0(text).trim();
  if (words(t).length < 3) return false;
  if (/^(just |please |no,? )?(build|make|launch|create|develop|do|start)( it| the| my| our| an?)?\b/.test(t) && similar(t, objective) > 0) return false;
  if (/^(just |please |no,? )?(build|make|launch|create|develop) (it|the (app|platform|website|product|thing))\b/.test(t)) return false;
  return similar(t, objective) < 0.34;
}

export function readSignal(text: string): ReadSignal | null {
  const t = n0(text);
  const summary = text.trim().slice(0, 400);
  const proof = proofIn(text);
  const money = t.match(/(?:₹|rs\.?\s?)(\d[\d,]*)/);
  if (/\b(paid|received|got paid|bought|purchased|ordered|pre-?ordered)\b/.test(t) && !/\b(no one|nobody|none|didn'?t|did not)\b/.test(t)) {
    return { summary, polarity: 'POSITIVE', rung: 5, ...(proof ? { proof } : {}), ...(money ? { moneyInr: Number(money[1].replace(/,/g, '')) } : {}) };
  }
  if (/\b(no one|nobody|none|zero|0)\b[^.]{0,30}\b(replied|responded|bought|paid|came|interested|liked|signed up|clicked)\b|\b(hated|didn'?t like|did not like|said no|rejected|not interested|ignored|blocked)\b/.test(t) && !/\b(replied|responded|interested|asked)\b[^.]*\b(and|but)\b/.test(t)) return { summary, polarity: 'NEGATIVE', rung: 4, ...(proof ? { proof } : {}) };
  if (/\b(asked|asking) (for|about) (the )?(price|pricing|cost|rates?|details|more)\b|\bhow much\b/.test(t)) return { summary, polarity: 'POSITIVE', rung: 4, ...(proof ? { proof } : {}) };
  if (/\b(quoted|quote|price was|asked for)\b/.test(t)) return { summary, polarity: 'NEUTRAL', rung: 4, ...(proof ? { proof } : {}) };
  if (/\b(replied|responded|loved|liked|said yes|signed up|interested|finished|asked for more|want(s|ed)? (it|more|one)|enjoyed|clicked|booked)\b/.test(t)) return { summary, polarity: 'POSITIVE', rung: 4, ...(proof ? { proof } : {}) };
  return null;
}

/** The Move-phase conversation turn: what the founder's message means for the current Move. */
export const MOVING_INTENTS = ['SIGNAL', 'ACTION_DONE', 'CORRECTION', 'QUESTION', 'CHANGE_OBJECTIVE', 'CANT', 'ANOTHER_WAY', 'HELP', 'FAILED', 'APPROVE', 'NOT_NOW', 'NEXT', 'OTHER'] as const;
export type MovingIntent = (typeof MOVING_INTENTS)[number];
export const MOVING_TURN_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...MOVING_INTENTS] }, reply: { type: 'string' },
    signal: { type: 'object', properties: { summary: { type: 'string' }, polarity: { type: 'string', enum: ['POSITIVE', 'NEGATIVE', 'NEUTRAL'] }, outcome: { type: 'boolean' } } },
    avoid: { type: 'array', items: { type: 'string' } }, budgetInr: { type: 'number' }, existingCustomers: { type: 'number' }, assets: { type: 'array', items: { type: 'string' } },
  },
  required: ['intent', 'reply'],
};
export type MovingTurn = { intent: MovingIntent; reply: string; signal?: { summary: string; polarity: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; outcome: boolean }; avoid: string[]; budgetInr?: number; existingCustomers?: number; assets: string[] };

export function parseMovingTurn(d: unknown): MovingTurn | null {
  const o = (d ?? {}) as Record<string, unknown>;
  if (typeof o.reply !== 'string') return null;
  const sig = o.signal as Record<string, unknown> | undefined;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 1).map((x) => x.trim().slice(0, 80)).slice(0, 5) : []);
  return {
    intent: (MOVING_INTENTS.includes(o.intent as MovingIntent) ? o.intent : 'OTHER') as MovingIntent, reply: o.reply.trim().slice(0, 1000),
    ...(sig && typeof sig.summary === 'string' && sig.summary.trim() ? { signal: { summary: sig.summary.trim().slice(0, 400), polarity: (['POSITIVE', 'NEGATIVE', 'NEUTRAL'].includes(String(sig.polarity)) ? sig.polarity : 'NEUTRAL') as 'POSITIVE', outcome: sig.outcome === true } } : {}),
    avoid: arr(o.avoid), assets: arr(o.assets),
    ...(typeof o.budgetInr === 'number' && o.budgetInr >= 0 ? { budgetInr: Math.round(o.budgetInr) } : {}),
    ...(typeof o.existingCustomers === 'number' && o.existingCustomers >= 0 ? { existingCustomers: Math.round(o.existingCustomers) } : {}),
  };
}

export function movingTurnPrompt(move: { title: string; why: string; status: string; expectedSignal: string; needs: string[] } | null, profile: FounderProfile, history: { role: string; text: string }[], founderText: string): string {
  return `You are Hippo — the founder's operating partner: warm, direct, plain-spoken, on their side, not always on their side of the argument.
${profile.minor ? 'The founder is a child: short sentences, simple words.' : ''}${profile.casual ? ' Casual tone is fine.' : ' No slang.'}
THE CURRENT MOVE: ${move ? `"${move.title}" (status ${move.status}). Why: ${move.why}. Watching for: ${move.expectedSignal}. Needs from founder: ${move.needs.join('; ')}` : 'none yet'}
Classify the founder's message and reply in 1–3 sentences, tied to the current Move. Do not lecture. Never use the words task, workflow, hypothesis, belief, rung.
intent: SIGNAL (they report what happened in the world — fill signal: summary, polarity, outcome=true only if money was received or something was delivered),
ACTION_DONE (they did the external step), CORRECTION (they correct facts or constraints — fill budgetInr / existingCustomers / avoid / assets from their words),
QUESTION (answer it concisely), CHANGE_OBJECTIVE (a different business entirely), CANT (they can't or won't do this — fill avoid with what they won't do),
ANOTHER_WAY, HELP, FAILED, APPROVE, NOT_NOW, NEXT, OTHER.
Only fill avoid/budgetInr/existingCustomers/assets with what the founder literally said.
RECENT CONVERSATION:
${history.slice(-8).map((m) => `${m.role === 'HIPPO' ? 'Hippo' : 'Founder'}: ${m.text}`).join('\n')}
FOUNDER'S MESSAGE:
"""${founderText}"""`;
}
