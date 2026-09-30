import { deterministicAudit, Sector, AuditReport, ReportLanguage } from './audit';
import { estimateCompute } from './pricing';
import { buildFounderFactsBlock, FACT_CONCEPTS, type FounderFact } from './founder-facts';
import { validateReport } from './report-validation';
import type { Scope } from './routing';
import { toResearchRecord, validateEvidence, type ResearchRecord } from './evidence';
import { isDemoMode } from './payments';

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
EVIDENCE DISCIPLINE (Aristotle's core rule: evidence over confidence)
════════════════════════════════════════════════════════════════════════
Research sources below are labelled [S1], [S2], … Founder facts are labelled F1, F2, …
Cite ONLY these ids. Never invent a source, statistic, competitor price, market size, regulation or URL.

decisionMemo
  decisionQuestion: the single decision the founder faces, in one plain sentence.
  criticalAssumptions: EXACTLY 3 — the assumptions that decide whether this business works (demand, price /
    willingness to pay, unit economics, channel, regulation…). For each:
    evidenceStatus: SUPPORTED (cited evidence supports it) | PARTIAL | UNKNOWN (no evidence yet) | CONTRADICTED.
    evidence: what the cited evidence actually says, or "No evidence yet".
    evidenceIds: the S#/F# ids used. SUPPORTED/PARTIAL/CONTRADICTED require at least one id.
    cheapestTest: the cheapest, fastest way to find out; experimentIndex: the matching experiment (1-5).
  proceedIf / changeModelIf: measurable conditions (numbers, thresholds, deadlines).
  evidenceStillRequired: what is unknown and must be validated before serious investment.

evidence (6–12 items): the key claims this report relies on, each tagged:
  FACT (from a cited source — sourceIds required) | FOUNDER (founder-confirmed fact — cite F#) |
  CALCULATION (derived from facts) | ASSUMPTION (your estimate) | HYPOTHESIS (must be tested) |
  INFERENCE (reasoned from evidence, not directly stated). confidence: HIGH | MEDIUM | LOW.
  validation: how the founder can check it.
If research is thin, say so. "Unknown" is an acceptable, honest answer.
Challenge the founder: if an assumption looks unrealistic or the economics do not work, say why and show the math.
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
If an input is missing, do not fill it with a sector default silently: mark it ASSUMPTION and give the basis.
`;

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

async function tavilySearch(query: string): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        max_results: 2,
        include_answer: false,
        include_raw_content: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TAVILY_ERROR ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`TAVILY_TIMEOUT after 12 seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
}

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
            },
            required: ['assumption', 'whyItMatters', 'evidenceStatus', 'evidence', 'evidenceIds', 'cheapestTest', 'experimentIndex'],
          },
        },
        proceedIf: { type: 'array', items: { type: 'string' } },
        changeModelIf: { type: 'array', items: { type: 'string' } },
        evidenceStillRequired: { type: 'array', items: { type: 'string' } },
      },
      required: ['decisionQuestion', 'criticalAssumptions', 'proceedIf', 'changeModelIf', 'evidenceStillRequired'],
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
        },
        required: ['name', 'status', 'rationale', 'action', 'source', 'trigger'],
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
    'decisionMemo', 'evidence',
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
  Mark every unverified claim as (INFERENCE).

marketView.marketRisk
  Single biggest market-level risk for this specific idea and operating model.

unitEconomics (3–8 rows)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CRITICAL RULES:
  • Build from the actual pricing and model described by the founder.
  • If pricing is given (e.g. ₹1,499/month + ₹5/order), model BOTH revenue streams.
  • Never substitute generic sector averages for founder-provided numbers.
  • All three scenario values (conservative, base, upside) must be finite numbers.
  • Conservative < Base < Upside for revenue rows; Upside < Base < Conservative for cost rows.
  • Units must be correct and specific: ₹/pharmacy/month, orders/pharmacy/month, ₹/order, months.
    Never put a currency symbol before a count (e.g. "300 orders" not "₹300 orders").
  • Every row MUST have both fields populated:
    - commentary: explain what this row measures and how the numbers were derived.
    - assumption: start with one of FOUNDER-STATED / ASSUMPTION / INFERENCE / NOT VERIFIED,
      then state the specific basis. Examples:
        FOUNDER-STATED: ₹1,499 monthly subscription as specified by founder.
        FOUNDER-STATED: ₹5 fee per successfully completed order.
        ASSUMPTION: 300 orders per pharmacy per month; requires pilot validation.
        NOT VERIFIED: WhatsApp API cost — depends on final messaging architecture.
  • Do not invent precise variable costs without labelling them NOT VERIFIED.
  • If contribution margin cannot be reliably calculated, say so explicitly in commentary.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Suggested structure for subscription + per-transaction model:
    Row 1: Monthly subscription revenue per active customer (unit: ₹/customer/month)
    Row 2: Orders processed per active customer per month (unit: orders/customer/month)
    Row 3: Per-order platform revenue (unit: ₹/order)
    Row 4: Total platform revenue per customer per month (unit: ₹/customer/month)
    Row 5: Estimated variable cost per customer per month (unit: ₹/customer/month)
    Row 6: Gross contribution per customer per month (unit: ₹/customer/month)
    Row 7: Customer acquisition cost (unit: ₹/customer)
    Row 8: CAC payback (unit: months)
  Adapt rows to fit the actual model.

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

regulatory
  ONLY include regulations triggered by the actual operating model.
  For each: name, status ("Likely"|"Conditional"|"Low signal"), rationale, trigger (the specific activity in
  THIS business that triggers it), action, source (a researched URL [S#] or the official regulator's .gov.in /
  regulator homepage; leave empty if unsure — unverifiable links are removed).
  Do NOT default-include GST/MSME/DPDP/BIS/RBI/SEBI/IRDAI.
  Say "Requires legal verification." where needed.

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
RESEARCH (use to improve market, competitor and regulatory sections)
════════════════════════════════════════════════════════════════════════
${research}

════════════════════════════════════════════════════════════════════════
EVIDENCE RULES
════════════════════════════════════════════════════════════════════════
- Never invent a statistic, competitor name, regulation, price, or URL.
- Mark unverified claims: (INFERENCE) or (NOT VERIFIED).
- Use real regulator URLs only. If unsure, use the regulator homepage.
- If research is thin, say so — do not fill gaps with invented facts.
- Do not import financial-regulation sections unless the idea involves financial services.
- Distinguish: FACT (founder input or verified source) / ASSUMPTION (your estimate, labelled) /
  INFERENCE (from research, unverified).
`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function runAudit(input: AuditInput) {
  const fallback = deterministicAudit(input);
  const geminiKey = process.env.GEMINI_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (!geminiKey || !tavilyKey) {
    // A paying founder must never receive a template dressed up as research. Outside Demo Mode this is a
    // failure (the audit stays paid and can be retried once the engine is configured).
    if (!isDemoMode()) throw new Error('AI_ENGINE_NOT_CONFIGURED: research or generation credentials are missing');
    return {
      research: null as ResearchRecord | null,
      report: validateEvidence(validateReport(fallback, input.founderFacts).report, null, input.founderFacts).report,
      pricing: estimateCompute(0, 0),
      provider: 'deterministic-no-key',
    };
  }

  let researchRecord: ResearchRecord | null = null;
  try {
    console.log(JSON.stringify({
      event: 'aristotle_audit_start',
      sector: input.sector,
      stage: input.stage,
      geography: input.geography,
      scope: input.scope,
      founderFacts: input.founderFacts?.length ?? 0,
    }));

    const geography = input.geography || 'India';
    const queries = [
      `"${input.idea}" ${geography} regulations licensing compliance`,
      `${input.sector} ${geography} competitors alternatives pricing`,
      `"${input.idea}" ${geography} customer demand market alternatives`,
    ];

    const settled = await Promise.allSettled(
      queries.map(async (query) => ({ query, results: await tavilySearch(query) })),
    );

    const groups = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );

    if (groups.length === 0) {
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      throw new Error(`All Tavily research calls failed: ${failures.join(' | ')}`);
    }

    // Evidence layer: every source gets a stable id that the report must cite; persisted as research.json.
    researchRecord = toResearchRecord(groups);
    const idByUrl = new Map(researchRecord.sources.map((src) => [src.url, src.id]));
    const research = groups.map(({ query, results }) => [
      `SEARCH: ${query}`,
      ...results.map((r) => [
        `[${idByUrl.get(r.url || '') ?? 'S?'}] TITLE: ${r.title || 'Untitled'}`,
        `URL: ${r.url || ''}`,
        `CONTENT: ${(r.content || '').slice(0, 1800)}`,
      ].join('\n')),
    ].join('\n')).join('\n---\n').slice(0, 14000);

    const finalPrompt = buildPrompt(input, research);

    let geminiResponse: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 38000);

      try {
        geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiKey,
            },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [{ text: finalPrompt }],
                },
              ],
              generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: AUDIT_RESPONSE_SCHEMA,
                maxOutputTokens: 16384, // decision memo + evidence register need headroom; truncated JSON fails the audit
              },
            }),
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const detail =
        error instanceof Error && error.name === 'AbortError'
          ? 'Request timed out after 38 seconds'
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`GEMINI_ERROR: ${detail}`);
    }

    if (!geminiResponse.ok) {
      const body = await geminiResponse.text();
      throw new Error(
        `GEMINI_ERROR: HTTP ${geminiResponse.status}: ${body.slice(0, 600)}`
      );
    }

    const geminiJson = await geminiResponse.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const text =
      geminiJson.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('') || '';

    if (!text) throw new Error('GEMINI_ERROR: Gemini returned an empty response');

    const parsed = JSON.parse(cleanJson(text)) as AuditReport;
    // Prompting alone is not trusted: founder facts, provenance, calculations and units are enforced here.
    const { report: numbersChecked, log } = validateReport(parsed, input.founderFacts);
    const { report, log: evidenceLog } = validateEvidence(numbersChecked, researchRecord, input.founderFacts);
    console.log(JSON.stringify({ event: 'aristotle_evidence_validated', sources: researchRecord?.sources.length ?? 0, ...evidenceLog }));
    console.log(JSON.stringify({ event: 'aristotle_report_validated', corrected: log.corrected.length, keptAsScenario: log.keptAsScenario.length, downgraded: log.downgraded.length, converted: log.converted.length, unitFixed: log.unitFixed.length, insertedFacts: log.insertedFacts.length, proseConflicts: log.proseConflicts.length }));
    const inputTokens = geminiJson.usageMetadata?.promptTokenCount || 0;
    const outputTokens = geminiJson.usageMetadata?.candidatesTokenCount || 0;

    console.log(JSON.stringify({
      event: 'aristotle_audit_complete',
      inputTokens,
      outputTokens,
      provider: 'gemini-structured-tavily',
    }));

    return {
      research: researchRecord,
      report,
      pricing: estimateCompute(inputTokens, outputTokens),
      provider: 'gemini-structured-tavily',
    };
  } catch (error) {
    console.error(
      'Aristotle research audit failed:',
      error instanceof Error ? error.message : error,
    );
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Research engine failed: ${message}`);
  }
}
