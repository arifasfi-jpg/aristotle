// Bridge between Hippoturtle and the existing Aristotle engine.
// Aristotle keeps its own audit record, ₹99 payment, research pipeline and evidence validation; Hippoturtle
// links an Objective to that audit and copies the finished, validated result into structured tables.
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import type { AuditReport, Sector } from '../audit';
import { getLockedFacts, getResearch } from '../audit-meta';
import type { EvidenceClaim, ResearchRecord } from '../evidence';
import { describeFact, extractFounderFacts, formatFactValue, type FounderFact } from '../founder-facts';
import { aiMeta, generateJson } from './gateway';
import { logActivity, remember } from './context';
import { advanceTo, NOT_ESTABLISHED, type Understanding } from './types';

// ---------------------------------------------------------------- UNDERSTAND
const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' }, target: { type: 'string' }, currentState: { type: 'string' }, keyQuestion: { type: 'string' },
    businessKind: { type: 'string', enum: ['NEW_IDEA', 'EXISTING_BUSINESS', 'UNCLEAR'] },
  },
  required: ['objective', 'target', 'currentState', 'keyQuestion', 'businessKind'],
};

export function understandPrompt(text: string): string {
  return `You are Hippoturtle, an organisation that helps founders build companies. Restate what this founder is trying to achieve.
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

export async function understandObjective(text: string): Promise<{ understanding: Understanding; meta?: ReturnType<typeof aiMeta>; error?: string }> {
  try {
    const r = await generateJson<Omit<Understanding, 'source'>>('understand', understandPrompt(text), UNDERSTAND_SCHEMA);
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
    await db.businessIdea.upsert({ where: { objectiveId }, update: {}, create: { organizationId: orgId, objectiveId, summary: b.summary, customer: b.customer, payer: b.payer, offering: b.offering, revenueMechanism: b.revenueMechanism, keyActivities: b.keyActivities, regulatedActivities: b.regulatedActivities } });
    await remember({ organizationId: orgId, objectiveId, kind: 'IDEA', title: 'Business model (as understood by research)', detail: `${b.summary} Customer: ${b.customer}. Payer: ${b.payer}. Revenue: ${b.revenueMechanism}.`, status: 'INFERENCE', owner: 'Aristotle', refType: 'idea', refId: objectiveId });
  }
  if (research?.questions?.length) {
    await db.researchQuestion.createMany({ skipDuplicates: true, data: research.questions.map((q) => ({ objectiveId, code: q.id, category: q.category, question: q.question, whyItMatters: q.whyItMatters, query: q.query, status: q.status })) });
  }
  for (const f of research?.findings || []) {
    const src = sourceById.get(f.sourceId);
    await db.researchFinding.upsert({ where: { objectiveId_code: { objectiveId, code: f.id } }, update: {}, create: {
      objectiveId, code: f.id, questionCode: f.questionId, statement: f.statement, quote: f.quote, sourceTitle: src?.title || 'Unknown source', sourceUrl: src?.url || '',
      retrievedAt: src?.retrievedAt ? new Date(src.retrievedAt) : null, geography: audit.geography || 'India', confidence: f.confidence,
    } });
    await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: f.statement, detail: `“${f.quote}”`, status: 'VERIFIED_FACT', source: src?.title || f.sourceId, sourceUrl: src?.url, confidence: f.confidence, owner: 'Aristotle', refType: 'finding', refId: `${objectiveId}:${f.id}`, occurredAt: src?.retrievedAt ? new Date(src.retrievedAt) : undefined });
  }
  for (const q of (research?.questions || []).filter((q) => q.status !== 'ANSWERED')) {
    await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: q.question, detail: `Research status: ${q.status}. ${q.whyItMatters}`, status: 'UNKNOWN', owner: 'Aristotle', refType: 'question', refId: `${objectiveId}:${q.id}` });
  }
  const evidence: EvidenceClaim[] = Array.isArray(report.evidence) ? report.evidence : [];
  if (evidence.length && !(await db.evidence.count({ where: { objectiveId } }))) {
    await db.evidence.createMany({ data: evidence.map((e) => ({ objectiveId, claim: e.claim, type: e.type, status: e.type === 'FACT' && e.sourceIds?.length ? 'VERIFIED_FACT' : CLAIM_TO_TRUTH[e.type] || 'INFERENCE', sourceRefs: e.sourceIds || [], confidence: e.confidence, validation: e.validation || '' })) });
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

  try {
    await db.decisionMemo.create({ data: { objectiveId, auditId: audit.id, content: report as unknown as Prisma.InputJsonValue } });
  } catch { return 'already'; } // concurrent sync: unique(objectiveId) makes exactly one win
  await db.objective.update({ where: { id: objectiveId }, data: { stage: advanceTo(objective.stage, 'DECISION'), lastError: null } });
  await logActivity({ organizationId: orgId, objectiveId, type: 'RESEARCH_COMPLETED', actor: 'Aristotle', message: `Research completed: ${research?.questions?.length ?? 0} questions, ${research?.findings?.length ?? 0} sourced findings.` });
  await logActivity({ organizationId: orgId, objectiveId, type: 'DECISION_GENERATED', actor: 'Aristotle', message: `Decision memo ready: ${report.oneLineVerdict || report.verdict || 'see memo'}`.slice(0, 300) });
  return 'synced';
}

export async function rememberFounderFact(orgId: string, objectiveId: string, f: FounderFact) {
  await remember({ organizationId: orgId, objectiveId, kind: 'FACT', title: describeFact(f), value: formatFactValue(f), detail: `Founder wording: “${f.raw}”`, status: 'FOUNDER_STATED', source: 'Founder (confirmed)', owner: 'Founder', confidence: 'FOUNDER', refType: 'founder_fact', refId: `${objectiveId}:${f.id}` });
}
