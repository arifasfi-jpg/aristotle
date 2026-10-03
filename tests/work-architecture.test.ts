// Work architecture: deliverable vs external action, Aaira Studio tools, Mogli routing, marketing-claim provenance.
// Every assertion calls the production functions (classifyWork, routeWork, normalisePlan, computeEstimates,
// briefPrompt, executePrompt, guardMarketingClaims, withAiProvenance, identityBlock, businessName). Nothing here
// re-implements their logic. The same paths run end to end against PostgreSQL in work-architecture-e2e.test.tsx.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, getCapability, STUDIO_TOOLS } from '../src/lib/hippo/capabilities';
import { guardMarketingClaims, TESTIMONIAL_PLACEHOLDER } from '../src/lib/hippo/claims';
import { computeEstimates, normaliseEffort } from '../src/lib/hippo/costs';
import type { Price } from '../src/lib/ai-usage';
// Contract change (Phase 1.1): AI estimates take the routed model's ModelPrice; fixture = verified gemini-3.5-flash-lite.
const PRICE: Price = { id: 'mp_gemini_3_5_flash_lite_v', inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5, cachedInputUsdPerMTok: 0.03, reasoningUsdPerMTok: 2.5, usdPerCredit: 0, currency: 'USD', status: 'VERIFIED_PRICE' };

import { AI_PROVENANCE_MARKER, executePrompt, withAiProvenance } from '../src/lib/hippo/execution';
import { briefPrompt, normalisePlan, planPrompt, type BriefData } from '../src/lib/hippo/mogli';
import type { ProvenanceContext } from '../src/lib/hippo/provenance';
import { businessName, identityBlock, INTERNAL_CAPABILITY_NAMES } from '../src/lib/hippo/types';
import { classifyWork, routeWork, type WorkLike } from '../src/lib/hippo/work-classification';
import { confirmFounderFacts, extractFounderFacts } from '../src/lib/founder-facts';

const w = (title: string, deliverable = title, capability?: string, description = ''): WorkLike => ({ title, deliverable, capability, description });
const aiExecutable = (x: WorkLike) => { const c = classifyWork(x); return c.aiCanExecute && c.modes.includes('AI'); };

describe('Execution classification: the deliverable decides, not a later human step', () => {
  // The planner's capability guesses below are deliberately WRONG or human-leaning (as observed on Preview).
  it('1. Aaira Books manuscript editing / formatting / digital layout / sample PDF → AI-executable (Aaira Studio)', () => {
    for (const x of [w('Edit the manuscript', 'Edited manuscript', 'strategy'), w('Format the manuscript for print', 'Print-ready interior', 'technology'), w('Create the digital layout', 'Digital layout of the quiz book', 'technology'), w('Create a sample PDF', 'Sample PDF of 10 quiz pages', 'operations')]) {
      const c = classifyWork(x);
      expect([x.title, c.executionClass, c.capabilityId, c.tool?.id]).toEqual([x.title, 'AI_DELIVERABLE', 'marketing', 'book_layout']);
      expect(aiExecutable(x)).toBe(true);
    }
    // Source material is an input, not a reason to call the work human-only.
    expect(classifyWork(w('Format the manuscript', 'Formatted manuscript')).requiredInputs.join(' ')).toMatch(/manuscript text/i);
  });

  it('2–5. Ortus landing page, brochure, Instagram creative, Google Ads campaign preparation → AI-executable', () => {
    const cases: [WorkLike, string][] = [
      [w('Write landing page copy and wireframe', 'Landing page for US buyers', 'technology'), 'landing_page'],
      [w('Create a brochure', 'Brochure for US retail buyers', 'sales'), 'brochure'],
      [w('Create Instagram creatives', '6 Instagram posts for launch week'), 'instagram_creative'],
      [w('Create Google Ads campaign', 'Google Search campaign structure, keywords and ads', 'strategy'), 'google_search_campaign'],
      [w('Create product catalogue', 'Areca-leaf tableware catalogue'), 'product_catalogue'],
      [w('Create Google Ads creatives', 'Responsive search ad variants'), 'ad_creative'],
    ];
    for (const [x, tool] of cases) {
      const c = classifyWork(x);
      expect([x.title, c.capabilityId, c.tool?.id, aiExecutable(x)]).toEqual([x.title, 'marketing', tool, true]);
    }
    // Prepared campaigns/pages go live only via the founder's account: listed as a separate external step.
    const ads = classifyWork(cases[3][0]);
    expect(ads.executionClass).toBe('AI_WITH_INTEGRATION');
    expect(ads.externalActions).toEqual([expect.objectContaining({ kind: 'PUBLISH', performedBy: 'INTEGRATION', founderApproval: true, integration: { id: 'google_ads_integration', label: 'Google Ads integration', status: 'NOT_CONNECTED' } })]);
  });

  it('6. Google Ads PUBLISHING → external integration + founder approval, not an AI-only act', () => {
    const c = classifyWork(w('Publish the Google Ads campaign', 'Live Google Search campaign'));
    expect(c.primaryAction).toBe('PUBLISH');
    expect(c.executionClass).toBe('AI_WITH_INTEGRATION');
    expect(c.externalActions[0]).toMatchObject({ kind: 'PUBLISH', performedBy: 'INTEGRATION', founderApproval: true, integration: { id: 'google_ads_integration', status: 'NOT_CONNECTED' } });
    expect(c.aiPrepares).toMatch(/nothing is published or sent without your approval/);
    expect(c.summary).toMatch(/need your approval and your own account/);
  });

  it('7. Regulatory research → AI (even in a regulated capability)', () => {
    for (const x of [w('Research regulatory requirements for exporting areca plates to the US', 'Regulatory requirements checklist', 'legal_regulatory'), w('Medical device regulatory checklist', 'Checklist', 'legal_regulatory')]) {
      const c = classifyWork(x);
      expect([c.capabilityId, c.executionClass, c.modes]).toEqual(['legal_regulatory', 'AI_DELIVERABLE', ['AI', 'HUMAN', 'HYBRID']]);
    }
  });

  it('8. Regulated filing / signature → professional or authorised person; never AI-only', () => {
    for (const x of [w('File the CDSCO import licence application', 'Filed application'), w('Sign the distributor agreement', 'Signed agreement'), w('Register for GST', 'GST registration')]) {
      const c = classifyWork(x);
      expect([x.title, c.executionClass, c.modes]).toEqual([x.title, 'PROFESSIONAL_APPROVAL', ['HYBRID', 'HUMAN']]);
      expect(c.externalActions[0].founderApproval).toBe(true);
    }
    expect(classifyWork(w('File the GST return', 'Filed return')).externalActions[0].performedBy).toBe('PROFESSIONAL');
    // Drafting a contract is AI work that a professional must review before it is relied on.
    expect(classifyWork(w('Draft the distributor agreement', 'Agreement draft', 'legal_regulatory'))).toMatchObject({ executionClass: 'AI_WITH_HUMAN_REVIEW', modes: ['HYBRID', 'HUMAN'] });
  });

  it('9. Financial model / unit economics / baseline from supplied data → AI (Kuber)', () => {
    for (const x of [w('Build a 12-month financial model', 'Financial model'), w('Calculate unit economics', 'Unit economics sheet', 'strategy'), w('Prepare financial baseline report', 'Baseline report from supplied transaction data', 'strategy')]) {
      expect([x.title, classifyWork(x).capabilityId, aiExecutable(x)]).toEqual([x.title, 'finance', true]);
    }
    expect(classifyWork(w('Analyse the supplied transaction data', 'Analysis of our IndiaMART transaction data')).requiredInputs.join(' ')).toMatch(/transaction\/sales data/);
  });

  it('10. Money transfer → the founder approves and acts; AI only prepares', () => {
    const c = classifyWork(w('Transfer the advance payment to the supplier', 'Payment made', 'finance'));
    expect(c).toMatchObject({ executionClass: 'HUMAN_EXECUTION', modes: ['HYBRID', 'HUMAN'] });
    expect(c.externalActions[0]).toMatchObject({ kind: 'PAYMENT', performedBy: 'FOUNDER', founderApproval: true });
  });

  it('a later human step in the description does not make the deliverable human-only', () => {
    const c = classifyWork(w('Prepare pharmacy outreach scripts', 'Call scripts', 'sales', 'Scripts for the founder. Then call 50 pharmacies in Pune.'));
    expect(c.executionClass).toBe('AI_DELIVERABLE');
    expect(c.externalActions).toEqual([expect.objectContaining({ kind: 'HUMAN_CONTACT', step: 'Then call 50 pharmacies in Pune' })]);
    expect(aiExecutable(w('Contact 50 pharmacy prospects', 'Call log', 'sales'))).toBe(false); // the work itself is a person's act
    // Consequence words never decide: "visitors", "call to action", "judgement", "professional".
    expect(classifyWork(w('Create landing page with a clear call to action for visitors', 'Landing page', 'marketing', 'Needs professional judgement on tone.')).modes).toContain('AI');
  });

  it('the planner’s aiExecutable/capability are hints; normalisePlan stores the derived values', () => {
    const p = normalisePlan({ headline: 'h', work: [
      { title: 'Format the manuscript', description: 'd', deliverable: 'Print-ready manuscript', capability: 'operations', priority: 1, pathwayId: 'P1', whyNow: 'x', aiExecutable: false, externalSteps: ['Print 500 copies at a local printer'] },
      { title: 'Create landing page copy', description: 'd', deliverable: 'Landing page', capability: 'technology', priority: 2, pathwayId: '', whyNow: 'x', aiExecutable: false, externalSteps: [] },
    ] });
    expect(p.work.map((x) => [x.capability, x.aiExecutable])).toEqual([['marketing', true], ['marketing', true]]);
    expect(p.work[0].description).toContain('External steps (not done by AI): Print 500 copies at a local printer');
    expect(p.work[0].classification.externalActions).toEqual([expect.objectContaining({ kind: 'PHYSICAL', step: 'Print 500 copies at a local printer' })]);
  });

  it('cost estimates follow the work’s modes: an AI estimate whenever AI may execute, none for human/professional acts', () => {
    const cap = getCapability('marketing')!;
    const effort = normaliseEffort({ aiFeasible: false, humanHours: { low: 4, high: 6 }, hourlyRateInr: { low: 500, high: 800 } } as never, cap); // model said "not AI-feasible"
    expect(computeEstimates(effort, cap, 2000, PRICE, classifyWork(w('Create a brochure', 'Brochure')).modes).map((e) => e.mode)).toContain('AI');
    const legal = getCapability('legal_regulatory')!;
    expect(computeEstimates(normaliseEffort(effort, legal), legal, 2000, PRICE, classifyWork(w('Sign the lease deed', 'Signed deed')).modes).map((e) => e.mode)).not.toContain('AI');
  });
});

describe('Aaira Studio: one capability with tools, not agents', () => {
  it('Studio is a single capability; its tools include create, campaign preparation and (unconnected) integrations', () => {
    const studio = CAPABILITIES.filter((c) => c.internalName === 'Aaira Studio');
    expect(studio).toHaveLength(1);
    expect(studio[0].tools).toBe(STUDIO_TOOLS);
    expect(new Set(STUDIO_TOOLS.map((t) => t.group))).toEqual(new Set(['CREATE', 'CAMPAIGN_PREPARATION', 'EXTERNAL_EXECUTION']));
    for (const t of STUDIO_TOOLS.filter((x) => x.kind === 'INTEGRATION')) expect(t.integrationStatus).toBe('NOT_CONNECTED');
    // No capability per tool (brochure, website, Instagram, Google Ads …).
    for (const t of STUDIO_TOOLS) expect(CAPABILITIES.some((c) => c.id === t.id)).toBe(false);
  });
});

describe('Mogli routing uses the CURRENT work only', () => {
  it('17–19. Aaira Books → Aaira Studio; Ortus landing page → Aaira Studio; Demo Glucose financial baseline → Kuber', () => {
    expect(routeWork(w('Format the quiz book manuscript', 'Print-ready PDF', 'strategy')).internalName).toBe('Aaira Studio');
    expect(routeWork(w('Ortus landing page', 'Landing page for areca-leaf plates', 'technology')).internalName).toBe('Aaira Studio');
    expect(routeWork(w('Prepare financial baseline', 'Baseline of monthly glucometer sales, margin and cash from the supplied transaction data', 'marketing')).internalName).toBe('Kuber');
  });
  it('20. routing is a pure function of the work: same work → same capability, whatever came before', () => {
    const x = w('Create a brochure', 'Brochure', 'sales');
    const before = routeWork(x).id;
    for (const other of [w('Prepare financial baseline', 'Baseline'), w('File GST return', 'Return'), w('Edit the manuscript', 'Edited manuscript')]) classifyWork(other);
    expect(routeWork(x).id).toBe(before);
    expect(routeWork.length).toBe(1);   // takes the work only — no objective, memory or history parameter
    expect(classifyWork.length).toBe(1);
  });
  it('the plan prompt describes deliverable vs external action and Studio as one capability', () => {
    const p = planPrompt({ objective: 'o', understanding: null, pathways: [], experiments: [], thirtyDayPlan: [], memory: 'm', company: 'Ortus Global' });
    expect(p).toContain('externalSteps');
    expect(p).toContain('A later human step never makes the deliverable human-only');
    expect(p).toMatch(/marketing \(Aaira Studio, one capability\)/);
    expect(p).not.toMatch(/NEVER aiExecutable|aiExecutable=false/);
  });
});

describe('Marketing claims: proposed, not fabricated', () => {
  const ortus: ProvenanceContext = { objectiveText: 'Ortus Global sells handcrafted areca-leaf plates made in India from naturally fallen leaves to US households. Our plates are biodegradable.', facts: [], findings: [{ code: 'R1', statement: 'Areca palm leaf plates are heat resistant up to 220°F', quote: 'heat resistant up to 220°F' }], approvals: [{ item: 'Founder approved: Free shipping on orders over $40', value: 'Free shipping on orders over $40' }] };
  const page = `# Ortus Global\n- **100% Chemical-Free** — fallen leaves and water\n- **Sturdy & Leak-Proof**\n- Fully biodegradable and compostable — returns to the earth within 60 days\n- Biodegradable\n- Loved by thousands of eco-conscious hosts\n- Over 10,000 happy customers across the US\n- Rated 4.9/5; 30% stronger than bamboo plates\n- FDA approved and BPI certified compostable\n- Heat resistant up to 220°F\n\n## What our customers say\n> "These plates were perfect for our backyard wedding — guests kept asking where we got them!"\n> — Sarah M., Austin TX\n\n"Finally a disposable plate I don't feel guilty about." — **David K.**, Seattle WA\n`;
  const out = guardMarketingClaims(page, ortus);
  const label = (t: string) => out.claims.find((c) => c.text.includes(t))?.label;

  it('11. fabricated testimonials become explicit placeholders; names/locations are not published', () => {
    expect(out.markdown).not.toMatch(/Sarah M\.|David K\.|Austin TX|Seattle WA/);
    expect(out.markdown.split('## Claims in this draft')[0].match(new RegExp(TESTIMONIAL_PLACEHOLDER.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(out.markdown).toContain('not a real customer'); // the useful idea is preserved, clearly labelled
    expect(label('perfect for our backyard wedding')).toBe('PLACEHOLDER');
  });
  it('12. invented customer counts, ratings and statistics are not presented as facts', () => {
    for (const t of ['Loved by thousands', 'Over 10,000 happy customers', 'Rated 4.9/5', '30% stronger']) {
      expect(label(t)).toBe('UNSUPPORTED');
      expect(out.markdown).toContain(`[UNSUPPORTED CLAIM — DO NOT PUBLISH: ${t}`);
    }
  });
  it('13. unsupported product, environmental and certification claims get validation-required provenance', () => {
    for (const t of ['100% Chemical-Free', 'Leak-Proof', 'compostable — returns to the earth within 60 days', 'FDA approved', 'BPI certified compostable']) {
      expect([t, label(t)]).toEqual([t, 'AI_PROPOSED']);
    }
    expect(out.markdown).toContain('[CLAIM TO VERIFY: 100% Chemical-Free]');
    expect(out.markdown).toContain('**Sturdy & [CLAIM TO VERIFY: Leak-Proof]**'); // the idea survives, labelled
  });
  it('14. founder-stated / founder-approved claims stay founder-approved and unchanged', () => {
    expect(out.claims.find((c) => c.text === 'Biodegradable')).toMatchObject({ label: 'FOUNDER_APPROVED', ref: 'founder objective' });
    expect(out.markdown).toContain('\n- Biodegradable\n');
    const facts = confirmFounderFacts(extractFounderFacts('Our plates are 100% chemical-free and leak-proof. We sell 2,000 plates a month.').facts);
    const g = guardMarketingClaims('- 100% chemical-free\n- Leak-proof', { ...ortus, objectiveText: 'Our plates are 100% chemical-free and leak-proof.', facts });
    expect(g.markdown.split('<!--')[0].trimEnd()).toBe('- 100% chemical-free\n- Leak-proof');
    expect(g.claims.map((c) => c.label)).toEqual(['FOUNDER_APPROVED', 'FOUNDER_APPROVED']);
  });
  it('15. sourced claims keep their source', () => {
    expect(out.claims.find((c) => c.text === 'Heat resistant up to 220°F')).toMatchObject({ label: 'SOURCED', ref: 'R1' });
    expect(out.markdown).toContain('Heat resistant up to 220°F [R1]');
  });
  it('a partially supported claim is not founder-approved (the "within 60 days" part is unverified)', () => {
    expect(label('compostable — returns to the earth within 60 days')).toBe('AI_PROPOSED');
  });
  it('idempotent: guarding again (display after storage) changes nothing', () => {
    expect(guardMarketingClaims(out.markdown, ortus).markdown).toBe(out.markdown);
  });
  it('plan targets in plain text are not mistaken for marketing claims', () => {
    const plan = '- Aim for 20% more repeat orders in month 2\n- Target 50 restaurants in Austin\n- Margin 30% at $12 per pack';
    expect(guardMarketingClaims(plan, ortus)).toEqual({ markdown: plan, claims: [] });
  });
  it('16. the AI-generated marker stays unconditional on guarded output', () => {
    const tagged = withAiProvenance(out.markdown, { assumptions: [], founderInputsNeeded: [] });
    expect(tagged.startsWith(AI_PROVENANCE_MARKER)).toBe(true);
    expect(withAiProvenance(guardMarketingClaims('# Short brochure with no claims at all, just layout.', ortus).markdown).startsWith(AI_PROVENANCE_MARKER)).toBe(true);
  });
});

describe('Execution prompt: tool, external actions and claim rules reach the model', () => {
  const brief: BriefData = { objective: 'o', deliverable: 'Landing page', inputs: [], constraints: { budget: 'Not set', deadline: 'Not set', geography: 'US', brand: 'Not set', technology: 'Not set', regulatory: 'None' }, successCriteria: ['c'], expectedOutput: 'Markdown', outOfScope: [], effort: {} };
  const x = w('Write landing page copy', 'Landing page for areca-leaf plates');
  const cls = classifyWork(x);
  const prompt = executePrompt({ title: x.title, brief, cap: getCapability(cls.capabilityId)!, mode: 'AI', memory: 'm', research: 'none', company: 'Ortus Global', classification: cls });
  it('names the Studio tool, separates external actions and carries the claim rules', () => {
    expect(prompt).toContain('TOOL: Aaira Studio › Landing page');
    expect(prompt).toMatch(/EXTERNAL ACTIONS — you do NOT perform these/);
    expect(prompt).toContain('Website publishing is not connected');
    expect(prompt).toContain(TESTIMONIAL_PLACEHOLDER);
    expect(prompt).toContain('[CLAIM TO VERIFY:');
  });
  it('24. capability names are never company identity', () => {
    expect(prompt).toContain('IDENTITY (strict)');
    expect(prompt).toContain('business being analysed and served is "Ortus Global"');
    expect(prompt).toMatch(/internal capabilities .* are never the founder's company/);
    for (const name of INTERNAL_CAPABILITY_NAMES) expect(businessName(name)).toBeNull();
    expect(businessName('Aaira Books')).toBe('Aaira Books'); // a real company that merely shares a word stays a company
    expect(identityBlock(businessName('Aaira Studio'))).not.toContain('"Aaira Studio"');
    expect(INTERNAL_CAPABILITY_NAMES.sort()).toEqual(CAPABILITIES.filter((c) => c.enabled || c.id === 'wellbeing').map((c) => c.internalName).sort());
  });
  it('the brief prompt carries the same classification', () => {
    const b = briefPrompt({ work: { title: x.title, description: '', deliverable: x.deliverable! }, cap: getCapability('marketing')!, objective: 'o', memory: 'm', timeCommitment: null, company: 'Ortus Global', classification: cls });
    expect(b).toContain('WHAT HIPPOTURTLE PREPARES');
    expect(b).toContain('Publish via Website publishing');
    expect(b).not.toContain("aiFeasible=false for anything needing calls");
  });
});
