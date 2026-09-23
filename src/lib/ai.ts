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


type TavilyResult = { title?: string; url?: string; content?: string; score?: number };

async function tavilySearch(query: string): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response: Response;
  try {
    response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'advanced',
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
    }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Tavily search timed out after 20 seconds for: ${query}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const data = await response.json();
  return Array.isArray(data?.results) ? data.results : [];
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

export async function runAudit(input: AuditInput) {
  const fallback = deterministicAudit(input);
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (!nvidiaKey || !tavilyKey) {
    return {
      report: fallback,
      pricing: estimateCompute(0, 0),
      provider: 'deterministic-no-key',
    };
  }

  const client = new OpenAI({
    apiKey: nvidiaKey,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    timeout: 90000,
    maxRetries: 0,
  });

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

FRESH WEB RESEARCH
${'__RESEARCH__'}

Return ONLY valid JSON matching the supplied schema exactly. Keep the report dense but readable. Do not add markdown outside the JSON.
`;

  try {
    console.log(JSON.stringify({
      event: 'aristotle_audit_start',
      sector: input.sector,
      stage: input.stage,
      geography: input.geography,
    }));

    const queries = [
      `"${input.idea}" ${input.geography || 'India'} regulations licensing compliance`,
      `${input.sector} ${input.geography || 'India'} current competitors alternatives pricing`,
      `${input.idea} ${input.geography || 'India'} customer demand market alternatives`,
      `${input.sector} ${input.geography || 'India'} official regulator rules platform costs`,
    ];

    // Run a small number of searches in parallel. Individual failures are tolerated,
    // but the audit never silently falls back to an unresearched report.
    const settled = await Promise.allSettled(
      queries.map(async (query) => ({ query, results: await tavilySearch(query) })),
    );
    const researchGroups = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (researchGroups.length === 0) {
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      throw new Error(`All Tavily research calls failed: ${failures.join(' | ')}`);
    }

    const research = researchGroups.map(({ query, results }) => [
      `SEARCH QUERY: ${query}`,
      ...results.map((r) => [
        `TITLE: ${r.title || 'Untitled'}`,
        `URL: ${r.url || ''}`,
        `CONTENT: ${(r.content || '').slice(0, 5000)}`,
      ].join('\n')),
    ].join('\n\n')).join('\n\n---\n\n').slice(0, 30000);

    const finalPrompt = prompt.replace("${'__RESEARCH__'}", research);

    const completion = await client.chat.completions.create({
      model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
      messages: [
        {
          role: 'system',
          content: 'You are a rigorous venture analyst. Follow the requested JSON schema exactly. Never invent evidence. Use the supplied research and clearly label uncertainty.',
        },
        { role: 'user', content: finalPrompt },
      ],
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 8000,
    });

    const text = completion.choices?.[0]?.message?.content;
    if (!text) throw new Error('NVIDIA returned an empty response');

    const report = JSON.parse(cleanJson(text)) as AuditReport;
    const usage = completion.usage;

    console.log(JSON.stringify({
      event: 'aristotle_audit_complete',
      inputTokens: usage?.prompt_tokens || 0,
      outputTokens: usage?.completion_tokens || 0,
      provider: 'nvidia-tavily',
    }));

    return {
      report,
      pricing: estimateCompute(usage?.prompt_tokens || 0, usage?.completion_tokens || 0),
      provider: 'nvidia-tavily-research',
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
