import type { Sector, AuditReport, ReportLanguage } from './audit';
import { estimateCompute } from './pricing';
import { buildFounderFactsBlock, FACT_CONCEPTS, type FounderFact } from './founder-facts';
import { validateReport } from './report-validation';
import type { Scope } from './routing';
import { validateEvidence, type ResearchRecord } from './evidence';
import type { UsageContext } from './ai-usage';
import { aristotleGeminiJson } from './hippo/gateway';
import { isPlanCheckpoint, researchBusiness, researchBrief } from './research';

// Whole audit must fit the 60s serverless limit of /api/payments/verify (DB work included).
const AUDIT_BUDGET_MS = 54_000;
const MIN_DECIDE_MS = 15_000;

type AuditInput = {
  idea: string;
  sector: Sector;
  stage?: string;
  geography?: string;
  language?: ReportLanguage;
  /** Founder-confirmed scope. NEW_IDEA (or undefined) keeps the original audit behaviour. */
  scope?: Scope;
  /** Founder-confirmed, locked facts. Sent to Gemini by ID and enforced by validateReport. */
  founderFacts?: FounderFact[];
};

const GROWTH_PLAN_BLOCK = `
════════════════════════════════════════════════════════════════════════
SCOPE: EXISTING BUSINESS / GROWTH PLAN (founder-confirmed)
════════════════════════════════════════════════════════════════════════
The founder confirmed this business already operates. Treat it as an operating business, not an idea.
Use the CURRENT founder facts as the baseline and focus unitEconomics, experiments, thirtyDayPlan and
killOrScale on moving from the current numbers to the stated targets. Keep exactly the same JSON contract.
`;

const EVIDENCE_BLOCK = `
════════════════════════════════════════════════════════════════════════
EVIDENCE DISCIPLINE (Aristotle's core rule: research before judgement, evidence over confidence)
════════════════════════════════════════════════════════════════════════
You receive a RESEARCH BRIEF: questions Q#, each with a STATUS and verified findings R# (each from a source S#).
Founder facts are F#. These are the ONLY evidence. Your general knowledge is NOT evidence: anything you add
from it must be labelled INFERENCE or ASSUMPTION, never FACT, and must not be presented as researched.
Never invent a source, statistic, competitor, price, market size, regulation or URL.

decisionMemo
  decisionQuestion: the single decision the founder faces, in one plain sentence, specific to this business.
  criticalAssumptions: up to 3. Each MUST come from the research: a question whose STATUS is NOT_FOUND,
    PARTIAL or CONTRADICTORY (cite it in basedOnQuestions), or a finding that contradicts the founder's plan.
    Never write generic assumptions ("customers must pay", "the problem must be painful") — name the specific
    customer, behaviour, price, channel or rule at stake for THIS business.
    evidenceStatus: SUPPORTED | PARTIAL | UNKNOWN | CONTRADICTED. evidence: what the findings say, or
    "No evidence found in research". evidenceIds: the R#/F# used (required unless UNKNOWN).
    cheapestTest + experimentIndex: the matching experiment (1-5).
  proceedIf / changeModelIf: measurable conditions (numbers, thresholds, deadlines).
  evidenceStillRequired: every open question that matters, in plain words.

evidence (6–12 items): the key claims this report relies on, each tagged:
  FACT (only from a finding — cite R#) | FOUNDER (cite F#) | CALCULATION (from F#/R# numbers) |
  ASSUMPTION | HYPOTHESIS | INFERENCE. confidence: HIGH | MEDIUM | LOW. validation: how to check it.

UNKNOWN is a correct, respected answer. A short report with real findings and honest unknowns is better
than a long report of plausible guesses. Challenge the founder where findings contradict the plan.
`;

const PROVENANCE_BLOCK = `
════════════════════════════════════════════════════════════════════════
NUMERIC PROVENANCE (required on every unitEconomics row)
════════════════════════════════════════════════════════════════════════
concept: what the number measures (${[...FACT_CONCEPTS, 'contribution', 'cac', 'payback'].join(', ')}).
timeframe: CURRENT (already happening) | TARGET (founder goal) | PROPOSED (planned price or estimate) |
           CONDITIONAL | PROJECTION (what you calculate could happen) | ASSUMPTION (you introduced it).
provenance: FOUNDER_STATED (only for confirmed founder facts, with factId) | CALCULATED (derived only from
            founder facts or assumption rows, listed in inputs) | EXTERNAL (from research) |
            ASSUMPTION (introduced because the founder did not provide it) | HYPOTHESIS (to be tested).
basis: required for EXTERNAL / ASSUMPTION / HYPOTHESIS — say where the figure comes from.
Units must match the concept: counts never carry ₹, money always carries ₹, margins are %.
EXTERNAL rows must list the finding ids (R#) they come from in inputs. If a number is not founder-stated,
researched or calculated from those, DO NOT write a number: put the metric in unknownEconomics instead.
`;

// ---------------------------------------------------------------------------
// Gemini responseSchema — mirrors AuditReport exactly.
// unitEconomics now requires commentary + assumption.
// experiments is a new required top-level array of exactly 5 items.
// ---------------------------------------------------------------------------
const AUDIT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    decisionMemo: {
      type: 'object',
      properties: {
        decisionQuestion: { type: 'string' },
        criticalAssumptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assumption: { type: 'string' },
              whyItMatters: { type: 'string' },
              evidenceStatus: { type: 'string', enum: ['SUPPORTED', 'PARTIAL', 'UNKNOWN', 'CONTRADICTED'] },
              evidence: { type: 'string' },
              evidenceIds: { type: 'array', items: { type: 'string' } },
              cheapestTest: { type: 'string' },
              experimentIndex: { type: 'number' },
              basedOnQuestions: { type: 'array', items: { type: 'string' } },
            },
            required: ['assumption', 'whyItMatters', 'evidenceStatus', 'evidence', 'evidenceIds', 'cheapestTest', 'experimentIndex', 'basedOnQuestions'],
          },
        },
        proceedIf: { type: 'array', items: { type: 'string' } },
        changeModelIf: { type: 'array', items: { type: 'string' } },
        evidenceStillRequired: { type: 'array', items: { type: 'string' } },
      },
      required: ['decisionQuestion', 'criticalAssumptions', 'proceedIf', 'changeModelIf', 'evidenceStillRequired'],
    },
    unknownEconomics: {
      type: 'array',
      items: { type: 'object', properties: { metric: { type: 'string' }, whyUnknown: { type: 'string' }, howToEstablish: { type: 'string' } }, required: ['metric', 'whyUnknown', 'howToEstablish'] },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          type: { type: 'string', enum: ['FACT', 'FOUNDER', 'CALCULATION', 'ASSUMPTION', 'HYPOTHESIS', 'INFERENCE'] },
          sourceIds: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          validation: { type: 'string' },
        },
        required: ['claim', 'type', 'sourceIds', 'confidence', 'validation'],
      },
    },
    executiveSummary: { type: 'string' },
    score: { type: 'number' },
    verdict: { type: 'string' },
    oneLineVerdict: { type: 'string' },
    whatThisBusinessIs: { type: 'string' },
    whyItCouldWork: { type: 'array', items: { type: 'string' } },
    whatMustBeTrue: { type: 'array', items: { type: 'string' } },
    customer: {
      type: 'object',
      properties: {
        icp: { type: 'string' },
        problem: { type: 'string' },
        willingnessToPay: { type: 'string' },
      },
      required: ['icp', 'problem', 'willingnessToPay'],
    },
    businessModel: {
      type: 'object',
      properties: {
        revenueModel: { type: 'string' },
        pricingLogic: { type: 'string' },
        keyCostDrivers: { type: 'array', items: { type: 'string' } },
      },
      required: ['revenueModel', 'pricingLogic', 'keyCostDrivers'],
    },
    marketView: {
      type: 'object',
      properties: {
        marketType: { type: 'string' },
        demandSignal: { type: 'string' },
        competition: { type: 'string' },
        marketRisk: { type: 'string' },
      },
      required: ['marketType', 'demandSignal', 'competition', 'marketRisk'],
    },
    unitEconomics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          metric: { type: 'string' },
          conservative: { type: 'number' },
          base: { type: 'number' },
          upside: { type: 'number' },
          unit: { type: 'string' },
          commentary: { type: 'string' },
          assumption: { type: 'string' },
          concept: { type: 'string', enum: [...FACT_CONCEPTS, 'contribution', 'cac', 'payback'] },
          timeframe: { type: 'string', enum: ['CURRENT', 'TARGET', 'PROPOSED', 'CONDITIONAL', 'PROJECTION', 'ASSUMPTION'] },
          provenance: { type: 'string', enum: ['FOUNDER_STATED', 'CALCULATED', 'EXTERNAL', 'ASSUMPTION', 'HYPOTHESIS'] },
          factId: { type: 'string' },
          inputs: { type: 'array', items: { type: 'string' } },
          basis: { type: 'string' },
        },
        required: ['metric', 'conservative', 'base', 'upside', 'unit', 'commentary', 'assumption', 'concept', 'timeframe', 'provenance'],
      },
    },
    experiments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string' },
          test: { type: 'string' },
          metric: { type: 'string' },
          passThreshold: { type: 'string' },
          failThreshold: { type: 'string' },
        },
        required: ['hypothesis', 'test', 'metric', 'passThreshold', 'failThreshold'],
      },
    },
    operatingModel: { type: 'array', items: { type: 'string' } },
    technologyBuild: {
      type: 'object',
      properties: {
        mvp: { type: 'array', items: { type: 'string' } },
        avoidBuilding: { type: 'array', items: { type: 'string' } },
        estimatedBuildApproach: { type: 'string' },
      },
      required: ['mvp', 'avoidBuilding', 'estimatedBuildApproach'],
    },
    regulatory: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string' },
          rationale: { type: 'string' },
          action: { type: 'string' },
          source: { type: 'string' },
          trigger: { type: 'string' },
          activity: { type: 'string' },
          requirement: { type: 'string' },
          sourceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'status', 'rationale', 'action', 'activity', 'requirement', 'sourceIds'],
      },
    },
    vulnerabilities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          risk: { type: 'string' },
          probability: { type: 'string' },
          impact: { type: 'string' },
          whyItMatters: { type: 'string' },
          mitigation: { type: 'string' },
        },
        required: ['risk', 'probability', 'impact', 'whyItMatters', 'mitigation'],
      },
    },
    goToMarket: { type: 'array', items: { type: 'string' } },
    thirtyDayPlan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          week: { type: 'string' },
          objective: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
          successMetric: { type: 'string' },
        },
        required: ['week', 'objective', 'actions', 'successMetric'],
      },
    },
    killOrScale: {
      type: 'object',
      properties: {
        scaleWhen: { type: 'array', items: { type: 'string' } },
        pauseWhen: { type: 'array', items: { type: 'string' } },
      },
      required: ['scaleWhen', 'pauseWhen'],
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'executiveSummary', 'score', 'verdict', 'oneLineVerdict', 'whatThisBusinessIs',
    'whyItCouldWork', 'whatMustBeTrue', 'customer', 'businessModel', 'marketView',
    'unitEconomics', 'experiments', 'operatingModel', 'technologyBuild', 'regulatory',
    'vulnerabilities', 'goToMarket', 'thirtyDayPlan', 'killOrScale', 'assumptions', 'nextSteps',
    'decisionMemo', 'evidence', 'unknownEconomics',
  ],
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildPrompt(input: AuditInput, research: string): string {
  const lang =
    input.language === 'Hinglish'
      ? 'Write every string value in natural Indian Hinglish (Roman script). Keep business/legal terms in English and explain them simply.'
      : 'Write every string value in simple, direct English. Use short sentences. Avoid jargon.';

  return `You are Aristotle, an India-focused venture screening and business-model analysis engine.
You produce a paid founder decision memo for a specific business idea.

LANGUAGE: ${lang}
${input.scope === 'GROWTH_PLAN' ? GROWTH_PLAN_BLOCK : ''}${buildFounderFactsBlock(input.founderFacts)}${PROVENANCE_BLOCK}${EVIDENCE_BLOCK}
════════════════════════════════════════════════════════════════════════
OUTPUT CONTRACT
════════════════════════════════════════════════════════════════════════
Return ONLY the AuditReport JSON object defined by responseSchema.
Do not add fields. Do not rename fields. Do not use numbered sections as a JSON alternative.
Do not return markdown, code fences, or any text outside the JSON object.
Exact field names required: executiveSummary, score, verdict, oneLineVerdict,
whatThisBusinessIs, whyItCouldWork, whatMustBeTrue, customer, businessModel,
marketView, unitEconomics, experiments, operatingModel, technologyBuild, regulatory,
vulnerabilities, goToMarket, thirtyDayPlan, killOrScale, assumptions, nextSteps.

Before returning JSON, verify internally:
1. Did I use every founder-provided commercial number exactly?
2. Did I label assumptions as ASSUMPTION and facts as FACT?
3. Are all unit-economics values finite numbers with correct units?
4. Does every unitEconomics row have both commentary and assumption fields populated?
5. Does competition explain alternatives, not just list names?
6. Is regulation specific to the actual operating model — not a generic checklist?
7. Are vulnerabilities specific to this business?
8. Are scale/pause conditions measurable, not vague?
9. Did I produce exactly 5 experiments, each specific to this business?
10. Would this memo help the founder decide what to do in the next 7 days?

════════════════════════════════════════════════════════════════════════
FOUNDER INPUT — PRIMARY SOURCE OF TRUTH
════════════════════════════════════════════════════════════════════════
FOUNDER INPUT IS THE SOURCE OF TRUTH FOR THIS BUSINESS MODEL.
Extract every explicit commercial fact before making any assumption.
If the founder specifies pricing, customer type, AOV, transaction volume, commission,
subscription fee, operating model, geography, delivery model, inventory ownership,
payment flow, or any other economics — use those values exactly in the report.
Do not replace founder-provided numbers with generic sector assumptions.
If a value is not provided, label it explicitly as: (ASSUMPTION: [your estimate]).

Idea (verbatim):
${input.idea}

Sector:    ${input.sector}
Stage:     ${input.stage || 'Idea / pre-launch'}
Geography: ${input.geography || 'India'}

STEP 1 — EXTRACT (complete this before writing any section):
A. Paying customer: who exactly pays, their role, size, location
B. End user: who uses the product day-to-day (may differ from payer)
C. Problem: what painful workflow exists today, its frequency, its cost
D. Product: exactly what is being sold or enabled
E. Revenue model: subscription / per-transaction / commission / hybrid
F. Pricing: quote founder numbers exactly; if absent note as ASSUMPTION
G. Volume assumptions: orders/month, customers/month — from idea or label ASSUMPTION
H. Founder's role vs. partner/customer role: who does what
I. Key cost drivers: what costs scale with volume for THIS model
J. Operating model: how the business runs day-to-day

════════════════════════════════════════════════════════════════════════
FIELD INSTRUCTIONS — write each field using the extraction above
════════════════════════════════════════════════════════════════════════

executiveSummary
  3 sentences maximum.
  Sentence 1: name the specific customer and the specific problem they have today.
  Sentence 2: state the exact revenue model and pricing (use founder numbers if given).
  Sentence 3: state the score and the single most important risk.
  FORBIDDEN: "This is a large market." / "Recurring revenue is attractive."

score (0–100)
  Derive from six factors: problem urgency, willingness-to-pay evidence, unit-economics
  viability, regulatory complexity, competitive alternatives, execution risk.
  Weight each factor for THIS business. Do not default to 67.

verdict
  One sentence naming the specific core risk for this business.
  FORBIDDEN: "Execution will be key." / "Market timing matters."

oneLineVerdict
  One directive sentence: what should the founder do in the next 30 days?

whatThisBusinessIs
  Describe the exact business: what is sold, to whom, how it is delivered, how it is paid for,
  and what the founder owns vs. what they intermediate.

whyItCouldWork (3–5 strings)
  Each item must name a specific structural advantage of THIS business.
  Connect it to the actual model, customer pain, or market gap.
  FORBIDDEN: "The market is large." / "Technology is scalable."

whatMustBeTrue (4–6 strings)
  Falsifiable, specific assumptions. Each must be testable within 60 days.
  FORBIDDEN: "Customers must want the product." / "Pricing must be right."

customer.icp
  Name: segment, role, geography, size, digital literacy, current tooling.
  Distinguish: who pays vs. who uses vs. who can block adoption.

customer.problem
  Describe: current workflow, existing workaround, frequency, economic cost of the problem.
  Frequency, scale and cost are facts ONLY if the founder stated them or research found them: cite [F#] or [R#] inline.
  Otherwise write them as "Hypothesis: …" (e.g. "Hypothesis: parents look for such books weekly") — never as fact.
  Use FACT / ASSUMPTION / HYPOTHESIS labels.
  FORBIDDEN: inventing customer research not in the founder's idea.

customer.willingnessToPay
  What evidence or proxy exists? If no evidence, state: HYPOTHESIS — unverified.

businessModel.revenueModel
  Reconstruct exact money flow using founder-provided pricing. If unclear, state the ambiguity.

businessModel.pricingLogic
  Analyse the pricing logic. If founder gave numbers, use them. If not, label as ASSUMPTION.

businessModel.keyCostDrivers (4–6 strings)
  Specific costs for this operating model. Not "marketing" — name the actual cost item.

marketView.marketType
  Category dynamics specific to this business, not just the sector name.

marketView.demandSignal
  Proxies for demand. State VERIFIED or INFERENCE honestly.

marketView.competition
  Map what the customer can use TODAY. For each alternative: what they get, cost, weakness,
  advantage over this idea. Include do-nothing, manual workflow, existing software, funded rivals.
  Mark every unverified claim as (INFERENCE). A claim that competitors LACK something (personalisation, local content,
  a feature) is a fact only with a research citation [R#]; otherwise write "Hypothesis: competitors may not …".

marketView.marketRisk
  Single biggest market-level risk for this specific idea and operating model.

unitEconomics (0–8 rows) — numbers ONLY from:
  • founder facts (provenance FOUNDER_STATED, factId F#),
  • research findings (provenance EXTERNAL, inputs [R#…]),
  • transparent calculations from those (provenance CALCULATED, inputs = F#/R# ids or metrics of such rows).
  Never use sector averages, typical margins, benchmark CAC or guesses. An empty table is acceptable.
  Units must be specific (₹/customer/month, orders/month, months); never ₹ before a count.
  commentary: how the number was obtained. assumption: FOUNDER-STATED / RESEARCHED / CALCULATED + basis.

unknownEconomics — every important metric that could NOT be established (price, CAC, margin, volume, cost…):
  metric, whyUnknown (what research did not find), howToEstablish (the cheapest way to measure it).

experiments (EXACTLY 5 objects)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Produce EXACTLY 5 experiments. Not 4, not 6 — exactly 5.
  Each experiment must test one specific assumption of THIS business.
  Do NOT produce generic experiments applicable to any startup.
  Each experiment must be executable by the founder within 30 days at low cost.
  Each experiment must have a measurable, unambiguous pass and fail threshold.

  Required fields for each experiment:
  hypothesis:     The specific assumption being tested. Name the business, the customer,
                  the price or behaviour being tested. Not generic.
  test:           Exactly what the founder should do. Name the channel, the number of
                  prospects, the ask, and the timeframe.
  metric:         The single number or observation that determines the result.
  passThreshold:  A specific, measurable result that confirms the hypothesis.
  failThreshold:  A specific, measurable result that refutes the hypothesis.

  FORBIDDEN experiment types (too generic):
  - "Test if customers want this product" (not specific to this business)
  - "Validate the business model" (not a test)
  - "Check if technology works" (not a customer experiment)

  GOOD experiment examples (specific to a pharmacy platform):
  hypothesis: "Independent pharmacy owners in Tier-2 cities will pay ₹1,499/month before
              seeing measurable revenue uplift, based on time-saving alone."
  test: "Approach 15 independent pharmacies in one city. Present the product demo and
        ask for an upfront 3-month commitment at ₹1,499/month."
  metric: "Number of pharmacies that pay or sign a commitment letter out of 15 approached."
  passThreshold: "5 or more pharmacies commit or pay within 3 weeks."
  failThreshold: "Fewer than 3 pharmacies commit after 15 conversations."
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

operatingModel (3–5 strings)
  How this specific business runs day-to-day. Specific roles, manual vs automated steps.

technologyBuild.mvp (4–6 strings)
  Specific features that test the business hypothesis. Prefer manual validation first.

technologyBuild.avoidBuilding (3–5 strings)
  Features NOT to build yet, with a reason tied to the business stage.

technologyBuild.estimatedBuildApproach
  Concrete build path. Name the core technical decision for this product.

regulatory — ONLY conclusions supported by the research brief:
  activity (the specific activity in THIS business, from the business model), requirement (what the rule
  requires), name, status ("Likely"|"Conditional"|"Low signal"), rationale, action, sourceIds (R#/S# that
  support it — REQUIRED), source (leave empty; the server fills it from sourceIds).
  If research found nothing on a regulated activity, do NOT list a regulation for it — add
  "Confirm the regulation for <activity>" to decisionMemo.evidenceStillRequired instead.
  Never add GST/MSME/DPDP/BIS/RBI/SEBI/IRDAI by default. Say "Requires legal verification." where needed.

vulnerabilities (5–7 objects)
  Each risk specific to THIS business. probability/impact: Low/Medium/High.
  Include: willingness-to-pay risk, unit-economics risk, one operational risk,
  one competitive/disintermediation risk.

goToMarket (4–6 strings)
  Operational steps. Name segment, channel, first sales action, key objection, pilot structure.

thirtyDayPlan (exactly 4 objects: Week 1–4)
  Each: week, objective, actions (3–4 specific), successMetric (a number or observable fact).
  Weeks 1–2: customer validation. Weeks 3–4: paid pilot and economics measurement.

killOrScale.scaleWhen (4–5 strings)
  Measurable thresholds. Not vague.

killOrScale.pauseWhen (4–5 strings)
  Specific observable failure signals with thresholds.

assumptions (5–7 strings)
  Ranked by kill-potential. Label each: UNVERIFIED ASSUMPTION / INFERENCE / FOUNDER-STATED.

nextSteps (5–7 strings)
  Concrete this-week actions. Name the customer, channel, and test.

════════════════════════════════════════════════════════════════════════
RESEARCH BRIEF (Aristotle researched this business before this step — use ONLY this as evidence)
════════════════════════════════════════════════════════════════════════
${research}

════════════════════════════════════════════════════════════════════════
EVIDENCE RULES
════════════════════════════════════════════════════════════════════════
- Never invent a statistic, competitor name, regulation, price, or URL.
- Mark unverified claims: (INFERENCE) or (NOT VERIFIED).
- Cite findings (R#) for anything presented as researched. Do not write URLs yourself.
- If research is thin, say so — do not fill gaps with invented facts.
- Do not import financial-regulation sections unless the idea involves financial services.
- Distinguish: FACT (founder input or verified source) / ASSUMPTION (your estimate, labelled) /
  INFERENCE (from research, unverified).
`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
/**
 * The audit engine. Aristotle researches the specific business BEFORE writing the decision memo:
 *   PLAN → SEARCH → EXTRACT (see research.ts) → DECIDE (below).
 * There is no template path: without research credentials the audit fails (retryable), in every
 * environment including Demo Mode. Demo Mode only skips the Razorpay payment.
 *
 * `existingResearch`: research already completed for this audit (e.g. a retry after the decision stage
 * failed) is reused instead of searching again. `onResearch` persists research as soon as it exists.
 */
export async function runAudit(input: AuditInput, opts: { existingResearch?: ResearchRecord | null; onResearch?: (r: ResearchRecord) => Promise<void>; budgetMs?: number; usage?: UsageContext } = {}) {
  const start = Date.now();
  const deadline = start + (opts.budgetMs ?? AUDIT_BUDGET_MS);
  if (!process.env.GEMINI_API_KEY || !process.env.TAVILY_API_KEY) {
    throw new Error('AI_ENGINE_NOT_CONFIGURED: research or generation credentials are missing');
  }
  console.log(JSON.stringify({ event: 'aristotle_audit_start', sector: input.sector, stage: input.stage, geography: input.geography, scope: input.scope, founderFacts: input.founderFacts?.length ?? 0, reusedResearch: Boolean(opts.existingResearch) }));

  // RESEARCH (or reuse)
  // Complete research is reused as-is; a planning checkpoint resumes at the search stage (the plan is not redone).
  const checkpoint = isPlanCheckpoint(opts.existingResearch) ? opts.existingResearch.plan : null;
  let research = opts.existingResearch?.version === 2 && !checkpoint ? opts.existingResearch : null;
  const reusedResearch = Boolean(research);
  if (!research) {
    const facts = (input.founderFacts || []).filter((f) => f.locked);
    research = await researchBusiness({ idea: input.idea, sector: input.sector, stage: input.stage, geography: input.geography, founderFactsText: facts.map((f) => `${f.id}: ${f.concept} ${f.timeframe} ${f.raw}`).join('\n') }, deadline, undefined, { plan: checkpoint, onPlan: opts.onResearch, usage: opts.usage });
    if (opts.onResearch) await opts.onResearch(research);
  }
  const answered = (research.questions || []).filter((q) => q.status === 'ANSWERED' || q.status === 'PARTIAL').length;
  console.log(JSON.stringify({ event: 'aristotle_research_complete', questions: research.questions?.length ?? 0, answered, sources: research.sources.length, findings: research.findings?.length ?? 0, ms: Date.now() - start }));

  // DECIDE
  const decideTimeout = deadline - Date.now() - 1000;
  if (decideTimeout < MIN_DECIDE_MS) {
    throw new Error('AUDIT_TIME_BUDGET_EXCEEDED: research is saved; retry to complete the decision memo');
  }
  const decision = await aristotleGeminiJson<AuditReport>('decision', { label: 'decision', prompt: buildPrompt(input, researchBrief(research)), schema: AUDIT_RESPONSE_SCHEMA, maxOutputTokens: 12000, timeoutMs: decideTimeout }, opts.usage);

  // Prompting alone is not trusted: founder facts, numbers, citations, assumptions and regulation are enforced here.
  const { report: numbersChecked, log } = validateReport(decision.data, input.founderFacts);
  const { report, log: evidenceLog } = validateEvidence(numbersChecked, research, input.founderFacts);
  console.log(JSON.stringify({ event: 'aristotle_evidence_validated', ...evidenceLog, corrected: log.corrected.length, insertedFacts: log.insertedFacts.length, proseConflicts: log.proseConflicts.length }));

  const inputTokens = decision.inputTokens + (reusedResearch ? 0 : research.usage?.inputTokens ?? 0);
  const outputTokens = decision.outputTokens + (reusedResearch ? 0 : research.usage?.outputTokens ?? 0);
  console.log(JSON.stringify({ event: 'aristotle_audit_complete', inputTokens, outputTokens, ms: Date.now() - start }));
  return { research, report, pricing: estimateCompute(inputTokens, outputTokens), provider: 'aristotle-research-v2' };
}
