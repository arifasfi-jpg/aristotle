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

const auditSchema = {
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
        willingnessToPay: { type: 'string' }
      },
      required: ['icp', 'problem', 'willingnessToPay'],
      additionalProperties: false
    },
    businessModel: {
      type: 'object',
      properties: {
        revenueModel: { type: 'string' },
        pricingLogic: { type: 'string' },
        keyCostDrivers: { type: 'array', items: { type: 'string' } }
      },
      required: ['revenueModel', 'pricingLogic', 'keyCostDrivers'],
      additionalProperties: false
    },
    marketView: {
      type: 'object',
      properties: {
        marketType: { type: 'string' },
        demandSignal: { type: 'string' },
        competition: { type: 'string' },
        marketRisk: { type: 'string' }
      },
      required: ['marketType', 'demandSignal', 'competition', 'marketRisk'],
      additionalProperties: false
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
          commentary: { type: 'string' }
        },
        required: ['metric', 'conservative', 'base', 'upside', 'unit', 'commentary'],
        additionalProperties: false
      }
    },
    operatingModel: { type: 'array', items: { type: 'string' } },
    technologyBuild: {
      type: 'object',
      properties: {
        mvp: { type: 'array', items: { type: 'string' } },
        avoidBuilding: { type: 'array', items: { type: 'string' } },
        estimatedBuildApproach: { type: 'string' }
      },
      required: ['mvp', 'avoidBuilding', 'estimatedBuildApproach'],
      additionalProperties: false
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
          source: { type: 'string' }
        },
        required: ['name', 'status', 'rationale', 'action', 'source'],
        additionalProperties: false
      }
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
          mitigation: { type: 'string' }
        },
        required: ['risk', 'probability', 'impact', 'whyItMatters', 'mitigation'],
        additionalProperties: false
      }
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
          successMetric: { type: 'string' }
        },
        required: ['week', 'objective', 'actions', 'successMetric'],
        additionalProperties: false
      }
    },
    killOrScale: {
      type: 'object',
      properties: {
        scaleWhen: { type: 'array', items: { type: 'string' } },
        pauseWhen: { type: 'array', items: { type: 'string' } }
      },
      required: ['scaleWhen', 'pauseWhen'],
      additionalProperties: false
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'executiveSummary','score','verdict','oneLineVerdict','whatThisBusinessIs',
    'whyItCouldWork','whatMustBeTrue','customer','businessModel','marketView',
    'unitEconomics','operatingModel','technologyBuild','regulatory',
    'vulnerabilities','goToMarket','thirtyDayPlan','killOrScale',
    'assumptions','nextSteps'
  ],
  additionalProperties: false
};

export async function runAudit(input: AuditInput) {
  const fallback = deterministicAudit(input);
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return { report: fallback, pricing: estimateCompute(0, 0), provider: 'deterministic' };
  }

  const client = new OpenAI({ apiKey: key });

  const languageInstruction = input.language === 'Hinglish'
    ? 'Write in natural Indian Hinglish using Roman script. Use simple English mixed with common Hindi words. Do not overdo slang. Every sentence must be understandable to a normal Indian founder.'
    : 'Write in very simple, direct English. Short sentences. Avoid consulting jargon. If a business term is unavoidable, explain it in plain English.';

  const prompt = `
You are Aristotle, an India-focused venture screening partner.

Your job is to audit a founder's business idea, not to praise it and not to write generic startup advice.

The output must feel like a short paid decision memo prepared by a strong strategy team:
- Start with the answer.
- Analyse the actual idea.
- Be specific to the sector, customer, business model and geography.
- Challenge the founder's assumptions.
- Quantify wherever a reasonable calculation is possible.
- Clearly distinguish facts, sourced information, estimates and unknowns.
- Never manufacture customer demand, market size, competitor numbers, regulatory certainty or unit economics.
- If information is unavailable, say exactly what is unknown and give the cheapest practical test to find out.
- Do not use empty phrases such as "conduct market research", "leverage technology", "build a strong brand", or "focus on customer needs" unless you make them specific and measurable.

${languageInstruction}

RESEARCH RULES
1. Use web search when it materially improves the analysis, especially for Indian regulations, current competitors/substitutes, current market structure, credible market data, and current pricing or public business-model information.
2. Prefer primary sources: RBI, SEBI, IRDAI, NPCI, GST/CBIC, MeitY, BIS, Udyam/MSME, Ministry of Education, government portals and company websites.
3. For factual claims based on web research, include the source URL in the relevant text where practical.
4. Never invent a source or URL.
5. If no reliable source is available, label the statement as an estimate or assumption.
6. Regulatory analysis is screening only, not legal/tax advice.

UNIT ECONOMICS RULES
- Use founder-provided numbers if available.
- Otherwise use explicitly labelled illustrative assumptions.
- Explain important calculations in commentary, for example: "₹1,200 revenue - ₹540 direct variable cost = ₹660 gross contribution."
- Conservative/base/upside must represent different assumptions, not arbitrary numbers.
- If CAC is unknown, call it illustrative and specify how to validate it.
- Choose the correct unit for the business: customer/month, project, order, lead, device, transaction, etc.
- Do not force a transaction model onto a business where it makes no sense.

SCREENING SCORE
Give a 0-100 screening score, but do not pretend it is scientifically precise.
Base it on:
1. Problem severity/frequency
2. Evidence of willingness to pay
3. Market accessibility
4. Unit-economic potential
5. Execution/regulatory feasibility
If evidence is weak, reduce confidence and say why.

REQUIRED REPORT

1. Bottom line: 3-5 sentences answering what the business is, strongest reason it could work, biggest reason it could fail, and what the founder should do next.
2. Screening score with the main drivers.
3. Rewrite the raw idea into one clean business description and identify who pays.
4. Give 3 concrete, idea-specific mechanisms for why it could work.
5. Give 3-5 falsifiable conditions that must be true.
6. Identify a sharply defined initial ICP, specific pain, current workaround and switching reason.
7. State willingness-to-pay evidence and propose a paid pilot/deposit/pre-order/LOI or other observable commitment.
8. Identify who pays, what they pay for, when they pay, monetisation options and key gross-margin drivers.
9. Analyse the actual market. Identify direct competitors only when evidence exists, plus indirect competitors and the status quo. Do not invent TAM. If credible market data exists, give source/date; otherwise use bottom-up sizing and label it an estimate.
10. Give conservative/base/upside unit economics with revenue, direct variable cost/gross contribution, CAC and contribution after CAC where meaningful. Explain important numbers and confidence.
11. Explain what should remain manual, what can be outsourced, and what should eventually be automated.
12. Give the smallest MVP, what not to build, and the appropriate manual/no-code/low-code/software approach.
13. Cover GST, MSME/Udyam, BIS, DPDP and sector-specific requirements only where relevant. Use Likely/Conditional/Low signal, explain why, give an action, and prefer official sources.
14. Give at least 5 idea-specific risks with probability, impact, why it matters, mitigation and evidence needed.
15. Give a specific GTM sequence: first segment, acquisition route, offer, sales motion and proof point.
16. Give four weekly validation plans with concrete actions and PASS/FAIL success criteria.
17. Give observable scale conditions and pause/rethink conditions.
18. List important assumptions and clearly distinguish founder-provided facts from Aristotle assumptions.
19. Give no more than 5 immediate next steps, ordered by priority.

FOUNDER INPUT
Idea: ${input.idea}
Sector: ${input.sector}
Stage: ${input.stage || 'Idea / pre-launch'}
Geography: ${input.geography || 'India'}

FINAL QUALITY CHECK
Before returning JSON, internally challenge the report:
- If a statement would still be true after changing the idea, make it more specific.
- If a number was invented, convert it to an assumption and explain the formula.
- If something is called a competitor without evidence, label it as an alternative/category.
- If a regulatory conclusion depends on the exact activity, make it conditional.
- Ensure there is a clear first experiment with a pass/fail threshold.
- Ensure the first screen tells the founder what to do tomorrow morning.

Return valid JSON matching the supplied schema. Do not return markdown outside the JSON.
`;

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      tools: [{ type: 'web_search' }],
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'aristotle_audit',
          strict: true,
          schema: auditSchema
        }
      }
    });

    const report = JSON.parse(response.output_text) as AuditReport;
    const usage = response.usage;

    return {
      report,
      pricing: estimateCompute(usage?.input_tokens || 0, usage?.output_tokens || 0),
      provider: 'openai-web-research'
    };
  } catch {
    return {
      report: fallback,
      pricing: estimateCompute(0, 0),
      provider: 'deterministic-fallback'
    };
  }
}
