// The Hippo conversation when Moves are on (HIPPO_MOVES=on). Chat is the natural-language interface to the operating
// partner; the pinned Move is the anchor. Discovery hands off straight into a first Move (no report, no paywall);
// "I don't know" becomes at most two questions and three directions with one recommended; while a Move is on the
// table every message either changes the Move, records what happened, updates what Hippo knows, or answers briefly.
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { applyTurn, handoffText, isStop, parseModelTurn, turnPrompt, TURN_SCHEMA, type BusinessState, type Phase, type Status } from './conversation';
import { DIRECTIONS_SCHEMA, directionsPrompt, normaliseDirectionChoice } from './explore';
import { aiMeta, generateJson } from './gateway';
import { HttpError } from './context';
import { createObjective } from './service';
import type { Understanding } from './types';
import {
  CONSEQUENCE_LABEL, materialChange, mergeCapacity, mergeProfile, movingControl, movingTurnPrompt, MOVING_TURN_SCHEMA, parseMovingTurn,
  proofIn, readFounderSignals, readSignal, validateMove, emptyCapacity, type MoveControl, type ProposedMove,
} from './moves';
import {
  activeMoveJob, approveMove, currentMove, markActed, moveContext, pageUrl, parkMove, recordSignal, requestMove, rerouteMove, stateOf, whyMove,
} from './move-service';
import { resumeIfDue } from '../jobs/runtime';
import { MOVE_RUN_MS } from './move-service';

const json = (v: unknown) => v as Prisma.InputJsonValue;
type Ctx = { user: { id: string }; founder: { id: string; name: string | null }; org: { id: string; name?: string; isDemo?: boolean } };

export const MOVES_OPENING = "Hi, I'm Hippo. Tell me what you want to build or make happen — in your own words.";
const IDEA_QUESTIONS = ['What are you good at — or what do people already ask you for help with?', 'Roughly how much money and how many hours a week could you put in to start?'];
const NO_IDEA_RE = /\b(no idea|don'?t know|do not know|not sure|no clue|idk|pata nahi|kuch nahi pata)\b/i;
const JUST_SUGGEST_RE = /\b(just suggest|you (tell|choose|pick|decide)|give me (some )?(ideas|options)|suggest something|any ideas?)\b/i;

// ---------------------------------------------------------------- what the founder sees
export type MoveView = {
  id: string; kind: string; owner: string; title: string; why: string; hippoWill: string; needs: string[]; cost: string; expectedSignal: string;
  status: string; consequential: boolean; okBecause: string[]; needsGuardian: boolean; alternative: { title: string; why: string } | null;
  artifact: null | { type: 'DOCUMENT'; title: string; markdown: string } | { type: 'PUBLIC_PAGE'; slug: string; url: string; status: string; headline: string; views: number; responses: { name: string | null; contact: string; message: string | null; at: string; fromOwner: boolean }[] } | { type: 'DEEP_RESEARCH' };
  signals: { summary: string; source: string; at: string }[]; proof: string | null; proofSource: string | null;
};

const costLabel = (c: number | null, basis: string) => (!c ? 'Free' : `₹${c.toLocaleString('en-IN')}${basis && basis !== 'estimate' ? ` (${basis})` : ' (estimate)'}`);

export async function moveView(move: NonNullable<Awaited<ReturnType<typeof currentMove>>>): Promise<MoveView> {
  let artifact: MoveView['artifact'] = null;
  if (move.publicPageId) {
    const page = await db.publicPage.findUnique({ where: { id: move.publicPageId }, include: { responses: { orderBy: { createdAt: 'desc' }, take: 20 } } });
    if (page) artifact = { type: 'PUBLIC_PAGE', slug: page.slug, url: pageUrl(page.slug), status: page.status, headline: page.headline, views: page.views, responses: page.responses.map((r) => ({ name: r.name, contact: r.contact, message: r.message, at: r.createdAt.toISOString(), fromOwner: r.fromOwner })) };
  } else if (move.workId) {
    const ex = await db.execution.findFirst({ where: { workId: move.workId }, orderBy: { startedAt: 'desc' } });
    if (ex?.output) artifact = { type: 'DOCUMENT', title: ex.outputSummary || move.title, markdown: ex.output };
  } else if (move.artifactType === 'DEEP_RESEARCH') artifact = { type: 'DEEP_RESEARCH' };
  const signals = await db.outcome.findMany({ where: { moveId: move.id, NOT: { external: false } }, orderBy: { createdAt: 'asc' } }); // self-tests aren't signals
  const reasons = move.consequentialReasons as string[];
  return {
    id: move.id, kind: move.kind, owner: move.owner, title: move.title, why: move.why, hippoWill: move.hippoWill, needs: move.needs as string[],
    cost: costLabel(move.costInr, move.costBasis), expectedSignal: move.expectedSignal, status: move.status, consequential: move.consequential,
    okBecause: reasons.filter((r) => r !== 'FLAGGED' || reasons.length === 1).map((r) => CONSEQUENCE_LABEL[r] || r), needsGuardian: reasons.includes('MINOR'),
    alternative: (move.alternative as MoveView['alternative']) ?? null, artifact,
    signals: signals.map((s) => ({ summary: s.summary, source: s.source || 'FOUNDER_REPORTED', at: s.createdAt.toISOString() })), proof: move.proof, proofSource: move.proofSource,
  };
}

/** Quick replies for the current state: only the controls that make sense now. */
export function quickReplies(m: { status: string; owner: string; artifactType?: string } | null, s: BusinessState, thinking: boolean): string[] {
  if (thinking) return [];
  const alts = (s.directions ?? []).map((_, i) => i).filter((i) => i !== (s.chosen ?? s.recommended ?? 0)).map((i) => `Try ${'ABC'[i]} instead`);
  if (!m) return s.directions?.length ? [`Start with ${'ABC'[s.recommended ?? 0]}`, ...alts, 'Something else'] : [];
  if (m.status === 'PARKED') return ['Bring it back', 'Try another way'];
  if (m.status === 'LIVE') return m.owner === 'HIPPO' ? ["What's next?", 'This failed'] : ['No one replied', 'This failed', 'Help me do this'];
  if (m.status === 'SIGNALLED') return ["What's next?"];
  if (m.status === 'APPROVED') return ['I did it', 'Help me do this', "I can't do this"];
  return ['Yes', 'Try another way', 'Help me do this', 'Not now', ...(s.chosen !== undefined ? alts : [])];
}

/** Current Move, whether Hippo is still working on the next one, and the quick replies. Resumes a parked job. */
export async function movesState(objectiveId: string | null, s: BusinessState) {
  if (!objectiveId) return { move: null, thinking: false, quick: quickReplies(null, s, false) };
  const job = await activeMoveJob(objectiveId);
  if (job) await resumeIfDue(job, MOVE_RUN_MS);
  const move = await currentMove(objectiveId);
  const thinking = Boolean(job) || move?.status === 'PREPARING';
  return { move: move ? await moveView(move) : null, thinking, quick: quickReplies(move, s, thinking) };
}

// ---------------------------------------------------------------- Move actions (shared by chat and the Move card)
export type MoveAction = 'YES' | 'NOT_NOW' | 'RESUME' | 'HELP' | 'ANOTHER_WAY' | 'CANT' | 'FAILED' | 'DID_IT' | 'NEXT' | 'WHY';

export async function applyMoveAction(ctx: { userId: string; founderId: string }, objective: { id: string; organizationId: string }, action: MoveAction, opts: { text?: string; proof?: string; guardian?: boolean } = {}): Promise<string> {
  const move = await currentMove(objective.id);
  if (!move) {
    if (await activeMoveJob(objective.id)) return "I'm setting it up now — it'll appear above in a moment.";
    if (action === 'NEXT' || action === 'YES' || action === 'RESUME') { await requestMove(objective, ctx.userId, 'NEXT'); return 'On it — working out the next move.'; }
    return "There's nothing on the table right now. Say \"what's next\" and I'll work out the next move.";
  }
  const actor = { userId: ctx.userId, founderId: ctx.founderId };
  switch (action) {
    case 'YES': {
      const reasons = move.consequentialReasons as string[];
      if (reasons.includes('MINOR') && !opts.guardian) return 'This one needs a parent or guardian to say OK — ask them to tap “Yes” with you on the card.';
      const m = await approveMove(move.id, actor, { guardian: opts.guardian });
      if (m.status === 'LIVE' && m.proof) return `It's live: ${m.proof}\nShare it with the people we talked about. I'll see every response and tell you.`;
      if (m.status === 'PREPARING') return "OK — I'll put it out as soon as it's ready.";
      if (m.artifactType === 'DEEP_RESEARCH') return "OK — start the analysis from the card. It's a one-time payment and you'll see exactly what it covers first.";
      const needs = (move.needs as string[]).map((n) => n.replace(/\.$/, ''));
      return `Let's do it. Everything I prepared is on the card above.${needs.length ? ` Your part: ${needs.join('; ')}.` : ''} Then tell me what happened — even if nobody replied.`;
    }
    case 'NOT_NOW': await parkMove(move.id, actor, true); return "Parked. Nothing's lost — say “bring it back” when you're ready.";
    case 'RESUME': await parkMove(move.id, actor, false); return "Back on the table.";
    case 'DID_IT': await markActed(move.id, actor, opts.proof); return opts.proof ? 'Got it — I saved the link. What happened? Tell me even if nobody replied.' : 'Nice. What happened? Tell me even if nobody replied — and paste a link or screenshot if you have one.';
    case 'WHY': return whyMove(move.id);
    case 'NEXT':
      if (!['LIVE', 'SIGNALLED'].includes(move.status)) return "Let's get this one out first — or say “try another way” if it doesn't fit.";
      await rerouteMove(move.id, actor, 'NEXT'); return 'Let me work out what this tells us and what to do next.';
    case 'HELP': await rerouteMove(move.id, actor, 'HELP', opts.text); return move.owner === 'FOUNDER'
      ? "I can prepare everything, but I can't send it without your approval. I'm getting it down to the point where you only check it and press send — who to send it to first, the exact message for each, and what to reply if they answer."
      : "Let me make that easier — I'll do more of it myself and keep your part to a yes.";
    case 'ANOTHER_WAY': await rerouteMove(move.id, actor, 'ANOTHER_WAY', opts.text); return 'Same goal, different route — give me a moment.';
    case 'CANT': await rerouteMove(move.id, actor, 'CANT', opts.text); return "Understood. The goal stays — I'll find another way that works for you.";
    case 'FAILED': await rerouteMove(move.id, actor, 'FAILED', opts.text); return "That's useful to know — it rules something out. Let me rethink the route.";
  }
  return '';
}

// ---------------------------------------------------------------- handing off into the first Move
async function handoff(ctx: Ctx, convId: string, s: BusinessState, reason: 'START' | 'DIRECTION', instruction?: string) {
  const u: Understanding = { objective: s.objective?.value || 'Not stated yet', target: s.target?.value || 'Not stated yet', currentState: s.current_state?.value || 'Not stated yet', keyQuestion: 'What is the smallest real step that tests this?', businessKind: s.current_state ? 'UNCLEAR' : 'NEW_IDEA', source: 'FOUNDER_NUMBERS' };
  const created = await createObjective(ctx, { text: handoffText(s), mode: s.directions?.length ? 'EXPLORE' : 'IDEA', understanding: u });
  const objective = await db.objective.findUniqueOrThrow({ where: { id: created.objectiveId }, select: { id: true, organizationId: true } });
  await db.conversation.update({ where: { id: convId }, data: { phase: 'MOVING', status: 'ACTIVE', objectiveId: objective.id, state: json(s) } });
  return { objective, start: (words: { intro?: string; outro?: string } = {}) => requestMove(objective, ctx.user.id, reason, { instruction, ...words }) };
}

async function startDirection(ctx: Ctx, convId: string, s: BusinessState, i: number, words: { intro?: string; outro?: string } = {}) {
  const d = s.directions![i];
  s.objective = { value: d.objective.slice(0, 300), provenance: 'FOUNDER' };
  s.noIdea = false; s.chosen = i;
  const h = await handoff(ctx, convId, s, 'DIRECTION', `Chosen direction: ${d.title} (for ${d.whoItServes}). Why it fits: ${d.whyYou}. Suggested first step: ${d.firstTest}`);
  await h.start(words);
}

function pickDirection(text: string, s: BusinessState): number | null {
  if (!s.directions?.length) return null;
  const t = text.toLowerCase().trim();
  const letter = t.match(/^(?:start with |go with |let'?s do |let'?s try |try |option |pick )?\(?([abc])\)?\s*(?:instead)?[.!]?$/) || t.match(/\b(?:option|direction)\s+([abc1-3])\b/);
  if (letter) { const c = letter[1]; return /[1-3]/.test(c) ? Number(c) - 1 : 'abc'.indexOf(c); }
  if (/^(yes|yeah|ok|okay|sure|go|let'?s go|do it|start|the recommended one|your pick)\b/.test(t)) return s.recommended ?? 0;
  const i = s.directions.findIndex((d) => t.includes(d.title.toLowerCase().slice(0, 20)));
  return i >= 0 ? i : null;
}

/** Hippo's call in words: the recommended direction and why (intro), and at most two alternatives (outro). The first Move's
 *  details go between them, so the founder gets one coherent turn. */
const recommendation = (s: BusinessState) => {
  const d = s.directions!; const r = s.recommended ?? 0; const rec = d[r];
  const others = d.map((x, i) => ({ x, i })).filter(({ i }) => i !== r);
  const intro = `I've thought through a few directions. ${s.recommendWhy ? `I think we should start with ${rec.title.toLowerCase()} — ${s.recommendWhy.replace(/\.$/, '')}.` : `I think we should start with ${rec.title.toLowerCase()}, for ${rec.whoItServes}.`}\n\nI don't want you spending money building anything yet.`;
  const outro = others.length ? `If it doesn't feel right, I also considered ${others.map(({ x, i }) => `${'ABC'[i]}) ${x.title.toLowerCase()}`).join(' and ')} — just say the letter.` : '';
  return { intro, outro };
};

// ---------------------------------------------------------------- one founder message
export async function postMoveMessage(ctx: Ctx, conv: { id: string; phase: string; status: string; state: unknown; objectiveId: string | null }, text: string): Promise<void> {
  await db.conversationMessage.create({ data: { conversationId: conv.id, role: 'FOUNDER', text } });
  const s = stateOf(conv);
  const read = readFounderSignals(text);
  const before = { cap: s.capacity || emptyCapacity(), prof: s.profile || {} };
  s.profile = mergeProfile(s.profile, read.profile);
  s.capacity = mergeCapacity(s.capacity, read.capacity);
  const usage = { userId: ctx.user.id, founderId: ctx.founder.id, organizationId: ctx.org.id, parentType: 'REQUEST' as const };
  const say = async (reply: string, meta: Record<string, unknown> = {}) => db.conversationMessage.create({ data: { conversationId: conv.id, role: 'HIPPO', text: reply, meta: json(meta) } });
  const history = async () => (await db.conversationMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'desc' }, take: 11 })).reverse().slice(0, -1).map((m) => ({ role: m.role, text: m.text }));

  // ---- a Move is on the table
  if (conv.phase === 'MOVING' && conv.objectiveId) {
    const objective = await db.objective.findUniqueOrThrow({ where: { id: conv.objectiveId }, select: { id: true, organizationId: true } });
    await db.conversation.update({ where: { id: conv.id }, data: { state: json(s) } });
    const actor = { userId: ctx.user.id, founderId: ctx.founder.id };
    if (isStop(text)) { const m = await currentMove(objective.id); if (m) await parkMove(m.id, actor, true); await say("Stopped. Nothing runs and nothing goes out without you. Say anything when you want to pick it up."); return; }
    const alt = s.directions?.length && text.trim().length <= 40 && !/^(yes|yeah|ok|okay|sure|go|let'?s go|do it|start)\b/i.test(text.trim()) ? pickDirection(text, s) : null;
    if (alt !== null && alt !== (s.chosen ?? s.recommended ?? 0) && s.directions?.[alt]) {
      const m = await currentMove(objective.id);
      if (m) await db.move.update({ where: { id: m.id }, data: { status: 'SUPERSEDED', closeReason: 'founder chose another direction' } });
      await startDirection(ctx, conv.id, s, alt, { intro: `OK — ${s.directions[alt].title.toLowerCase()} instead.` });
      return;
    }
    let control = movingControl(text) as MoveControl | null;
    if (control === 'DID_IT' && readSignal(text)) control = null; // they already told us what happened — treat it as a signal
    if (control) { await say(await applyMoveAction(actor, objective, control, { text, proof: proofIn(text) })); return; }
    const move = await currentMove(objective.id);
    let turn = null;
    try {
      const r = await generateJson<unknown>('converse', movingTurnPrompt(move ? { title: move.title, why: move.why, status: move.status, expectedSignal: move.expectedSignal, needs: move.needs as string[] } : null, s.profile || {}, await history(), text), MOVING_TURN_SCHEMA, {}, usage);
      turn = parseMovingTurn(r.data);
      console.log(JSON.stringify({ event: 'hippo_move_turn', conversationId: conv.id, ...aiMeta(r) }));
    } catch (e) { console.error(JSON.stringify({ event: 'hippo_move_turn_fallback', error: e instanceof Error ? e.message.slice(0, 200) : String(e) })); }
    const sig = readSignal(text);
    const intent = turn?.intent && !(turn.intent === 'OTHER' && sig) ? turn.intent : sig ? 'SIGNAL' : 'OTHER'; // a plain outcome is never lost
    // Constraints the founder stated (deterministic reading + the model's literal extraction).
    s.capacity = mergeCapacity(s.capacity, { avoid: turn?.avoid ?? [], assets: turn?.assets ?? [], ...(turn?.budgetInr !== undefined && read.capacity.budgetInr === undefined ? { budgetInr: turn.budgetInr } : {}), ...(turn?.existingCustomers !== undefined && read.capacity.existingCustomers === undefined ? { existingCustomers: turn.existingCustomers } : {}) });
    await db.conversation.update({ where: { id: conv.id }, data: { state: json(s) } });
    const changed = materialChange(before.cap, s.capacity!, before.prof, s.profile || {});
    if ((changed || intent === 'CORRECTION') && move) {
      // A material correction can invalidate the current Move immediately.
      const { ctx: mctx } = await moveContext(objective.id, 'CORRECTION');
      const asProposed = { ...move, needs: move.needs as string[], consequential: move.consequential, researchJustification: 'existing', alternative: null, reply: '', beliefs: [] } as unknown as ProposedMove;
      const v = validateMove(asProposed, { ...mctx, history: mctx.history.filter((h) => h.title !== move.title) });
      if (!v.ok) { await say(`${turn?.reply ? `${turn.reply}\n\n` : ''}That changes things — this move no longer fits. Let me rethink it.`); await rerouteMove(move.id, actor, 'CORRECTION', text); return; }
    }
    if (intent === 'SIGNAL' && move && (turn?.signal || sig)) {
      const polarity = turn?.signal?.polarity ?? sig!.polarity;
      const rung = (turn?.signal?.outcome || sig?.rung === 5) ? 5 : 4;
      const ack = polarity === 'NEGATIVE' ? "That's useful — silence or a no tells us something real." : polarity === 'POSITIVE' ? "That's useful — someone out there responded." : "That's useful to know.";
      await say(`${(turn?.intent === 'SIGNAL' && turn.reply) || ack}\n\nLet me work out what this means for our next move.`);
      await recordSignal(move.id, { summary: turn?.signal?.summary || text.slice(0, 400), polarity, rung, source: 'FOUNDER_REPORTED', proof: proofIn(text) });
      await rerouteMove(move.id, actor, 'SIGNAL', text);
      return;
    }
    const mapped: Partial<Record<string, MoveControl>> = { ACTION_DONE: 'DID_IT', CANT: 'CANT', ANOTHER_WAY: 'ANOTHER_WAY', HELP: 'HELP', FAILED: 'FAILED', APPROVE: 'YES', NOT_NOW: 'NOT_NOW', NEXT: 'NEXT' };
    if (mapped[intent]) { await say(await applyMoveAction(actor, objective, mapped[intent]!, { text, proof: proofIn(text) })); return; }
    if (intent === 'CHANGE_OBJECTIVE') {
      if (move) await db.move.update({ where: { id: move.id }, data: { status: 'SUPERSEDED', closeReason: 'founder changed the business' } });
      const fresh = { ...stateOf(null), profile: s.profile, capacity: s.capacity, previous_objectives: [...s.previous_objectives, ...(s.objective ? [{ objective: s.objective.value, known_facts: s.known_facts, at: new Date().toISOString() }] : [])].slice(-5) };
      await db.conversation.update({ where: { id: conv.id }, data: { phase: 'DISCOVER', state: json(fresh) } });
      await say(turn?.reply || "New direction — tell me what you want this one to be.");
      return;
    }
    await say(turn?.reply || "Tell me what happened, or ask me anything about this move.");
    return;
  }

  // ---- discovery
  const phase = conv.phase as Phase;
  const choice = pickDirection(text, s);
  if (choice !== null && s.directions?.[choice]) {
    await startDirection(ctx, conv.id, s, choice, { intro: `${s.directions[choice].title} it is.` });
    return;
  }
  let raw: unknown = null;
  try {
    const prompt = `${turnPrompt(s, phase === 'MOVING' ? 'DISCOVER' : phase, [{ role: 'HIPPO', text: MOVES_OPENING }, ...(await history())], text)}
STYLE OVERRIDE: use slang (like "bro") only if the founder uses it first. ${s.profile?.minor ? 'The founder is a child: short sentences, simple words.' : ''}
has_business_idea: false only when the founder has no product or business in mind yet (e.g. "I want to make money but no idea how").`;
    const r = await generateJson<unknown>('converse', prompt, { ...TURN_SCHEMA, properties: { ...TURN_SCHEMA.properties, has_business_idea: { type: 'boolean' } } }, {}, usage);
    raw = r.data;
    console.log(JSON.stringify({ event: 'hippo_turn', conversationId: conv.id, ...aiMeta(r) }));
  } catch (e) { console.error(JSON.stringify({ event: 'hippo_turn_fallback', conversationId: conv.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) })); }
  const ai = raw ? parseModelTurn(raw) : null;
  const r = applyTurn(s, phase === 'MOVING' ? 'DISCOVER' : phase, conv.status as Status, text, ai);
  const ns: BusinessState = { ...r.state, profile: s.profile, capacity: s.capacity, noIdea: s.noIdea, ideaQuestions: s.ideaQuestions, directions: s.directions, recommended: s.recommended, recommendWhy: s.recommendWhy };
  if (r.intent === 'STOP') { await say(r.reply); await db.conversation.update({ where: { id: conv.id }, data: { state: json(ns), status: 'PAUSED', phase: 'DISCOVER' } }); return; }

  // "I don't know": at most two questions, then three directions with one recommended — never a questionnaire.
  const hasIdea = (raw as { has_business_idea?: unknown } | null)?.has_business_idea;
  const noIdea = ns.noIdea || hasIdea === false || (!ai && NO_IDEA_RE.test(text) && !ns.objective?.value.match(/\b(sell|make|build|open|start|run)\b.*\b(shop|store|book|app|service|business of)\b/i)) || r.intent === 'DONT_KNOW';
  if (noIdea && !ns.directions?.length) {
    ns.noIdea = true;
    const asked = ns.ideaQuestions ?? 0;
    const knowsTime = ns.capacity?.hoursPerWeek !== undefined;
    if (asked < (knowsTime ? 1 : 2) && !JUST_SUGGEST_RE.test(text)) {
      ns.ideaQuestions = asked + 1;
      const reply = `${asked === 0 ? "No problem — you don't need to know yet. " : ''}${IDEA_QUESTIONS[asked]}`;
      await say(reply, { kind: 'IDEA_QUESTION' });
      await db.conversation.update({ where: { id: conv.id }, data: { state: json(ns), phase: 'DISCOVER', status: 'ACTIVE' } });
      return;
    }
    const msgs = await db.conversationMessage.findMany({ where: { conversationId: conv.id, role: 'FOUNDER' }, orderBy: { createdAt: 'asc' }, take: 12 });
    const about = [ns.conversation_summary, ...msgs.map((m) => m.text), ns.capacity?.budgetInr !== undefined ? `Money available: ₹${ns.capacity.budgetInr}` : ''].filter(Boolean).join('\n');
    try {
      const d = await generateJson<unknown>('explore', directionsPrompt(about, { budgetInr: ns.capacity?.budgetInr, hoursPerWeek: ns.capacity?.hoursPerWeek, avoid: ns.capacity?.avoid ?? [], minor: ns.profile?.minor }), DIRECTIONS_SCHEMA, {}, usage);
      const c = normaliseDirectionChoice(d.data);
      Object.assign(ns, { directions: c.directions, recommended: c.recommended, recommendWhy: c.why });
      await db.conversation.update({ where: { id: conv.id }, data: { state: json(ns), phase: 'DISCOVER', status: 'ACTIVE' } });
      await startDirection(ctx, conv.id, ns, ns.recommended ?? 0, recommendation(ns)); // Hippo decides; the founder doesn't have to pick
      return;
    } catch (e) {
      console.error(JSON.stringify({ event: 'hippo_directions_failed', error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      await say("Tell me one thing you're good at or enjoy, and I'll suggest three directions with a cheap first step for each.");
    }
    await db.conversation.update({ where: { id: conv.id }, data: { state: json(ns), phase: 'DISCOVER', status: 'ACTIVE' } });
    return;
  }

  // Enough to act: straight into the first Move (no report, no paywall).
  if (r.phase === 'PROPOSED' || r.handoff) {
    await say('Got it. Give me a moment — I’m working out the first move.', { kind: 'HANDOFF' });
    const h = await handoff(ctx, conv.id, ns, 'START');
    await h.start();
    return;
  }
  await say(r.reply, { intent: r.intent });
  await db.conversation.update({ where: { id: conv.id }, data: { state: json(ns), phase: r.phase, status: r.status } });
}

/** Founder action from the Move card (same rules as chat), recorded in the conversation for continuity. */
export async function cardAction(ctx: { user: { id: string }; founder: { id: string } }, moveId: string, action: MoveAction, opts: { text?: string; proof?: string; guardian?: boolean } = {}) {
  const move = await db.move.findFirst({ where: { id: moveId } });
  if (!move) throw new HttpError(404, 'Not found');
  const owned = await db.organization.count({ where: { id: move.organizationId, founderId: ctx.founder.id } });
  if (!owned) throw new HttpError(404, 'Not found');
  const conv = await db.conversation.findFirst({ where: { objectiveId: move.objectiveId, userId: ctx.user.id }, orderBy: { updatedAt: 'desc' } });
  const label: Record<MoveAction, string> = { YES: opts.guardian ? 'Yes — my parent/guardian says OK' : 'Yes', NOT_NOW: 'Not now', RESUME: 'Bring it back', HELP: 'Help me do this', ANOTHER_WAY: 'Try another way', CANT: "I can't do this", FAILED: 'This failed', DID_IT: opts.proof ? `I did it: ${opts.proof}` : 'I did it', NEXT: "What's next?", WHY: 'Why?' };
  if (conv) await db.conversationMessage.create({ data: { conversationId: conv.id, role: 'FOUNDER', text: opts.text?.trim() ? `${label[action]} — ${opts.text.trim()}` : label[action] } });
  const reply = await applyMoveAction({ userId: ctx.user.id, founderId: ctx.founder.id }, { id: move.objectiveId, organizationId: move.organizationId }, action, opts);
  if (conv) await db.conversationMessage.create({ data: { conversationId: conv.id, role: 'HIPPO', text: reply, meta: json({ kind: 'MOVE_ACTION', action }) } });
  return reply;
}
