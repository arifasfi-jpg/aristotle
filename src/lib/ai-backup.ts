import OpenAI from 'openai';
import { deterministicAudit, Sector, AuditReport, ReportLanguage } from './audit';
import { estimateCompute } from './pricing';

type AuditInput = {
  idea: string;
  sector: Sector;
  stage?: string;
  geography?: string;
  language?: ReportLanguage;
};

export async function runAudit(input: AuditInput) {
  const fallback = deterministicAudit(input);
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return {
      report: fallback,
      pricing: estimateCompute(0, 0),
      provider: 'deterministic-no-key',
    };
  }

  const client = new OpenAI({ apiKey: key });

  const languageInstruction =
    input.language === 'Hinglish'
      ? `Write in natural Indian Hinglish using Roman script. Keep business terms such as CAC, AOV,
GMV, contribution margin and payback in English, but explain them simply. Do not use forced slang.`
      : `Write in very simple, direct English. Short sentences. Avoid consulting jargon.
If a business term is necessary, define it in plain English.`;

  const prompt = `
You are Aristotle, an India-focused venture screening and business-model analysis engine.

Your output is a paid founder decision memo. It must feel like a serious, evidence-led consulting engagement:
crisp, specific, quantified where possible, and directly tied to the founder's exact idea.

${languageInstruction}

CRITICAL RULE: Do NOT produce generic startup advice. Before analysing the idea, reconstruct the actual business model.

STEP 1 — RECONSTRUCT THE IDEA
Determine from the founder's description:
1. What exactly is being sold?
2. Who is the customer, payer and beneficiary?
3. Who fulfils it and who owns inventory/assets?
4. Who receives money and bears refunds, returns, delivery failures and disputes?
5. What is the transaction/revenue unit and likely frequency?
6. How does the business make money?
7. What operational activity does the platform itself perform?
8. What business archetype best describes it: SaaS, marketplace, transaction platform, commerce, services, fintech, infrastructure, consumer app, etc.?
9. What is the single biggest assumption that could make it fail?

Do not blindly trust the sector dropdown. Infer the business model from the idea. If ambiguous, state the ambiguity and analyse the most reasonable interpretation. Do not invent missing operating details.

STEP 2 — RESEARCH THE ACTUAL BUSINESS
Use web search before making substantive claims about current Indian regulations, licensing, named competitors, market data, current pricing, payment/API/platform costs or relevant industry facts.
Prefer primary sources: Indian government departments, regulators, statutory authorities, company websites, official pricing pages, annual reports and official documentation. Use reputable secondary sources only when primary data is unavailable.
Never invent a competitor, statistic, regulation, source or URL.
Distinguish important claims as VERIFIED, FOUNDER INPUT, ASSUMPTION or INFERENCE. If reliable current evidence cannot be found, say “Not verified”.

STEP 3 — ANALYSE THE REAL ALTERNATIVE
Competition is not just companies in the same sector. Identify what the target customer does TODAY instead: WhatsApp, calls, spreadsheets, POS/ERP, staff, marketplaces, banks, payment gateways, distributors, manual processes, etc.
Explain the current alternative's cost/pain, why the customer might switch, and why they might refuse. Name 3–5 relevant competitors/substitutes only when evidence supports them.

STEP 4 — BUILD IDEA-SPECIFIC UNIT ECONOMICS
Never use generic SaaS economics unless the actual business is SaaS.
Choose metrics matching the model. Examples: marketplace = orders × AOV × take-rate − payment − delivery − refunds − support − acquisition; transaction infrastructure = transaction value × fee − processing − support − acquisition; SaaS = customers × monthly revenue − hosting/API/support/sales; commerce = orders × gross margin − fulfilment − payment − returns − acquisition; services = projects × price − delivery cost − acquisition.
Show conservative/base/upside scenarios. Label every numeric assumption as founder input, researched figure or illustrative assumption. Where inputs are missing, show formulas and reasonable illustrative ranges rather than pretending they are known.
Calculate relevant metrics such as revenue per customer/order, gross contribution, contribution margin, CAC, CAC payback and break-even volume where applicable.

STEP 5 — REGULATORY RADAR
Do not dump a standard checklist into every report. Assess regulation based on what the business ACTUALLY DOES.
For each relevant item explain: why it applies/may apply; the activity that triggers it; what must be verified/obtained; whether the source is current law, official guidance, draft/proposed rule or historical material; and the actual source URL when available.
Potential areas include GST, MSME/Udyam, DPDP, consumer protection, BIS, Shops & Establishments and sector-specific licensing such as drugs/medical, RBI/payment, insurance, education, food, telecom, etc. Only include a sector-specific rule if the model actually touches that activity.
Example: software serving licensed pharmacies is not automatically the same as an e-pharmacy or drug seller. Analyse the distinction and how operational choices change regulatory exposure. Do not say “confirm RBI/IRDAI/SEBI” merely because an idea is digital or financial. Name the specific activity creating the question. This is screening information, not legal advice.

STEP 6 — DECISION ANALYSIS
Answer: what is this business really; why might customers pay; what must be true; what is the economic engine; biggest vulnerability; what to test before building; what NOT to build yet.
Use measurable hypotheses. Example: “Interview 20 target customers and test whether at least 6 will commit to a 30-day paid pilot at ₹X/month.” Clearly label such thresholds as proposed validation criteria, not industry facts.

STEP 7 — SCREENING SCORE
Provide a 0–100 screening score as an internal framework, not an investment rating. Base it on five explicit dimensions: customer pain/urgency, willingness to pay/monetisation, economic attractiveness, execution complexity, regulatory/dependency risk. Make drivers idea-specific.

REQUIRED REPORT STRUCTURE
1. Bottom line — 3–5 sentences answering the founder's question.
2. Screening score — 0–100 with explicit idea-specific drivers.
3. What this business actually is — operating model and money flow.
4. Why it could work — 3–5 evidence-linked reasons.
5. What must be true — 4–6 measurable hypotheses.
6. Customer — exact ICP, payer, beneficiary, pain and willingness-to-pay test.
7. Business model — revenue unit, pricing logic, money flow and variable costs.
8. Market & competition — current customer alternative + named competitors/substitutes.
9. Unit economics — conservative/base/upside with formulas and labelled assumptions.
10. Operating model — what must happen and what should remain manual initially.
11. Technology build — MVP versus what NOT to build.
12. India regulatory radar — only relevant rules, with current sources and status.
13. Vulnerability matrix — probability, impact, why it matters, mitigation.
14. Go-to-market — exact first customer acquisition sequence.
15. First 30 days — four weeks, actions and measurable success criteria.
16. Scale / pause criteria — numerical validation thresholds.
17. Assumptions — separate founder inputs from assumptions/inferences.
18. Next steps — maximum 7 concrete actions.

QUALITY BAR
Before returning JSON, silently check: Did I analyse the actual business model rather than its sector label? Did I identify who pays and what they pay for? Did I identify the customer's current alternative? Are unit economics specific? Did I avoid made-up market numbers? Did I research relevant current regulations? Did I avoid irrelevant regulations? Did I name real competitors/substitutes only when supported? Did I distinguish facts, founder inputs, assumptions and inference? Are the 30-day actions measurable? Could a founder actually make a build/test/pause decision from this report?

Founder input:
Idea: ${input.idea}
Sector selected by founder: ${input.sector}
Stage: ${input.stage || 'Idea / pre-launch'}
Primary geography: ${input.geography || 'India'}

Return valid JSON matching the supplied schema exactly. Keep the report dense but readable. Do not add markdown outside the JSON.
`;

  try {
    console.log(JSON.stringify({
      event: 'aristotle_audit_start',
      sector: input.sector,
      stage: input.stage,
      geography: input.geography,
    }));

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      tools: [{ type: 'web_search' }],
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'aristotle_audit',
          strict: true,
          schema: {
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
                additionalProperties: false,
              },
              businessModel: {
                type: 'object',
                properties: {
                  revenueModel: { type: 'string' },
                  pricingLogic: { type: 'string' },
                  keyCostDrivers: { type: 'array', items: { type: 'string' } },
                },
                required: ['revenueModel', 'pricingLogic', 'keyCostDrivers'],
                additionalProperties: false,
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
                additionalProperties: false,
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
                  additionalProperties: false,
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
                additionalProperties: false,
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
                  additionalProperties: false,
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
                  additionalProperties: false,
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
                  additionalProperties: false,
                },
              },
              killOrScale: {
                type: 'object',
                properties: {
                  scaleWhen: { type: 'array', items: { type: 'string' } },
                  pauseWhen: { type: 'array', items: { type: 'string' } },
                },
                required: ['scaleWhen', 'pauseWhen'],
                additionalProperties: false,
              },
              assumptions: { type: 'array', items: { type: 'string' } },
              nextSteps: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'executiveSummary','score','verdict','oneLineVerdict','whatThisBusinessIs',
              'whyItCouldWork','whatMustBeTrue','customer','businessModel','marketView',
              'unitEconomics','operatingModel','technologyBuild','regulatory','vulnerabilities',
              'goToMarket','thirtyDayPlan','killOrScale','assumptions','nextSteps'
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const report = JSON.parse(response.output_text) as AuditReport;
    const usage = response.usage;

    console.log(JSON.stringify({
      event: 'aristotle_audit_complete',
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
    }));

    return {
      report,
      pricing: estimateCompute(usage?.input_tokens || 0, usage?.output_tokens || 0),
      provider: 'openai-web-research',
    };
  } catch (error) {
    console.error(
      'Aristotle research audit failed:',
      error instanceof Error ? error.message : error,
    );
    throw new Error('Research engine failed. No unresearched fallback report was returned. Please retry the audit.');
  }
}
