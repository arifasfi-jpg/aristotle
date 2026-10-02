// Capability registry. The founder never picks a capability: Mogli (orchestration) routes work here.
// Internal names (Aristotle, Galileo, …) are organisational units, not products the founder must learn.
import type { ExecutionMode } from './types';

export type Capability = {
  id: string;
  internalName: string;
  label: string;
  description: string;
  executionModes: ExecutionMode[];
  enabled: boolean;
  /** AI may produce the deliverable on its own. */
  aiExecutable: boolean;
  /** A qualified professional must review / sign where the law requires it. AI-only is never offered. */
  requiresProfessional: boolean;
  costModel: { kind: 'ai_tokens' | 'effort_hours'; defaultOutputTokens: number; specialist: string };
  /**
   * Tools underneath ONE capability (never separate agents). GENERATE tools produce a deliverable with the AI;
   * INTEGRATION tools act in an external system (publishing, ad accounts, analytics) and always need the founder's
   * account + approval. No integration is connected yet: status says so, and nothing is ever executed externally.
   */
  tools?: CapabilityTool[];
};

export type ToolGroup = 'CREATE' | 'CAMPAIGN_PREPARATION' | 'EXTERNAL_EXECUTION';
export type CapabilityTool = {
  id: string; label: string; group: ToolGroup; kind: 'GENERATE' | 'INTEGRATION';
  /** What the AI hands over for GENERATE tools (honest about what is a spec vs a finished asset). */
  produces: string;
  /** For campaign/website deliverables: the external tool that would publish them (founder account + approval). */
  publishedVia?: string;
  integrationStatus?: 'NOT_CONNECTED';
};

const T = (t: CapabilityTool) => t;
/** Aaira Studio — Hippoturtle's Creative & Marketing capability. One capability, tools underneath. */
export const STUDIO_TOOLS: CapabilityTool[] = [
  // Create
  T({ id: 'brochure', label: 'Brochure', group: 'CREATE', kind: 'GENERATE', produces: 'print/PDF-ready brochure copy, section layout and design direction' }),
  T({ id: 'product_catalogue', label: 'Product catalogue', group: 'CREATE', kind: 'GENERATE', produces: 'catalogue structure, product entries, copy and layout direction' }),
  T({ id: 'landing_page', label: 'Landing page', group: 'CREATE', kind: 'GENERATE', produces: 'landing-page wireframe (sections in order) and final copy', publishedVia: 'website_publishing' }),
  T({ id: 'd2c_website', label: 'D2C website', group: 'CREATE', kind: 'GENERATE', produces: 'site map, page wireframes and copy for each page', publishedVia: 'website_publishing' }),
  T({ id: 'copy', label: 'Copy', group: 'CREATE', kind: 'GENERATE', produces: 'final marketing copy' }),
  T({ id: 'images', label: 'Images', group: 'CREATE', kind: 'GENERATE', produces: 'creative brief, shot list and image-generation prompts (image rendering is not connected yet)' }),
  T({ id: 'video', label: 'Video', group: 'CREATE', kind: 'GENERATE', produces: 'script, storyboard and shot list (video rendering is not connected yet)' }),
  T({ id: 'instagram_creative', label: 'Instagram creatives', group: 'CREATE', kind: 'GENERATE', produces: 'post/carousel/reel concepts with captions, on-image text and visual direction', publishedVia: 'meta_integration' }),
  T({ id: 'ad_creative', label: 'Ad creatives', group: 'CREATE', kind: 'GENERATE', produces: 'ad variants: headlines, descriptions, primary text and visual direction' }),
  T({ id: 'book_layout', label: 'Book & document layout', group: 'CREATE', kind: 'GENERATE', produces: 'edited/formatted manuscript, digital layout specification and sample-PDF content from the supplied text' }),
  // Campaign preparation
  T({ id: 'meta_campaign', label: 'Meta / Instagram campaign', group: 'CAMPAIGN_PREPARATION', kind: 'GENERATE', produces: 'campaign → ad set → ad structure, audiences, budgets and creatives, ready to enter in Ads Manager', publishedVia: 'meta_integration' }),
  T({ id: 'google_search_campaign', label: 'Google Search campaign', group: 'CAMPAIGN_PREPARATION', kind: 'GENERATE', produces: 'campaign/ad-group structure, keywords, negatives, responsive search ads, budget and bidding plan', publishedVia: 'google_ads_integration' }),
  T({ id: 'google_shopping_campaign', label: 'Google Shopping campaign', group: 'CAMPAIGN_PREPARATION', kind: 'GENERATE', produces: 'product-feed fields, campaign structure, budget and bidding plan', publishedVia: 'google_ads_integration' }),
  T({ id: 'audiences', label: 'Audience definitions', group: 'CAMPAIGN_PREPARATION', kind: 'GENERATE', produces: 'audience definitions with targeting parameters' }),
  T({ id: 'budget_plan', label: 'Budget plan', group: 'CAMPAIGN_PREPARATION', kind: 'GENERATE', produces: 'channel budget split, pacing and stop/scale rules' }),
  T({ id: 'tracking_plan', label: 'Tracking plan', group: 'CAMPAIGN_PREPARATION', kind: 'GENERATE', produces: 'events, UTM conventions, conversion definitions and dashboard spec', publishedVia: 'analytics' }),
  // External execution (integration boundary — not connected yet)
  T({ id: 'website_publishing', label: 'Website publishing', group: 'EXTERNAL_EXECUTION', kind: 'INTEGRATION', produces: 'publishes a page/site on the founder\'s domain', integrationStatus: 'NOT_CONNECTED' }),
  T({ id: 'meta_integration', label: 'Meta / Instagram integration', group: 'EXTERNAL_EXECUTION', kind: 'INTEGRATION', produces: 'posts content / launches campaigns in the founder\'s Meta account', integrationStatus: 'NOT_CONNECTED' }),
  T({ id: 'google_ads_integration', label: 'Google Ads integration', group: 'EXTERNAL_EXECUTION', kind: 'INTEGRATION', produces: 'launches campaigns in the founder\'s Google Ads account', integrationStatus: 'NOT_CONNECTED' }),
  T({ id: 'analytics', label: 'Analytics', group: 'EXTERNAL_EXECUTION', kind: 'INTEGRATION', produces: 'installs tracking and reads results from the founder\'s analytics', integrationStatus: 'NOT_CONNECTED' }),
];

const C = (c: Capability) => c;

export const CAPABILITIES: Capability[] = [
  C({ id: 'orchestration', internalName: 'Mogli', label: 'Chief of Staff', description: 'Turns objectives into work, routes it and keeps the plan moving.', executionModes: ['AI'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 3000, specialist: 'Chief of staff' } }),
  C({ id: 'strategy', internalName: 'Aristotle', label: 'Strategy & Research', description: 'Evidence-based venture intelligence, pricing and validation design.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Strategy consultant' } }),
  C({ id: 'technology', internalName: 'Galileo', label: 'Technology', description: 'MVPs, software, integrations and product specs.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 7000, specialist: 'Web developer' } }),
  C({ id: 'marketing', internalName: 'Aaira Studio', label: 'Creative & Marketing', description: 'Brochures, catalogues, landing pages and websites, copy, creatives, book/document layout, and campaign preparation (Meta, Google).', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Marketing specialist' }, tools: STUDIO_TOOLS }),
  C({ id: 'sales', internalName: 'Marcus', label: 'Sales & Distribution', description: 'Prospect lists, outreach scripts, channel and distributor plans.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Sales executive' } }),
  C({ id: 'finance', internalName: 'Kuber', label: 'Finance', description: 'Unit economics, working capital and funding models.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Financial analyst' } }),
  C({ id: 'accounting_tax', internalName: 'Garg', label: 'Accounting & Tax', description: 'AI prepares; a qualified CA reviews, signs and files where required.', executionModes: ['AI', 'HYBRID', 'HUMAN'], enabled: true, aiExecutable: true, requiresProfessional: true, costModel: { kind: 'effort_hours', defaultOutputTokens: 5000, specialist: 'Chartered Accountant' } }),
  C({ id: 'legal_regulatory', internalName: 'Eagle', label: 'Legal & Regulatory', description: 'AI researches and prepares checklists; a lawyer advises and approves where required.', executionModes: ['AI', 'HYBRID', 'HUMAN'], enabled: true, aiExecutable: true, requiresProfessional: true, costModel: { kind: 'effort_hours', defaultOutputTokens: 5000, specialist: 'Lawyer / regulatory consultant' } }),
  C({ id: 'operations', internalName: 'Sherlock', label: 'Operations & Process', description: 'SOPs, supply chain, fulfilment and process design.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 5000, specialist: 'Operations manager' } }),
  C({ id: 'customer_support', internalName: 'Minerva', label: 'Customer Support', description: 'Support playbooks, FAQs and service design.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 4000, specialist: 'Support lead' } }),
  C({ id: 'memory_crm', internalName: 'Xeno', label: 'Business Memory & CRM', description: 'Remembers facts, decisions, customers and outcomes.', executionModes: ['AI'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 2000, specialist: 'CRM administrator' } }),
  C({ id: 'infrastructure', internalName: 'Olympus', label: 'Infrastructure', description: 'Hosting, domains, tooling and security setup.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 4000, specialist: 'DevOps engineer' } }),
  C({ id: 'wellbeing', internalName: 'Sia', label: 'Founder Wellbeing', description: 'Workload and focus support for the founder. Not medical or therapeutic advice.', executionModes: ['AI'], enabled: false, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 2000, specialist: 'Coach' } }),
  // Planned capabilities: registered so routing and UI already know them; disabled until built.
  ...['HR', 'Recruitment', 'Payroll', 'Procurement', 'Vendor management', 'Investor relations', 'Fundraising', 'PR', 'Cybersecurity', 'Data & BI', 'Quality assurance', 'Administration'].map((label) =>
    C({ id: label.toLowerCase().replace(/[^a-z]+/g, '_'), internalName: label, label, description: `${label} (planned)`, executionModes: ['HUMAN'], enabled: false, aiExecutable: false, requiresProfessional: false, costModel: { kind: 'effort_hours', defaultOutputTokens: 4000, specialist: label } })),
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));
export const getCapability = (id: string): Capability | undefined => BY_ID.get(id);
export const enabledCapabilities = () => CAPABILITIES.filter((c) => c.enabled && c.id !== 'orchestration' && c.id !== 'memory_crm');

/** Routing fallback: unknown or disabled capabilities go to Strategy & Research. */
export function routeCapability(id: string | undefined | null): Capability {
  const c = id ? BY_ID.get(id) : undefined;
  return c && c.enabled ? c : BY_ID.get('strategy')!;
}

/**
 * Modes for a capability's REGULATED deliverables (drafts relied on for a filing/contract never offer AI-only).
 * Per-work modes come from classifyWork() in work-classification.ts, which uses this only for such deliverables.
 */
export function allowedModes(c: Capability): ExecutionMode[] {
  return c.requiresProfessional ? c.executionModes.filter((m) => m !== 'AI') : c.executionModes;
}

export const getTool = (id: string | undefined | null): CapabilityTool | undefined => (id ? STUDIO_TOOLS.find((t) => t.id === id) : undefined);

/** Internal capability names (Aaira Studio, Kuber, …) are Hippoturtle teams — never the founder's company. */
export const CAPABILITY_NAMES = (): string[] => CAPABILITIES.map((c) => c.internalName);
