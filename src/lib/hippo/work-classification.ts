// Work classification: what Hippoturtle can PREPARE (the deliverable) is separated from what needs the outside world
// (EXTERNAL ACTIONS: publishing through an account, contacting people, physical work, signatures, regulated filings,
// payments). One later step needing a human never makes the whole work human-only.
//
// Deterministic and computed from the CURRENT work only (title, deliverable, description, routed capability):
// never from previous objectives, previous work or memory. It is recomputed on every read, so work created before
// this existed is classified the same way. The decision is made from the ACTION the work requires (its verb and
// object), not from words describing consequences ("judgement", "professional", "calls to action" …).
import { getCapability, getTool, routeCapability, STUDIO_TOOLS, type Capability, type CapabilityTool } from './capabilities';
import type { ExecutionMode } from './types';

export type ActionKind =
  | 'PREPARE'            // write, design, format, analyse, research, plan … → AI can produce it
  | 'PUBLISH'            // publish / launch / run ads / post → external system + founder approval
  | 'ACCOUNT_SETUP'      // create/connect an account, buy a domain → founder's account
  | 'SEND'               // send emails/messages to real people → founder approval
  | 'HUMAN_CONTACT'      // call, visit, meet, negotiate, pitch, contact → a person
  | 'PHYSICAL'           // ship, print, photograph, manufacture, sample → physical work
  | 'HIRE'               // hire, recruit, appoint → a person decides
  | 'SIGNATURE'          // sign, execute an agreement → authorised person / professional
  | 'REGULATED_FILING'   // file, submit or register with an authority, obtain a licence → professional / authorised person
  | 'PAYMENT';           // pay, transfer, buy, order stock → founder approves and acts

export type ExecutionClass =
  | 'AI_DELIVERABLE'         // AI can produce the deliverable
  | 'AI_WITH_INTEGRATION'    // AI prepares it; publishing/sending needs an external account + founder approval
  | 'AI_WITH_HUMAN_REVIEW'   // AI drafts; a qualified human must review before it is relied on (contracts, tax computations …)
  | 'HUMAN_EXECUTION'        // the work itself is done by a person (calls, visits, payment …); AI can prepare support material
  | 'PROFESSIONAL_APPROVAL'; // a qualified professional / authorised person must sign or file; AI can prepare the pack

export type ExternalAction = {
  kind: Exclude<ActionKind, 'PREPARE'>;
  step: string;
  performedBy: 'FOUNDER' | 'HUMAN' | 'PROFESSIONAL' | 'INTEGRATION';
  /** Founder must approve before anything happens in the outside world. */
  founderApproval: boolean;
  /** External tool that would perform it (Aaira Studio integration); none is connected yet. */
  integration?: { id: string; label: string; status: 'NOT_CONNECTED' };
};

export type WorkClassification = {
  executionClass: ExecutionClass;
  /** AI can produce the deliverable (or, for human/professional work, the supporting material). */
  aiCanPrepare: boolean;
  /** AI-only execution is offered (the deliverable IS the work; external steps are separate and need approval). */
  aiCanExecute: boolean;
  /** What the AI prepares, in founder words. */
  aiPrepares: string;
  externalActions: ExternalAction[];
  /** Inputs the AI needs from the founder to do this well (e.g. the manuscript, the transaction export). */
  requiredInputs: string[];
  modes: ExecutionMode[];
  capabilityId: string;
  tool?: CapabilityTool;
  primaryAction: ActionKind;
  /** One-line founder-facing summary. */
  summary: string;
};

export type WorkLike = { title: string; deliverable?: string | null; description?: string | null; capability?: string | null };

// ---------------------------------------------------------------- action vocabulary (verb + object)
const V = (words: string) => new RegExp(`^(?:${words})\\b(?!-)`, 'i');
const VERBS: [ActionKind, RegExp][] = [
  ['PAYMENT', V('pay|transfer|wire|remit|refund|deposit|purchase|buy|order\\s+(?:stock|inventory|raw|materials|units|samples\\s+from)|fund|invest')],
  ['SIGNATURE', V('sign(?!\\s*up)|countersign|notari[sz]e|execute\\s+(?:the\\s+)?(?:agreement|contract|deed|mou|nda|lease)')],
  ['REGULATED_FILING', V('file|submit|register|apply\\s+for|obtain|incorporate|renew|lodge')],
  ['ACCOUNT_SETUP', V('sign\\s*up\\s+(?:for|to|with)|(?:set\\s*up|create|open|connect|link)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?(?:[\\w-]+\\s+){0,3}(?:account|business\\s+manager|ads\\s+manager|merchant\\s+center|pixel|domain|hosting|payment\\s+gateway)|buy\\s+(?:a\\s+)?domain')],
  ['PUBLISH', V('publish|launch|go\\s+live|deploy|post|upload|run\\s+(?:the\\s+|a\\s+|our\\s+)?(?:ads?|campaigns?|google|meta|facebook|instagram)|activate|boost|schedule\\s+(?:the\\s+)?posts?|list\\s+(?:the\\s+)?(?:products?|items?)\\s+on|make\\s+live')],
  ['SEND', V('send|email|message|whatsapp|dm|mail')],
  ['HIRE', V('hire|recruit|appoint|onboard\\s+(?:a|an|the)\\s+(?:freelancer|agency|designer|developer|employee|staff)')],
  ['HUMAN_CONTACT', V('call|phone|visit|meet|interview|negotiate|pitch|contact|reach\\s+out|follow\\s+up|attend|present\\s+to|demo\\s+to|onboard|recruit\\s+(?:distributors|retailers|partners)|survey\\s+(?:customers|pharmacies|shops|retailers)\\s+in\\s+person|talk\\s+to|speak\\s+to|connect\\s+with|collect|survey(?!\\s+(?:design|questions|form|questionnaire))|test\\s+.*\\bwith\\s+(?:\\d+\\s+)?(?:real\\s+)?(?:customers|buyers|users|parents|pharmacies|shops|retailers|people|restaurants|stores)')],
  ['PHYSICAL', V('ship|deliver|dispatch|print|photograph|shoot|film|manufacture|produce\\s+(?:samples|units|stock|batch)|pack|package\\s+(?:the\\s+)?(?:products|orders)|install|stock|inspect|test\\s+(?:the\\s+)?(?:product|samples|prototype)(?!.*\\bwith\\s+(?:\\d+\\s+)?(?:real\\s+)?(?:customers|buyers|users))|source\\s+(?:physical\\s+)?samples')],
  ['PREPARE', V('create|write|draft|design|prepare|build|develop|produce|format|edit|proofread|copy-?edit|typeset|lay\\s*out|layout|compile|analy[sz]e|calculate|compute|model|estimate|forecast|project|research|investigate|study|plan|map|define|outline|structure|generate|summari[sz]e|benchmark|identify|list|shortlist|translate|review|audit|evaluate|assess|compare|document|set\\s*up\\s+(?:a\\s+|the\\s+)?(?:tracking|campaign|budget|plan|structure|framework|process|sop)|refine|rewrite|improve|optimi[sz]e|propose|recommend|establish\\s+(?:a\\s+)?baseline|baseline|track|test\\s+(?:messaging|headlines|copy|pricing)|validate|segment|price|cost')],
];

/** Regulated objects for filing/submission verbs; otherwise "submit"/"register" is not a regulated act. */
const REGULATED_OBJECT = /\b(licen[cs]e|registration|regist(?:er|ry)|permit|filing|return|gst|itr|tds|tax|roc|mca|cdsco|fssai|fda|bis|iec|udyam|msme|trademark|patent|company|llp|incorporation|import|export|authority|government|regulator|application|certificate|certification|compliance\s+form|form\s+\w+|declaration)\b/i;
/** Deliverables a qualified professional must review before they are relied on (not research about them). */
const RELIANCE_DRAFT = /\b(contract|agreement|nda|mou|term\s*sheet|terms\s+(?:of|and)\s+(?:service|use|conditions|sale)|privacy\s+policy|refund\s+policy|legal\s+opinion|legal\s+notice|lease|deed|shareholders?\\s+agreement|tax\s+(?:return|computation)|gst\s+return|itr|audited|financial\s+statements\s+for\s+filing|licen[cs]e\s+application|registration\s+application|regulatory\s+submission|dossier|label(?:ling)?\s+claims?)\b/i;
/** Research/explanatory deliverables are AI work even in regulated capabilities. */
const RESEARCH_DELIVERABLE = /\b(research|requirements?|checklist|overview|summary|guide|comparison|landscape|roadmap|what\s+licen[cs]es|which\s+licen[cs]es|map\s+of|list\s+of|questions?\s+for)\b/i;

function actionOf(clause: string): { kind: ActionKind; matched: boolean } {
  const c = clause.trim().replace(/^[\d.)\-•*\s]+/, '').replace(/^(?:to|then|and|next,?|finally,?|also)\s+/i, '');
  for (const [kind, re] of VERBS) {
    if (!re.test(c)) continue;
    if (kind === 'REGULATED_FILING' && !REGULATED_OBJECT.test(c)) {
      // "submit the brochure for founder review", "register interest" — not a regulated act
      if (/^register\b/i.test(c) && /\b(domain|account|website)\b/i.test(c)) return { kind: 'ACCOUNT_SETUP', matched: true };
      return { kind: /^submit\b/i.test(c) ? 'SEND' : 'PREPARE', matched: true };
    }
    if (kind === 'PUBLISH' && /^(?:run|post)\b/i.test(c) && /\b(analysis|numbers|model|report|scenario|calculation|test\s+plan)\b/i.test(c)) return { kind: 'PREPARE', matched: true };
    return { kind, matched: true };
  }
  return { kind: 'PREPARE', matched: false }; // noun phrase ("Medical device regulatory checklist") → a document to prepare
}

/** Leading verb chain: "Create and publish X" → ['Create … X', 'publish X']. */
function titleActions(title: string): ActionKind[] {
  const t = title.trim();
  const m = t.match(/^(\w+(?:\s+\w+)?)\s*(?:,|and|&|\+)\s*(\w+)\b(.*)$/i);
  const kinds = [actionOf(t).kind];
  if (m) { const second = actionOf(`${m[2]}${m[3]}`); if (second.matched && second.kind !== 'PREPARE') kinds.push(second.kind); }
  return kinds;
}

/** External steps the work statement names explicitly ("External steps: …", or sentences starting with an action verb). */
function statedExternalSteps(work: WorkLike): { kind: Exclude<ActionKind, 'PREPARE'>; step: string }[] {
  const out: { kind: Exclude<ActionKind, 'PREPARE'>; step: string }[] = [];
  const desc = String(work.description || '').replace(/\n\nWhy now:[\s\S]*$/i, '');
  const explicit = desc.match(/External steps(?:\s*\(not done by AI\))?:\s*([^\n]+)/i)?.[1];
  const candidates = [
    ...(explicit ? explicit.split(/;|\|/) : []),
    ...desc.replace(/External steps[^\n]*/i, '').split(/(?<=[.!?])\s+|\n+/).filter((x) => /^(?:then|and then|after (?:that|approval),?|next,?|finally,?)?\s*[A-Z]/.test(x.trim())),
  ];
  for (const raw of candidates) {
    const step = raw.trim().replace(/[.;]+$/, '');
    if (!step || step.length > 200) continue;
    const a = actionOf(step);
    if (a.matched && a.kind !== 'PREPARE') out.push({ kind: a.kind, step });
  }
  return out;
}

// ---------------------------------------------------------------- Aaira Studio tool + capability routing (current work only)
const TOOL_RULES: [string, RegExp][] = [
  ['book_layout', /\b(manuscript|book|chapters?|e-?book|kindle|epub|typeset|sample\s+pdf|print-ready\s+pdf|interior\s+layout|digital\s+layout)\b/i],
  ['google_shopping_campaign', /\bgoogle\s+shopping|merchant\s+center|product\s+feed\b/i],
  ['google_search_campaign', /\bgoogle\s+(?:search\s+)?(?:ads?\s+)?campaign|search\s+campaign|google\s+ads\b(?![^.\n]*\bcreatives?\b)|\bkeywords?\s+(?:list|plan|research)\b|\bppc\b|\bsem\b/i],
  ['meta_campaign', /\b(?:meta|facebook|instagram|fb)\s+(?:ads?\s+)?campaign|\bads?\s+manager\b|\bmeta\s+ads\b|\bfacebook\s+ads\b|\binstagram\s+ads\b/i],
  ['ad_creative', /\b(?:ad|ads|advert(?:isement)?)\s+(?:creatives?|copy|variants?|banners?|headlines?)\b|\bcreatives?\s+for\s+(?:google|meta|facebook|instagram)\s+ads\b|\bgoogle\s+ads?\s+creatives?\b/i],
  ['instagram_creative', /\binstagram\b|\breels?\b|\bcarousel\b|\bsocial\s+(?:media\s+)?(?:posts?|creatives?|content|calendar)\b/i],
  ['tracking_plan', /\btracking\s+plan|utm|conversion\s+tracking|pixel\s+events|analytics\s+(?:plan|setup\s+plan|spec)\b/i],
  ['audiences', /\baudiences?\s+(?:definitions?|segments?|targeting)|target(?:ing)?\s+audiences?\b/i],
  ['budget_plan', /\b(?:ad|media|marketing|campaign)\s+budget\b/i],
  ['d2c_website', /\b(?:d2c|e-?commerce|online\s+store|shopify|website)\b(?!\s+(?:hosting|domain))/i],
  ['landing_page', /\blanding[\s-]?page|\bwireframe\b|\bhero\s+section\b/i],
  ['product_catalogue', /\bcatalog(?:ue)?\b/i],
  ['brochure', /\bbrochure|leaflet|flyer|pamphlet|sell\s+sheet|one[\s-]pager\b/i],
  ['video', /\bvideo|storyboard|youtube|explainer\b/i],
  ['images', /\b(?:product\s+)?(?:images?|photos?|visuals?|mock-?ups?|packaging\s+design|logo|brand\s+identity)\b/i],
  ['copy', /\b(?:copy|copywriting|tagline|slogan|product\s+descriptions?|email\s+sequence|newsletter|blog|press\s+release|messaging|positioning\s+statement)\b/i],
];
const ROUTES: [string, RegExp][] = [
  ['accounting_tax', /\b(gst|tds|itr|income\s+tax|tax\s+(?:return|filing|computation|registration)|bookkeeping|accounting|ledger\s+reconciliation|statutory\s+audit)\b/i],
  ['legal_regulatory', /\b(contract|agreement|nda|mou|terms\s+(?:of|and)\s+(?:service|use|conditions)|privacy\s+policy|trademark|legal|regulat\w*|licen[cs]e|licensing|compliance|cdsco|fssai|fda|bis\b|iec\b|certification\s+requirements?|import\s+(?:rules|requirements|regulations)|export\s+(?:rules|requirements|regulations|compliance))\b/i],
  ['finance', /\b(unit\s+economics|financial\s+(?:model|baseline|plan|projections?|analysis|report)|p\s*&\s*l|profit\s+and\s+loss|cash\s*flow|working\s+capital|break[\s-]?even|margin\s+analysis|contribution\s+margin|cac\b|ltv\b|transaction\s+data|sales\s+data|baseline(?:\s+report)?|pricing\s+model|cost\s+model|funding\s+model|budget\s+forecast|revenue\s+model)\b/i],
  ['operations', /\b(suppliers?|vendors?|rfq|request\s+for\s+quotation|procurement|sourcing|manufacturers?|logistics|fulfil+ment|warehous\w*|inventory|shipping\s+(?:plan|rates|partners?)|freight|3pl|sop|standard\s+operating)\b/i],
  ['sales', /\b(prospects?|leads?|outreach|distributors?|dealers?|retailers?|pharmac(?:y|ies)|chemists?|b2b|sales\s+(?:script|pipeline|deck|pitch|plan)|cold\s+(?:email|call)|crm\s+list)\b/i],
  ['technology', /\b(mvp|app|software|api|integration\s+spec|product\s+spec|prototype\s+app|backend|database\s+schema|chatbot)\b/i],
];

const textOf = (w: WorkLike) => `${w.title}\n${w.deliverable || ''}\n${String(w.description || '').replace(/External steps[^\n]*/i, '').replace(/\n\nWhy now:[\s\S]*$/i, '')}`;

/** The Aaira Studio tool for this work, if it is creative/marketing work. Title + deliverable decide first. */
export function studioToolFor(work: WorkLike): CapabilityTool | undefined {
  for (const text of [`${work.title}\n${work.deliverable || ''}`, textOf(work)]) {
    for (const [id, re] of TOOL_RULES) if (re.test(text)) return getTool(id);
  }
  return undefined;
}

/**
 * Mogli's routing: the capability for THIS work, from the work's own words. A strong rule wins; otherwise the
 * planner's choice (if it names an enabled capability); otherwise Strategy & Research. Pure function of the work.
 */
export function routeWork(work: WorkLike): Capability {
  const head = `${work.title}\n${work.deliverable || ''}`;
  const all = textOf(work);
  const rule = (id: string) => ROUTES.find(([r]) => r === id)![1];
  // STRONG rules — what the deliverable IS decides, whatever the planner guessed:
  // tax, legal instruments (a "privacy policy page" is legal work), creative/marketing tools, finance, regulatory topics.
  for (const text of [head, all]) {
    if (rule('accounting_tax').test(text)) return routeCapability('accounting_tax');
    if (RELIANCE_DRAFT.test(text) && rule('legal_regulatory').test(text)) return routeCapability('legal_regulatory');
    if (rule('finance').test(head)) return routeCapability('finance'); // "unit economics of Instagram sales" is finance
    if (studioToolFor({ title: text, deliverable: '' })) return routeCapability('marketing');
    if (rule('finance').test(text)) return routeCapability('finance');
    if (rule('legal_regulatory').test(text)) return routeCapability('legal_regulatory');
  }
  // Otherwise the planner's choice for THIS work, if it names an enabled capability …
  const chosen = work.capability ? getCapability(work.capability) : undefined;
  if (chosen && chosen.enabled && chosen.id !== 'orchestration' && chosen.id !== 'memory_crm') return chosen;
  // … else WEAK rules from the work's own words, else Strategy & Research.
  for (const id of ['operations', 'sales', 'technology']) if (rule(id).test(all)) return routeCapability(id);
  return routeCapability('strategy');
}

// ---------------------------------------------------------------- classification
const WHO: Record<Exclude<ActionKind, 'PREPARE'>, ExternalAction['performedBy']> = {
  PUBLISH: 'INTEGRATION', ACCOUNT_SETUP: 'FOUNDER', SEND: 'FOUNDER', HUMAN_CONTACT: 'HUMAN', PHYSICAL: 'HUMAN', HIRE: 'FOUNDER',
  SIGNATURE: 'PROFESSIONAL', REGULATED_FILING: 'PROFESSIONAL', PAYMENT: 'FOUNDER',
};
const INTEGRATION_FOR = (text: string): CapabilityTool | undefined =>
  /\bgoogle\b/i.test(text) ? getTool('google_ads_integration') : /\b(meta|facebook|instagram)\b/i.test(text) ? getTool('meta_integration')
    : /\b(website|landing\s+page|site|domain|shopify)\b/i.test(text) ? getTool('website_publishing') : /\banalytics|pixel|tracking\b/i.test(text) ? getTool('analytics') : undefined;

function external(kind: Exclude<ActionKind, 'PREPARE'>, step: string): ExternalAction {
  const integration = kind === 'PUBLISH' || kind === 'ACCOUNT_SETUP' ? INTEGRATION_FOR(step) : undefined;
  const signer = kind === 'SIGNATURE' && !/\b(lawyer|advocate|ca\b|chartered|notary)\b/i.test(step) ? 'FOUNDER' : WHO[kind];
  return {
    kind, step, performedBy: kind === 'PUBLISH' && !integration ? 'FOUNDER' : signer,
    founderApproval: true, // nothing happens in the outside world without the founder
    ...(integration ? { integration: { id: integration.id, label: integration.label, status: 'NOT_CONNECTED' as const } } : {}),
  };
}

function requiredInputsFor(work: WorkLike, tool: CapabilityTool | undefined): string[] {
  const t = textOf(work);
  const out: string[] = [];
  if (tool?.id === 'book_layout' && /\b(edit|format|proofread|typeset|lay\s*out|layout|sample\s+pdf)\b/i.test(t)) out.push('The manuscript text (paste or upload it) — the AI formats and edits what you supply, it does not invent the book');
  if (/\b(supplied|your|our|existing|provided)\s+(?:\w+\s+){0,2}(?:transaction|sales|order|ledger|bank)\s+(?:data|export|records|statements?)\b|\btransaction\s+data\b/i.test(t)) out.push('The transaction/sales data export the analysis is based on');
  if (tool && ['product_catalogue', 'brochure'].includes(tool.id)) out.push('Product list with names, sizes/specs and prices you want shown (otherwise placeholders are used)');
  if (tool && ['images', 'video'].includes(tool.id)) out.push('Brand assets and real product photos, if available');
  return out;
}

export function classifyWork(work: WorkLike): WorkClassification {
  const cap = routeWork(work);
  const tool = cap.id === 'marketing' ? studioToolFor(work) : undefined;
  const [primary, ...chained] = titleActions(work.title);
  const head = `${work.title}\n${work.deliverable || ''}`;
  const steps: ExternalAction[] = [];
  const add = (a: ExternalAction) => { if (!steps.some((s) => s.kind === a.kind && s.step.toLowerCase() === a.step.toLowerCase())) steps.push(a); };

  if (primary !== 'PREPARE') add(external(primary, work.title));
  for (const k of chained) add(external(k as Exclude<ActionKind, 'PREPARE'>, work.title));
  for (const s of statedExternalSteps(work)) add(external(s.kind, s.step));
  // A prepared campaign / page / post goes live only through the founder's account (integration not connected yet).
  const via = tool?.publishedVia ? getTool(tool.publishedVia) : undefined;
  if (primary === 'PREPARE' && via && !steps.some((s) => s.kind === 'PUBLISH')) {
    steps.push({ kind: 'PUBLISH', step: `Publish via ${via.label} from your own account, after you approve the final version`, performedBy: 'INTEGRATION', founderApproval: true, integration: { id: via.id, label: via.label, status: 'NOT_CONNECTED' } });
  }
  // Regulated deliverables: research is AI work; drafts that will be relied on need a professional; acts need one too.
  const reliance = primary === 'PREPARE' && RELIANCE_DRAFT.test(head) && !RESEARCH_DELIVERABLE.test(work.title);
  if (reliance && cap.requiresProfessional && !steps.some((s) => s.kind === 'SIGNATURE' || s.kind === 'REGULATED_FILING')) {
    steps.push({ kind: 'SIGNATURE', step: `A qualified ${cap.costModel.specialist.toLowerCase()} reviews and approves the draft before it is used`, performedBy: 'PROFESSIONAL', founderApproval: true });
  }

  let executionClass: ExecutionClass;
  if (primary === 'SIGNATURE' || primary === 'REGULATED_FILING') executionClass = 'PROFESSIONAL_APPROVAL';
  else if (primary !== 'PREPARE' && primary !== 'PUBLISH' && primary !== 'ACCOUNT_SETUP' && primary !== 'SEND') executionClass = 'HUMAN_EXECUTION';
  else if (reliance && (cap.requiresProfessional || /\b(contract|agreement|nda|privacy\s+policy|terms)\b/i.test(head))) executionClass = 'AI_WITH_HUMAN_REVIEW';
  else if (steps.some((s) => ['PUBLISH', 'ACCOUNT_SETUP', 'SEND'].includes(s.kind)) || primary !== 'PREPARE') executionClass = 'AI_WITH_INTEGRATION';
  else executionClass = 'AI_DELIVERABLE';

  const modes: ExecutionMode[] = executionClass === 'AI_DELIVERABLE' || executionClass === 'AI_WITH_INTEGRATION' ? ['AI', 'HUMAN', 'HYBRID'] : ['HYBRID', 'HUMAN'];
  const deliverable = (work.deliverable || work.title).trim();
  const aiPrepares = {
    AI_DELIVERABLE: deliverable,
    AI_WITH_INTEGRATION: `${deliverable} — prepared ready to use; nothing is published or sent without your approval`,
    AI_WITH_HUMAN_REVIEW: `A draft of ${deliverable.charAt(0).toLowerCase()}${deliverable.slice(1)} for a qualified reviewer`,
    HUMAN_EXECUTION: `Supporting material for this work (scripts, lists, checklists, templates) — a person does the work itself`,
    PROFESSIONAL_APPROVAL: `The preparation pack (forms pre-filled from your facts, document checklist, explanations) — an authorised person signs or files`,
  }[executionClass];
  const summary = {
    AI_DELIVERABLE: 'AI can prepare this.',
    AI_WITH_INTEGRATION: 'AI can prepare this. Publishing, sending or account steps need your approval and your own account.',
    AI_WITH_HUMAN_REVIEW: 'AI can draft this. A qualified person must review it before it is relied on.',
    HUMAN_EXECUTION: 'A person needs to do this work. AI can prepare the supporting material.',
    PROFESSIONAL_APPROVAL: 'This must be signed or filed by an authorised person or qualified professional. AI can prepare everything for it.',
  }[executionClass];

  return { executionClass, aiCanPrepare: true, aiCanExecute: modes.includes('AI'), aiPrepares, externalActions: steps, requiredInputs: requiredInputsFor(work, tool), modes, capabilityId: cap.id, tool, primaryAction: primary, summary };
}

/** Founder-facing label for who performs an external step. */
export const PERFORMER_LABEL: Record<ExternalAction['performedBy'], string> = {
  FOUNDER: 'You', HUMAN: 'A person (you or someone you appoint)', PROFESSIONAL: 'A qualified professional / authorised signatory', INTEGRATION: 'External account (integration not connected yet)',
};

export const STUDIO_TOOL_IDS = STUDIO_TOOLS.map((t) => t.id);
