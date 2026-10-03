// Shared fake replies for the model calls research escalation and the audit job's pathways step add to an audit.
// Tests that fake Gemini by prompt text route these prompts here instead of treating them as the decision memo.

/** 'escalate' (follow-up query planning), 'gap' (explaining unresolved questions), 'pathways', or null. */
export function escalationKind(prompt: string): 'escalate' | 'gap' | 'pathways' | null {
  if (prompt.includes('FOLLOW-UP web searches')) return 'escalate';
  if (prompt.includes('Research could not settle')) return 'gap';
  if (prompt.includes('You are Aristotle, the strategy capability of Hippoturtle')) return 'pathways';
  return null;
}

/** Three materially different pathways, no numbers (nothing for grounding to strip). */
export const FAKE_PATHWAYS = {
  goal: 'Reach the full objective', ambitionNote: 'This needs several channels working at once.', combination: 'P1 + P2 together', founderChecklist: ['Which channel first?'],
  pathways: (['OBVIOUS_ROUTE', 'ADJACENT_ROUTE', 'ASSET_LIGHT'] as const).map((lens, i) => ({
    name: `Pathway ${i + 1}`, lens, model: `How pathway ${i + 1} works`, customer: 'Target customers', valueProposition: 'Value', revenueMechanism: 'Revenue', whyPlausible: 'Plausible',
    evidence: [], assumptions: ['Customers respond'], economics: 'Not yet established.', constraints: [], risks: ['Risk'], firstExperiment: `Test pathway ${i + 1}`, contributionToTarget: 'Requirement',
  })),
};

/** Reply data for an escalation/pathways prompt: {} makes escalation use its deterministic queries and gap texts. */
export function escalationReply(prompt: string): unknown | undefined {
  const k = escalationKind(prompt);
  return k === 'pathways' ? FAKE_PATHWAYS : k ? {} : undefined;
}
