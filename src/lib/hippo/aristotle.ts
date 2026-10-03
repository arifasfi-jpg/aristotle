// Bridge between Hippoturtle and the existing Aristotle engine.
// Aristotle keeps its own audit record, ₹99 payment, research pipeline and evidence validation; Hippoturtle
// links an Objective to that audit and copies the finished, validated result into structured tables.
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import type { AuditReport, Sector } from '../audit';
import { getLockedFacts, getResearch } from '../audit-meta';
import type { EvidenceClaim, ResearchRecord } from '../evidence';
import { describeFact, extractFounderFacts, formatFactValue, type FounderFact } from '../founder-facts';
import type { UsageContext } from '../ai-usage';
import { aiMeta, generateJson } from './gateway';
import { isUniqueViolation, logActivity, remember, stableId, upsertSafely } from './context';
import { advanceTo, identityBlock, NOT_ESTABLISHED, type PathwaysResult, type Understanding } from './types';

// ---------------------------------------------------------------- UNDERSTAND
const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' }, target: { type: 'string' }, currentState: { type: 'string' }, keyQuestion: { type: 'string' },
    businessKind: { type: 'string', enum: ['NEW_IDEA', 'EXISTING_BUSINESS', 'UNCLEAR'] },
  },
  required: ['objective', 'target', 'currentState', 'keyQuestion', 'businessKind'],
};

export function understandPrompt(text: string, company: string | null = null): string {
  return `You are Hippoturtle, an organisation that helps founders build companies. Restate what this founder is trying to achieve.
${identityBlock(company)}
Rules:
- Use ONLY what the founder wrote. Do not add market data, prices or statistics.
- Keep the founder's ambition exactly: never lower or "correct" their target.
- target: the measurable target and deadline in the founder's words, or "Not stated yet".
- currentState: where they are today in their words (sales, channels, team), or "Not stated yet".
- keyQuestion: the single question that decides how to reach the target (one sentence, specific to this business).
- objective: one plain sentence.
FOUNDER WROTE:
"""${text}"""`;
}

/** Deterministic restatement from the founder's own numbers (used when AI is unavailable). Never invents anything. */
export function understandFromNumbers(text: string): Understanding {
  const { facts } = extractFounderFacts(text);
  const pick = (tf: string) => facts.filter((f) => f.timeframe === tf).map((f) => `${f.raw}${f.deadline ? ` by ${f.deadline}` : ''}`).join('; ');
  const target = pick('TARGET'); const current = pick('CURRENT');
  const first = text.split(/(?<=[.!?])\s+/)[0].trim();
  return {
    objective: first.slice(0, 300), target: target || 'Not stated yet', currentState: current || 'Not stated yet',
    keyQuestion: target && current ? `What would it take to move from ${current} to ${target}?` : 'What must be true for this to work, and what is the cheapest way to find out?',
    businessKind: current ? 'EXISTING_BUSINESS' : 'UNCLEAR', source: 'FOUNDER_NUMBERS',
  };
}

export async function understandObjective(text: string, company: string | null = null, usage?: UsageContext): Promise<{ understanding: Understanding; meta?: ReturnType<typeof aiMeta>; error?: string }> {
  try {
    const r = await generateJson<Omit<Understanding, 'source'>>('understand', understandPrompt(text, company), UNDERSTAND_SCHEMA, {}, usage);
    const d = r.data;
    const s = (v: unknown, max = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : 'Not stated yet');
    const kind = ['NEW_IDEA', 'EXISTING_BUSINESS', 'UNCLEAR'].includes(d.businessKind) ? d.businessKind : 'UNCLEAR';
    return { understanding: { objective: s(d.objective), target: s(d.target), currentState: s(d.currentState), keyQuestion: s(d.keyQuestion), businessKind: kind, source: 'AI' }, meta: aiMeta(r) };
  } catch (e) {
    return { understanding: understandFromNumbers(text), error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- AUDIT LINK
const SECTOR_RULES: [RegExp, Sector][] = [
  [/\b(saas|software|platform for businesses|b2b app|crm|erp)\b/i, 'B2B SaaS'],
  [/\b(quick commerce|q-?commerce|10[- ]minute|dark store)\b/i, 'Quick Commerce'],
  [/\b(loan|lending|credit|wallet|payments?|insurance|nbfc|fintech)\b/i, 'Fintech'],
  [/\b(clinic|hospital|health|glucometer|medical|pharma|diagnostic|doctor)/i, 'Healthtech'],
  [/\b(school|course|tuition|edtech|learning|student)/i, 'Edtech'],
  [/\b(marketplace|aggregator)\b/i, 'Marketplace'],
  [/\b(agency|consulting|services firm)\b/i, 'Digital Agency'],
  [/\b(manufactur|factory|plant)\w*/i, 'Manufacturing'],
  [/\b(d2c|brand|skincare|apparel|food|snacks?|beverage)\b/i, 'D2C / Consumer'],
];
export const inferSector = (text: string): Sector => SECTOR_RULES.find(([re]) => re.test(text))?.[1] ?? 'Other';

/** Creates the Aristotle audit for an objective (pending payment). Re-uses the existing audit when present. */
export async function ensureAudit(objective: { id: string; text: string; auditId: string | null; understanding: Prisma.JsonValue }, userId: string, founderName: string | null) {
  if (objective.auditId) {
    const a = await db.audit.findFirst({ where: { id: objective.auditId, userId } });
    if (a) return a;
  }
  const u = objective.understanding as Understanding | null;
  const audit = await db.audit.create({ data: {
    userId, idea: objective.text, sector: inferSector(objective.text), geography: 'India',
    stage: u?.businessKind === 'EXISTING_BUSINESS' ? 'Existing business' : 'Idea / pre-launch',
    founderName: founderName || null, reportLanguage: 'Simple English', assumptions: '[]', report: '{}', pricePaise: 9900, paymentStatus: 'pending',
  } });
  await db.objective.update({ where: { id: objective.id }, data: { auditId: audit.id } });
  return audit;
}

// ---------------------------------------------------------------- SYNC (deterministic)
const CLAIM_TO_TRUTH: Record<string, string> = { FACT: 'VERIFIED_FACT', FOUNDER: 'FOUNDER_STATED', CALCULATION: 'INFERENCE', ASSUMPTION: 'ASSUMPTION', HYPOTHESIS: 'HYPOTHESIS', INFERENCE: 'INFERENCE' };

export function parseReport(raw: string): AuditReport | null {
  try { const r = JSON.parse(raw); return r && typeof r === 'object' && Object.keys(r).length ? r as AuditReport : null; } catch { return null; }
}

/**
 * Copies a completed Aristotle audit into Hippoturtle's structured tables and Business Memory.
 * Idempotent: re-running never duplicates rows. Returns false when the audit is not complete yet.
 */
export async function syncAristotle(objective: { id: string; organizationId: string; auditId: string | null; stage: string }): Promise<'synced' | 'already' | 'not_ready'> {
  if (!objective.auditId) return 'not_ready';
  const audit = await db.audit.findUnique({ where: { id: objective.auditId } });
  if (!audit || audit.status !== 'completed' || audit.paymentStatus !== 'paid') return 'not_ready';
  const report = parseReport(audit.report);
  if (!report) return 'not_ready';
  if (await db.decisionMemo.findUnique({ where: { objectiveId: objective.id } })) return 'already';

  const research = (await getResearch(audit.id)) as ResearchRecord | null;
  const facts = await getLockedFacts(audit.id);
  const orgId = objective.organizationId; const objectiveId = objective.id;
  const sourceById = new Map((research?.sources || []).map((s) => [s.id, s]));

  if (research?.businessModel) {
    const b = research.businessModel;
    const idea = { summary: b.summary, customer: b.customer, payer: b.payer, offering: b.offering, revenueMechanism: b.revenueMechanism, keyActivities: b.keyActivities, regulatedActivities: b.regulatedActivities };
    await upsertSafely(() => db.businessIdea.upsert({ where: { objectiveId }, update: idea, create: { organizationId: orgId, objectiveId, ...idea } }));
    await remember({ organizationId: orgId, objectiveId, kind: 'IDEA', title: 'Business model (as understood by research)', detail: `${b.summary} Customer: ${b.customer}. Payer: ${b.payer}. Revenue: ${b.revenueMechanism}.`, status: 'INFERENCE', owner: 'Aristotle', refType: 'idea', refId: objectiveId });
  }
  if (research?.questions?.length) {
    await db.researchQuestion.createMany({ skipDuplicates: true, data: research.questions.map((q) => ({ objectiveId, code: q.id, category: q.category, question: q.question, whyItMatters: q.whyItMatters, query: q.query, status: q.status })) });
  }
  for (const f of research?.findings || []) {
    const src = sourceById.get(f.sourceId);
    const finding = {
      questionCode: f.questionId, statement: f.statement, quote: f.quote, sourceTitle: src?.title || 'Unknown source', sourceUrl: src?.url || '',
      retrievedAt: src?.retrievedAt ? new Date(src.retrievedAt) : null, geography: f.geography || audit.geography || 'India', confidence: f.confidence,
    };
    // Keyed on the existing unique (objectiveId, code): create if missing, otherwise refresh it from research.json
    // (the same record for this audit, so a refresh/retry rewrites identical values). Safe under concurrent loads.
    await upsertSafely(() => db.researchFinding.upsert({ where: { objectiveId_code: { objectiveId, code: f.id } }, update: finding, create: { objectiveId, code: f.id, ...finding } }));
    const analogue = f.evidenceType === 'ANALOGOUS'; // an analogue informs; it is never stored as a verified fact about this business
    await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: analogue ? `Analogue: ${f.statement}` : f.statement, detail: `“${f.quote}”${f.analogy ? ` (analogue: ${f.analogy})` : ''}`, status: analogue ? 'INFERENCE' : 'VERIFIED_FACT', source: src?.title || f.sourceId, sourceUrl: src?.url, confidence: f.confidence, owner: 'Aristotle', refType: 'finding', refId: `${objectiveId}:${f.id}`, occurredAt: src?.retrievedAt ? new Date(src.retrievedAt) : undefined });
  }
  for (const q of (research?.questions || []).filter((q) => q.status !== 'ANSWERED')) {
    await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: q.question, detail: `Research status: ${q.status}. ${q.whyItMatters}${q.gap ? ` Closest evidence: ${q.gap.closestEvidence} To find out: ${q.gap.resolveBy.action}` : ''}`.slice(0, 1500), status: 'UNKNOWN', owner: 'Aristotle', refType: 'question', refId: `${objectiveId}:${q.id}` });
  }
  const evidence: EvidenceClaim[] = Array.isArray(report.evidence) ? report.evidence : [];
  if (evidence.length) {
    // Evidence has no natural unique key: skip claims already stored (e.g. by an earlier partial run) and give the rest
    // deterministic ids, so concurrent syncs insert each claim exactly once (ON CONFLICT DO NOTHING on the primary key).
    const have = new Set((await db.evidence.findMany({ where: { objectiveId }, select: { type: true, claim: true } })).map((e) => `${e.type}\u0000${e.claim}`));
    const rows = evidence.filter((e) => !have.has(`${e.type}\u0000${e.claim}`)).map((e) => ({ id: stableId('ev', objectiveId, e.type, e.claim), objectiveId, claim: e.claim, type: e.type, status: e.type === 'FACT' && e.sourceIds?.length ? 'VERIFIED_FACT' : e.type === 'FOUNDER' && !(e.sourceIds || []).some((x) => /^F\d+$/.test(x)) ? 'INFERENCE' : CLAIM_TO_TRUTH[e.type] || 'INFERENCE', sourceRefs: e.sourceIds || [], confidence: e.confidence, validation: e.validation || '' }));
    if (rows.length) await db.evidence.createMany({ data: rows, skipDuplicates: true });
  }
  for (const f of facts) await rememberFounderFact(orgId, objectiveId, f);
  for (const [i, a] of (report.decisionMemo?.criticalAssumptions || []).entries()) {
    await remember({ organizationId: orgId, objectiveId, kind: 'ASSUMPTION', title: a.assumption, detail: `${a.whyItMatters} Evidence: ${a.evidenceStatus}. Cheapest test: ${a.cheapestTest}`, status: a.evidenceStatus === 'SUPPORTED' ? 'INFERENCE' : 'ASSUMPTION', owner: 'Aristotle', refType: 'assumption', refId: `${objectiveId}:${i}` });
  }
  for (const [i, x] of (report.experiments || []).entries()) {
    await remember({ organizationId: orgId, objectiveId, kind: 'EXPERIMENT', title: x.test, detail: `Hypothesis: ${x.hypothesis}. Pass: ${x.passThreshold}. Fail: ${x.failThreshold}.`, status: 'HYPOTHESIS', owner: 'Aristotle', refType: 'experiment', refId: `${objectiveId}:${i}` });
  }
  for (const u of report.unknownEconomics || []) {
    await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: u.metric, detail: `${u.whyUnknown} How to establish: ${u.howToEstablish}`, value: NOT_ESTABLISHED, status: 'UNKNOWN', owner: 'Aristotle', refType: 'unknown', refId: `${objectiveId}:${u.metric}` });
  }

  let memo;
  try {
    // Pathways generated by the audit job arrive with the report: the founder never sees a finished memo without them.
    memo = await db.decisionMemo.create({ data: { objectiveId, auditId: audit.id, content: report as unknown as Prisma.InputJsonValue } });
  } catch (e) { if (isUniqueViolation(e)) return 'already'; throw e; } // concurrent sync: unique(objectiveId) makes exactly one win; it alone logs
  await db.objective.update({ where: { id: objectiveId }, data: { stage: advanceTo(objective.stage, 'DECISION'), lastError: null } });
  await logActivity({ organizationId: orgId, objectiveId, type: 'RESEARCH_COMPLETED', actor: 'Aristotle', message: `Research completed: ${research?.questions?.length ?? 0} questions, ${research?.findings?.length ?? 0} sourced findings.` });
  await logActivity({ organizationId: orgId, objectiveId, type: 'DECISION_GENERATED', actor: 'Aristotle', message: `Decision memo ready: ${report.oneLineVerdict || report.verdict || 'see memo'}`.slice(0, 300) });
  if (report.pathways?.pathways?.length) await persistPathways({ id: objectiveId, organizationId: orgId, stage: advanceTo(objective.stage, 'DECISION') }, memo.id, report.pathways);
  return 'synced';
}

/** Stores pathways on the decision memo and objective, with the activity log and Business Memory entries. */
export async function persistPathways(objective: { id: string; organizationId: string; stage: string }, memoId: string, result: PathwaysResult) {
  await db.decisionMemo.update({ where: { id: memoId }, data: { pathways: result as unknown as Prisma.InputJsonValue, founderChecklist: result.founderChecklist as unknown as Prisma.InputJsonValue } });
  await db.objective.update({ where: { id: objective.id }, data: { pathways: result.pathways as unknown as Prisma.InputJsonValue, stage: advanceTo(objective.stage, 'PATHWAYS') } });
  await logActivity({ organizationId: objective.organizationId, objectiveId: objective.id, type: 'PATHWAYS_GENERATED', actor: 'Aristotle', message: `${result.pathways.length} pathways to the full objective: ${result.pathways.map((p) => p.name).join(', ')}`.slice(0, 400) });
  for (const p of result.pathways) {
    await remember({ organizationId: objective.organizationId, objectiveId: objective.id, kind: 'IDEA', title: `Pathway: ${p.name}`, detail: `${p.howItWorks} Evidence: ${p.evidenceStrength}.`, status: p.evidenceStrength === 'NOT_YET_ESTABLISHED' ? 'HYPOTHESIS' : 'INFERENCE', owner: 'Aristotle', refType: 'pathway', refId: `${objective.id}:${p.id}` });
  }
}

export async function rememberFounderFact(orgId: string, objectiveId: string, f: FounderFact) {
  await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: describeFact(f), value: formatFactValue(f), detail: `Founder wording: “${f.raw}”`, status: 'FOUNDER_STATED', source: 'Founder (confirmed)', owner: 'Founder', confidence: 'FOUNDER', refType: 'founder_fact', refId: `${objectiveId}:${f.id}` });
}
