// ---------------------------------------------------------------------------
// Founder facts: the structured, locked record of numbers the founder stated.
//
// Lifecycle
//   1. extractFounderFacts(text)  → candidate facts (locked=false). Heuristic, never authoritative.
//   2. The founder reviews / corrects them on the confirmation screen before payment.
//   3. confirmFounderFacts(input) → validated facts with source=FOUNDER_STATED, locked=true.
//   4. Generation receives ONLY confirmed facts; report validation enforces them.
//
// Extraction is deliberately conservative: it separates CURRENT state from TARGETS, PROPOSED
// pricing/estimates, HISTORICAL facts (e.g. start year) and CONDITIONAL statements. When unsure it
// records the number (so nothing is lost) and lets the founder correct it.
// ---------------------------------------------------------------------------

export const FACT_CONCEPTS = [
  'selling_price', 'unit_cost', 'margin', 'volume', 'revenue', 'customers', 'order_quantity', 'aov',
  'marketing_budget', 'shipping', 'channel', 'start_year', 'other',
] as const;
export type FactConcept = (typeof FACT_CONCEPTS)[number];

export const FACT_TIMEFRAMES = ['CURRENT', 'TARGET', 'PROPOSED', 'HISTORICAL', 'CONDITIONAL'] as const;
export type FactTimeframe = (typeof FACT_TIMEFRAMES)[number];

export type Period = 'day' | 'week' | 'month' | 'year';

export type FounderFact = {
  id: string;                       // F1, F2, …
  concept: FactConcept;
  timeframe: FactTimeframe;
  value?: number;                   // single value
  low?: number;                     // range
  high?: number;
  unit: string;                     // "INR/unit", "INR/month", "%", "units/month", "customers", "year", "text"
  period?: Period;
  condition?: string;               // CONDITIONAL: "at 10,000 units"
  deadline?: string;                // TARGET: "October", "Diwali", "March"
  text?: string;                    // non-numeric facts (shipping terms, channels)
  raw: string;                      // exact founder wording of the number
  context: string;                  // sentence it came from
  timeframeEvidence: 'explicit' | 'inferred';
  source: 'FOUNDER_STATED';
  locked: boolean;                  // true ONLY after founder confirmation
  confirmedByFounder: boolean;
};

export const CONCEPT_LABEL: Record<FactConcept, string> = {
  selling_price: 'Selling price', unit_cost: 'Unit cost', margin: 'Margin', volume: 'Volume', revenue: 'Revenue',
  customers: 'Customers', order_quantity: 'Units per order', aov: 'Average order value', marketing_budget: 'Marketing budget',
  shipping: 'Shipping terms', channel: 'Sales channel', start_year: 'Operating since', other: 'Other number',
};
export const TIMEFRAME_LABEL: Record<FactTimeframe, string> = {
  CURRENT: 'Current', TARGET: 'Target', PROPOSED: 'Proposed / estimate', HISTORICAL: 'Historical', CONDITIONAL: 'Conditional',
};

export const MONEY_CONCEPTS: FactConcept[] = ['selling_price', 'unit_cost', 'revenue', 'aov', 'marketing_budget', 'shipping'];
export const COUNT_CONCEPTS: FactConcept[] = ['volume', 'customers', 'order_quantity'];
export const isNumericFact = (f: FounderFact) => typeof f.value === 'number' || (typeof f.low === 'number' && typeof f.high === 'number');

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, mn: 1e6, million: 1e6,
};
const PERIOD_OF: Record<string, Period> = {
  day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', mo: 'month', monthly: 'month', pm: 'month',
  year: 'year', yr: 'year', annum: 'year', annually: 'year', yearly: 'year',
};
const CUSTOMER_NOUNS = 'customers|clients|users|subscribers|members|pharmacies|stores|shops|offices|restaurants|businesses|schools|clinics|hospitals|merchants|retailers|kiranas|outlets|accounts|buyers';
const ITEM_NOUNS = 'units|unit|orders|order|pieces|pcs|packs|pack|items|item|boxes|box|bottles|devices|sarees|meals|tiffins|plates|kg|kgs|tonnes|tons|litres|liters|subscriptions|bookings|deliveries|products|sets|pairs|cups|glucometers|strips';
const COUNT_NOUN_RE = new RegExp(String.raw`^\s*(?:(k|lakh|lakhs|lac)\s+)?((?:${CUSTOMER_NOUNS}|${ITEM_NOUNS}))\b`, 'i');
const DURATION_RE = /^\s*\+?\s*(years?|yrs?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?)\b/i;
const PERIOD_AFTER_RE = /^\s*(?:\/|per|a|an|every|each)\s*(day|week|month|mo|year|yr|annum)\b|^\s*(daily|weekly|monthly|yearly|annually)\b/i;
const PER_UNIT_AFTER_RE = new RegExp(String.raw`^\s*(?:\/|per|a|an|each)\s*(${ITEM_NOUNS}|seat|user|person|head|visit|session|kg)\b`, 'i');

// Tier 1: explicit meaning words (win over denominators such as "per item").
const MONEY_KEYWORDS: [FactConcept, RegExp][] = [
  ['marketing_budget', /marketing|advertis\w*|\bads?\b|ad spend|promotion/g],
  ['shipping', /shipping|delivery charges?|courier|freight/g],
  ['aov', /average order value|\baov\b|basket size|ticket size|order value/g],
  ['other', /acquisition cost|\bcac\b|\brent\b|salary|salaries|loan|funding|investment|capital|valuation/g],
  ['unit_cost', /cost price|\bcosts?\b|landed|purchase price|procure\w*|\bcogs\b|buy(?:ing)?(?: it| them)? (?:at|for)|making cost|manufactur\w*/g],
  ['selling_price', /selling price|\bprice[ds]?\b|pricing|\bmrp\b|sell(?:s|ing)?(?: it| them| each)? (?:at|for)|\bcharg(?:e|es|ing)\b|subscription|\bfee\b|retail(?:s|ing)? (?:at|for)/g],
  ['revenue', /revenue|\bsales\b|turnover|\bgmv\b|\bdoing\b|\bmaking\b|clocking|generating|\bearn(?:ing|s)?\b|billing|business of/g],
];

const TARGET_CUE = /(?:\btarget(?:ing)?|\bgoal|\baim(?:ing)?|\breach|\bhit|\bachieve|\bgrow(?:ing)? to|\bscale to|\bget to|\btouch|\bcross|\bwants?|→|\bupto|\bup to)\W*(?:\w+\W+){0,2}$/i;
const HYPOTHETICAL_CUE = /\b(?:would|could|might|will|expect(?:ed|ing)?|estimat\w*|projected|assum\w*|should|plan(?:ning)? to|going to|hope to|likely)\b/i;
const CURRENT_CUE = /\b(?:currently|current|right now|now|today|at present|presently|this month|last month|doing|making|clocking|generating|we sell|we're selling|we are selling|i sell|i'm selling|selling|sales are|sales of|monthly sales|existing|we have|i have|we've been|i've been|have been|so far|already)\b/i;

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const FESTIVALS = 'diwali|deepavali|holi|eid|christmas|new year|navratri|dussehra|pongal|onam|rakhi|raksha bandhan';
const DEADLINE_RE = new RegExp(
  String.raw`\b(?:by|before|until|till|in|within|by end of|end of)\s+((?:the\s+)?(?:${MONTHS})\b(?:\s+\d{4})?|${FESTIVALS}|q[1-4](?:\s*(?:fy)?\s*'?\d{2,4})?|fy\s*'?\d{2,4}|next (?:month|quarter|year)|(?:the )?end of (?:the )?(?:month|quarter|year)|year[- ]end|\d+\s+(?:months?|weeks?|days?)|(?:19|20)\d{2})\b`,
  'i',
);
const BARE_MONTH_RE = new RegExp(String.raw`\b(january|february|march|april|june|july|august|september|october|november|december|${FESTIVALS})\b`, 'i');
const START_YEAR_RE = /\b(?:started|start(?:ed)? in|since|founded|established|incorporated|began|begun|launched|operating since|running since|in business since|set up)\s+(?:in\s+|back in\s+)?((?:19|20)\d{2})\b/i;

const CHANNELS: [string, RegExp][] = [
  ['Amazon', /\bamazon\b/i], ['Flipkart', /\bflipkart\b/i], ['Meesho', /\bmeesho\b/i], ['Myntra', /\bmyntra\b/i],
  ['Nykaa', /\bnykaa\b/i], ['Blinkit', /\bblinkit\b/i], ['Zepto', /\bzepto\b/i], ['Swiggy', /\bswiggy\b/i],
  ['Zomato', /\bzomato\b/i], ['IndiaMART', /\bindiamart\b/i], ['Instagram', /\binstagram\b/i], ['WhatsApp', /\bwhatsapp\b/i],
  ['Own website', /\b(?:our|my) (?:own )?(?:website|site|online store)\b|\bshopify\b/i], ['Offline retail', /\b(?:our|my) (?:shop|store|outlet)s?\b|\bretail stores?\b|\bdistributors?\b/i],
];
const SELLING_HISTORY_CUE = /\b(?:been selling|currently selling|we sell|i sell|selling on|sell on|sell through|sold on|listed on|sales on|doing|we're on|we are on)\b/i;

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------
type Tok = {
  start: number; end: number; raw: string;
  kind: 'money' | 'percent' | 'count' | 'year' | 'bare';
  value?: number; low?: number; high?: number;
  moneyPeriod?: Period;
  noun?: string;
  consumed?: boolean;
};

export function normaliseText(text: string): string {
  return (text || '')
    .replace(/ /g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\s*(?:->|=>|→)\s*/g, ' → ')
    .replace(/\bRs\.?\s*/gi, '₹')
    .replace(/\bINR\s*/g, '₹')
    .replace(/[ \t]+/g, ' ');
}

function splitSentences(text: string): string[] {
  return normaliseText(text).split(/\n+|;|(?<=[.!?])\s+(?=[A-Z₹\d"'(])/).map((s) => s.trim().replace(/[.!?]+$/, '')).filter(Boolean);
}

const toNum = (s: string, mult?: string) => {
  const n = Number(s.replace(/,/g, ''));
  const m = mult ? MULT[mult.toLowerCase()] ?? 1 : 1;
  return Math.round(n * m * 100) / 100;
};

function tokenise(sentence: string): Tok[] {
  const toks: Tok[] = [];
  const taken = (s: number, e: number) => toks.some((t) => s < t.end && e > t.start);

  // Percent ranges and percents
  for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)\s*%?\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:%|percent)/gi)) {
    toks.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0], kind: 'percent', low: Number(m[1]), high: Number(m[2]) });
  }
  for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)/gi)) {
    if (!taken(m.index!, m.index! + m[0].length)) toks.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0], kind: 'percent', value: Number(m[1]) });
  }
  // Money with currency symbol
  for (const m of sentence.matchAll(/₹\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|l|cr|crores?|mn|million)?\b/gi)) {
    const end = m.index! + m[0].length;
    if (taken(m.index!, end)) continue;
    const t: Tok = { start: m.index!, end, raw: m[0].trim(), kind: 'money', value: toNum(m[1], m[2]) };
    const pm = PERIOD_AFTER_RE.exec(sentence.slice(end));
    if (pm) t.moneyPeriod = PERIOD_OF[(pm[1] || pm[2]).toLowerCase()];
    toks.push(t);
  }
  // Numbers (with optional k / L / lakh / crore)
  for (const m of sentence.matchAll(/(?<![\d₹.,])(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|l|cr|crores?|mn|million)?(?![\d%])\b/gi)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (taken(start, end)) continue;
    const after = sentence.slice(end);
    const mult = m[2]?.toLowerCase();
    const value = toNum(m[1], m[2]);
    const noun = COUNT_NOUN_RE.exec(after);
    if (!mult && /^(19|20)\d{2}$/.test(m[1])) { toks.push({ start, end, raw: m[0], kind: 'year', value }); continue; }
    if (DURATION_RE.test(after)) continue; // "2 years", "30 mins": durations are not commercial numbers
    if (noun) { toks.push({ start, end: end + noun[0].length, raw: (m[0] + noun[0]).trim(), kind: 'count', value, noun: noun[2].toLowerCase() }); continue; }
    if (mult && mult !== 'k' && mult !== 'thousand') {
      // "8L/month", "₹-less 1 crore": lakh/crore amounts are money unless followed by a count noun
      const t: Tok = { start, end, raw: m[0].trim(), kind: 'money', value };
      const pm = PERIOD_AFTER_RE.exec(after);
      if (pm) t.moneyPeriod = PERIOD_OF[(pm[1] || pm[2]).toLowerCase()];
      toks.push(t);
      continue;
    }
    toks.push({ start, end, raw: m[0].trim(), kind: 'bare', value });
  }
  return toks.sort((a, b) => a.start - b.start);
}

function nearestKeyword(before: string, after: string): FactConcept | null {
  let best: { c: FactConcept; d: number } | null = null;
  for (const [c, re] of MONEY_KEYWORDS) {
    for (const m of before.matchAll(re)) { const d = before.length - (m.index! + m[0].length); if (!best || d < best.d) best = { c, d }; }
    for (const m of after.matchAll(re)) { const d = m.index! + 0.5; if (!best || d < best.d) best = { c, d }; }
  }
  return best?.c ?? null;
}

const lastWords = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(-n).join(' ');

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
export type FactExtraction = { facts: FounderFact[]; notes: string[] };

export function extractFounderFacts(text: string): FactExtraction {
  const facts: Omit<FounderFact, 'id'>[] = [];
  const notes: string[] = [];
  const channels = new Set<string>();
  const base = { source: 'FOUNDER_STATED' as const, locked: false, confirmedByFounder: false };

  for (const sentence of splitSentences(text)) {
    const lower = sentence.toLowerCase();
    const toks = tokenise(sentence);
    const arrowAt = sentence.indexOf('→');

    // Operating start year (historical, never a deadline)
    const sy = START_YEAR_RE.exec(sentence);
    let startYearSpan: [number, number] | null = null;
    if (sy) {
      const yi = sy.index! + sy[0].lastIndexOf(sy[1]);
      startYearSpan = [yi, yi + 4];
      facts.push({ ...base, concept: 'start_year', timeframe: 'HISTORICAL', value: Number(sy[1]), unit: 'year', raw: sy[0], context: sentence, timeframeEvidence: 'explicit' });
    }

    // Deadline for targets in this sentence (skip the start-year phrase)
    const masked = startYearSpan ? sentence.slice(0, startYearSpan[0]) + '    ' + sentence.slice(startYearSpan[1]) : sentence;
    const dm = DEADLINE_RE.exec(masked);
    let deadline = dm ? dm[1].trim() : undefined;
    if (!deadline && (TARGET_CUE.test(lower) || arrowAt >= 0 || /\btarget|\bgoal|\breach/.test(lower))) {
      const bm = BARE_MONTH_RE.exec(masked);
      if (bm) deadline = bm[1];
    }
    if (deadline) deadline = deadline.replace(/^\w/, (c) => c.toUpperCase());

    const sentenceHasCurrent = CURRENT_CUE.test(sentence);

    toks.forEach((t, i) => {
      if (t.consumed) return;
      if (t.kind === 'year') {
        if (startYearSpan && t.start >= startYearSpan[0] - 1 && t.start <= startYearSpan[1]) return;
        return; // other years only act as deadlines (handled above)
      }
      const prevEnd = i > 0 ? toks[i - 1].end : 0;
      const nextStart = i < toks.length - 1 ? toks[i + 1].start : sentence.length;
      const before = sentence.slice(Math.max(prevEnd, t.start - 60), t.start).toLowerCase();
      const after = sentence.slice(t.end, Math.min(nextStart, t.end + 40)).toLowerCase();
      const prefix = sentence.slice(0, t.start).toLowerCase();
      const recent = lastWords(before, 4);

      // Timeframe
      let timeframe: FactTimeframe = 'CURRENT';
      let evidence: FounderFact['timeframeEvidence'] = 'inferred';
      const afterArrow = arrowAt >= 0 && t.start > arrowAt;
      const beforeArrow = arrowAt >= 0 && t.start < arrowAt;
      let condition: string | undefined;
      const condBefore = /\bat\s+(\d[\d,.]*\s*k?\s*[a-z]*)\s*$/i.exec(sentence.slice(0, t.start).replace(/\s+$/, ' '));
      if (afterArrow || TARGET_CUE.test(recent + ' ') || TARGET_CUE.test(recent)) { timeframe = 'TARGET'; evidence = 'explicit'; }
      else if (beforeArrow) { timeframe = 'CURRENT'; evidence = 'explicit'; }
      else if (HYPOTHETICAL_CUE.test(before) || (HYPOTHETICAL_CUE.test(prefix) && !CURRENT_CUE.test(prefix))) { timeframe = 'PROPOSED'; evidence = 'explicit'; }
      else if (CURRENT_CUE.test(prefix) || CURRENT_CUE.test(before)) { timeframe = 'CURRENT'; evidence = 'explicit'; }

      const push = (f: Omit<FounderFact, 'id' | 'source' | 'locked' | 'confirmedByFounder' | 'context' | 'timeframeEvidence'> & Partial<Pick<FounderFact, 'timeframeEvidence'>>) => {
        const tf = f.timeframe;
        facts.push({ ...base, context: sentence, timeframeEvidence: evidence, ...f, ...(tf === 'TARGET' && deadline && !f.deadline ? { deadline } : {}) });
      };

      if (t.kind === 'percent') {
        const near = before + ' ' + after;
        if (/margin|mark-?up|profit/.test(near) || /margin|mark-?up/.test(lower)) {
          let basis = '';
          if (/\bgross\b/.test(near)) basis = 'gross';
          else if (/\bnet\b/.test(near)) basis = 'net';
          else if (/on cost|mark-?up/.test(near)) basis = 'on cost';
          else if (/on (?:selling )?price|on mrp/.test(near)) basis = 'on price';
          // Conditional: "at 10,000 units margin could reach 15%" / "15% at 10K"
          const condAfter = /^\s*(?:,\s*)?at\s+(\d[\d,.]*\s*k?(?:\s+(?:units|orders|customers|pieces))?)/i.exec(sentence.slice(t.end));
          const condPrev = /\bat\s+(\d[\d,.]*\s*k?(?:\s+(?:units|orders|customers|pieces))?)\s+(?:the\s+)?margins?\b/i.exec(sentence.slice(0, t.start));
          if (condAfter || condPrev) {
            condition = `at ${(condAfter || condPrev)![1].trim()}`;
            timeframe = 'CONDITIONAL'; evidence = 'explicit';
            if (condAfter) { const next = toks[i + 1]; if (next && next.start >= t.end && next.start - t.end < 12) next.consumed = true; }
          } else if (timeframe === 'PROPOSED' && /\bpotentially|could reach|can reach|may reach/.test(near)) {
            timeframe = 'CONDITIONAL';
          }
          push({ concept: 'margin', timeframe, ...(t.low !== undefined ? { low: t.low, high: t.high } : { value: t.value }), unit: basis ? `% (${basis})` : '%', raw: t.raw, ...(condition ? { condition } : {}) });
        } else {
          push({ concept: 'other', timeframe, ...(t.low !== undefined ? { low: t.low, high: t.high } : { value: t.value }), unit: '%', raw: t.raw });
        }
        return;
      }

      if (t.kind === 'money') {
        let concept = nearestKeyword(before, after);
        const perUnit = PER_UNIT_AFTER_RE.exec(sentence.slice(t.end));
        if (!concept) {
          if (perUnit || t.moneyPeriod) concept = 'selling_price'; // "₹60 per pack", "SaaS at ₹1,499/month": pricing, NOT revenue
          else if (timeframe === 'TARGET' && (t.value ?? 0) >= 1e5) {
            concept = 'revenue';
            notes.push(`"${t.raw}" read as a revenue target from "${sentence}". Please confirm.`);
          } else concept = 'other';
        }
        // A revenue word must be present for revenue; a bare period never makes something revenue.
        if (concept === 'selling_price' && timeframe === 'CURRENT' && evidence === 'inferred') timeframe = 'PROPOSED';
        if (concept === 'selling_price' && /\bsell|selling|we charge|currently/.test(prefix) && timeframe !== 'TARGET') { timeframe = 'CURRENT'; evidence = 'explicit'; }
        if (concept === 'unit_cost' && timeframe === 'TARGET' && !/reduce|bring down|lower/.test(before)) { timeframe = 'CURRENT'; }
        const unit =
          concept === 'selling_price' ? (perUnit ? `INR/${perUnit[1].toLowerCase().replace(/s$/, '')}` : t.moneyPeriod ? `INR/${t.moneyPeriod}` : 'INR/unit')
          : concept === 'unit_cost' ? (perUnit ? `INR/${perUnit[1].toLowerCase().replace(/s$/, '')}` : 'INR/unit')
          : t.moneyPeriod ? `INR/${t.moneyPeriod}` : 'INR';
        const f: Parameters<typeof push>[0] = { concept, timeframe, value: t.value, unit, raw: t.raw, ...(t.moneyPeriod ? { period: t.moneyPeriod } : {}) };
        if (concept === 'shipping') f.text = sentence;
        push(f);
        return;
      }

      if (t.kind === 'count') {
        const noun = t.noun!;
        const pm = PERIOD_AFTER_RE.exec(sentence.slice(t.end));
        const period = pm ? PERIOD_OF[(pm[1] || pm[2]).toLowerCase()] : undefined;
        let concept: FactConcept = new RegExp(`^(?:${CUSTOMER_NOUNS})$`, 'i').test(noun) ? 'customers' : 'volume';
        if (/average order (?:quantity|size)|units? per order|per order|\baov\b|order quantity/.test(before)) concept = 'order_quantity';
        // "At 10,000 units margin could reach 15%": volume that conditions a margin statement
        if (/\bat\s*$/.test(before.trimEnd() + ' ') && /margin/.test(sentence.slice(t.end).toLowerCase()) && !afterArrow) { timeframe = 'CONDITIONAL'; evidence = 'explicit'; }
        push({ concept, timeframe, value: t.value, unit: concept === 'order_quantity' ? `${noun}/order` : `${noun}${period ? `/${period}` : ''}`, raw: t.raw, ...(period ? { period } : {}) });
        return;
      }

      // Bare numbers
      if (/average order (?:quantity|size)|units? per order|order quantity|\baov\b/.test(before)) {
        push({ concept: 'order_quantity', timeframe: timeframe === 'TARGET' ? 'TARGET' : 'CURRENT', value: t.value, unit: 'units/order', raw: t.raw });
        return;
      }
      if (afterArrow || timeframe === 'TARGET') {
        const leftVolume = [...facts].reverse().find((f) => f.context === sentence && (f.concept === 'volume' || f.concept === 'customers'));
        if (leftVolume) {
          push({ concept: leftVolume.concept, timeframe: 'TARGET', value: t.value, unit: leftVolume.unit.replace(/\/(day|week|month|year)$/, ''), raw: t.raw });
          notes.push(`Target "${t.raw}" has no unit or period stated; assumed the same item as "${leftVolume.raw}". Please confirm.`);
          return;
        }
      }
      if ((t.value ?? 0) >= 10) push({ concept: 'other', timeframe, value: t.value, unit: 'number', raw: t.raw });
    });

    // Shipping terms without an amount ("shipping paid by customer", "free delivery", "COD")
    if (/shipping|delivery charges?|courier|\bcod\b|cash on delivery|free delivery/i.test(sentence) && !facts.some((f) => f.concept === 'shipping' && f.context === sentence)) {
      facts.push({ ...base, concept: 'shipping', timeframe: 'CURRENT', unit: 'text', text: sentence, raw: sentence, context: sentence, timeframeEvidence: 'inferred' });
    }
    // Channels (only when the sentence talks about selling through them)
    // Clause-level so "selling on Instagram…, now want to launch our website" keeps Instagram but not the planned website.
    for (const clause of sentence.split(/,\s*|\s+(?:and|but|now|then|so)\s+/i)) {
      if (!SELLING_HISTORY_CUE.test(clause) || /\b(?:launch|start|build|open|create|want|plan|planning|will|going to)\b/i.test(clause)) continue;
      for (const [name, re] of CHANNELS) if (re.test(clause)) channels.add(name);
    }
  }

  for (const c of channels) facts.push({ ...base, concept: 'channel', timeframe: 'CURRENT', unit: 'text', text: c, raw: c, context: c, timeframeEvidence: 'explicit' });

  // Deduplicate a conditional volume that merely repeats a target volume
  const out = facts.filter((f, i) => !(f.concept === 'volume' && f.timeframe === 'CONDITIONAL' && facts.some((g, j) => j !== i && g.concept === 'volume' && g.timeframe === 'TARGET' && g.value === f.value)));
  if (out.some((f) => f.concept === 'margin' && (f.low !== undefined || f.unit === '%'))) {
    const m = out.find((f) => f.concept === 'margin' && f.timeframe !== 'CONDITIONAL')!;
    if (m && (m.low !== undefined || m.unit === '%')) notes.push(`Margin "${m.raw}" ${m.low !== undefined ? 'is a range and ' : ''}${m.unit === '%' ? 'does not state whether it is on cost or on selling price' : ''}. It is kept exactly as stated.`);
  }
  return { facts: out.map((f, i) => ({ ...f, id: `F${i + 1}` })), notes };
}

// ---------------------------------------------------------------------------
// Founder confirmation → locked facts
// ---------------------------------------------------------------------------
export type FounderFactInput = Partial<Pick<FounderFact, 'concept' | 'timeframe' | 'value' | 'low' | 'high' | 'unit' | 'period' | 'condition' | 'deadline' | 'text' | 'raw' | 'context'>>;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13 ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')) : undefined);

/** Validate founder-reviewed facts. Throws on invalid input. Output facts are locked FOUNDER_STATED. */
export function confirmFounderFacts(input: unknown): FounderFact[] {
  if (!Array.isArray(input)) throw new Error('facts must be an array');
  if (input.length > 40) throw new Error('too many facts');
  return input.map((raw, i) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const concept = f.concept as FactConcept;
    const timeframe = f.timeframe as FactTimeframe;
    if (!FACT_CONCEPTS.includes(concept)) throw new Error(`fact ${i + 1}: invalid concept`);
    if (!FACT_TIMEFRAMES.includes(timeframe)) throw new Error(`fact ${i + 1}: invalid timeframe`);
    const value = num(f.value);
    const low = num(f.low);
    const high = num(f.high);
    const text = str(f.text, 300);
    const hasRange = low !== undefined && high !== undefined;
    if (value === undefined && !hasRange && !text) throw new Error(`fact ${i + 1}: needs a number or text`);
    if (hasRange && low! > high!) throw new Error(`fact ${i + 1}: low is greater than high`);
    const period = f.period && ['day', 'week', 'month', 'year'].includes(f.period as string) ? (f.period as Period) : undefined;
    return {
      id: `F${i + 1}`,
      concept,
      timeframe,
      ...(hasRange ? { low, high } : value !== undefined ? { value } : {}),
      unit: str(f.unit, 40) || (concept === 'margin' ? '%' : MONEY_CONCEPTS.includes(concept) ? 'INR' : 'count'),
      ...(period ? { period } : {}),
      ...(str(f.condition, 200) ? { condition: str(f.condition, 200) } : {}),
      ...(str(f.deadline, 80) ? { deadline: str(f.deadline, 80) } : {}),
      ...(text ? { text } : {}),
      raw: str(f.raw, 300) || '',
      context: str(f.context, 500) || '',
      timeframeEvidence: 'explicit' as const,
      source: 'FOUNDER_STATED' as const,
      locked: true,
      confirmedByFounder: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------
export function formatFactValue(f: FounderFact): string {
  const n = (v: number) => v.toLocaleString('en-IN');
  if (f.text && !isNumericFact(f)) return f.text;
  const core = f.low !== undefined && f.high !== undefined ? `${n(f.low)}–${n(f.high)}` : f.value !== undefined ? n(f.value) : '';
  if (f.concept === 'margin' || f.unit.startsWith('%')) return `${core}%${f.unit.length > 1 ? ` ${f.unit.slice(1).trim()}` : ''}`;
  if (f.concept === 'start_year') return String(f.value);
  if (f.unit.startsWith('INR')) return `₹${core}${f.unit.slice(3)}`;
  return `${core} ${f.unit}`;
}

export function describeFact(f: FounderFact): string {
  return `${TIMEFRAME_LABEL[f.timeframe]} ${CONCEPT_LABEL[f.concept].toLowerCase()}: ${formatFactValue(f)}${f.deadline ? ` by ${f.deadline}` : ''}${f.condition ? ` (${f.condition})` : ''}`;
}

/** Prompt block: confirmed facts by ID. Empty when there are none (NEW_IDEA prompt unchanged). */
export function buildFounderFactsBlock(facts?: FounderFact[] | null): string {
  const locked = (facts || []).filter((f) => f.locked && f.confirmedByFounder);
  if (!locked.length) return '';
  return `
════════════════════════════════════════════════════════════════════════
CONFIRMED FOUNDER FACTS (locked — the founder reviewed and confirmed these)
════════════════════════════════════════════════════════════════════════
${locked.map((f) => `${f.id}: ${describeFact(f)}  [founder wrote: "${f.raw}"]`).join('\n')}

Rules:
- These are FOUNDER-STATED facts. Use them exactly. Never replace, round, re-estimate or contradict them.
- CURRENT is what already happens; TARGET is what the founder wants; PROPOSED is planned pricing or an estimate;
  CONDITIONAL applies only under its stated condition. Never turn a TARGET or PROPOSED price into current revenue.
- In unitEconomics, a row that restates a fact must set provenance "FOUNDER_STATED" and factId to its ID (e.g. "F2").
- A row you calculate must set provenance "CALCULATED" and list the fact IDs it uses in "inputs".
- A different figure (benchmark, scenario) is allowed only with provenance EXTERNAL / ASSUMPTION / HYPOTHESIS,
  a "basis" explaining why it differs, and a metric name that makes clear it is not the founder's figure.
`;
}
