// Identity, authorisation and the organisation's operating record (activity + business memory).
// Every Hippoturtle read/write goes through these helpers so a founder can only reach their own organisation.
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { createSession, getCurrentUser } from '../session';
import type { MemoryKind, TruthStatus } from './types';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Postgres unique-constraint violation surfaced by Prisma. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === 'P2002';

/**
 * Concurrency-safe upsert. Prisma's upsert on a compound unique key is "find, then create or update", so two
 * requests can both miss the row and both try to create it; the loser gets P2002. Retrying once is safe:
 * the row now exists, so the retry takes the update path.
 */
export async function upsertSafely<T>(op: () => Promise<T>): Promise<T> {
  try { return await op(); } catch (e) { if (!isUniqueViolation(e)) throw e; return op(); }
}

/** Deterministic primary key so concurrent inserts of the same logical row collide on the PK and are skipped. */
export const stableId = (prefix: string, ...parts: string[]) => `${prefix}_${crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 25)}`;

/** Current founder + organisation. With `create`, a first-time visitor gets an anonymous account (same auth as Aristotle). */
export async function getFounderContext(opts: { create?: boolean; name?: string } = {}) {
  let user = await getCurrentUser();
  if (!user) {
    if (!opts.create) return null;
    user = await db.user.create({ data: { name: opts.name || null } });
    await createSession(user.id);
  }
  let founder = await db.founder.findUnique({ where: { userId: user.id } });
  if (!founder) {
    if (!opts.create) return { user, founder: null, org: null };
    founder = await db.founder.create({ data: { userId: user.id, name: opts.name || user.name || null } });
  }
  // Which of the founder's organisations the dashboard (/company, /memory) shows:
  //  1. the live (non-demo) organisation once it holds a real objective — a demo org never shadows real work;
  //  2. otherwise the most recent organisation that holds an objective (a founder who has only tried the demo
  //     sees the demo, labelled as demo data, instead of an empty live org);
  //  3. otherwise the live organisation, then any organisation.
  // Creating a REAL objective never relies on this: createObjective() itself resolves (or creates) the live org.
  const mine = { founderId: founder.id };
  let org = await db.organization.findFirst({ where: { ...mine, isDemo: false, objectives: { some: {} } }, orderBy: { createdAt: 'asc' } })
    ?? await db.organization.findFirst({ where: { ...mine, objectives: { some: {} } }, orderBy: { createdAt: 'desc' } })
    ?? await db.organization.findFirst({ where: { ...mine, isDemo: false }, orderBy: { createdAt: 'asc' } })
    ?? await db.organization.findFirst({ where: mine, orderBy: { createdAt: 'asc' } });
  if (!org && opts.create) org = await db.organization.create({ data: { founderId: founder.id, name: 'My company' } });
  return { user, founder, org };
}

export async function requireFounder() {
  const ctx = await getFounderContext();
  if (!ctx?.founder || !ctx.org) throw new HttpError(401, 'Please start from the Hippoturtle home page.');
  return ctx as { user: NonNullable<typeof ctx.user>; founder: NonNullable<typeof ctx.founder>; org: NonNullable<typeof ctx.org> };
}

/** Objective owned by the current founder, or 404 (never reveals that another founder's objective exists). */
export async function requireObjective(id: string) {
  const ctx = await requireFounder();
  const objective = await db.objective.findFirst({ where: { id, organization: { founderId: ctx.founder.id } } });
  if (!objective) throw new HttpError(404, 'Objective not found');
  return { ...ctx, objective };
}

export async function requireWork(id: string) {
  const ctx = await requireFounder();
  const work = await db.work.findFirst({ where: { id, organization: { founderId: ctx.founder.id } } });
  if (!work) throw new HttpError(404, 'Work not found');
  const objective = await db.objective.findUniqueOrThrow({ where: { id: work.objectiveId } });
  return { ...ctx, work, objective };
}

export async function logActivity(a: { organizationId: string; objectiveId?: string | null; workId?: string | null; type: string; message: string; actor: string; meta?: Prisma.InputJsonValue }) {
  await db.activityLog.create({ data: { organizationId: a.organizationId, objectiveId: a.objectiveId ?? null, workId: a.workId ?? null, type: a.type, message: a.message.slice(0, 500), actor: a.actor, meta: a.meta } });
}

export type MemoryInput = {
  organizationId: string; objectiveId?: string | null; kind: MemoryKind; title: string; detail?: string; value?: string | null;
  status: TruthStatus; source?: string | null; sourceUrl?: string | null; owner: string; confidence?: string | null; refType?: string; refId?: string; occurredAt?: Date;
};

/** Structured business memory. Idempotent per (refType, refId) so syncs and retries never duplicate entries. */
export async function remember(m: MemoryInput) {
  const data = {
    organizationId: m.organizationId, objectiveId: m.objectiveId ?? null, kind: m.kind, title: m.title.slice(0, 300), detail: (m.detail || '').slice(0, 4000),
    value: m.value ?? null, status: m.status, source: m.source ?? null, sourceUrl: m.sourceUrl ?? null, owner: m.owner, confidence: m.confidence ?? null,
    refType: m.refType ?? null, refId: m.refId ?? null, occurredAt: m.occurredAt ?? new Date(),
  };
  if (!(m.refType && m.refId)) return db.businessMemory.create({ data });
  const where = { organizationId: m.organizationId, refType: m.refType, refId: m.refId };
  const existing = await db.businessMemory.findFirst({ where });
  if (existing) return existing;
  // Same (org, refType, refId) → same primary key, so a concurrent request inserting the same entry is skipped (ON CONFLICT DO NOTHING).
  const id = stableId('bm', m.organizationId, m.refType, m.refId);
  await db.businessMemory.createMany({ data: [{ id, ...data }], skipDuplicates: true });
  return (await db.businessMemory.findUnique({ where: { id } })) ?? db.businessMemory.findFirstOrThrow({ where });
}

/**
 * Memory brief for AI capabilities, grouped by provenance so a proposal can never read like a fact:
 * founder-stated / sourced facts first, then AI proposals and records, explicitly marked as NOT facts.
 */
export async function memoryBrief(organizationId: string, objectiveId: string, limit = 40): Promise<string> {
  const rows = await db.businessMemory.findMany({ where: { organizationId, objectiveId }, orderBy: { occurredAt: 'desc' }, take: limit });
  if (!rows.length) return 'No business memory yet.';
  const line = (r: (typeof rows)[number]) => `- ${r.kind}: ${r.title}${r.value ? ` = ${r.value}` : ''}${r.source ? ` (source: ${r.source})` : ''}`;
  const group = (title: string, pick: (r: (typeof rows)[number]) => boolean) => { const g = rows.filter(pick); return g.length ? `${title}\n${g.map(line).join('\n')}` : ''; };
  return [
    group('FOUNDER-STATED OR FOUNDER-APPROVED (may be treated as known):', (r) => r.status === 'FOUNDER_STATED'),
    group('SOURCED RESEARCH (known only as far as the source says):', (r) => r.status === 'VERIFIED_FACT'),
    group('AI PROPOSALS, HYPOTHESES, ASSUMPTIONS AND INFERENCES — NOT FACTS, never "known", never founder-approved:', (r) => ['ASSUMPTION', 'HYPOTHESIS', 'INFERENCE'].includes(r.status)),
    group('NOT YET ESTABLISHED:', (r) => r.status === 'UNKNOWN'),
    group('RECORDS OF DECISIONS AND WORK (what happened; any numbers inside them are not founder facts unless listed above):', (r) => r.status === 'RECORD'),
  ].filter(Boolean).join('\n\n');
}
