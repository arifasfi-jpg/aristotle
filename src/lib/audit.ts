export type Sector = 'Quick Commerce' | 'D2C / Consumer' | 'B2B SaaS' | 'Digital Agency' | 'Fintech' | 'Healthtech' | 'Edtech' | 'Marketplace' | 'Manufacturing' | 'Other';
export type ReportLanguage = 'Simple English' | 'Hinglish';

export type AuditReport = {
  executiveSummary: string;
  score: number;
  verdict: string;
  oneLineVerdict: string;
  whatThisBusinessIs: string;
  whyItCouldWork: string[];
  whatMustBeTrue: string[];
  customer: { icp: string; problem: string; willingnessToPay: string };
  businessModel: { revenueModel: string; pricingLogic: string; keyCostDrivers: string[] };
  marketView: { marketType: string; demandSignal: string; competition: string; marketRisk: string };
  unitEconomics: { metric: string; conservative: number; base: number; upside: number; unit: string; commentary?: string }[];
  operatingModel: string[];
  technologyBuild: { mvp: string[]; avoidBuilding: string[]; estimatedBuildApproach: string };
  regulatory: { name: string; status: 'Likely' | 'Conditional' | 'Low signal'; rationale: string; action: string; source: string }[];
  vulnerabilities: { risk: string; probability: 'Low' | 'Medium' | 'High'; impact: 'Low' | 'Medium' | 'High'; whyItMatters: string; mitigation: string }[];
  goToMarket: string[];
  thirtyDayPlan: { week: string; objective: string; actions: string[]; successMetric: string }[];
  killOrScale: { scaleWhen: string[]; pauseWhen: string[] };
  assumptions: string[];
  nextSteps: string[];
};

const isHinglish = (language: ReportLanguage) => language === 'Hinglish';

export function deterministicAudit(input: { idea: string; sector: Sector; stage?: string; geography?: string; language?: ReportLanguage }): AuditReport {
  const t = input.idea.toLowerCase();
  const lang = input.language || 'Simple English';
  const physical = ['Quick Commerce','D2C / Consumer','Manufacturing'].includes(input.sector) || /(store|warehouse|food|device|electronics|product|manufactur|inventory|delivery)/.test(t);
  const data = ['B2B SaaS','Digital Agency','Fintech','Healthtech','Edtech','Marketplace','Quick Commerce','D2C / Consumer'].includes(input.sector) || /(app|platform|saas|customer data|personal data|users|whatsapp|payment)/.test(t);
  const money = input.sector === 'Fintech' || /(loan|lending|credit|wallet|payment|insurance|investment|nidhi|nbfc)/.test(t);
  const bis = input.sector === 'Manufacturing' || /(electronics|charger|toy|helmet|appliance|battery|steel|cement|device)/.test(t);
  const subscription = ['B2B SaaS','Digital Agency'].includes(input.sector);
  const price = subscription ? (input.sector === 'B2B SaaS' ? 5000 : 15000) : input.sector === 'Quick Commerce' ? 450 : input.sector === 'Marketplace' ? 700 : 1200;
  const grossMargin = input.sector === 'Quick Commerce' ? 0.18 : input.sector === 'Marketplace' ? 0.22 : input.sector === 'D2C / Consumer' ? 0.35 : subscription ? 0.70 : 0.55;
  const cac = input.sector === 'Digital Agency' ? 15000 : input.sector === 'B2B SaaS' ? 12000 : input.sector === 'Quick Commerce' ? 180 : 350;
  const unit = subscription ? '₹ / customer / month' : '₹ / transaction';
  const contribution = Math.round(price * grossMargin);
  const score = Math.max(38, Math.min(86, 67 + (input.sector === 'B2B SaaS' ? 8 : 0) - (money ? 9 : 0) - (physical ? 4 : 0)));

  const simple = isHinglish(lang);
  const verdict = score >= 75 ? (simple ? 'Idea mein potential hai, but pehle small paid pilot se proof chahiye.' : 'Promising, but prove demand and economics before scaling.') : score >= 58 ? (simple ? 'Potential hai, lekin kuch critical assumptions abhi prove nahi hue hain.' : 'Potentially viable, but several critical assumptions need proof.') : (simple ? 'Abhi uncertainty high hai. Pehle core demand validate karo.' : 'Uncertainty is high. Validate the core demand before investing heavily.');

  const regulatory = [
    { name: 'GST', status: 'Likely' as const, rationale: simple ? 'Business mein taxable sales/services ho sakti hain. GST registration turnover, supply type aur exceptions par depend karega.' : 'GST registration and invoicing depend on taxable supplies, turnover, supply type and applicable exceptions.', action: simple ? 'Expected turnover, states, taxable supplies aur inter-state/e-commerce flows map karke CA se confirm karein.' : 'Map expected turnover, states, taxable supplies and inter-state/e-commerce flows with a tax professional.', source: 'https://cbic-gst.gov.in/faq.html' },
    { name: 'MSME / Udyam', status: 'Likely' as const, rationale: simple ? 'Indian operating business ke liye Udyam eligibility check karna useful hai; registration government portal par free hai.' : 'An Indian operating business should assess Udyam eligibility; registration is available through the government portal.', action: simple ? 'Current investment aur turnover classification check karke official Udyam portal use karein.' : 'Check current investment and turnover classification and use the official Udyam portal.', source: 'https://www.udyamregistration.gov.in/' },
    { name: 'BIS', status: bis ? 'Likely' as const : 'Conditional' as const, rationale: bis ? 'Product category compulsory certification/QCO regime mein aa sakti hai.' : 'BIS is product-specific and becomes mandatory where a government order/QCO applies.', action: simple ? 'Exact SKU/category identify karke current BIS compulsory lists check karein.' : 'Identify the exact SKU/category and check the current BIS compulsory-certification/QCO lists.', source: 'https://www.bis.gov.in/product-certification/products-under-compulsory-certification/' },
    { name: 'DPDP', status: data ? 'Likely' as const : 'Conditional' as const, rationale: data ? 'Business likely digital personal data process karega, so privacy controls launch se pehle design karne honge.' : 'Applicability depends on whether and how the business processes digital personal data.', action: simple ? 'Data map karein: kya collect kar rahe hain, kyun, kitne time ke liye, kiske saath share hota hai.' : 'Map personal-data flows, purpose, notices, lawful basis, processor contracts, retention and user-rights workflows.', source: 'https://www.meity.gov.in/static/uploads/2024/02/Digital-Personal-Data-Protection-Act-2023.pdf' },
    { name: 'Sector licensing', status: money ? 'Likely' as const : 'Conditional' as const, rationale: money ? 'Idea regulated financial activity ko touch karta hai.' : 'No specific sector licence is inferred from the intake alone.', action: money ? 'Exact regulated activity define karke RBI/IRDAI/SEBI or relevant framework validate karein.' : 'Confirm sector and state-specific rules before launch.', source: 'https://www.rbi.org.in/' }
  ];

  const unitEconomics = [
    { metric: 'Revenue / unit', conservative: Math.round(price*.8), base: price, upside: Math.round(price*1.25), unit, commentary: simple ? 'Real customer pricing se replace karein.' : 'Replace with observed customer pricing.' },
    { metric: 'Gross contribution', conservative: Math.round(contribution*.7), base: contribution, upside: Math.round(contribution*1.2), unit, commentary: simple ? 'Direct delivery/service/product cost minus revenue.' : 'Revenue less direct variable cost.' },
    { metric: 'Acquisition cost', conservative: Math.round(cac*1.3), base: cac, upside: Math.round(cac*.75), unit: '₹ / acquired customer', commentary: 'Illustrative CAC; validate through a paid acquisition or sales pilot.' },
    { metric: 'Contribution after CAC', conservative: Math.round(contribution*.7-cac*1.3), base: contribution-cac, upside: Math.round(contribution*1.2-cac*.75), unit: '₹ / acquired customer', commentary: 'Positive is necessary but not sufficient; payback period also matters.' }
  ];

  const vulnerabilities = [
    { risk: 'Demand validation', probability: 'High' as const, impact: 'High' as const, whyItMatters: simple ? 'Idea achha lagna aur customer ka paisa dena alag cheez hai.' : 'Interest is not the same as willingness to pay.', mitigation: simple ? '10–20 target customers ke saath paid/manual pilot run karein.' : 'Run a paid or commitment-based pilot with 10–20 target customers.' },
    { risk: 'Unit economics', probability: 'High' as const, impact: 'High' as const, whyItMatters: simple ? 'Scale karne par loss bhi scale ho sakta hai.' : 'Scaling can amplify losses if contribution is weak.', mitigation: simple ? 'CAC, gross contribution, fulfilment/service cost aur payback daily/weekly track karein.' : 'Track CAC, gross contribution, service/fulfilment cost and payback from the first customers.' },
    { risk: 'Regulatory interpretation', probability: money || bis ? 'High' as const : 'Medium' as const, impact: 'High' as const, whyItMatters: simple ? 'Wrong structure se launch delay ya compliance cost aa sakti hai.' : 'Incorrect assumptions can create launch delays or compliance cost.', mitigation: simple ? 'Exact activity map karke specialist CA/lawyer/compliance advisor se validate karein.' : 'Map the exact activity and validate with a relevant professional before launch.' },
    { risk: 'Execution bandwidth', probability: 'High' as const, impact: 'Medium' as const, whyItMatters: simple ? 'Too many features se founder ka focus toot sakta hai.' : 'Too many features can dilute founder focus.', mitigation: simple ? 'One ICP, one wedge, one core workflow aur one 30-day metric rakhein.' : 'Choose one ICP, one wedge, one core workflow and one 30-day metric.' },
    { risk: 'Platform / channel dependency', probability: data ? 'Medium' as const : 'Low' as const, impact: 'Medium' as const, whyItMatters: simple ? 'WhatsApp, marketplaces ya APIs ke rules badal sakte hain.' : 'Third-party platform or API changes can affect distribution or operations.', mitigation: simple ? 'Data, source code aur customer relationship portable rakhein; single-channel dependency avoid karein.' : 'Keep code, data and customer relationships portable; avoid single-channel dependency.' }
  ];

  return {
    executiveSummary: simple
      ? `Bottom line: ${verdict} ${input.sector} mein biggest question demand + unit economics hai. Aristotle ke current assumptions ke hisaab se score ${score}/100 hai. Is score ko investment decision na samjhein; yeh screening signal hai.`
      : `Bottom line: ${verdict} The core question is whether customers will pay at a price that leaves enough contribution after variable cost and acquisition. Aristotle's current screening score is ${score}/100; it is a decision aid, not an investment recommendation.`,
    score,
    verdict,
    oneLineVerdict: simple ? `${verdict} Pehle proof, phir scale.` : `${verdict} Prove first, then scale.`,
    whatThisBusinessIs: simple ? `Aapka idea ${input.sector} business hai jo ${input.idea.slice(0, 220)}${input.idea.length > 220 ? '…' : ''}` : `This is a ${input.sector} business built around: ${input.idea.slice(0, 260)}${input.idea.length > 260 ? '…' : ''}`,
    whyItCouldWork: [
      simple ? 'Customer ki problem clear aur frequent honi chahiye.' : 'The problem should be frequent, painful and easy for the customer to recognise.',
      simple ? 'Narrow ICP ke saath sales story simple ho sakti hai.' : 'A narrow ICP can make the sales proposition much easier to prove.',
      simple ? 'Agar repeat usage aata hai to economics improve ho sakti hai.' : 'Repeat usage can improve economics and create operating leverage.'
    ],
    whatMustBeTrue: [
      simple ? 'Target customer real problem ke liye pay kare.' : 'The target customer must pay for the problem being solved.',
      simple ? 'Variable cost ke baad healthy contribution bache.' : 'Contribution after variable costs must be positive and improve with scale.',
      simple ? 'Acquisition channel repeatable ho.' : 'At least one customer-acquisition channel must become repeatable.',
      simple ? 'Operational complexity revenue ke saath control mein rahe.' : 'Operational complexity must not grow faster than revenue.'
    ],
    customer: {
      icp: simple ? `Start with one sharply defined customer group in ${input.geography || 'India'}.` : `Start with one sharply defined customer group in ${input.geography || 'India'}.`,
      problem: simple ? 'Customer ka current workaround kya hai, aur usmein kitna time/paisa/risk waste hota hai — this must be proven.' : 'Prove the current workaround, its cost and why the customer would switch.',
      willingnessToPay: simple ? 'Interview se zyada useful paid pilot, deposit ya signed commitment hai.' : 'A paid pilot, deposit or signed commitment is stronger evidence than interview enthusiasm.'
    },
    businessModel: {
      revenueModel: subscription ? (input.sector === 'B2B SaaS' ? 'Recurring SaaS subscription' : 'Project/retainer fee') : 'Transaction or product-linked revenue',
      pricingLogic: simple ? 'Price ko customer value + competitor benchmark + gross contribution ke against test karein.' : 'Test price against customer value, competitor alternatives and required gross contribution.',
      keyCostDrivers: physical ? ['Inventory / procurement', 'Fulfilment / delivery', 'Returns / wastage', 'Customer acquisition'] : ['People / delivery cost', 'Cloud / software', 'Customer acquisition', 'Support / operations']
    },
    marketView: {
      marketType: subscription ? 'Recurring B2B / professional service' : physical ? 'Operationally intensive consumer market' : 'Digital / service-led market',
      demandSignal: simple ? 'Strongest signal = customer actually pays or commits.' : 'The strongest early demand signal is payment or a credible commercial commitment.',
      competition: simple ? 'Competition ko features se nahi, customer ke current alternative se compare karein.' : "Compare against the customer's current alternative, not only direct feature competitors.",
      marketRisk: simple ? 'Top-down TAM se zyada important hai first 100 customers ka reachable market.' : 'Reachable demand among the first 100 customers matters more than a large top-down TAM.'
    },
    unitEconomics,
    operatingModel: [
      simple ? 'Founder-led sales and customer discovery first.' : 'Founder-led sales and customer discovery first.',
      simple ? 'Manual/concierge workflow se repeatability prove karein.' : 'Use a manual or concierge workflow before automating the full process.',
      simple ? 'Only bottlenecks automate karein; everything build mat karein.' : 'Automate bottlenecks only; do not build the entire workflow upfront.'
    ],
    technologyBuild: {
      mvp: ['Landing page + lead capture', 'Core workflow for one use case', 'Basic analytics and customer feedback', 'Payment/invoicing where needed', 'Exportable customer/data records'],
      avoidBuilding: ['Complex admin panels before demand', 'Large mobile apps before repeat usage', 'Custom AI models without proven volume', 'Multi-city/multi-segment workflows on day one'],
      estimatedBuildApproach: simple ? 'Start with no-code/manual operations where possible; build only the workflow that customers repeatedly use.' : 'Start with manual/no-code operations where possible; build only the workflow customers repeatedly use.'
    },
    regulatory,
    vulnerabilities,
    goToMarket: [
      simple ? 'One ICP choose karein; everyone ko target mat karein.' : 'Choose one ICP; do not target everyone.',
      simple ? '10–20 customer interviews → 5 paid pilots → repeat usage.' : '10–20 interviews → 5 paid pilots → repeat usage.',
      simple ? 'Founder-led outbound + referrals se first customers laayein.' : 'Use founder-led outbound and referrals for the first customers.',
      simple ? 'Pilot data ke basis par pricing aur product change karein.' : 'Use pilot data to refine pricing and product before scaling acquisition.'
    ],
    thirtyDayPlan: [
      { week: 'Week 1', objective: 'Problem proof', actions: ['Interview 15 target customers', 'Document current workaround and spend', 'Write one clear paid offer'], successMetric: '15 interviews + at least 5 strong problem confirmations' },
      { week: 'Week 2', objective: 'Willingness to pay', actions: ['Pitch the offer', 'Ask for payment/deposit/commitment', 'Manually deliver the core outcome'], successMetric: 'At least 3–5 paid or committed pilots' },
      { week: 'Week 3', objective: 'Economics proof', actions: ['Measure revenue, variable cost, time-to-serve and CAC', 'Remove low-value steps', 'Test one pricing change'], successMetric: 'Known contribution per customer and first CAC benchmark' },
      { week: 'Week 4', objective: 'Scale decision', actions: ['Review repeat usage', 'Choose the one acquisition channel that worked', 'Define the smallest build backlog'], successMetric: 'Clear scale/pause decision backed by customer data' }
    ],
    killOrScale: {
      scaleWhen: simple ? ['Customers pay without heavy discounting.', 'Repeat usage/renewal is visible.', 'Contribution after variable cost is positive.', 'One acquisition channel shows repeatability.'] : ['Customers pay without heavy discounting.', 'Repeat usage or renewal is visible.', 'Contribution after variable cost is positive.', 'At least one acquisition channel is repeatable.'],
      pauseWhen: simple ? ['Customers like the idea but refuse to pay.', 'CAC repeatedly exceeds expected contribution.', 'Operational effort grows faster than revenue.', 'A key regulatory dependency cannot be solved economically.'] : ['Customers like the idea but will not pay.', 'CAC repeatedly exceeds expected contribution.', 'Operational effort grows faster than revenue.', 'A key regulatory dependency cannot be solved economically.']
    },
    assumptions: [
      'These economics are scenario estimates, not market-verified quotes.',
      `Geography assumed: ${input.geography || 'India'}.`,
      `Stage assumed: ${input.stage || 'Idea / pre-launch'}.`,
      'Regulatory items are screening prompts, not legal or tax advice.'
    ],
    nextSteps: [
      simple ? 'Aaj: one ICP + one paid offer finalise karein.' : 'Today: finalise one ICP and one paid offer.',
      simple ? 'Next 7 days: 15 customer conversations + 3 paid pilot attempts.' : 'Next 7 days: 15 customer conversations and 3 paid-pilot attempts.',
      simple ? 'Next 14 days: actual CAC, contribution aur repeat usage measure karein.' : 'Next 14 days: measure actual CAC, contribution and repeat usage.',
      simple ? 'Day 30: scale ya pause ka decision actual data par lein.' : 'Day 30: make the scale-or-pause decision using actual evidence.'
    ]
  };
}
