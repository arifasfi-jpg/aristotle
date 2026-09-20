import OpenAI from 'openai';
import { deterministicAudit, Sector, AuditReport, ReportLanguage } from './audit';
import { estimateCompute } from './pricing';

export async function runAudit(input: { idea: string; sector: Sector; stage?: string; geography?: string; language?: ReportLanguage }) {
  const fallback = deterministicAudit(input);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { report: fallback, pricing: estimateCompute(0, 0), provider: 'deterministic' };

  const client = new OpenAI({ apiKey: key });
  const languageInstruction = input.language === 'Hinglish'
    ? 'Write in natural Indian Hinglish: simple English mixed with common Hindi words in Roman script. Do not overdo slang. A founder should understand every sentence.'
    : 'Write in very simple, direct English. Short sentences. Avoid consulting jargon. Define any unavoidable business term in plain English.';
  const prompt = `You are Aristotle, an India-focused venture screening partner. Produce a rigorous, decision-useful founder report in the style of a top management consulting engagement, but do not imitate any firm's branding or proprietary language.

${languageInstruction}

Your job is NOT to praise the idea. Start with the answer, then show the evidence. Separate facts supplied by the founder from assumptions. Never invent market size, competitor revenue, regulatory certainty or customer demand. Use scenario estimates when data is missing and label them clearly.

Required report structure:
1. Bottom line: 3-5 sentence executive answer.
2. Screening score 0-100 with 3-5 explicit drivers; this is a screening score, not an investment recommendation.
3. What the business is and who pays.
4. Why it could work.
5. What must be true for it to work.
6. Ideal customer, pain and willingness-to-pay test.
7. Business model, pricing logic and key cost drivers.
8. Market/competition view focused on the customer's current alternative, not a made-up TAM.
9. Unit economics with conservative/base/upside scenarios. If inputs are missing, use clearly labelled illustrative assumptions.
10. Operating model and what should remain manual initially.
11. MVP technology build vs what NOT to build.
12. India regulatory radar: GST, MSME/Udyam, BIS, DPDP and sector-specific licensing where relevant. Treat this as screening, not legal advice.
13. Vulnerability matrix with probability, impact, why it matters and mitigation.
14. Go-to-market sequence.
15. 30-day plan split into four weeks with measurable success criteria.
16. Scale vs pause/kill criteria.
17. Assumptions and immediate next steps.

Founder input:
Idea: ${input.idea}
Sector: ${input.sector}
Stage: ${input.stage || 'Idea / pre-launch'}
Geography: ${input.geography || 'India'}

Return valid JSON matching the supplied schema. Keep each array item concrete and actionable. Avoid generic filler such as 'conduct market research'. Prefer numbers, tests, thresholds and observable evidence where possible. Keep the total report dense but readable.`;
  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      input: prompt,
      text: { format: { type: 'json_schema', name: 'aristotle_audit', strict: true, schema: {
        type:'object', properties:{
          executiveSummary:{type:'string'}, score:{type:'number'}, verdict:{type:'string'}, oneLineVerdict:{type:'string'}, whatThisBusinessIs:{type:'string'},
          whyItCouldWork:{type:'array',items:{type:'string'}}, whatMustBeTrue:{type:'array',items:{type:'string'}},
          customer:{type:'object',properties:{icp:{type:'string'},problem:{type:'string'},willingnessToPay:{type:'string'}},required:['icp','problem','willingnessToPay'],additionalProperties:false},
          businessModel:{type:'object',properties:{revenueModel:{type:'string'},pricingLogic:{type:'string'},keyCostDrivers:{type:'array',items:{type:'string'}}},required:['revenueModel','pricingLogic','keyCostDrivers'],additionalProperties:false},
          marketView:{type:'object',properties:{marketType:{type:'string'},demandSignal:{type:'string'},competition:{type:'string'},marketRisk:{type:'string'}},required:['marketType','demandSignal','competition','marketRisk'],additionalProperties:false},
          unitEconomics:{type:'array',items:{type:'object',properties:{metric:{type:'string'},conservative:{type:'number'},base:{type:'number'},upside:{type:'number'},unit:{type:'string'},commentary:{type:'string'}},required:['metric','conservative','base','upside','unit','commentary'],additionalProperties:false}},
          operatingModel:{type:'array',items:{type:'string'}}, technologyBuild:{type:'object',properties:{mvp:{type:'array',items:{type:'string'}},avoidBuilding:{type:'array',items:{type:'string'}},estimatedBuildApproach:{type:'string'}},required:['mvp','avoidBuilding','estimatedBuildApproach'],additionalProperties:false},
          regulatory:{type:'array',items:{type:'object',properties:{name:{type:'string'},status:{type:'string'},rationale:{type:'string'},action:{type:'string'},source:{type:'string'}},required:['name','status','rationale','action','source'],additionalProperties:false}},
          vulnerabilities:{type:'array',items:{type:'object',properties:{risk:{type:'string'},probability:{type:'string'},impact:{type:'string'},whyItMatters:{type:'string'},mitigation:{type:'string'}},required:['risk','probability','impact','whyItMatters','mitigation'],additionalProperties:false}},
          goToMarket:{type:'array',items:{type:'string'}}, thirtyDayPlan:{type:'array',items:{type:'object',properties:{week:{type:'string'},objective:{type:'string'},actions:{type:'array',items:{type:'string'}},successMetric:{type:'string'}},required:['week','objective','actions','successMetric'],additionalProperties:false}},
          killOrScale:{type:'object',properties:{scaleWhen:{type:'array',items:{type:'string'}},pauseWhen:{type:'array',items:{type:'string'}}},required:['scaleWhen','pauseWhen'],additionalProperties:false}, assumptions:{type:'array',items:{type:'string'}}, nextSteps:{type:'array',items:{type:'string'}}
        },required:['executiveSummary','score','verdict','oneLineVerdict','whatThisBusinessIs','whyItCouldWork','whatMustBeTrue','customer','businessModel','marketView','unitEconomics','operatingModel','technologyBuild','regulatory','vulnerabilities','goToMarket','thirtyDayPlan','killOrScale','assumptions','nextSteps'],additionalProperties:false
      }}}
    });
    const report = JSON.parse(response.output_text) as AuditReport;
    const usage = response.usage;
    return { report, pricing: estimateCompute(usage?.input_tokens || 0, usage?.output_tokens || 0), provider: 'openai' };
  } catch {
    return { report: fallback, pricing: estimateCompute(0, 0), provider: 'deterministic-fallback' };
  }
}
