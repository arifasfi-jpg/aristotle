// Moves — persistence, the background job that plans and prepares a Move, founder actions, signals and learning.
//
// One current Move per objective (database-enforced). A Move is planned from structured state (business state, founder
// profile and capacity, working beliefs, previous Moves and what the world said), validated by moves.ts, and prepared
// by Hippo (a document via Work/Execution, or a draft public page). The founder authorizes consequential steps; actions
// and signals are recorded with who observed them; every signal updates beliefs and leads to the next Move.
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { callCeilingInr } from '../ai-usage';
import { getResearch } from '../audit-meta';
import type { ResearchRecord } from '../evidence';
import { researchBrief } from '../research';
import { enqueueJob, kickJob, registerJobHandler, renewLease, resumeIfDue, type JobHandler, type StepResult } from '../jobs/runtime';
import type { Job } from '@prisma/client';
import { generateJson } from './gateway';
import { HttpError, logActivity, remember } from './context';
import { emptyState, type BusinessState } from './conversation';
import {
  CONSEQUENCE_LABEL, CURRENT_STATUSES, DEEP_RESEARCH_PRICE_INR, emptyCapacity, fallbackMove, MOVE_SCHEMA, movePrompt, normaliseMove,
  inventedClaims, normalisePrepared, PREPARE_SCHEMA, preparePrompt, readFounderSignals, mergeCapacity, stripClaims, validateMove,
  type MoveContext, type Prepared, type ProposedMove,
} from './moves';

export const MOVE_JOB = 'HIPPO_MOVE';
/** Per-planning-request cost limit (₹, internal). Planning + preparation are a few cheap model calls. */
export const moveJobBudgetInr = () => { const n = Number(process.env.HIPPO_MOVE_JOB_INR); return Number.isFinite(n) && n > 0 ? n : 15; };
/** A run started from a chat request must fit that route's maxDuration (30s). */
export const MOVE_RUN_MS = 25_000;
const json = (v: unknown) => v as Prisma.InputJsonValue;
const isBudgetRefusal = (e: unknown) => e instanceof Error && /AI_BUDGET_EXCEEDED/.test(e.message);

export type MoveReason = 'START' | 'SIGNAL' | 'NEXT' | 'ANOTHER_WAY' | 'CANT' | 'FAILED' | 'HELP' | 'CHANGE' | 'CORRECTION' | 'DIRECTION' | 'INSTRUCTION';
const REASON_TEXT: Record<MoveReason, string> = {
  START: 'first Move for this business', SIGNAL: 'the world responded to the last Move — learn from it and decide what to do next',
  NEXT: 'the founder asked what is next', ANOTHER_WAY: 'the founder wants a different route to the same objective',
  CANT: "the founder can't or won't do the last Move — same objective, but a materially different activity (not the same thing through another channel or reworded)", FAILED: 'the last Move failed — learn and change route',
  HELP: 'the founder needs help doing the last Move — keep the same goal but have Hippo do far more of it: prepare every piece (the exact message for each person, who to send it to first, what to reply when they answer) so the founder only has to approve and send. Do not just rewrite the same script',
  CHANGE: 'the founder asked to change the Move',
  INSTRUCTION: "the founder gave an explicit new instruction — it overrides the current Move and Hippo's own view of what comes next. The Move must do exactly what they asked, using everything already known about the business", CORRECTION: "the founder's constraints changed — the last Move no longer fits",
  DIRECTION: 'Hippo recommended this direction — first Move for it (do not ask the founder to choose anything)',
};

// ---------------------------------------------------------------- reading state
async function conversationFor(objectiveId: string) {
  return db.conversation.findFirst({ where: { objectiveId }, orderBy: { updatedAt: 'desc' } });
}
export const stateOf = (c: { state: unknown } | null): BusinessState => ({ ...emptyState(), ...((c?.state ?? {}) as Partial<BusinessState>) });

export async function currentMove(objectiveId: string) {
  return db.move.findFirst({ where: { objectiveId, status: { in: [...CURRENT_STATUSES] } }, orderBy: { createdAt: 'desc' } });
}

async function beliefsFor(organizationId: string, objectiveId: string) {
  const rows = await db.businessMemory.findMany({ where: { organizationId, objectiveId, kind: 'BELIEF' }, orderBy: { occurredAt: 'desc' }, take: 8 });
  return rows.map((r) => ({ key: (r.refId || '').split(':').pop() || r.id, statement: r.title, confidence: r.confidence || 'LOW', evidence: r.detail.split('\nDisproved if:')[0] }));
}

/** Everything the Move engine is allowed to reason from — structured, never a vague "what next?". */
export async function moveContext(objectiveId: string, reason: MoveReason, opts: { instruction?: string; blockedRoutes?: string[] } = {}): Promise<{ ctx: MoveContext; objective: { id: string; organizationId: string; text: string; auditId: string | null; companyName: string | null } }> {
  const objective = await db.objective.findUniqueOrThrow({ where: { id: objectiveId }, select: { id: true, organizationId: true, text: true, auditId: true, companyName: true } });
  const conv = await conversationFor(objectiveId);
  const s = stateOf(conv);
  const [history, outcomes, beliefs, said] = await Promise.all([
    // The most recent 12 (oldest first): what just happened must always be in view. Evidence reported before any Move counts too.
    db.move.findMany({ where: { objectiveId }, orderBy: { createdAt: 'desc' }, take: 12 }).then((r) => r.reverse()),
    db.outcome.findMany({ where: { objectiveId, AND: [{ OR: [{ moveId: { not: null } }, { source: 'FOUNDER_REPORTED' }] }, { OR: [{ external: null }, { external: true }] }] }, orderBy: { createdAt: 'desc' }, take: 12 }).then((r) => r.reverse()),
    beliefsFor(objective.organizationId, objectiveId),
    // The founder's own recent words (business context the extracted fields can't hold: who, how it's funded, who's ready).
    conv ? db.conversationMessage.findMany({ where: { conversationId: conv.id, role: 'FOUNDER' }, orderBy: { createdAt: 'desc' }, take: 12, select: { text: true } }) : Promise.resolve([]),
  ]);
  const founderWords = said.reverse().map((m) => m.text.trim()).filter((t) => t.length > 12).map((t) => t.slice(0, 300));
  const negative = new Set(outcomes.filter((o) => o.polarity === 'NEGATIVE').map((o) => o.moveId));
  let research: string | undefined;
  if (objective.auditId) {
    const audit = await db.audit.findUnique({ where: { id: objective.auditId }, select: { status: true } });
    const r = audit?.status === 'completed' ? (await getResearch(objective.auditId)) as ResearchRecord | null : null;
    if (r) research = researchBrief(r);
  }
  const ctx: MoveContext = {
    objective: s.objective?.value || objective.text, target: s.target?.value, today: s.current_state?.value,
    constraints: [...s.constraints, ...(s.lastInstruction && reason !== 'INSTRUCTION' ? [`the founder's latest explicit instruction (still applies unless they said otherwise): "${s.lastInstruction}"`] : [])], knownFacts: s.known_facts.map((f) => ({ key: f.key, quote: f.quote })), unknowns: s.unknowns, preferences: s.founder_preferences,
    profile: s.profile || {}, capacity: s.capacity || emptyCapacity(), beliefs,
    history: history.map((h) => ({ title: h.title, kind: h.kind, routeKey: h.routeKey, status: h.status, closeReason: h.closeReason, negative: negative.has(h.id) })),
    signals: outcomes.map((o) => ({ summary: o.summary, polarity: o.polarity || 'NEUTRAL', source: o.source || 'FOUNDER_REPORTED', at: o.createdAt.toISOString(), rung: o.rung ?? undefined })),
    founderWords, reason: REASON_TEXT[reason], reasonCode: reason, instruction: opts.instruction, blockedRoutes: opts.blockedRoutes || [], research, company: objective.companyName,
  };
  return { ctx, objective };
}

// ---------------------------------------------------------------- planning (model proposes, rules decide)
export async function proposeMove(ctx: MoveContext, usage: Parameters<typeof generateJson>[4]): Promise<{ move: ProposedMove; reasons: string[]; fallback: boolean; problems: string[] }> {
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await generateJson<unknown>('move', movePrompt(ctx, problems), MOVE_SCHEMA, {}, usage);
      const m = normaliseMove(r.data);
      if (!m) { problems = ['UNUSABLE: return a complete move object.']; continue; }
      const v = validateMove(m, ctx);
      if (v.ok) return { move: m, reasons: v.consequentialReasons, fallback: false, problems };
      problems = v.problems;
    } catch (e) {
      if (isBudgetRefusal(e)) throw e;
      console.error(JSON.stringify({ event: 'move_plan_failed', attempt, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      break;
    }
  }
  const f = fallbackMove(ctx);
  return { move: f, reasons: validateMove(f, ctx).consequentialReasons, fallback: true, problems };
}

async function upsertBelief(organizationId: string, objectiveId: string, b: ProposedMove['beliefs'][number]) {
  const refId = `${objectiveId}:${b.key}`;
  const data = { title: b.statement, detail: `${b.evidence || 'No evidence yet.'}\nDisproved if: ${b.disprovedIf || 'not stated'}`, confidence: b.confidence, status: b.confidence === 'HIGH' ? 'INFERENCE' : 'HYPOTHESIS', occurredAt: new Date() };
  const existing = await db.businessMemory.findFirst({ where: { organizationId, refType: 'belief', refId } });
  if (existing) await db.businessMemory.update({ where: { id: existing.id }, data });
  else await db.businessMemory.create({ data: { organizationId, objectiveId, kind: 'BELIEF', owner: 'Hippo', source: 'Hippo (working belief)', refType: 'belief', refId, ...data } });
}

/** Persists a planned Move as the ONE current Move (older current Moves are closed in the same transaction). */
export async function saveMove(objective: { id: string; organizationId: string }, planned: { move: ProposedMove; reasons: string[] }, meta: { reason: MoveReason; previousMoveId?: string | null; conversationId?: string | null }) {
  const m = planned.move;
  const prepare = m.artifactType === 'DOCUMENT' || m.artifactType === 'PUBLIC_PAGE';
  const created = await db.$transaction(async (tx) => {
    const open = await tx.move.findMany({ where: { objectiveId: objective.id, status: { in: [...CURRENT_STATUSES] } } });
    for (const o of open) {
      await tx.move.update({ where: { id: o.id }, data: { status: ['LIVE', 'SIGNALLED'].includes(o.status) ? 'DONE' : 'SUPERSEDED', closeReason: o.closeReason || `replaced (${meta.reason.toLowerCase()})` } });
    }
    return tx.move.create({ data: {
      organizationId: objective.organizationId, objectiveId: objective.id, conversationId: meta.conversationId ?? null,
      kind: m.kind, owner: m.owner, title: m.title, why: m.why, bet: m.bet, hippoWill: m.hippoWill, needs: json(m.needs),
      costInr: m.artifactType === 'DEEP_RESEARCH' ? DEEP_RESEARCH_PRICE_INR : m.costInr, costBasis: m.artifactType === 'DEEP_RESEARCH' ? 'one-time price of the full analysis' : m.costBasis,
      expectedSignal: m.expectedSignal, artifactType: m.artifactType, artifactBrief: m.artifactBrief, alternative: m.alternative ? json(m.alternative) : undefined,
      routeKey: m.routeKey, consequential: planned.reasons.length > 0, consequentialReasons: json(planned.reasons),
      status: prepare ? 'PREPARING' : 'PROPOSED', rung: 1, reason: meta.reason, previousMoveId: meta.previousMoveId ?? null, reply: m.reply,
    } });
  });
  for (const b of m.beliefs) await upsertBelief(objective.organizationId, objective.id, b);
  await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, type: 'MOVE_PROPOSED', actor: 'Hippo', message: `Next move: ${m.title}`.slice(0, 400) });
  return created;
}

async function hippoSays(objectiveId: string, text: string, kind: string, extra: Record<string, unknown> = {}) {
  const conv = await conversationFor(objectiveId);
  if (!conv || !text.trim()) return;
  await db.conversationMessage.create({ data: { conversationId: conv.id, role: 'HIPPO', text: text.trim().slice(0, 1200), meta: json({ kind, ...extra }) } });
  await db.conversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
}

// ---------------------------------------------------------------- preparing (Hippo never needs permission to prepare)
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'offer';
export const pageUrl = (slug: string) => `/p/${slug}`;

export async function prepareMove(moveId: string, usage: Parameters<typeof generateJson>[4]) {
  const move = await db.move.findUniqueOrThrow({ where: { id: moveId } });
  if (move.status !== 'PREPARING') return move;
  const { ctx } = await moveContext(move.objectiveId, 'NEXT');
  const write = (problems: string[] = []) => generateJson<unknown>('move-prepare', preparePrompt({ ...move, needs: move.needs as string[] }, ctx, problems), PREPARE_SCHEMA, {}, usage);
  const claimsIn = (p: Prepared) => inventedClaims([p.markdown, p.page?.headline, p.page?.subhead, p.page?.body].filter(Boolean).join('\n'), ctx.profile, ctx.capacity);
  let r = await write();
  let prepared = normalisePrepared(r.data, move.artifactType);
  if (!prepared) throw new Error('MOVE_PREPARE_INVALID: the prepared artifact was unusable');
  // The founder never claims experience, clients or a business they haven't told us about.
  const invented = claimsIn(prepared);
  if (invented.length) {
    r = await write(invented);
    prepared = normalisePrepared(r.data, move.artifactType) ?? prepared;
    const still = claimsIn(prepared);
    if (still.length) prepared = { ...prepared, markdown: stripClaims(prepared.markdown, still), ...(prepared.page ? { page: { ...prepared.page, body: stripClaims(prepared.page.body, still) } } : {}) };
  }
  let data: Prisma.MoveUpdateInput;
  if (move.artifactType === 'PUBLIC_PAGE' && prepared.page) {
    const slug = `${slugify(prepared.page.headline)}-${crypto.randomBytes(3).toString('hex')}`;
    const page = await db.publicPage.create({ data: { slug, organizationId: move.organizationId, objectiveId: move.objectiveId, moveId: move.id, status: 'DRAFT', ...prepared.page } });
    data = { publicPageId: page.id };
  } else {
    // A document Hippo prepared: kept as Work + Execution (existing machinery). Prepared ≠ completed.
    const work = await db.work.create({ data: { organizationId: move.organizationId, objectiveId: move.objectiveId, title: prepared.title.slice(0, 160), description: move.why, deliverable: move.artifactBrief || prepared.title, capability: 'strategy', status: 'READY', executionMode: 'AI', aiExecutable: true } });
    await db.execution.create({ data: { workId: work.id, mode: 'AI', status: 'PREPARED', provider: r.provider, model: r.model, input: json({ moveId: move.id }), output: `> Prepared by Hippo (AI). Check it before you use it.\n\n${prepared.markdown}`, outputSummary: prepared.title, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costInr: r.costInr, completedAt: new Date() } });
    data = { workId: work.id };
  }
  const updated = await db.move.update({ where: { id: move.id }, data: { ...data, status: 'READY', rung: 2 } });
  // Authorized while it was being prepared (e.g. "yes, publish it"): carry it out now.
  if (updated.authorizedAt && updated.artifactType === 'PUBLIC_PAGE') return publishMove(updated.id);
  return updated;
}

// ---------------------------------------------------------------- the background job: PLAN → PREPARE
type MoveJobState = { reason: MoveReason; instruction?: string; blockedRoutes?: string[]; fromMoveId?: string | null; moveId?: string; intro?: string; outro?: string } | null;

/** The first Move in Hippo's words: what we're doing, what Hippo does, what the founder does, what we're watching for. */
export function moveTurnText(m: { title: string; hippoWill: string; needs: string[]; expectedSignal: string }, intro?: string, outro?: string) {
  const block = `Here's our first move: ${m.title.replace(/\.$/, '')}.\nWhat I'll do: ${m.hippoWill.replace(/\.$/, '')}.${m.needs.length ? `\nWhat I need from you: ${m.needs.map((n) => n.replace(/\.$/, '')).join('; ')}.` : ''}\nWhat we're watching for: ${m.expectedSignal.replace(/\.$/, '')}.`;
  return [intro, block, outro].filter(Boolean).join('\n\n');
}
const usageOf = (job: Job, objective: { organizationId: string; id: string }) => ({ userId: job.userId, organizationId: objective.organizationId, objectiveId: objective.id, parentType: 'JOB' as const, parentId: job.budgetScopeId, budget: policyOf(job) });
const policyOf = (job: Job) => ({ scope: { type: 'JOB' as const, id: job.budgetScopeId }, includedInr: job.budgetInr, warningInr: job.budgetInr * 0.9, nearLimitInr: job.budgetInr * 0.95, perCallInr: callCeilingInr(), canAskFounder: false });

const handler: JobHandler = {
  minStepMs: () => 20_000,
  policy: policyOf,
  async step({ job, workerId }): Promise<StepResult> {
    const st = (job.state ?? null) as MoveJobState;
    const objectiveId = (job.subjectId || '').split(':')[0];
    const objective = await db.objective.findFirst({ where: { id: objectiveId, organization: { founder: { userId: job.userId } } }, select: { id: true, organizationId: true } });
    if (!objective || !st) throw new Error('JOB_INVALID: move request without an owned objective');
    if (!st.moveId) {
      const { ctx } = await moveContext(objective.id, st.reason, { instruction: st.instruction, blockedRoutes: st.blockedRoutes });
      const planned = await proposeMove(ctx, usageOf(job, objective));
      await renewLease(job, workerId);
      const conv = await conversationFor(objective.id);
      const saved = await saveMove(objective, planned, { reason: st.reason, previousMoveId: st.fromMoveId, conversationId: conv?.id });
      // After a recommendation, one coherent turn: the recommendation and its first Move together (no second hand-off message).
      const text = st.intro ? moveTurnText(planned.move, st.intro, st.outro) : planned.move.reply || `Here's what I think we should do next: ${planned.move.title}.`;
      await hippoSays(objective.id, text, st.intro ? 'DIRECTIONS' : 'MOVE', { moveId: saved.id });
      return { checkpoint: 'PLANNED', progress: 'ANALYSING', state: json({ ...st, moveId: saved.id }) };
    }
    const move = await db.move.findUnique({ where: { id: st.moveId } });
    if (move?.status === 'PREPARING') { await renewLease(job, workerId); await prepareMove(move.id, usageOf(job, objective)); }
    return { done: true };
  },
  async onStatus(job, status) {
    if (status !== 'FAILED') return;
    const st = (job.state ?? null) as MoveJobState;
    const objectiveId = (job.subjectId || '').split(':')[0];
    if (st?.moveId) {
      await db.move.updateMany({ where: { id: st.moveId, status: 'PREPARING' }, data: { status: 'PROPOSED' } });
      await hippoSays(objectiveId, "I couldn't finish preparing that just now. Say \"help me\" and I'll have another go.", 'MOVE_ERROR');
    } else await hippoSays(objectiveId, `${st?.intro ? `${st.intro}\n\n` : ''}I couldn't set up the ${st?.intro ? 'first step' : 'next move'} just now. Say "what's next" and I'll try again.`, 'MOVE_ERROR');
  },
};
registerJobHandler(MOVE_JOB, handler);

/** The planning job currently working on this objective (at most one at a time). */
export async function activeMoveJob(objectiveId: string) {
  return db.job.findFirst({ where: { type: MOVE_JOB, subjectId: { startsWith: `${objectiveId}:` }, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } });
}

/** Asks Hippo for the next Move (background job, resumed from the founder's polls). Reuses an in-flight request. */
export async function requestMove(objective: { id: string; organizationId: string }, userId: string, reason: MoveReason, opts: { instruction?: string; blockedRoutes?: string[]; fromMoveId?: string | null; intro?: string; outro?: string } = {}) {
  const active = await activeMoveJob(objective.id);
  if (active) { await resumeIfDue(active, MOVE_RUN_MS); return active; }
  const id = crypto.randomUUID();
  const { job } = await enqueueJob({ type: MOVE_JOB, userId, organizationId: objective.organizationId, subjectType: 'MOVE_REQUEST', subjectId: `${objective.id}:${id}`, budgetScope: { type: 'JOB', id }, budgetInr: moveJobBudgetInr() });
  await db.job.update({ where: { id: job.id }, data: { state: json({ reason, instruction: opts.instruction, blockedRoutes: opts.blockedRoutes, fromMoveId: opts.fromMoveId ?? null, intro: opts.intro, outro: opts.outro }) } });
  await kickJob(job.id, Date.now(), MOVE_RUN_MS);
  return job;
}

// ---------------------------------------------------------------- founder actions on the current Move
export type MoveActor = { userId: string; founderId: string };
export async function ownedMove(moveId: string, founderId: string) {
  const move = await db.move.findFirst({ where: { id: moveId } });
  if (!move) throw new HttpError(404, 'Not found');
  const owned = await db.organization.count({ where: { id: move.organizationId, founderId } });
  if (!owned) throw new HttpError(404, 'Not found');
  return move;
}

async function ledger(move: { organizationId: string; objectiveId: string }, kind: 'DECISION' | 'OUTCOME' | 'WORK', title: string, detail: string, status: 'RECORD' | 'FOUNDER_STATED' | 'VERIFIED_FACT', refId: string, sourceUrl?: string) {
  await remember({ organizationId: move.organizationId, objectiveId: move.objectiveId, kind, title: title.slice(0, 300), detail, status, owner: status === 'VERIFIED_FACT' ? 'Hippo' : 'Founder', refType: 'move-ledger', refId, sourceUrl });
}

/** Founder authorization ("Yes"). Consequential Moves of a minor need a parent/guardian's OK. Public pages go live. */
export async function approveMove(moveId: string, actor: MoveActor, opts: { guardian?: boolean } = {}) {
  const move = await ownedMove(moveId, actor.founderId);
  if (!['PROPOSED', 'PREPARING', 'READY', 'PARKED'].includes(move.status)) throw new HttpError(409, 'This move is not waiting for a yes.');
  const reasons = move.consequentialReasons as string[];
  if (reasons.includes('MINOR') && !opts.guardian) throw new HttpError(409, 'A parent or guardian needs to OK this first.');
  const by = reasons.includes('MINOR') ? 'GUARDIAN' : 'FOUNDER';
  await db.move.update({ where: { id: move.id }, data: { authorizedBy: by, authorizedAt: new Date(), ...(move.status === 'PARKED' ? { status: move.publicPageId || move.workId ? 'READY' : 'PROPOSED' } : {}) } });
  if (move.consequential) await ledger(move, 'DECISION', `${by === 'GUARDIAN' ? 'Parent/guardian' : 'You'} approved: ${move.title}`, `Needed an OK because ${reasons.map((r) => CONSEQUENCE_LABEL[r] || r).join(', ')}.`, 'FOUNDER_STATED', `${move.id}:approved`);
  if (move.artifactType === 'PUBLIC_PAGE' && move.status === 'READY') return publishMove(move.id);
  if (move.status === 'PREPARING') return db.move.findUniqueOrThrow({ where: { id: move.id } }); // goes live when ready
  return db.move.update({ where: { id: move.id }, data: { status: 'APPROVED' } });
}

/** The native public surface goes live: something has left the building, observed by Hippo itself. */
export async function publishMove(moveId: string) {
  const move = await db.move.findUniqueOrThrow({ where: { id: moveId } });
  if (!move.publicPageId || !move.authorizedAt) throw new HttpError(409, 'This page has not been approved yet.');
  const page = await db.publicPage.update({ where: { id: move.publicPageId }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
  const updated = await db.move.update({ where: { id: move.id }, data: { status: 'LIVE', rung: 3, actedAt: new Date(), proof: pageUrl(page.slug), proofSource: 'SYSTEM_VERIFIED' } });
  await ledger(move, 'WORK', `Live: ${page.headline}`, `Public page ${pageUrl(page.slug)} is live.`, 'VERIFIED_FACT', `${move.id}:live`, pageUrl(page.slug));
  await logActivity({ organizationId: move.organizationId, objectiveId: move.objectiveId, type: 'MOVE_LIVE', actor: 'Hippo', message: `Page live: ${pageUrl(page.slug)}` });
  return updated;
}

/** "I did it" — the founder performed the external step. Founder-reported unless they attach proof. */
export async function markActed(moveId: string, actor: MoveActor, proof?: string) {
  const move = await ownedMove(moveId, actor.founderId);
  if (!['PROPOSED', 'READY', 'APPROVED', 'PARKED'].includes(move.status)) throw new HttpError(409, 'This move is not waiting to be done.');
  const source = proof ? 'FOUNDER_LINK' : 'FOUNDER_REPORTED';
  const updated = await db.move.update({ where: { id: move.id }, data: { status: 'LIVE', rung: Math.max(3, move.rung), actedAt: new Date(), proof: proof ?? null, proofSource: source } });
  await ledger(move, 'WORK', `Done: ${move.title}`, proof ? `Proof: ${proof}` : 'You reported it (no proof attached).', 'FOUNDER_STATED', `${move.id}:acted`, proof);
  return updated;
}

/** A response from the world. Founder-reported or seen by Hippo; updates the Move and the conversation's state. */
export async function recordSignal(moveId: string, s: { summary: string; polarity: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; rung: 4 | 5; source: 'FOUNDER_REPORTED' | 'SYSTEM_OBSERVED'; proof?: string; external?: boolean }) {
  const move = await db.move.findUniqueOrThrow({ where: { id: moveId } });
  const outcome = await db.outcome.create({ data: { objectiveId: move.objectiveId, summary: s.summary.slice(0, 2000), metrics: json([]), recordedBy: s.source === 'SYSTEM_OBSERVED' ? 'System' : 'Founder', moveId: move.id, rung: s.rung, source: s.source, polarity: s.polarity, proof: s.proof ?? null, external: s.external ?? null } });
  if (s.external === false) return outcome; // the founder's own test: kept for the record, never counted as the world answering
  // A response implies the step happened; without proof it stays founder-reported.
  await db.move.update({ where: { id: move.id }, data: { status: ['SUPERSEDED', 'DONE', 'FAILED', 'DECLINED'].includes(move.status) ? move.status : 'SIGNALLED', rung: Math.max(move.rung, s.rung), ...(move.actedAt ? {} : { actedAt: new Date(), proofSource: 'FOUNDER_REPORTED' }) } });
  await ledger(move, 'OUTCOME', s.summary, `${s.source === 'SYSTEM_OBSERVED' ? 'Seen by Hippo' : 'You reported'}${s.proof ? ` · proof: ${s.proof}` : ''}`, s.source === 'SYSTEM_OBSERVED' ? 'VERIFIED_FACT' : 'FOUNDER_STATED', `signal:${outcome.id}`, s.proof);
  const conv = await conversationFor(move.objectiveId);
  if (conv) {
    const st = stateOf(conv);
    st.signals = [...(st.signals || []), { summary: s.summary.slice(0, 300), polarity: s.polarity, source: s.source, at: new Date().toISOString(), moveId: move.id }].slice(-12);
    await db.conversation.update({ where: { id: conv.id }, data: { state: json(st) } });
  }
  return outcome;
}

/** Evidence the founder reported before there was a Move ("I talked to 3 women, they said …"): kept as founder-reported
 *  signals of this business and in the Ledger, so the first Move starts from it instead of rediscovering it. */
export async function recordEarlyEvidence(objective: { id: string; organizationId: string }, items: { summary: string; polarity: string }[]) {
  for (const e of items) {
    const outcome = await db.outcome.create({ data: { objectiveId: objective.id, summary: e.summary.slice(0, 2000), metrics: json([]), recordedBy: 'Founder', rung: 4, source: 'FOUNDER_REPORTED', polarity: e.polarity, moveId: null } });
    await ledger({ organizationId: objective.organizationId, objectiveId: objective.id }, 'OUTCOME', e.summary, 'You reported', 'FOUNDER_STATED', `signal:${outcome.id}`);
  }
}

/** Parks the Move ("not now") or brings it back. */
export async function parkMove(moveId: string, actor: MoveActor, park: boolean) {
  const move = await ownedMove(moveId, actor.founderId);
  if (park) return db.move.update({ where: { id: move.id }, data: { status: 'PARKED' } });
  return db.move.update({ where: { id: move.id }, data: { status: move.publicPageId || move.workId ? 'READY' : move.authorizedAt ? 'APPROVED' : 'PROPOSED' } });
}

/** Closes the current Move for an escape route and asks for a new route to the same objective. */
export async function rerouteMove(moveId: string, actor: MoveActor & { userId: string }, how: 'CANT' | 'ANOTHER_WAY' | 'FAILED' | 'HELP' | 'CHANGE' | 'NEXT' | 'SIGNAL' | 'CORRECTION', text?: string) {
  const move = await ownedMove(moveId, actor.founderId);
  if (how === 'CANT') {
    const conv = await conversationFor(move.objectiveId);
    if (conv && text) {
      const st = stateOf(conv);
      const read = readFounderSignals(text).capacity.avoid ?? [];
      st.capacity = mergeCapacity(st.capacity, { avoid: read.length ? read : [`do this: ${move.title}`] });
      await db.conversation.update({ where: { id: conv.id }, data: { state: json(st) } });
    }
    await db.move.update({ where: { id: move.id }, data: { status: 'DECLINED', closeReason: `founder can't or won't${text ? `: ${text.slice(0, 160)}` : ''}` } });
    await ledger(move, 'DECISION', `You chose not to: ${move.title}`, text || '', 'FOUNDER_STATED', `${move.id}:declined`);
  } else if (how === 'FAILED') {
    await recordSignal(move.id, { summary: text?.trim() || `This didn't work: ${move.title}`, polarity: 'NEGATIVE', rung: 4, source: 'FOUNDER_REPORTED' });
    await db.move.update({ where: { id: move.id }, data: { status: 'FAILED', closeReason: 'founder said it failed' } });
  } else if (how === 'ANOTHER_WAY') {
    await db.move.update({ where: { id: move.id }, data: { status: 'SUPERSEDED', closeReason: 'founder asked for another way' } });
  }
  const blocked = ['CANT', 'ANOTHER_WAY', 'FAILED'].includes(how) ? [move.routeKey] : [];
  const reason: MoveReason = how === 'NEXT' ? 'NEXT' : how;
  const instruction = how === 'HELP' ? `Make this easier: "${move.title}". ${text || ''}`.trim() : text;
  return requestMove({ id: move.objectiveId, organizationId: move.organizationId }, actor.userId, reason, { instruction, blockedRoutes: blocked, fromMoveId: move.id });
}

/** "Why?" — the reasoning and the evidence closest to it, in plain words. Deeper evidence lives behind the objective page. */
export async function whyMove(moveId: string) {
  const move = await db.move.findUniqueOrThrow({ where: { id: moveId } });
  const beliefs = await beliefsFor(move.organizationId, move.objectiveId);
  const lines = [move.why, move.expectedSignal && `What this will tell us: ${move.expectedSignal}.`, ...beliefs.slice(0, 3).map((b) => `• ${b.statement}${b.evidence && !/^No evidence/.test(b.evidence) ? ` — ${b.evidence}` : ' — not tested yet'}`)].filter(Boolean);
  return lines.join('\n');
}

// ---------------------------------------------------------------- the native public surface: responses become signals
export async function recordPublicResponse(slug: string, input: { name?: string; contact: string; message?: string }, opts: { ipHash?: string; viewerUserId?: string | null }) {
  const page = await db.publicPage.findUnique({ where: { slug } });
  if (!page || page.status !== 'PUBLISHED') throw new HttpError(404, 'This page is not available.');
  const owner = opts.viewerUserId ? await db.organization.count({ where: { id: page.organizationId, founder: { userId: opts.viewerUserId } } }) > 0 : false;
  await db.publicResponse.create({ data: { pageId: page.id, name: input.name?.slice(0, 100) || null, contact: input.contact.slice(0, 200), message: input.message?.slice(0, 1000) || null, ipHash: opts.ipHash ?? null, fromOwner: owner } });
  const who = input.name?.trim() ? input.name.trim().split(/\s+/)[0] : 'Someone';
  const summary = owner ? `Test response from you on "${page.headline}"` : `${who} responded on your page "${page.headline}"${input.message?.trim() ? `: “${input.message.trim().slice(0, 140)}”` : ''}`;
  await recordSignal(page.moveId, { summary, polarity: 'POSITIVE', rung: 4, source: 'SYSTEM_OBSERVED', proof: pageUrl(page.slug), external: !owner });
  await hippoSays(page.objectiveId, owner ? "That was you testing your page — it works. I won't count it as a real response." : `${summary}. That's a real person responding. Say "what's next" when you want to build on it — or wait for a few more.`, owner ? 'SIGNAL_TEST' : 'SIGNAL');
  return { ok: true };
}

/** The Ledger: only what really happened (actions, signals, OKs), each saying who saw it — plus the milestones that
 *  matter: first action, first signal, first outcome Hippo verified, first payment from a stranger. */
export async function ledgerFor(organizationId: string) {
  const [entries, moves, outcomes, firstObjective] = await Promise.all([
    db.businessMemory.findMany({ where: { organizationId, refType: 'move-ledger' }, orderBy: { occurredAt: 'desc' }, take: 200 }),
    db.move.findMany({ where: { organizationId, actedAt: { not: null } }, orderBy: { actedAt: 'asc' }, take: 1, select: { actedAt: true, title: true } }),
    db.outcome.findMany({ where: { objective: { organizationId }, moveId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, summary: true, source: true, external: true, rung: true } }),
    db.objective.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const external = outcomes.filter((o) => o.external !== false);
  const verified = external.find((o) => o.source === 'SYSTEM_OBSERVED');
  const paid = external.find((o) => o.source === 'SYSTEM_OBSERVED' && o.rung === 5); // V1 takes no payments: stays empty
  const start = firstObjective?.createdAt ?? null;
  const since = (d?: Date | null) => (d && start ? Math.max(0, d.getTime() - start.getTime()) : null);
  return {
    entries: entries.map((e) => ({ id: e.id, kind: e.kind, title: e.title, detail: e.detail, at: e.occurredAt, seenBy: e.status === 'VERIFIED_FACT' ? 'HIPPO' as const : 'FOUNDER' as const, sourceUrl: e.sourceUrl })),
    milestones: {
      firstAction: moves[0]?.actedAt ?? null,
      firstSignal: external[0]?.createdAt ?? null,
      firstVerified: verified?.createdAt ?? null,
      firstStrangerPayment: paid?.createdAt ?? null,
      msToFirstExternalSignal: since(external[0]?.createdAt),
    },
  };
}
