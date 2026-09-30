// ---------------------------------------------------------------------------
// Evidence layer v0.
//
// Principle: Aristotle never confuses a convincing answer with evidence.
//   - Every research source is persisted with a stable id (S1, S2, …) — research.json.
//   - The model must tag key claims as FACT / FOUNDER / CALCULATION / ASSUMPTION / HYPOTHESIS / INFERENCE
//     and cite source ids. The server verifies every citation: invented ids are removed, a FACT with no
//     real source is downgraded, "SUPPORTED" decision assumptions need real evidence.
//
// Deliberately file-based (ProjectFile) and additive, so a future evidence table / cross-audit
// intelligence can be introduced without reshaping reports.
// ---------------------------------------------------------------------------
import type { FounderFact } from './founder-facts';

export type ResearchSource = { id: string; title: string; url: string; snippet: string; query: string; retrievedAt: string };
export type ResearchRecord = { version: 1; retrievedAt: string; queries: string[]; sources: ResearchSource[] };

export const CLAIM_TYPES = ['FACT', 'FOUNDER', 'CALCULATION', 'ASSUMPTION', 'HYPOTHESIS', 'INFERENCE'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const EVIDENCE_STATUS = ['SUPPORTED', 'PARTIAL', 'UNKNOWN', 'CONTRADICTED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUS)[number];

export type EvidenceClaim = { claim: string; type: ClaimType; sourceIds: string[]; confidence: Confidence; validation: string; verified?: boolean; note?: string };

export type CriticalAssumption = {
  assumption: string;
  whyItMatters: string;
  evidenceStatus: EvidenceStatus;
  evidence: string;
  evidenceIds: string[];        // S# research sources and/or F# founder facts
  cheapestTest: string;
  experimentIndex?: number;     // 1-based pointer into report.experiments
  note?: string;
};

export type DecisionMemo = {
  decisionQuestion: string;
  criticalAssumptions: CriticalAssumption[];
  proceedIf: string[];
  changeModelIf: string[];
  evidenceStillRequired: string[];
};

export function toResearchRecord(groups: { query: string; results: { title?: string; url?: string; content?: string }[] }[], now = new Date()): ResearchRecord {
  const sources: ResearchSource[] = [];
  for (const g of groups) {
    for (const r of g.results) {
      if (!r.url || sources.some((s) => s.url === r.url)) continue;
      sources.push({ id: `S${sources.length + 1}`, title: (r.title || 'Untitled').slice(0, 200), url: r.url, snippet: (r.content || '').slice(0, 600), query: g.query, retrievedAt: now.toISOString() });
    }
  }
  return { version: 1, retrievedAt: now.toISOString(), queries: groups.map((g) => g.query), sources };
}

// Official Indian regulator / government domains accepted as regulatory sources without a research hit.
const OFFICIAL_DOMAINS = /(^|\.)(gov\.in|nic\.in|rbi\.org\.in|sebi\.gov\.in|irdai\.gov\.in|fssai\.gov\.in|bis\.gov\.in|gst\.gov\.in|cbic\.gov\.in|udyamregistration\.gov\.in|meity\.gov\.in|cdsco\.gov\.in|mca\.gov\.in|incometax\.gov\.in|dgft\.gov\.in|npci\.org\.in|trai\.gov\.in|india\.gov\.in)$/i;

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

type ReportLike = {
  evidence?: EvidenceClaim[];
  decisionMemo?: DecisionMemo;
  experiments?: unknown[];
  regulatory?: { name: string; source: string; trigger?: string; rationale?: string; [k: string]: unknown }[];
  [k: string]: unknown;
};

export type EvidenceLog = { droppedSourceIds: number; downgradedFacts: number; downgradedAssumptions: number; unverifiedRegSources: number };

/** Server-side verification of every citation in a generated report. */
export function validateEvidence<T extends ReportLike>(report: T, research: ResearchRecord | null, facts: FounderFact[] = []): { report: T; log: EvidenceLog } {
  const log: EvidenceLog = { droppedSourceIds: 0, downgradedFacts: 0, downgradedAssumptions: 0, unverifiedRegSources: 0 };
  const sourceIds = new Set((research?.sources || []).map((s) => s.id));
  const factIds = new Set(facts.filter((f) => f.locked).map((f) => f.id));
  const known = (id: string) => sourceIds.has(id) || factIds.has(id);
  const str = (v: unknown, n = 600) => (typeof v === 'string' ? v.slice(0, n) : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => (x as string).slice(0, 400)) : []);

  // Evidence register
  const evidence: EvidenceClaim[] = (Array.isArray(report.evidence) ? report.evidence : []).map((raw) => {
    const e = raw as Partial<EvidenceClaim>;
    let type: ClaimType = CLAIM_TYPES.includes(e.type as ClaimType) ? (e.type as ClaimType) : 'INFERENCE';
    let confidence: Confidence = CONFIDENCE.includes(e.confidence as Confidence) ? (e.confidence as Confidence) : 'LOW';
    const ids = list(e.sourceIds);
    const valid = ids.filter(known);
    log.droppedSourceIds += ids.length - valid.length;
    let note: string | undefined;
    if (type === 'FACT' && !valid.some((id) => sourceIds.has(id))) {
      type = 'INFERENCE'; confidence = 'LOW'; note = 'No verifiable source was found for this claim.'; log.downgradedFacts++;
    }
    if (type === 'FOUNDER' && !valid.some((id) => factIds.has(id))) { type = 'ASSUMPTION'; note = 'Not a founder-confirmed figure.'; }
    return { claim: str(e.claim, 500), type, sourceIds: valid, confidence, validation: str(e.validation, 400), verified: valid.length > 0, ...(note ? { note } : {}) };
  }).filter((e) => e.claim);

  // Decision memo
  let decisionMemo = report.decisionMemo;
  if (decisionMemo && typeof decisionMemo === 'object') {
    const nExp = Array.isArray(report.experiments) ? report.experiments.length : 0;
    const critical = (Array.isArray(decisionMemo.criticalAssumptions) ? decisionMemo.criticalAssumptions : []).slice(0, 5).map((raw) => {
      const a = raw as Partial<CriticalAssumption>;
      let status: EvidenceStatus = EVIDENCE_STATUS.includes(a.evidenceStatus as EvidenceStatus) ? (a.evidenceStatus as EvidenceStatus) : 'UNKNOWN';
      const ids = list(a.evidenceIds);
      const valid = ids.filter(known);
      log.droppedSourceIds += ids.length - valid.length;
      let note: string | undefined;
      if ((status === 'SUPPORTED' || status === 'PARTIAL' || status === 'CONTRADICTED') && valid.length === 0) {
        note = `Marked ${status.toLowerCase()} without verifiable evidence; treated as unknown.`;
        status = 'UNKNOWN'; log.downgradedAssumptions++;
      }
      const idx = typeof a.experimentIndex === 'number' && Number.isInteger(a.experimentIndex) && a.experimentIndex >= 1 && a.experimentIndex <= nExp ? a.experimentIndex : undefined;
      return { assumption: str(a.assumption, 400), whyItMatters: str(a.whyItMatters), evidenceStatus: status, evidence: str(a.evidence), evidenceIds: valid, cheapestTest: str(a.cheapestTest), ...(idx ? { experimentIndex: idx } : {}), ...(note ? { note } : {}) };
    }).filter((a) => a.assumption);
    decisionMemo = {
      decisionQuestion: str(decisionMemo.decisionQuestion, 300),
      criticalAssumptions: critical,
      proceedIf: list(decisionMemo.proceedIf).slice(0, 6),
      changeModelIf: list(decisionMemo.changeModelIf).slice(0, 6),
      evidenceStillRequired: list(decisionMemo.evidenceStillRequired).slice(0, 8),
    };
  }

  // Regulatory sources: must be a researched URL or an official regulator/government domain.
  const researchedUrls = new Set((research?.sources || []).map((s) => s.url));
  const regulatory = Array.isArray(report.regulatory) ? report.regulatory.map((r) => {
    const src = str(r.source, 500);
    const host = hostOf(src);
    const ok = Boolean(src && (researchedUrls.has(src) || (host && OFFICIAL_DOMAINS.test(host))));
    if (src && !ok) log.unverifiedRegSources++;
    return { ...r, source: ok ? src : '', trigger: str(r.trigger, 300) || str(r.rationale, 300) };
  }) : report.regulatory;

  return { report: { ...report, evidence, ...(decisionMemo ? { decisionMemo } : {}), ...(regulatory ? { regulatory } : {}) }, log };
}

export function evidenceSummary(evidence?: EvidenceClaim[]): Record<ClaimType, number> {
  const out = Object.fromEntries(CLAIM_TYPES.map((t) => [t, 0])) as Record<ClaimType, number>;
  for (const e of evidence || []) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}
