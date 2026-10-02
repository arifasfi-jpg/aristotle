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
};

const C = (c: Capability) => c;

export const CAPABILITIES: Capability[] = [
  C({ id: 'orchestration', internalName: 'Mogli', label: 'Chief of Staff', description: 'Turns objectives into work, routes it and keeps the plan moving.', executionModes: ['AI'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 3000, specialist: 'Chief of staff' } }),
  C({ id: 'strategy', internalName: 'Aristotle', label: 'Strategy & Research', description: 'Evidence-based venture intelligence, pricing and validation design.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Strategy consultant' } }),
  C({ id: 'technology', internalName: 'Galileo', label: 'Technology', description: 'Landing pages, MVPs, integrations and product specs.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 7000, specialist: 'Web developer' } }),
  C({ id: 'marketing', internalName: 'Aaira Studio', label: 'Creative & Marketing', description: 'Positioning, campaigns, copy and creative.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Marketing specialist' } }),
  C({ id: 'sales', internalName: 'Marcus', label: 'Sales & Distribution', description: 'Prospect lists, outreach scripts, channel and distributor plans.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Sales executive' } }),
  C({ id: 'finance', internalName: 'Kuber', label: 'Finance', description: 'Unit economics, working capital and funding models.', executionModes: ['AI', 'HUMAN', 'HYBRID'], enabled: true, aiExecutable: true, requiresProfessional: false, costModel: { kind: 'ai_tokens', defaultOutputTokens: 6000, specialist: 'Financial analyst' } }),
  C({ id: 'accounting_tax', internalName: 'Garg', label: 'Accounting & Tax', description: 'AI prepares; a qualified CA reviews, signs and files where required.', executionModes: ['HYBRID', 'HUMAN'], enabled: true, aiExecutable: false, requiresProfessional: true, costModel: { kind: 'effort_hours', defaultOutputTokens: 5000, specialist: 'Chartered Accountant' } }),
  C({ id: 'legal_regulatory', internalName: 'Eagle', label: 'Legal & Regulatory', description: 'AI researches and prepares checklists; a lawyer advises and approves where required.', executionModes: ['HYBRID', 'HUMAN'], enabled: true, aiExecutable: false, requiresProfessional: true, costModel: { kind: 'effort_hours', defaultOutputTokens: 5000, specialist: 'Lawyer / regulatory consultant' } }),
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

/** Modes a founder may choose for this capability (regulated work never offers AI-only). */
export function allowedModes(c: Capability): ExecutionMode[] {
  return c.requiresProfessional ? c.executionModes.filter((m) => m !== 'AI') : c.executionModes;
}
