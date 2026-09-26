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
      throw new Error(`Tavily search failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Tavily search timed out after 12 seconds`);
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
    timeout: 45000,
    maxRetries: 0,
  });

  const languageInstruction =
    input.language === 'Hinglish'
      ? 'Write in natural Indian Hinglish in Roman script. Keep business terms in English and explain them simply.'
      : 'Write in very simple, direct English. Use short sentences. Avoid jargon.';

  const prompt = `
You are Aristotle, an India-focused venture screening and business-model analysis engine.

${languageInstruction}

Create a paid founder decision memo based on the founder's EXACT business idea and the supplied fresh research.

First reconstruct the model:
- what is sold
- customer, payer and beneficiary
- who fulfils it and owns inventory/assets
- money flow, refunds, delivery/disputes
- revenue unit and frequency
- monetisation
- platform operating activity
- business archetype
- biggest failure assumption

Then analyse:
- customer pain and willingness to pay
- current alternatives and 3-5 relevant competitors/substitutes where evidence supports them
- idea-specific unit economics with conservative/base/upside scenarios
- relevant Indian regulation only; identify the activity that triggers each rule
- operating model and manual MVP
- technology MVP and what NOT to build
- vulnerabilities with probability, impact and mitigation
- GTM and first 30 days
- measurable scale/pause criteria

Evidence rules:
- Prefer primary government/regulator/company sources.
- Never invent a statistic, competitor, regulation, pricing figure or URL.
- Clearly distinguish FOUNDER INPUT, VERIFIED, ASSUMPTION and INFERENCE.
- If evidence is unavailable, say "Not verified".
- Do not dump irrelevant GST/MSME/DPDP/BIS/RBI/SEBI/IRDAI rules into the report.

REQUIRED REPORT STRUCTURE
1. Bottom line
2. Screening score with five explicit drivers
3. What this business actually is
4. Why it could work
5. What must be true
6. Customer
7. Business model
8. Market & competition
9. Unit economics
10. Operating model
11. Technology build
12. India regulatory radar
13. Vulnerability matrix
14. Go-to-market
15. First 30 days
16. Scale / pause criteria
17. Assumptions
18. Next steps (maximum 7)

Keep the report dense but readable and specific to the idea. Do not give generic startup advice.

FOUNDER INPUT
Idea: ${input.idea}
Sector selected: ${input.sector}
Stage: ${input.stage || 'Idea / pre-launch'}
Primary geography: ${input.geography || 'India'}

FRESH WEB RESEARCH
__RESEARCH__

Return ONLY valid JSON. No markdown outside JSON.
`;

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

    const finalPrompt = prompt.replace('__RESEARCH__', research);

    const completion = await client.chat.completions.create({
      model: process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: 'You are a rigorous venture analyst. Return valid JSON only. Never invent evidence. Use supplied research and label uncertainty.',
        },
        { role: 'user', content: finalPrompt },
      ],
      temperature: 0.1,
      top_p: 0.8,
      max_tokens: 3500,
    });

    const text = completion.choices?.[0]?.message?.content;
    if (!text) throw new Error('NVIDIA returned an empty response');

    const report = JSON.parse(cleanJson(text)) as AuditReport;
    const usage = completion.usage;

    console.log(JSON.stringify({
      event: 'aristotle_audit_complete',
      inputTokens: usage?.prompt_tokens || 0,
      outputTokens: usage?.completion_tokens || 0,
      provider: 'nvidia-gpt-oss-tavily-fast',
    }));

    return {
      report,
      pricing: estimateCompute(usage?.prompt_tokens || 0, usage?.completion_tokens || 0),
      provider: 'nvidia-gpt-oss-tavily-fast',
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
