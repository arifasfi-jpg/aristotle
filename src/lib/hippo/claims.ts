// Marketing-claim provenance for AI deliverables (landing pages, brochures, catalogues, ads, posts, outreach).
// AI may PROPOSE claims; it must never present invented testimonials, customer names/counts, reviews, statistics,
// certifications, compliance or environmental claims as facts. Deterministic and idempotent: it runs when the output
// is stored AND when it is shown/downloaded, so outputs stored earlier are corrected too.
//
// Labels:
//   FOUNDER_APPROVED — the claim is in the founder's objective, confirmed facts or approvals → kept as written
//   SOURCED          — the claim is in a verified research finding → kept, with its R# citation
//   AI_PROPOSED      — plausible product claim the founder must verify → [CLAIM TO VERIFY: …]
//   PLACEHOLDER      — testimonial slot → [CUSTOMER TESTIMONIAL — INSERT VERIFIED CUSTOMER QUOTE]
//   UNSUPPORTED      — invented social proof / statistic → [UNSUPPORTED CLAIM — DO NOT PUBLISH: …]
import type { ProvenanceContext } from './provenance';

export type ClaimLabel = 'FOUNDER_APPROVED' | 'SOURCED' | 'AI_PROPOSED' | 'PLACEHOLDER' | 'UNSUPPORTED';
export type ClaimCategory = 'TESTIMONIAL' | 'SOCIAL_PROOF' | 'RATING' | 'STATISTIC' | 'CERTIFICATION' | 'ENVIRONMENTAL' | 'PRODUCT_PERFORMANCE' | 'SUPERLATIVE';
export type MarketingClaim = { text: string; category: ClaimCategory; label: ClaimLabel; ref?: string };

export const CLAIM_LABEL: Record<ClaimLabel, string> = {
  FOUNDER_APPROVED: 'Founder-approved claim',
  SOURCED: 'Sourced / verified claim',
  AI_PROPOSED: 'AI-proposed marketing claim — validation required',
  PLACEHOLDER: 'Placeholder — insert verified content',
  UNSUPPORTED: 'Unsupported claim — do not publish',
};
export const TESTIMONIAL_PLACEHOLDER = '[CUSTOMER TESTIMONIAL — INSERT VERIFIED CUSTOMER QUOTE]';
const CLAIMS_MARKER = '<!-- HIPPOTURTLE_CLAIMS -->';

// Already-labelled spans are never touched again (idempotence).
const LABELLED = /\[(?:CLAIM TO VERIFY|UNSUPPORTED CLAIM — DO NOT PUBLISH|CUSTOMER TESTIMONIAL — INSERT VERIFIED CUSTOMER QUOTE)[^\]]*\]/g;

const N = '\\d[\\d,]*(?:\\.\\d+)?';
const PATTERNS: [ClaimCategory, 'AI_PROPOSED' | 'UNSUPPORTED', RegExp][] = [
  ['SOCIAL_PROOF', 'UNSUPPORTED', new RegExp(`\\b(?:loved|trusted|used|chosen|preferred|enjoyed|adopted|relied\\s+on|backed)\\s+by\\s+(?:over\\s+|more\\s+than\\s+)?(?:${N}\\s*(?:k|\\+)?\\+?|thousands|millions|hundreds|countless|many)[^.;:\\n!|]{0,50}`, 'gi')],
  ['SOCIAL_PROOF', 'UNSUPPORTED', new RegExp(`\\bjoin(?:ing)?\\s+(?:over\\s+|more\\s+than\\s+)?(?:${N}\\s*(?:k|\\+)?\\+?|thousands|millions|hundreds)\\s+(?:of\\s+)?[^.;:\\n!|]{0,40}`, 'gi')],
  ['SOCIAL_PROOF', 'UNSUPPORTED', new RegExp(`\\b(?:over|more\\s+than)\\s+${N}\\s*(?:k|\\+)?\\+?\\s+(?:(?:happy|satisfied|delighted|loyal|repeat|returning)\\s+)?(?:customers|clients|users|buyers|families|households|restaurants|businesses|readers|orders|units\\s+sold|copies\\s+sold|downloads)\\b`, 'gi')],
  ['SOCIAL_PROOF', 'UNSUPPORTED', new RegExp(`\\b${N}\\s*(?:k|\\+)?\\+?\\s+(?:happy|satisfied|delighted|loyal|repeat|returning)\\s+(?:customers|clients|users|buyers|families|parents|households|restaurants|businesses|readers|kids)\\b`, 'gi')],
  ['RATING', 'UNSUPPORTED', new RegExp(`\\brated\\s+${N}\\s*(?:\\/\\s*5|out\\s+of\\s+5|stars?)|\\b${N}\\s*(?:\\/\\s*5|out\\s+of\\s+5)\\s*(?:stars?|rating|average)?|★{3,}|\\b${N}\\s*\\+?\\s+(?:five[\\s-]star|5[\\s-]star)?\\s*reviews\\b`, 'gi')],
  // Comparative product claims and claims about what customers say — not plan targets ("aim for 20% more repeat orders").
  ['STATISTIC', 'UNSUPPORTED', new RegExp(`\\b${N}\\s?%\\s+(?:better|faster|stronger|cheaper|lighter|greener|healthier|safer|(?:more|less)\\s+\\w+\\s+than|(?:more|less|longer|lower|higher|fewer)\\s+than|of\\s+(?:our\\s+)?(?:customers|users|people|parents|buyers|restaurants)\\s+(?:say|said|prefer|recommend|love|agree|report)[^.;\\n]{0,40})|\\b${N}x\\s+(?:better|faster|stronger|longer)\\b`, 'gi')],
  ['SUPERLATIVE', 'UNSUPPORTED', /#1\b[^.;\n]{0,30}|\bnumber\s+one\b[^.;\n]{0,30}|\b(?:world|india|america|us)['’]?s?\s+(?:best|first|leading|largest|favourite|favorite)\b[^.;\n]{0,30}|\bbest[\s-]selling\b|\baward[\s-]winning\b|\bguaranteed\s+(?:results?|sales|growth|returns?)\b/gi],
  ['CERTIFICATION', 'AI_PROPOSED', /\b(?:(?:FDA|USDA|FSSAI|BIS|CE|BPI|CDSCO|ISO\s?\d{3,5}|ASTM\s?D?\s?\d{3,5}|EN\s?13432|OK\s+compost|TÜV|TUV|NSF|UL)(?:[\s-]+(?:certified|approved|compliant|registered|listed|cleared|tested)(?:\s+(?:organic|compostable|biodegradable|food[\s-]safe|non[\s-]toxic))?)?|(?:certified|approved|cleared)\s+(?:by\s+(?:the\s+)?)?(?:FDA|USDA|FSSAI|BIS|BPI|CDSCO|TÜV|TUV|NSF)|certified\s+(?:organic|compostable|biodegradable|food[\s-]safe|non[\s-]toxic)|clinically\s+(?:proven|tested)|dermatologically\s+tested|lab[\s-]tested|food[\s-]grade\s+certified)\b/gi],
  ['ENVIRONMENTAL', 'AI_PROPOSED', /\b(?:100\s?%\s+)?(?:fully\s+|completely\s+|totally\s+|naturally\s+)?(?:biodegradable|compostable|home[\s-]compostable)(?:\s+(?:and|&)\s+(?:biodegradable|compostable))?(?:[^.;\n]{0,50}?\bwithin\s+\d+\s*(?:days|weeks|months))?|\b100\s?%\s+(?:natural|organic|chemical[\s-]free|plastic[\s-]free|toxin[\s-]free|eco[\s-]friendly|sustainable|recyclable|pure)\b|\b(?:chemical[\s-]free|plastic[\s-]free|toxin[\s-]free|non[\s-]toxic|zero[\s-]waste|carbon[\s-]neutral|carbon[\s-]negative|BPA[\s-]free|PFAS[\s-]free)\b/gi],
  ['PRODUCT_PERFORMANCE', 'AI_PROPOSED', /\b(?:leak[\s-]?proof|water[\s-]?proof|grease[\s-]?proof|oil[\s-]?proof|unbreakable|shatter[\s-]?proof|microwave[\s-]safe|oven[\s-]safe|freezer[\s-]safe|dishwasher[\s-]safe|heat[\s-]resistant(?:\s+(?:up\s+to|to)\s+\d+\s*°?\s*[CF]?)?|hypoallergenic|medically\s+accurate|\d+\s?%\s+accura(?:te|cy)|lab[\s-]grade\s+accura(?:te|cy))\b/gi],
];

// Testimonials: a quote followed by a person-like attribution ("— Sarah M., Austin TX", "**Priya S.**, Mumbai").
const PERSON = String.raw`(?:[A-Z][a-z]+(?:\s+[A-Z]\.?){1,2}|[A-Z][a-z]+\s+[A-Z][a-z]+)(?:\s*,\s*[A-Z][\w .'-]{1,40}(?:,\s*[A-Z]{2})?)?`;
const TESTIMONIAL = new RegExp(String.raw`(?:^|\n)((?:[>*\-\s]*)?(?:\*\*|_)?["“]([^"”\n]{12,500})["”](?:\*\*|_)?)\s*(?:\n\s*(?:>\s*)?)?[\s>*_]*(?:[—–-]{1,2}|\bby\b)\s*(?:\*\*|_)?(${PERSON})(?:\*\*|_)?[^\n]*`, 'g');
const ATTRIBUTION_LINE = new RegExp(String.raw`(?:^|\n)[>\s*-]*[—–]\s*(?:\*\*|_)?(${PERSON})(?:\*\*|_)?\s*(?=\n|$)`, 'g');

const words = (t: string) => t.toLowerCase().replace(/[’']/g, '').match(/[a-z]{3,}|\d[\d,.]*/g)?.map((w) => w.replace(/,/g, '')) ?? [];
const STOP = new Set(['the', 'and', 'for', 'with', 'are', 'our', 'your', 'you', 'all', 'fully', 'completely', 'totally', 'naturally', 'within', 'over', 'more', 'than', 'made', 'from', 'that', 'this', 'its', 'certified', 'approved', 'proof', 'free', 'safe']);
const stem = (w: string) => w.replace(/(able|ible|ing|ed|es|s)$/, '');
/** Every significant token of the claim (numbers exactly, words by stem) appears in one source text. */
function supportedBy(claim: string, source: string): boolean {
  const src = new Set(words(source).map(stem));
  const need = words(claim).filter((w) => !STOP.has(w)).map(stem);
  return need.length > 0 && need.every((w) => src.has(w));
}

function grounding(claim: string, ctx: ProvenanceContext): { label: 'FOUNDER_APPROVED' | 'SOURCED'; ref: string } | null {
  const founder = [
    { ref: 'founder objective', text: ctx.objectiveText },
    ...ctx.facts.map((f) => ({ ref: f.id, text: `${f.raw} ${f.subject || ''}` })),
    ...ctx.approvals.map((a, i) => ({ ref: `founder approval ${i + 1}`, text: `${a.item} ${a.value}` })),
  ];
  for (const s of founder) if (s.text && supportedBy(claim, s.text)) return { label: 'FOUNDER_APPROVED', ref: s.ref };
  for (const f of ctx.findings) if (supportedBy(claim, `${f.statement} ${f.quote}`)) return { label: 'SOURCED', ref: f.code };
  return null;
}

/** Apply `fn` to the parts of `text` that are not already-labelled placeholders. */
function outsideLabels(text: string, fn: (part: string) => string): string {
  let out = ''; let last = 0;
  for (const m of text.matchAll(LABELLED)) { out += fn(text.slice(last, m.index)) + m[0]; last = m.index! + m[0].length; }
  return out + fn(text.slice(last));
}

export function guardMarketingClaims(markdown: string, ctx: ProvenanceContext): { markdown: string; claims: MarketingClaim[] } {
  const claims: MarketingClaim[] = [];
  const note = (c: MarketingClaim) => { if (!claims.some((x) => x.text === c.text && x.label === c.label)) claims.push(c); };
  const [rawBody, previousLedger = ''] = (markdown || '').split(CLAIMS_MARKER);
  // Re-running keeps the ledger an earlier pass wrote (it names claims the text no longer shows, e.g. removed attributions).
  for (const row of previousLedger.split('\n').filter((l) => /^\|(?!\s*Claim\s*\|)(?!-)/.test(l))) {
    const [text, status, basis] = row.slice(1, -1).split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, '|'));
    const label = (Object.entries(CLAIM_LABEL).find(([, v]) => v === status)?.[0]) as ClaimLabel | undefined;
    if (text && label) note({ text, category: 'TESTIMONIAL', label, ...(label === 'FOUNDER_APPROVED' || label === 'SOURCED' ? { ref: basis } : {}) });
  }
  let body = rawBody.replace(/\s+$/, '');

  // 1. Testimonials with an attribution: never presented as real unless the founder/research supplied the quote.
  body = outsideLabels(body, (part) => part.replace(TESTIMONIAL, (whole, _q, quote: string, person: string) => {
    const g = grounding(quote, ctx);
    if (g) { note({ text: `“${quote}” — ${person}`, category: 'TESTIMONIAL', label: g.label, ref: g.ref }); return whole; } // supplied by the founder/research: real
    note({ text: `Testimonial attributed to an invented customer: “${quote.trim()}”`, category: 'TESTIMONIAL', label: 'PLACEHOLDER' });
    const lead = whole.startsWith('\n') ? '\n' : '';
    return `${lead}${TESTIMONIAL_PLACEHOLDER} _(AI suggestion of what to ask a real customer about — not a real customer: “${quote.trim()}”)_`;
  }).replace(ATTRIBUTION_LINE, (whole, person: string) => {
    note({ text: 'Attribution to an invented customer', category: 'TESTIMONIAL', label: 'PLACEHOLDER' }); void person;
    return `${whole.startsWith('\n') ? '\n' : ''}${TESTIMONIAL_PLACEHOLDER}`;
  }));

  // 2. Social proof, ratings, statistics, superlatives, certifications, environmental and product-performance claims.
  for (const [category, fallback, re] of PATTERNS) {
    body = outsideLabels(body, (part) => part.replace(re, (m: string) => {
      const text = m.trim().replace(/[\s,]+$/, '');
      if (!text) return m;
      const g = grounding(text, ctx);
      if (g) {
        note({ text, category, label: g.label, ref: g.ref });
        return g.label === 'SOURCED' && !new RegExp(`\\[${g.ref}\\]`).test(part) ? `${m} [${g.ref}]` : m;
      }
      note({ text, category, label: fallback });
      const trail = m.slice(m.indexOf(text) + text.length);
      return (fallback === 'UNSUPPORTED' ? `[UNSUPPORTED CLAIM — DO NOT PUBLISH: ${text}]` : `[CLAIM TO VERIFY: ${text}]`) + trail;
    }));
  }

  // Claims already labelled in the text (by the model or an earlier pass) are listed too.
  for (const m of body.matchAll(LABELLED)) {
    const t = m[0];
    const label: ClaimLabel = t.startsWith('[CLAIM TO VERIFY') ? 'AI_PROPOSED' : t.startsWith('[UNSUPPORTED') ? 'UNSUPPORTED' : 'PLACEHOLDER';
    const text = t.replace(/^\[[^:\]]*:?\s*/, '').replace(/\]$/, '') || t;
    if (!claims.some((c) => c.text === text || (label === 'PLACEHOLDER' && c.label === 'PLACEHOLDER'))) claims.push({ text, category: label === 'PLACEHOLDER' ? 'TESTIMONIAL' : 'PRODUCT_PERFORMANCE', label });
  }

  if (!claims.length) return { markdown: body, claims };
  const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const ledger = [
    '', '', CLAIMS_MARKER, '## Claims in this draft',
    '_Checked by Hippoturtle against your stated facts, approvals and sourced research. Only founder-approved and sourced claims may be published as facts._',
    '', '| Claim | Status | Basis |', '|---|---|---|',
    ...claims.map((c) => `| ${esc(c.text)} | ${CLAIM_LABEL[c.label]} | ${c.ref ? esc(c.ref) : c.label === 'PLACEHOLDER' ? 'Collect a real, permitted customer quote' : c.label === 'UNSUPPORTED' ? 'No founder or sourced evidence' : 'Verify before publishing (test report, certificate or founder confirmation)'} |`),
  ].join('\n');
  return { markdown: body + ledger, claims };
}

/** Rules given to the model for customer-facing deliverables (the guard above enforces them regardless). */
export const MARKETING_CLAIM_RULES = `MARKETING CLAIMS (strict):
- Never invent testimonials, customer names or locations, reviews, ratings, customer counts ("loved by thousands"), performance
  statistics ("40% stronger"), certifications, compliance or environmental claims, or "#1/best-selling" claims.
- Only claims stated in the founder's objective/facts/approvals, or in the sourced research (cite R#), may be written as facts.
- Where a testimonial would help, write exactly: ${TESTIMONIAL_PLACEHOLDER}
- Where a product claim is plausible but unverified, keep the idea as: [CLAIM TO VERIFY: <claim, with the conditions to verify>]
  e.g. [CLAIM TO VERIFY: compostable within X days under specified conditions].`;
