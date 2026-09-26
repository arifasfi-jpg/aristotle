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
You produce a paid founder decision memo.

FOUNDER INPUT IS THE SOURCE OF TRUTH FOR THIS BUSINESS MODEL. Extract every explicit commercial fact from the founder's idea before making assumptions. If the founder specifies pricing, customer type, AOV, transaction volume, commission, subscription, operating model, geography, delivery model, or other economics, use those values in the report. Do not replace founder-provided economics with generic sector assumptions.

OUTPUT RULES
- Return ONLY the AuditReport JSON schema provided by responseSchema. Do not add extra fields. Do not use numbered sections as an alternative JSON structure. The JSON field names and types must exactly match the schema.
- No markdown outside the JSON. No commentary wrapping the JSON. No code fences.
- Do not invent field names. Use exactly: executiveSummary, score, verdict, oneLineVerdict, whatThisBusinessIs, whyItCouldWork, whatMustBeTrue, customer, businessModel, marketView, unitEconomics, operatingModel, technologyBuild, regulatory, vulnerabilities, goToMarket, thirtyDayPlan, killOrScale, assumptions, nextSteps.

LANGUAGE INSTRUCTION
${lang}

════════════════════════════════════════════════════════════
FOUNDER INPUT  — treat every field as the PRIMARY source of truth
════════════════════════════════════════════════════════════
Idea (verbatim):  ${input.idea}
Sector:           ${input.sector}
Stage:            ${input.stage || 'Idea / pre-launch'}
Geography:        ${input.geography || 'India'}

STEP 1 — EXTRACT FROM THE IDEA ABOVE (before writing anything):
• Who is the specific paying customer? (job title, business type, size, location)
• What exact painful problem exists TODAY for that customer?
• What is the proposed product or service?
• What is the revenue model? (subscription, per-transaction, hybrid, etc.)
• If pricing is mentioned, quote it exactly — do NOT replace it with a sector default.
• What does the founder do vs. what the customer/partner does?
• What are the primary cost drivers for THIS business?

STEP 2 — BUILD THE REPORT using your extraction above.

════════════════════════════════════════════════════════════
FIELD-BY-FIELD INSTRUCTIONS
════════════════════════════════════════════════════════════

executiveSummary (string)
  2–3 sentences. Name the specific customer, problem, revenue model and score.
  BAD: "This is a SaaS business with recurring revenue."
  GOOD: "Aristotle-Rx targets independent pharmacy owners in Tier-2 India who manage inventory manually. The ₹1,499/month + ₹5/order model needs ~40 active dispensing pharmacies to cover cloud + support costs. Score: 61/100 — demand is plausible but the sales cycle to pharmacy owners is long and the competitive set includes well-funded players."

score (number, 0–100)
  Derive from: problem urgency, willingness to pay evidence, unit economics viability,
  regulatory risk, competitive intensity, founder execution risk.
  Do not default to 67. Justify internally.

verdict (string) — one clear sentence on the core risk.

oneLineVerdict (string) — single sentence action directive for the founder.

whatThisBusinessIs (string)
  Describe the EXACT business, not the sector. Name what is sold, to whom, how delivered, how paid.

whyItCouldWork (array of strings, 3–5 items)
  Must be specific to THIS business. Not generic startup wisdom.

whatMustBeTrue (array of strings, 4–6 items)
  Specific falsifiable assumptions. Not generic startup checklist.

customer
  icp: Name the specific customer segment, geography, firmographic or demographic profile.
  problem: Describe the current painful workaround and its cost in time/money/risk.
  willingnessToPay: What evidence or proxy suggests they will pay? At what price point?

businessModel
  revenueModel: Describe the exact revenue streams as described or implied by the founder.
  pricingLogic: If pricing is specified in the idea, use it. Analyse the logic behind it.
                If not specified, propose a specific model with reasoning.
  keyCostDrivers: Array of 4–6 cost items specific to this operating model.

marketView
  marketType: Category and dynamics specific to this business.
  demandSignal: What early demand evidence exists or is implied? Be honest about uncertainty.
  competition: Name actual competitors or substitutes from research. Include "do nothing" and
               existing manual/software alternatives. Mark unverified names as INFERENCE.
  marketRisk: The single biggest market-level risk specific to this idea.

unitEconomics (array of 3–6 rows)
  CRITICAL: Build from the actual business model and pricing described.
  If the idea mentions ₹1,499/month + ₹5/order, model BOTH streams.
  Do NOT use generic sector averages as the primary estimate.
  Each row: metric, conservative (number), base (number), upside (number), unit (string),
  commentary (string explaining the assumption behind the numbers).
  All three scenario values must be finite numbers (integers or decimals). No strings, no nulls.
  Suggested rows for subscription+transaction model:
    - Monthly subscription revenue per customer
    - Orders processed per customer per month
    - Revenue per order
    - Gross contribution per customer per month
    - Customer acquisition cost
    - Months to payback
  Adjust row selection to fit the actual business model.

operatingModel (array of strings, 3–5 items)
  How the business actually runs day-to-day. Specific to this idea.

technologyBuild
  mvp: 4–6 specific things to build first for THIS product.
  avoidBuilding: 3–5 things NOT to build yet, specific to this idea.
  estimatedBuildApproach: Concrete build path for this product.

regulatory (array of objects)
  ONLY include regulations triggered by the ACTUAL business activity.
  For each rule ask: "Does this business actually do the activity that triggers this rule?"
  If not triggered, OMIT it. Do not include GST/MSME/DPDP/BIS/RBI/SEBI/IRDAI by default.
  Each object: name, status ("Likely"|"Conditional"|"Low signal"), rationale, action, source (real URL).
  For a pharmacy software platform: include Drugs & Cosmetics Act only if dispensing is involved;
  include IT Act/DPDP if patient data is processed; include GST only if it materially affects the model.

vulnerabilities (array of 4–6 objects)
  Risks specific to THIS business. probability and impact: "Low"|"Medium"|"High".
  Not a generic startup risk checklist.

goToMarket (array of strings, 4–6 items)
  Specific, actionable GTM steps for this customer and this product.

thirtyDayPlan (array of exactly 4 objects: Week 1, Week 2, Week 3, Week 4)
  Each: week, objective, actions (array of strings), successMetric.
  Tailor to the specific validation milestones for this business.

killOrScale
  scaleWhen: 4–5 specific, measurable criteria for THIS business.
  pauseWhen: 4–5 specific warning signals for THIS business.

assumptions (array of strings, 4–6 items)
  State the key assumptions underlying this analysis. Be honest about what is INFERENCE vs VERIFIED.

nextSteps (array of strings, 5–7 items)
  Concrete actions the founder should take this week. Specific to this idea.

════════════════════════════════════════════════════════════
RESEARCH  (use to improve market, competitor, regulatory sections)
════════════════════════════════════════════════════════════
${research}

════════════════════════════════════════════════════════════
EVIDENCE RULES
════════════════════════════════════════════════════════════
- Never invent a statistic, competitor name, regulation, price or URL.
- Mark unverified claims with (INFERENCE) or (NOT VERIFIED).
- Prefer primary government/regulator/company sources for regulatory URLs.
- If research is thin, reflect genuine uncertainty — do not fill gaps with generic advice.
- Do not import financial-regulation sections (RBI, SEBI, IRDAI, lending, insurance)
  unless the founder's idea explicitly involves those activities.
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
