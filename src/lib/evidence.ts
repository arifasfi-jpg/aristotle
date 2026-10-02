// ---------------------------------------------------------------------------
// Evidence layer.
//
// Principle: Aristotle researches the specific business BEFORE it writes the decision memo, and never
// confuses a convincing answer with evidence.
//   research.json (v2): business model → research questions → queries → sources (S#) → verified findings (R#)
//   The decision stage may only treat as evidence: founder facts (F#), verified findings (R#), sources (S#).
//   The server verifies every citation, drops critical assumptions that do not come from a research gap,
//   removes ungrounded numbers (→ "not yet established") and removes regulation without a source.
//
// File-based (ProjectFile) and additive, so a future evidence table / cross-audit intelligence can be
// introduced without reshaping reports.
// ---------------------------------------------------------------------------
import type { FounderFact } from './founder-facts';

export const CLAIM_TYPES = ['FACT', 'FOUNDER', 'CALCULATION', 'ASSUMPTION', 'HYPOTHESIS', 'INFERENCE'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const EVIDENCE_STATUS = ['SUPPORTED', 'PARTIAL', 'UNKNOWN', 'CONTRADICTED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUS)[number];

export const RESEARCH_CATEGORIES = ['DEMAND', 'ALTERNATIVES_PRICING', 'REGULATION', 'CHANNEL', 'COST', 'OPERATIONS', 'OTHER'] as const;
export type ResearchCategory = (typeof RESEARCH_CATEGORIES)[number];
export const QUESTION_STATUS = ['ANSWERED', 'PARTIAL', 'NOT_FOUND', 'CONTRADICTORY', 'SEARCH_FAILED'] as const;
export type QuestionStatus = (typeof QUESTION_STATUS)[number];
export const GAP_STATUSES: QuestionStatus[] = ['PARTIAL', 'NOT_FOUND', 'CONTRADICTORY', 'SEARCH_FAILED'];

export type BusinessModel = {
  summary: string; customer: string; payer: string; offering: string; revenueMechanism: string;
  keyActivities: string[]; regulatedActivities: { activity: string; whyRegulated: string }[];
};
export type ResearchSource = { id: string; title: string; url: string; snippet: string; content?: string; query: string; questionId?: string; retrievedAt: string };
export type Finding = { id: string; questionId: string; statement: string; sourceId: string; quote: string; confidence: Confidence };
export type ResearchQuestion = {
  id: string; category: ResearchCategory; question: string; whyItMatters: string; query: string; activity?: string;
  status: QuestionStatus; sourceIds: string[]; findingIds: string[]; note?: string;
};
export type ResearchRecord = {
  version: 1 | 2;
  retrievedAt: string;
  queries: string[];
  sources: ResearchSource[];
  inputHash?: string;
  businessModel?: BusinessModel;
  questions?: ResearchQuestion[];
  findings?: Finding[];
  usage?: { inputTokens: number; outputTokens: number; tavilySearches: number };
  /** 'PLANNED' = checkpoint after the planning call only (no searches yet); absent = complete research. */
  stage?: 'PLANNED';
  plan?: { businessModel: BusinessModel; questions: Omit<ResearchQuestion, 'status' | 'sourceIds' | 'findingIds'>[] };
};

export type EvidenceClaim = { claim: string; type: ClaimType; sourceIds: string[]; confidence: Confidence; validation: string; verified?: boolean; note?: string };
export type CriticalAssumption = {
  assumption: string; whyItMatters: string; evidenceStatus: EvidenceStatus; evidence: string;
  evidenceIds: string[];        // R# findings, S# sources, F# founder facts
  basedOnQuestions?: string[];  // Q# research questions this assumption comes from
  cheapestTest: string; experimentIndex?: number; note?: string;
};
export type DecisionMemo = { decisionQuestion: string; criticalAssumptions: CriticalAssumption[]; proceedIf: string[]; changeModelIf: string[]; evidenceStillRequired: string[] };
export type UnknownMetric = { metric: string; whyUnknown: string; howToEstablish: string };

/** Legacy (v1) builder from raw search groups. Kept for compatibility. */
export function toResearchRecord(groups: { query: string; results: { title?: string; url?: string; content?: string }[] }[], now = new Date()): ResearchRecord {
  const sources: ResearchSource[] = [];
  for (const g of groups) for (const r of g.results) {
    if (!r.url || sources.some((s) => s.url === r.url)) continue;
    sources.push({ id: `S${sources.length + 1}`, title: (r.title || 'Untitled').slice(0, 200), url: r.url, snippet: (r.content || '').slice(0, 600), query: g.query, retrievedAt: now.toISOString() });
  }
  return { version: 1, retrievedAt: now.toISOString(), queries: groups.map((g) => g.query), sources };
}

// Official Indian regulator / government domains accepted as regulatory sources.
const OFFICIAL_DOMAINS = /(^|\.)(gov\.in|nic\.in|rbi\.org\.in|sebi\.gov\.in|irdai\.gov\.in|fssai\.gov\.in|bis\.gov\.in|gst\.gov\.in|cbic\.gov\.in|udyamregistration\.gov\.in|meity\.gov\.in|cdsco\.gov\.in|mca\.gov\.in|incometax\.gov\.in|dgft\.gov\.in|npci\.org\.in|trai\.gov\.in|india\.gov\.in)$/i;
const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

type UERowLike = { metric: string; provenance?: string; factId?: string; inputs?: string[]; basis?: string; [k: string]: unknown };
type RegLike = { name: string; status?: string; source: string; trigger?: string; rationale?: string; activity?: string; requirement?: string; sourceIds?: string[]; [k: string]: unknown };
type ReportLike = {
  evidence?: EvidenceClaim[]; decisionMemo?: DecisionMemo; experiments?: unknown[];
  regulatory?: RegLike[]; unitEconomics?: UERowLike[]; unknownEconomics?: UnknownMetric[];
  [k: string]: unknown;
};

export type EvidenceLog = {
  droppedSourceIds: number; downgradedFacts: number; downgradedAssumptions: number; droppedAssumptions: number;
  unverifiedRegSources: number; droppedRegulations: number; ungroundedNumbers: number;
};

/**
 * Server-side verification of every citation in a generated report.
 * With a v2 research record (research-driven audit) the stricter rules apply:
 *   - critical assumptions must come from a research gap (NOT_FOUND / PARTIAL / CONTRADICTORY question)
 *   - numbers must be founder-stated, researched (R#) or calculated from those; others → unknownEconomics
 *   - regulation must be activity → requirement → verified source; others → evidence still required
 */
export function validateEvidence<T extends ReportLike>(report: T, research: ResearchRecord | null, facts: FounderFact[] = []): { report: T; log: EvidenceLog } {
  const log: EvidenceLog = { droppedSourceIds: 0, downgradedFacts: 0, downgradedAssumptions: 0, droppedAssumptions: 0, unverifiedRegSources: 0, droppedRegulations: 0, ungroundedNumbers: 0 };
  const strict = research?.version === 2;
  const sources = research?.sources || [];
  const sourceIds = new Set(sources.map((s) => s.id));
  const findingById = new Map((research?.findings || []).map((f) => [f.id, f]));
  const questionById = new Map((research?.questions || []).map((q) => [q.id, q]));
  const factIds = new Set(facts.filter((f) => f.locked).map((f) => f.id));
  const isEvidence = (id: string) => sourceIds.has(id) || findingById.has(id);
  const known = (id: string) => isEvidence(id) || factIds.has(id);
  const str = (v: unknown, n = 600) => (typeof v === 'string' ? v.slice(0, n) : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => (x as string).slice(0, 400)) : []);
  const stillRequired: string[] = [];

  // ---- Evidence register --------------------------------------------------------------------
  const evidence: EvidenceClaim[] = (Array.isArray(report.evidence) ? report.evidence : []).map((raw) => {
    const e = raw as Partial<EvidenceClaim>;
    let type: ClaimType = CLAIM_TYPES.includes(e.type as ClaimType) ? (e.type as ClaimType) : 'INFERENCE';
    let confidence: Confidence = CONFIDENCE.includes(e.confidence as Confidence) ? (e.confidence as Confidence) : 'LOW';
    const ids = list(e.sourceIds);
    const valid = ids.filter(known);
    log.droppedSourceIds += ids.length - valid.length;
    let note: string | undefined;
    if (type === 'FACT' && !valid.some(isEvidence)) { type = 'INFERENCE'; confidence = 'LOW'; note = 'No verifiable research evidence was found for this claim.'; log.downgradedFacts++; }
    if (type === 'FOUNDER' && !valid.some((id) => factIds.has(id))) { type = 'ASSUMPTION'; note = 'Not a founder-confirmed figure.'; }
    return { claim: str(e.claim, 500), type, sourceIds: valid, confidence, validation: str(e.validation, 400), verified: valid.length > 0, ...(note ? { note } : {}) };
  }).filter((e) => e.claim);

  // ---- Decision memo ------------------------------------------------------------------------
  let decisionMemo = report.decisionMemo;
  if (decisionMemo && typeof decisionMemo === 'object') {
    const nExp = Array.isArray(report.experiments) ? report.experiments.length : 0;
    const critical: CriticalAssumption[] = [];
    for (const raw of (Array.isArray(decisionMemo.criticalAssumptions) ? decisionMemo.criticalAssumptions : []).slice(0, 5)) {
      const a = raw as Partial<CriticalAssumption>;
      let status: EvidenceStatus = EVIDENCE_STATUS.includes(a.evidenceStatus as EvidenceStatus) ? (a.evidenceStatus as EvidenceStatus) : 'UNKNOWN';
      const ids = list(a.evidenceIds);
      const valid = ids.filter(known);
      log.droppedSourceIds += ids.length - valid.length;
      let note: string | undefined;
      if ((status === 'SUPPORTED' || status === 'PARTIAL' || status === 'CONTRADICTED') && !valid.some(isEvidence) && !valid.some((id) => factIds.has(id))) {
        note = `Marked ${status.toLowerCase()} without verifiable evidence; treated as unknown.`;
        status = 'UNKNOWN'; log.downgradedAssumptions++;
      }
      const basedOn = list(a.basedOnQuestions).filter((q) => questionById.has(q));
      if (strict) {
        // Must emerge from a research gap or a contradiction — never a generic startup assumption.
        const fromGap = basedOn.some((q) => GAP_STATUSES.includes(questionById.get(q)!.status));
        const fromContradiction = status === 'CONTRADICTED' && valid.some((id) => findingById.has(id));
        if (!fromGap && !fromContradiction) { log.droppedAssumptions++; continue; }
      }
      const idx = typeof a.experimentIndex === 'number' && Number.isInteger(a.experimentIndex) && a.experimentIndex >= 1 && a.experimentIndex <= nExp ? a.experimentIndex : undefined;
      if (!str(a.assumption, 400)) continue;
      critical.push({ assumption: str(a.assumption, 400), whyItMatters: str(a.whyItMatters), evidenceStatus: status, evidence: str(a.evidence), evidenceIds: valid, ...(basedOn.length ? { basedOnQuestions: basedOn } : {}), cheapestTest: str(a.cheapestTest), ...(idx ? { experimentIndex: idx } : {}), ...(note ? { note } : {}) });
    }
    decisionMemo = {
      decisionQuestion: str(decisionMemo.decisionQuestion, 300),
      criticalAssumptions: critical.slice(0, 3),
      proceedIf: list(decisionMemo.proceedIf).slice(0, 6),
      changeModelIf: list(decisionMemo.changeModelIf).slice(0, 6),
      evidenceStillRequired: list(decisionMemo.evidenceStillRequired).slice(0, 8),
    };
  }

  // ---- Regulation: activity → requirement → source -----------------------------------------
  const urlById = new Map<string, string>(sources.map((s) => [s.id, s.url]));
  for (const f of research?.findings || []) urlById.set(f.id, urlById.get(f.sourceId) || '');
  const researchedUrls = new Set(sources.map((s) => s.url));
  let regulatory = report.regulatory;
  if (Array.isArray(report.regulatory)) {
    regulatory = [];
    for (const r of report.regulatory) {
      const ids = list(r.sourceIds).filter(isEvidence);
      const activity = str(r.activity, 300) || str(r.trigger, 300);
      if (strict) {
        if (!activity || ids.length === 0) {
          log.droppedRegulations++;
          stillRequired.push(`Regulation to verify: whether ${str(r.name, 120) || 'a regulation'} applies${activity ? ` to "${activity}"` : ''} — no source was found in research.`);
          continue;
        }
        regulatory.push({ ...r, activity, trigger: activity, requirement: str(r.requirement, 400) || str(r.rationale, 400), sourceIds: ids, source: urlById.get(ids[0]) || '' });
        continue;
      }
      // Legacy (v1) behaviour: keep, but only researched or official source URLs.
      const src = str(r.source, 500);
      const host = hostOf(src);
      const ok = Boolean(src && (researchedUrls.has(src) || (host && OFFICIAL_DOMAINS.test(host))));
      if (src && !ok) log.unverifiedRegSources++;
      regulatory.push({ ...r, source: ok ? src : '', trigger: activity || str(r.rationale, 300) });
    }
  }

  // ---- Numbers: founder / researched / calculated only (strict) -------------------------------
  let unitEconomics = report.unitEconomics;
  let unknownEconomics: UnknownMetric[] = (Array.isArray(report.unknownEconomics) ? report.unknownEconomics : [])
    .map((u) => ({ metric: str(u?.metric, 200), whyUnknown: str(u?.whyUnknown, 400), howToEstablish: str(u?.howToEstablish, 400) }))
    .filter((u) => u.metric);
  if (strict && Array.isArray(report.unitEconomics)) {
    const rows = report.unitEconomics;
    const grounded = new Set<number>();
    const bare = (m: string) => m.toLowerCase().replace(/^(external benchmark|scenario): /, '').trim();
    const refOk = (ref: string) => factIds.has(ref) || findingById.has(ref) || rows.some((r, j) => grounded.has(j) && bare(r.metric) === bare(ref));
    let changed = true;
    while (changed) {
      changed = false;
      rows.forEach((r, i) => {
        if (grounded.has(i)) return;
        const inputs = Array.isArray(r.inputs) ? r.inputs.map(String) : [];
        const ok =
          (r.provenance === 'FOUNDER_STATED' && !!r.factId && factIds.has(r.factId)) ||
          (r.provenance === 'EXTERNAL' && inputs.some((x) => findingById.has(x))) ||
          (r.provenance === 'CALCULATED' && inputs.length > 0 && inputs.every(refOk));
        if (ok) { grounded.add(i); changed = true; }
      });
    }
    unitEconomics = rows.filter((_, i) => grounded.has(i));
    for (const r of rows.filter((_, i) => !grounded.has(i))) {
      log.ungroundedNumbers++;
      if (!unknownEconomics.some((u) => u.metric.toLowerCase() === r.metric.toLowerCase())) {
        unknownEconomics.push({ metric: r.metric, whyUnknown: 'No founder figure or researched evidence supports a number yet.', howToEstablish: str(r.basis, 300) || 'Measure it in the validation experiments.' });
      }
    }
    unknownEconomics = unknownEconomics.slice(0, 12);
  }

  if (decisionMemo && stillRequired.length) {
    decisionMemo = { ...decisionMemo, evidenceStillRequired: [...decisionMemo.evidenceStillRequired, ...stillRequired.filter((x) => !decisionMemo!.evidenceStillRequired.includes(x))].slice(0, 12) };
  }

  return {
    report: { ...report, evidence, ...(decisionMemo ? { decisionMemo } : {}), ...(regulatory ? { regulatory } : {}), ...(unitEconomics ? { unitEconomics } : {}), ...(strict || unknownEconomics.length ? { unknownEconomics } : {}) },
    log,
  };
}

export function evidenceSummary(evidence?: EvidenceClaim[]): Record<ClaimType, number> {
  const out = Object.fromEntries(CLAIM_TYPES.map((t) => [t, 0])) as Record<ClaimType, number>;
  for (const e of evidence || []) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}
