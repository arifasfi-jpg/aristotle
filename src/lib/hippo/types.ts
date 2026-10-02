// Hippoturtle domain vocabulary. Stored as strings in Postgres; validated here (deterministic code).

/** The core workflow. An Objective moves forward through these stages; Work items carry the later ones. */
export const STAGES = [
  'FOUNDER_OBJECTIVE', // objective captured
  'UNDERSTAND',        // understanding produced, founder confirming numbers / scope
  'RESEARCH',          // Aristotle audit paid (or Demo Mode) and running
  'DECISION',          // Aristotle decision memo synced into Hippoturtle
  'PATHWAYS',          // "How could we actually achieve this?" produced, founder choosing pathways
  'WORK_GENERATION',   // Mogli has created work packages
  'EXECUTION',         // at least one work item chosen / running
  'OUTCOME',           // at least one outcome recorded
] as const;
export type Stage = (typeof STAGES)[number];
export const stageIndex = (s: string) => Math.max(0, STAGES.indexOf(s as Stage));
/** Stages only move forward (a retry never moves the founder backwards). */
export const advanceTo = (current: string, next: Stage): Stage => (stageIndex(next) > stageIndex(current) ? next : (current as Stage));

/** Per-work loop (shown on each Work item). */
export const WORK_STEPS = ['WORK_BRIEF', 'COST_ESTIMATE', 'EXECUTION_OPTIONS', 'FOUNDER_CHOICE', 'PAYMENT_IF_REQUIRED', 'EXECUTION', 'OUTCOME', 'BUSINESS_MEMORY'] as const;

export const WORK_STATUSES = ['DRAFT', 'READY', 'AWAITING_DECISION', 'APPROVED', 'IN_PROGRESS', 'WAITING_FOR_INPUT', 'COMPLETED', 'CANCELLED'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const EXECUTION_MODES = ['AI', 'HUMAN', 'HYBRID'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export const isExecutionMode = (v: unknown): v is ExecutionMode => typeof v === 'string' && (EXECUTION_MODES as readonly string[]).includes(v);

export const PROVIDER_TIERS = ['INTEGRATED_PARTNER', 'PREFERRED_PROVIDER', 'EXTERNAL_OPTION'] as const;
export type ProviderTier = (typeof PROVIDER_TIERS)[number];

/** Business truth layer. AI output can never silently become VERIFIED_FACT. */
export const TRUTH_STATUSES = ['VERIFIED_FACT', 'FOUNDER_STATED', 'ASSUMPTION', 'HYPOTHESIS', 'INFERENCE', 'UNKNOWN', 'RECORD'] as const;
export type TruthStatus = (typeof TRUTH_STATUSES)[number];
export const TRUTH_LABEL: Record<TruthStatus, string> = {
  VERIFIED_FACT: 'Sourced fact', FOUNDER_STATED: 'Founder stated', ASSUMPTION: 'Assumption', HYPOTHESIS: 'Hypothesis',
  INFERENCE: 'Inference', UNKNOWN: 'Not yet established', RECORD: 'Record',
};

export const MEMORY_KINDS = ['OBJECTIVE', 'IDEA', 'FACT', 'DECISION', 'ASSUMPTION', 'EXPERIMENT', 'WORK', 'COST', 'PROVIDER', 'QUOTE', 'OUTCOME'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const TIME_COMMITMENTS = ['15 minutes/day', '30 minutes/day', '1 hour/day', 'Weekend only', '2–5 hours/week', 'I want Hippoturtle to do most of the work'] as const;

/** Work payment states. Nothing is ever marked PAID without a verified payment. */
export const WORK_PAYMENT_STATUSES = ['NOT_REQUIRED', 'INCLUDED_EARLY_ACCESS', 'PENDING_INTEGRATION', 'PENDING', 'PAID', 'FAILED'] as const;
export type WorkPaymentStatus = (typeof WORK_PAYMENT_STATUSES)[number];

export const NOT_ESTABLISHED = 'Not yet established.';

export type Understanding = {
  objective: string;
  target: string;
  currentState: string;
  keyQuestion: string;
  businessKind: 'NEW_IDEA' | 'EXISTING_BUSINESS' | 'UNCLEAR';
  source: 'AI' | 'FOUNDER_NUMBERS';
};

export type PathwayEvidence = { statement: string; refs: string[] };
export type Pathway = {
  id: string;            // P1…
  name: string;
  howItWorks: string;
  whyPlausible: string;
  evidence: PathwayEvidence[];        // only R#/F# backed statements survive validation
  economics: string;                  // numbers only from F#/R#; else "Not yet established."
  constraints: string[];
  risks: string[];
  firstExperiment: string;
  contributionToTarget: string;
  evidenceStrength: 'SUPPORTED' | 'PARTIAL' | 'NOT_YET_ESTABLISHED';
};
export type PathwaysResult = {
  goal: string;
  ambitionNote: string;
  pathways: Pathway[];
  combination: string;
  founderChecklist: string[];
};

export type WorkPlanItem = {
  title: string; description: string; deliverable: string; capability: string;
  priority: number; pathwayId?: string; whyNow: string; aiExecutable: boolean;
};

export type EffortModel = {
  aiFeasible: boolean;
  aiOutputTokens: number;
  specialist: string;
  humanHours: { low: number; high: number };
  hourlyRateInr: { low: number; high: number };
  hybridReviewHours: { low: number; high: number };
  agencyMultiplier: { low: number; high: number };
  costDrivers: string[];
  rateBasis: string;
};

// ---------------------------------------------------------------- IDENTITY
// Hippoturtle is the operating organisation. The founder's Organization row IS the founder's business.
// Hippoturtle must never become the customer's business just because it is doing the work.
export const DEFAULT_ORG_NAME = 'My company';
/** Fictional name for the Preview/demo glucometer business. Not a real company. */
export const DEMO_COMPANY_NAME = 'Demo Glucose Technologies';

/** A name that does not identify the founder's business (never set, or mistakenly the platform's own name). */
/** Hippoturtle's own internal capability names (teams inside Hippoturtle) — never a founder's company. */
export const INTERNAL_CAPABILITY_NAMES = ['Mogli', 'Aristotle', 'Galileo', 'Aaira Studio', 'Marcus', 'Kuber', 'Garg', 'Eagle', 'Sherlock', 'Minerva', 'Xeno', 'Olympus', 'Sia'];
const norm = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();
export const isGenericOrgName = (name: string | null | undefined) => !name || !name.trim() || norm(name) === DEFAULT_ORG_NAME.toLowerCase() || /hippo\s*turtle/i.test(name)
  || INTERNAL_CAPABILITY_NAMES.some((c) => norm(c) === norm(name));

/** The founder's business name, or null when the founder has not named it. Never returns "Hippoturtle". */
export const businessName = (name: string | null | undefined): string | null => (isGenericOrgName(name) ? null : name!.trim());

/** Prompt block that keeps the platform and the founder's business separate. */
export function identityBlock(company: string | null): string {
  const biz = company ? `"${company}"` : 'the founder\'s business (not named yet — call it "your business")';
  return `IDENTITY (strict): Hippoturtle is the company-building organisation working FOR the founder, like an outsourced team.
Hippoturtle is NOT the founder's business. The business being analysed and served is ${biz}.
Never call that business Hippoturtle, never brand its products, pages, campaigns or documents as Hippoturtle, and never write
as if Hippoturtle sells its products. Deliverables belong to ${company ? `"${company}"` : 'the founder\'s business'}.
Names of Hippoturtle's internal capabilities (its teams, e.g. the one executing this work) are never the founder's company, brand,
product or author.`;
}
