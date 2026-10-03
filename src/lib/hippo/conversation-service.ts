// I/O around the Hippo conversation: persistence (survives refresh/navigation), the metered model turn, the handoff
// into the existing pipeline, and Hippo's plain-words explanation once research is back.
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { applyTurn, emptyState, handoffText, isApproval, isStop, OPENING, parseModelTurn, turnPrompt, TURN_SCHEMA, type BusinessState, type ModelTurn, type Phase, type Status } from './conversation';
import { aiMeta, generateJson } from './gateway';
import { parseReport } from './aristotle';
import { getResearch } from '../audit-meta';
import type { ResearchRecord } from '../evidence';
import { createObjective } from './service';
import { stableId } from './context';
import { movesEnabled } from './moves';
import { MOVES_OPENING, movesState, postMoveMessage, type MoveView } from './conversation-moves';

const json = (v: unknown) => v as Prisma.InputJsonValue;
type Ctx = { user: { id: string }; founder: { id: string; name: string | null }; org: { id: string; name?: string; isDemo?: boolean } };

export type ConversationView = {
  id: string | null; phase: Phase; status: Status; state: BusinessState; objectiveId: string | null; auditId: string | null;
  messages: { id: string; role: 'HIPPO' | 'FOUNDER'; text: string; at: string; kind?: string }[];
  // Moves (HIPPO_MOVES=on): the one current Move pinned on the table, whether Hippo is still working, quick replies.
  moves?: boolean; move?: MoveView | null; thinking?: boolean; quick?: string[];
};

const opening = (): ConversationView['messages'][number] => ({ id: 'opening', role: 'HIPPO', text: movesEnabled() ? MOVES_OPENING : OPENING, at: new Date(0).toISOString() });

/** The founder's current conversation (latest not archived), or null. Owner-scoped: only this user's rows. */
async function current(userId: string) {
  return db.conversation.findFirst({ where: { userId, status: { not: 'ARCHIVED' } }, orderBy: { updatedAt: 'desc' } });
}

export async function viewConversation(userId: string | null): Promise<ConversationView> {
  const conv = userId ? await current(userId) : null;
  if (!conv) return { id: null, phase: 'DISCOVER', status: 'ACTIVE', state: emptyState(), objectiveId: null, auditId: null, messages: [opening()], ...(movesEnabled() ? { moves: true, move: null, thinking: false, quick: [] } : {}) };
  const moves = movesEnabled() ? { moves: true, ...(await movesState(conv.phase === 'MOVING' ? conv.objectiveId : null, { ...emptyState(), ...(conv.state as Partial<BusinessState>) })) } : {};
  if (!movesEnabled()) await explainResultIfReady(conv);
  const msgs = await db.conversationMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'asc' } });
  const objective = conv.objectiveId ? await db.objective.findUnique({ where: { id: conv.objectiveId }, select: { auditId: true } }) : null;
  return {
    id: conv.id, phase: conv.phase as Phase, status: conv.status as Status, state: conv.state as unknown as BusinessState, objectiveId: conv.objectiveId, auditId: objective?.auditId ?? null,
    messages: [opening(), ...msgs.map((m) => ({ id: m.id, role: m.role as 'HIPPO' | 'FOUNDER', text: m.text, at: m.createdAt.toISOString(), kind: (m.meta as { kind?: string } | null)?.kind }))],
    ...moves,
  };
}

/** One founder message → one Hippo reply (and, only on explicit approval of a proposal, the handoff). */
export async function postMessage(ctx: Ctx, text: string): Promise<ConversationView> {
  let conv = await current(ctx.user.id);
  if (!conv) conv = await db.conversation.create({ data: { userId: ctx.user.id, state: json(emptyState()) } });
  if (movesEnabled()) { await postMoveMessage(ctx, conv, text); return viewConversation(ctx.user.id); }
  const state = conv.state as unknown as BusinessState;
  const phase = conv.phase as Phase;
  await db.conversationMessage.create({ data: { conversationId: conv.id, role: 'FOUNDER', text } });

  // Stop and approval are decided without a model call (cheap, deterministic, never misread by a model).
  let ai: ModelTurn | null = null;
  if (!isStop(text) && !(phase === 'PROPOSED' && isApproval(text))) {
    const history = (await db.conversationMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'desc' }, take: 11 })).reverse().slice(0, -1);
    try {
      const r = await generateJson<unknown>('converse', turnPrompt(state, phase, [{ role: 'HIPPO', text: OPENING }, ...history], text), TURN_SCHEMA, {},
        { userId: ctx.user.id, founderId: ctx.founder.id, organizationId: ctx.org.id, parentType: 'REQUEST' });
      ai = parseModelTurn(r.data);
      console.log(JSON.stringify({ event: 'hippo_turn', conversationId: conv.id, ...aiMeta(r) }));
    } catch (e) {
      // Budget refusal, rate cap, provider outage or no key: Hippo still answers deterministically (no invention).
      console.error(JSON.stringify({ event: 'hippo_turn_fallback', conversationId: conv.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
  }
  const r = applyTurn(state, phase, conv.status as Status, text, ai);
  let objectiveId = conv.objectiveId;
  let reply = r.reply;
  let meta: Record<string, unknown> = { intent: r.intent };
  let nextPhase = r.phase; let nextStatus = r.status;
  if (r.handoff) {
    try {
      // The existing pipeline: objective + understanding + Aristotle audit (research starts after the ₹99 scope step).
      const created = await createObjective(ctx, { text: handoffText(r.state), mode: 'IDEA' });
      objectiveId = created.objectiveId;
      meta = { ...meta, kind: 'HANDOFF', objectiveId: created.objectiveId, auditId: created.auditId };
    } catch (e) {
      console.error(JSON.stringify({ event: 'hippo_handoff_failed', conversationId: conv.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      reply = "Hmm, I couldn't start that just now. Nothing was charged. Say \"dig in\" again in a moment and I'll retry.";
      nextPhase = 'PROPOSED'; nextStatus = 'ACTIVE';
    }
  }
  await db.conversationMessage.create({ data: { conversationId: conv.id, role: 'HIPPO', text: reply, meta: json(meta) } });
  await db.conversation.update({ where: { id: conv.id }, data: { state: json(r.state), phase: nextPhase, status: nextStatus, objectiveId } });
  return viewConversation(ctx.user.id);
}

/** Archives the current conversation (founder starts over). Nothing is deleted. */
export async function newConversation(userId: string) {
  await db.conversation.updateMany({ where: { userId, status: { not: 'ARCHIVED' } }, data: { status: 'ARCHIVED' } });
  return viewConversation(userId);
}

/**
 * When the handed-off research is complete, Hippo says what came back — once, in plain words, from the validated
 * report (deterministic: no extra model call) — and points to the full analysis.
 */
async function explainResultIfReady(conv: { id: string; objectiveId: string | null }) {
  if (!conv.objectiveId) return;
  const objective = await db.objective.findUnique({ where: { id: conv.objectiveId }, select: { id: true, auditId: true } });
  if (!objective?.auditId) return;
  const audit = await db.audit.findUnique({ where: { id: objective.auditId }, select: { status: true, report: true, paymentStatus: true } });
  if (!audit || audit.status !== 'completed' || audit.paymentStatus !== 'paid') return;
  const report = parseReport(audit.report);
  if (!report) return;
  const id = stableId('hres', conv.id, objective.id); // one explanation per handed-off objective, even on concurrent loads
  if (await db.conversationMessage.findUnique({ where: { id } })) return;
  const research = (await getResearch(objective.auditId)) as ResearchRecord | null;
  const coverage = researchCoverage(research, report.pathways?.pathways?.length ?? 0);
  const text = `The research is back. Short version: ${report.oneLineVerdict || report.verdict}\n\n${report.verdict && report.verdict !== report.oneLineVerdict ? `${report.verdict}\n\n` : ''}${coverage ? `${coverage}\n\n` : ''}The full analysis — evidence, sources and the possible routes — is on your objective page. Tell me what you think, or ask me to challenge any of it.`;
  await db.conversationMessage.createMany({ skipDuplicates: true, data: [{ id, conversationId: conv.id, role: 'HIPPO', text, meta: json({ kind: 'RESULT', objectiveId: objective.id }) }] });
  await db.conversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
}

/**
 * One honest line on what research established, in Hippo's voice — never a list of "no evidence found". Questions it
 * could not settle are summarised once; the objective page shows, per question, what was checked, the closest evidence,
 * what it implies and the cheapest way to find out.
 */
export function researchCoverage(r: ResearchRecord | null, pathways: number): string {
  const qs = r?.questions || [];
  if (!qs.length) return '';
  const n = (s: string[]) => qs.filter((q) => s.includes(q.status)).length;
  const answered = n(['ANSWERED']); const partly = n(['PARTIAL', 'CONTRADICTORY']); const analogous = n(['ANALOGOUS']); const open = n(['NOT_FOUND', 'SEARCH_FAILED']);
  const parts = [`${answered} of ${qs.length} questions answered from direct evidence`];
  if (partly) parts.push(`${partly} partly`);
  if (analogous) parts.push(`${analogous} only from comparable cases elsewhere`);
  if (open) parts.push(`${open} I couldn’t establish from public evidence even after widening the search`);
  const gaps = partly + analogous + open;
  return `I looked into ${qs.length} questions: ${parts.join(', ')}.${gaps ? ' For each gap I’ve noted what I checked, the closest evidence, and the cheapest way to find out.' : ''}${pathways ? ` I’ve laid out ${pathways} different pathways for you to choose between.` : ''}`;
}
