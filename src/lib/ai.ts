import { deterministicAudit, Sector, AuditReport, ReportLanguage } from './audit';
import { estimateCompute } from './pricing';

type AuditInput = {
  idea: string;
  sector: Sector;
  stage?: string;
  geography?: string;
  language?: ReportLanguage;
};

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
// Gemini responseSchema — mirrors AuditReport exactly so field names and
// types are enforced by the model, not inferred from a free-text prompt.
// ---------------------------------------------------------------------------
const AUDIT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
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
        },
        required: ['metric', 'conservative', 'base', 'upside', 'unit', 'commentary'],
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
        },
        required: ['name', 'status', 'rationale', 'action', 'source'],
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
    'unitEconomics', 'operatingModel', 'technologyBuild', 'regulatory', 'vulnerabilities',
    'goToMarket', 'thirtyDayPlan', 'killOrScale', 'assumptions', 'nextSteps',
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

════════════════════════════════════════════════════════════════════════
OUTPUT CONTRACT
════════════════════════════════════════════════════════════════════════
Return ONLY the AuditReport JSON object defined by responseSchema.
Do not add fields. Do not rename fields. Do not use numbered sections as a JSON alternative.
Do not return markdown, code fences, or any text outside the JSON object.
Exact field names required: executiveSummary, score, verdict, oneLineVerdict,
whatThisBusinessIs, whyItCouldWork, whatMustBeTrue, customer, businessModel,
marketView, unitEconomics, operatingModel, technologyBuild, regulatory,
vulnerabilities, goToMarket, thirtyDayPlan, killOrScale, assumptions, nextSteps.

Before returning JSON, verify internally:
1. Did I use every founder-provided commercial number exactly?
2. Did I label assumptions as ASSUMPTION and facts as FACT?
3. Are all unit-economics values finite numbers with correct units?
4. Does competition explain alternatives, not just list names?
5. Is regulation specific to the actual operating model — not a generic checklist?
6. Are vulnerabilities specific to this business?
7. Are scale/pause conditions measurable, not vague?
8. Did I avoid generic consulting filler?
9. Does every section answer "why does THIS business have this conclusion"?
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
  GOOD: "Independent pharmacies in Tier-2 cities must be willing to pay ₹1,499/month
        before seeing measurable revenue uplift — not just after pilot."

customer.icp
  Name: segment, role, geography, size, digital literacy, current tooling.
  Distinguish: who pays vs. who uses vs. who can block adoption.

customer.problem
  Describe: current workflow, existing workaround, frequency, economic cost of the problem,
  and what the customer currently does about it.
  Use FACT / ASSUMPTION / HYPOTHESIS labels.
  FORBIDDEN: inventing customer research that was not in the founder's idea.

customer.willingnessToPay
  What evidence or proxy exists that this customer would pay this price?
  If founder provided pricing, analyse whether it is above or below the customer's
  cost of their current workaround. If no evidence exists, state: HYPOTHESIS — unverified.

businessModel.revenueModel
  Reconstruct exact money flow: who pays, what they pay, when, how much Aristotle keeps,
  what costs increase with volume.
  Use founder-provided pricing. If unclear, state the ambiguity.

businessModel.pricingLogic
  Analyse the logic behind the pricing — is it cost-plus, value-based, competitive, or arbitrary?
  If founder gave numbers, use them. If not, propose and label as ASSUMPTION.

businessModel.keyCostDrivers (4–6 strings)
  Costs specific to this operating model. Be concrete: not "marketing" but
  "outbound sales rep cost per pharmacy acquired" or "WhatsApp Business API per message."

marketView.marketType
  Describe the category dynamics specific to this business, not just the sector name.

marketView.demandSignal
  What proxies for demand exist? Be honest. State VERIFIED or INFERENCE.

marketView.competition
  Map what the customer can use TODAY — do not just list competitor names.
  For each alternative: what they get, what it costs, its weakness, its advantage over this idea.
  Include: (1) do nothing, (2) existing manual/phone/WhatsApp workflow,
  (3) existing software they may already use, (4) funded competitors if research supports them.
  Mark every unverified competitor claim as (INFERENCE).

marketView.marketRisk
  One sentence: the single biggest market-level risk specific to this idea and operating model.

unitEconomics (3–6 rows)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CRITICAL RULES:
  • Build from the actual pricing and model described by the founder.
  • If pricing is given (e.g. ₹1,499/month + ₹5/order), model BOTH revenue streams.
  • Never substitute generic sector averages for founder-provided numbers.
  • All three scenario values (conservative, base, upside) must be finite numbers.
  • Units must be meaningful: ₹, orders, months, %, customers — never mix units within a row.
  • Conservative < Base < Upside for revenue rows; Upside < Base < Conservative for cost rows.
  • Each commentary must explain the specific assumption behind the numbers.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Suggested structure for subscription + per-transaction model:
    Row 1: Monthly subscription revenue per active customer (unit: ₹/customer/month)
    Row 2: Orders processed per active customer per month (unit: orders/customer/month)
    Row 3: Per-order platform revenue (unit: ₹/order)
    Row 4: Total platform revenue per customer per month = row1 + (row2 × row3) (unit: ₹/customer/month)
    Row 5: Estimated variable cost per customer per month (unit: ₹/customer/month)
    Row 6: Gross contribution per customer per month = row4 - row5 (unit: ₹/customer/month)
    Row 7: Customer acquisition cost (unit: ₹/customer acquired)
    Row 8: CAC payback = row7 / row6 (unit: months)
  Adjust rows to fit the actual model. For pure subscription, omit per-order rows.
  For marketplace/commission model, use GMV and take-rate rows instead.
  Label every estimate that is not from the founder's input as (ASSUMPTION).

operatingModel (3–5 strings)
  Describe how this specific business operates day-to-day.
  Who onboards customers? Who handles support? Who manages the transaction?
  What is manual vs. automated? What scales with headcount vs. software?

technologyBuild.mvp (4–6 strings)
  Specific features to build first that directly test the business hypothesis.
  Prefer manual/concierge validation over engineering where possible.

technologyBuild.avoidBuilding (3–5 strings)
  Specific features NOT to build yet, with a reason tied to the business stage.

technologyBuild.estimatedBuildApproach
  Concrete build path for this specific product. Name the core technical decision.

regulatory
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ONLY include regulations actually triggered by the operating model.
  For each candidate rule, answer: "What specific activity in this business triggers this rule?"
  If the answer is "none clearly," set status to "Low signal" or omit.
  Do NOT include RBI/SEBI/IRDAI/lending/insurance rules unless the idea explicitly
  involves financial services.
  Do NOT add GST/MSME/DPDP/BIS as defaults — only include if materially relevant.
  For each item: name, status ("Likely"|"Conditional"|"Low signal"), rationale explaining
  the specific triggering activity, action the founder should take, source (real URL only —
  if uncertain, use the regulator's homepage URL, not an invented deep link).
  If something requires a lawyer to confirm, say: "Requires legal verification."
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

vulnerabilities (5–7 objects)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Each risk must be specific to THIS business model.
  For each: risk name, whyItMatters (tied to actual model), probability (Low/Medium/High),
  impact (Low/Medium/High), mitigation (concrete, not generic).
  Include at minimum: willingness-to-pay risk, unit-economics risk, one operational
  risk specific to the model, one competitive/disintermediation risk.
  FORBIDDEN: "Technology may not work." / "Market may not grow." (too generic)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

goToMarket (4–6 strings)
  Operational, specific steps.
  Name: first customer segment, geographic wedge if relevant, acquisition channel,
  founder's first sales action, key objection to test, pilot structure.
  FORBIDDEN: "Use social media." / "Build brand awareness."

thirtyDayPlan (exactly 4 objects: Week 1, Week 2, Week 3, Week 4)
  Each must have: week, objective, actions (array of 3–4 specific actions), successMetric.
  successMetric must be a number or observable fact, not a vague statement.
  Week 1–2: focus on customer validation, not technology.
  Week 3–4: first paid pilot or commitment, initial economics measurement.

killOrScale.scaleWhen (4–5 strings)
  Each criterion must be measurable with a specific threshold.
  FORBIDDEN: "When traction is good." / "When unit economics are positive."
  GOOD: "≥5 pharmacies paying ₹1,499/month for ≥2 consecutive months without discount."

killOrScale.pauseWhen (4–5 strings)
  Each must be a specific observable failure signal with a threshold.

assumptions (5–7 strings)
  List the most important assumptions underlying this analysis.
  Rank by kill-potential: the assumption whose failure would end the business first, last.
  Label each: UNVERIFIED ASSUMPTION / INFERENCE / FOUNDER-STATED.

nextSteps (5–7 strings)
  Concrete actions the founder can take this week.
  Each must be specific to this business: name the customer, the channel, the test.

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
- Distinguish throughout: FACT (from founder input or verified source) vs.
  ASSUMPTION (your estimate, labelled) vs. INFERENCE (from research, unverified).
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
    return {
      report: fallback,
      pricing: estimateCompute(0, 0),
      provider: 'deterministic-no-key',
    };
  }

  try {
    console.log(JSON.stringify({
      event: 'aristotle_audit_start',
      sector: input.sector,
      stage: input.stage,
      geography: input.geography,
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

    const research = groups.map(({ query, results }) => [
      `SEARCH: ${query}`,
      ...results.map((r) => [
        `TITLE: ${r.title || 'Untitled'}`,
        `URL: ${r.url || ''}`,
        `CONTENT: ${(r.content || '').slice(0, 1800)}`,
      ].join('\n')),
    ].join('\n')).join('\n---\n').slice(0, 14000);

    const finalPrompt = buildPrompt(input, research);

    let geminiResponse: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

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
                // responseSchema enforces exact field names and types — this is the
                // primary fix for generic/misnamed fields in the Gemini output.
                responseSchema: AUDIT_RESPONSE_SCHEMA,
                maxOutputTokens: 8192,
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
          ? 'Request timed out after 25 seconds'
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

    const report = JSON.parse(cleanJson(text)) as AuditReport;
    const inputTokens = geminiJson.usageMetadata?.promptTokenCount || 0;
    const outputTokens = geminiJson.usageMetadata?.candidatesTokenCount || 0;

    console.log(JSON.stringify({
      event: 'aristotle_audit_complete',
      inputTokens,
      outputTokens,
      provider: 'gemini-structured-tavily',
    }));

    return {
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
