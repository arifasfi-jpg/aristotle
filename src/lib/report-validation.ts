// ---------------------------------------------------------------------------
// Report validation / normalisation.
//
// Runs on EVERY generated report (Gemini or deterministic fallback), after generation and before saving.
// Prompting alone is not trusted. Guarantees:
//   1. A number shown as FOUNDER_STATED equals a confirmed, locked founder fact.
//   2. A row about the same concept + timeframe as a founder fact either equals it, or is kept only
//      as a clearly labelled EXTERNAL / ASSUMPTION / HYPOTHESIS figure with a stated basis.
//   3. CALCULATED rows must trace to founder facts or explicitly labelled assumption rows.
//   4. Proposed pricing is never presented as revenue.
//   5. Units match the concept (counts never carry ₹; margins are %).
//   6. Every numeric founder fact appears in unit economics.
//   7. Narrative text that contradicts a founder figure is flagged in assumptions.
// ---------------------------------------------------------------------------
import type { AuditReport, Provenance, RowConcept, RowTimeframe, UnitEconomicsRow } from './audit';
import { COUNT_CONCEPTS, MONEY_CONCEPTS, NON_ECONOMIC_CONCEPTS, formatFactValue, isNumericFact, type FactConcept, type FounderFact } from './founder-facts';

export type ValidationLog = {
  corrected: { metric: string; factId: string; from: [number, number, number]; to: [number, number, number] }[];
  keptAsScenario: string[];
  downgraded: { metric: string; reason: string }[];
  converted: string[];
  unitFixed: string[];
  insertedFacts: string[];
  proseConflicts: string[];
};

const PROVENANCES: Provenance[] = ['FOUNDER_STATED', 'CALCULATED', 'EXTERNAL', 'ASSUMPTION', 'HYPOTHESIS'];
const TIMEFRAMES: RowTimeframe[] = ['CURRENT', 'TARGET', 'PROPOSED', 'CONDITIONAL', 'PROJECTION', 'ASSUMPTION'];
const STATIC_CONCEPTS: FactConcept[] = ['unit_cost', 'selling_price', 'margin', 'order_quantity', 'aov'];

/** Backup for rows without tags (older stored reports / model non-compliance). */
export function inferConcept(metric: string, unit: string): RowConcept {
  const m = metric.toLowerCase();
  const u = unit.toLowerCase();
  // Ages describe people, not the business; checked first so "age of customers" is never a customer count.
  if (/\bages?\b|\baged\b|years?[- ]old/.test(m)) {
    if (/founder|owner|author|\bmy\b|\bceo\b|entrepreneur/.test(m)) return 'founder_age';
    if (/audience|customer|reader|kid|child|student|user|buyer|target|segment|group|range/.test(m)) return 'audience_age';
    return 'other';
  }
  // A difference between two figures (premium, gap, discount vs a competitor) is not itself a price or cost.
  if (/premium|difference|\bgap\b|\bversus\b|\bvs\.?\s|discount (to|vs|versus|against)/.test(m)) return 'other';
  if (/acquisition|\bcac\b/.test(m)) return 'cac';
  if (/payback/.test(m)) return 'payback';
  if (/contribution/.test(m) && !/margin/.test(m)) return 'contribution';
  if (/marketing|advertis|ad spend/.test(m) && /budget|spend/.test(m)) return 'marketing_budget';
  if (/margin/.test(m)) return u.includes('₹') || u.includes('inr') ? 'contribution' : 'margin';
  if (/order quantity|units per order|basket units/.test(m)) return 'order_quantity';
  if (/average order value|\baov\b/.test(m)) return 'aov';
  if (/shipping|delivery charge|courier/.test(m)) return 'shipping';
  if (/(unit|product|landed|purchase|procurement|buying|manufacturing)\s+cost|cost (per|\/)|cost price|\bcogs\b|^cost\b/.test(m) && !/total|variable|fulfil|logistics/.test(m)) return 'unit_cost';
  if (/price|\bmrp\b|\basp\b|subscription fee|revenue per (unit|order|customer)|revenue \/ unit/.test(m)) return 'selling_price';
  if (/revenue|sales value|turnover|\bgmv\b/.test(m)) return 'revenue';
  if (/customers|clients|pharmacies|stores|subscribers|users/.test(m) && !/per (customer|user)/.test(m)) return 'customers';
  if (/units|volume|orders|meals|packs|pieces/.test(m)) return 'volume';
  return 'other';
}

function inferProvenance(assumption: string): Provenance {
  const a = (assumption || '').toUpperCase();
  if (a.startsWith('FOUNDER-STATED') || a.startsWith('FOUNDER_STATED')) return 'FOUNDER_STATED';
  if (a.startsWith('CALCULATED') || a.startsWith('DERIVED')) return 'CALCULATED';
  if (a.startsWith('EXTERNAL') || a.startsWith('INFERENCE')) return 'EXTERNAL';
  if (a.startsWith('HYPOTHESIS')) return 'HYPOTHESIS';
  return 'ASSUMPTION';
}

function inferTimeframe(metric: string): RowTimeframe {
  const m = metric.toLowerCase();
  if (/\btarget|\bgoal/.test(m)) return 'TARGET';
  if (/projected|forecast|expected|at target|scenario|break-?even|needed|required/.test(m)) return 'PROJECTION';
  return 'CURRENT';
}

const cls = (t: string) => (t === 'TARGET' || t === 'CONDITIONAL' ? 'target' : t === 'PROJECTION' || t === 'ASSUMPTION' ? 'projection' : 'now');

function factRow(f: FounderFact): UnitEconomicsRow {
  const range = f.low !== undefined && f.high !== undefined;
  const lo = range ? f.low! : f.value!;
  const hi = range ? f.high! : f.value!;
  const label = {
    selling_price: 'Selling price', unit_cost: 'Unit cost', margin: 'Margin', volume: 'Volume', revenue: 'Revenue', customers: 'Customers',
    order_quantity: 'Units per order', aov: 'Average order value', marketing_budget: 'Marketing budget', shipping: 'Shipping cost',
    channel: 'Channel', start_year: 'Operating since', founder_age: 'Founder age', audience_age: 'Target audience age', other: 'Stated figure',
  }[f.concept];
  const tf = NON_ECONOMIC_CONCEPTS.includes(f.concept) ? '' : f.timeframe === 'CURRENT' ? 'Current ' : f.timeframe === 'TARGET' ? 'Target ' : f.timeframe === 'PROPOSED' ? 'Proposed ' : f.timeframe === 'CONDITIONAL' ? 'Conditional ' : '';
  // Name the row after what the founder said the number is about ("Target volume — physical books").
  const what = f.subject && !['founder', 'target audience'].includes(f.subject) ? ` — ${f.subject}` : '';
  return {
    metric: `${tf}${label.toLowerCase()}${what} (founder-stated)`.replace(/^\w/, (c) => c.toUpperCase()),
    conservative: lo,
    base: range ? Math.round(((lo + hi) / 2) * 100) / 100 : lo,
    upside: hi,
    unit: displayUnit(f),
    commentary: `Founder-stated and confirmed${f.deadline ? `; deadline ${f.deadline}` : ''}${f.condition ? `; applies ${f.condition}` : ''}${range ? '; stated as a range (low / midpoint / high)' : ''}.`,
    assumption: `FOUNDER-STATED (LOCKED) ${f.id}: "${f.raw}"`,
    concept: f.concept as RowConcept,
    timeframe: f.timeframe as RowTimeframe,
    provenance: 'FOUNDER_STATED',
    factId: f.id,
  };
}

function displayUnit(f: FounderFact): string {
  if (f.concept === 'margin') return f.unit.startsWith('%') ? f.unit : '%';
  if (f.unit.startsWith('INR')) return `₹${f.unit.slice(3).replace(/^\//, ' / ')}` || '₹';
  return f.unit.replace('/', ' / ');
}

function valuesMatch(row: UnitEconomicsRow, f: FounderFact): boolean {
  if (f.low !== undefined && f.high !== undefined) return row.conservative === f.low && row.upside === f.high && row.base >= f.low && row.base <= f.high;
  return row.conservative === f.value && row.base === f.value && row.upside === f.value;
}

function fixUnit(row: UnitEconomicsRow, log: ValidationLog): UnitEconomicsRow {
  const c = row.concept as FactConcept;
  const u = row.unit || '';
  const hasMoney = /₹|\binr\b|\brs\b/i.test(u);
  if (COUNT_CONCEPTS.includes(c) && hasMoney) {
    log.unitFixed.push(row.metric);
    return { ...row, unit: u.replace(/₹\s*\/?\s*|\binr\b\s*\/?\s*|\brs\.?\b\s*\/?\s*/gi, '').trim() || 'count' };
  }
  if (MONEY_CONCEPTS.includes(c) && !hasMoney && c !== 'shipping') {
    log.unitFixed.push(row.metric);
    return { ...row, unit: `₹ ${u}`.trim() };
  }
  if (c === 'margin' && !u.includes('%')) { log.unitFixed.push(row.metric); return { ...row, unit: '%' }; }
  return row;
}

// ---------------------------------------------------------------------------
// Semantic fact matching. A founder number may only be attached to a row that is about the SAME thing:
// same concept, and — when several founder facts share a concept — the same subject ("physical books" vs
// "digital books"). The catch-all concept "other" never matches by concept alone, and ages never match
// anything but the same kind of age. Ambiguity means no match (a number is never guessed onto a row).
// ---------------------------------------------------------------------------
const GENERIC_WORDS = new Set(['target', 'current', 'founder', 'stated', 'proposed', 'conditional', 'volume', 'number', 'figure', 'other', 'per', 'month', 'monthly', 'week', 'year', 'day', 'total', 'the', 'and', 'of', 'a', 'an', 'to', 'in', 'for', 'sales', 'sold', 'sell', 'goal', 'units', 'unit']);
const wordsOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !GENERIC_WORDS.has(w)).map((w) => w.replace(/s$/, ''));
const AGE_CONCEPTS = ['founder_age', 'audience_age'];
/**
 * Founder facts that are unit-economics quantities. Ages describe people; "other" is a number whose meaning is
 * unknown; start year and channel are context. None of these become unit-economics rows on their own.
 */
const ECONOMIC_CONCEPTS: FactConcept[] = ['selling_price', 'unit_cost', 'margin', 'volume', 'revenue', 'customers', 'order_quantity', 'aov', 'marketing_budget', 'shipping'];
export const isEconomicFact = (f: FounderFact) => ECONOMIC_CONCEPTS.includes(f.concept) && !NON_ECONOMIC_CONCEPTS.includes(f.concept);
/** Row produced by factRow(), stored in an earlier report: a restatement of exactly one founder fact. */
const isFactRestatement = (row: UnitEconomicsRow) => /^FOUNDER-STATED \(LOCKED\) F\d+/.test(String(row.assumption || '')) && !!row.factId;
const sameConcept = (fact: FounderFact, concept: string) => fact.concept === concept || (fact.concept === 'customers' && concept === 'volume');

function semanticCandidates(row: UnitEconomicsRow, concept: string, facts: FounderFact[], rowClass: string): FounderFact[] {
  const rowWords = new Set(wordsOf(row.metric));
  const subjectWords = (f: FounderFact) => new Set(wordsOf(`${f.subject || ''} ${f.unit}`));
  const score = (f: FounderFact) => [...subjectWords(f)].filter((w) => rowWords.has(w)).length;
  const unknownConcept = concept === 'other';
  const pool = facts.filter((f) => {
    if (AGE_CONCEPTS.includes(f.concept) || AGE_CONCEPTS.includes(concept)) return f.concept === concept; // ages: only the same age
    if (f.concept === 'other') return unknownConcept && score(f) > 0;                                      // meaningless facts: only by subject
    if (unknownConcept) return score(f) > 0 && (cls(f.timeframe) === rowClass || valuesMatch(row, f));     // "Physical book sales target" → the physical-books fact
    return sameConcept(f, concept) && cls(f.timeframe) === rowClass;
  });
  const ok = pool.filter((f) => !contradicts(row, f, facts));
  if (ok.length > 1) {
    const best = Math.max(...ok.map(score));
    const top = ok.filter((f) => score(f) === best);
    return best > 0 && top.length === 1 ? top : ok; // still several → caller treats as ambiguous
  }
  if (ok.length === 1) return ok;
  // Last resort: the row restates exactly one economic founder figure (same values) and nothing in its label conflicts.
  const same = facts.filter((f) => isEconomicFact(f) && valuesMatch(row, f) && (unknownConcept || sameConcept(f, concept)) && !contradicts(row, f, facts));
  return same.length === 1 ? same : [];
}

/** A row conflicts with a fact if it is about a different kind of thing, or names a different fact's subject. */
function contradicts(row: UnitEconomicsRow, fact: FounderFact, facts: FounderFact[]): boolean {
  const concept = row.concept as string;
  if (AGE_CONCEPTS.includes(concept) !== AGE_CONCEPTS.includes(fact.concept)) return true;
  if (concept !== 'other' && !sameConcept(fact, concept)) return true;
  const rowWords = new Set(wordsOf(row.metric));
  const subjectWords = (f: FounderFact) => new Set(wordsOf(`${f.subject || ''} ${f.unit}`));
  const mine = subjectWords(fact);
  // Compare only with facts of the same kind ("book" is not distinctive between two book targets).
  const others = facts.filter((g) => g !== fact && (sameConcept(g, fact.concept) || sameConcept(fact, g.concept)));
  const distinctOf = (g: FounderFact) => [...subjectWords(g)].filter((w) => !mine.has(w));
  const namesOther = others.some((g) => distinctOf(g).some((w) => rowWords.has(w)));
  const namesMine = [...mine].some((w) => rowWords.has(w) && !others.every((g) => subjectWords(g).has(w)));
  return namesOther && !namesMine;
}

export function validateReport(report: AuditReport, factsIn?: FounderFact[] | null): { report: AuditReport; log: ValidationLog } {
  const log: ValidationLog = { corrected: [], keptAsScenario: [], downgraded: [], converted: [], unitFixed: [], insertedFacts: [], proseConflicts: [] };
  const facts = (factsIn || []).filter((f) => f.locked && f.confirmedByFounder && f.source === 'FOUNDER_STATED' && isNumericFact(f));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const sourceRows = Array.isArray(report.unitEconomics) ? report.unitEconomics : [];

  // 0. Normalise tags (backup inference for untagged rows)
  let rows: UnitEconomicsRow[] = sourceRows.map((r) => {
    const metric = String(r.metric ?? '');
    const unit = String(r.unit ?? '');
    return {
      ...r,
      metric,
      unit,
      concept: (AGE_CONCEPTS.includes(inferConcept(metric, unit)) ? inferConcept(metric, unit) : r.concept && r.concept !== 'other' ? r.concept : inferConcept(metric, unit)) as RowConcept,
      timeframe: (TIMEFRAMES.includes(r.timeframe as RowTimeframe) ? r.timeframe : inferTimeframe(metric)) as RowTimeframe,
      provenance: (PROVENANCES.includes(r.provenance as Provenance) ? r.provenance : inferProvenance(String(r.assumption ?? ''))) as Provenance,
    };
  });

  const usedFacts = new Set<string>();
  const out: UnitEconomicsRow[] = [];
  const metricsOf = new Map(rows.map((r) => [r.metric.toLowerCase(), r]));

  for (let row of rows) {
    // 0b. Ages describe people, not the business: they are founder facts, never unit-economics rows.
    if (AGE_CONCEPTS.includes(row.concept as string)) {
      log.downgraded.push({ metric: row.metric, reason: 'an age is a founder fact, not a unit-economics metric; removed' });
      continue;
    }
    // 0c. A row an earlier validation generated from a founder fact is that fact, not a new claim: refresh it from
    //     the fact (current label, subject) — or drop it when the fact is not a unit-economics quantity. Never
    //     downgrade it to an assumption (that is what produced "Founder stated" + "Assumption" duplicates).
    // A generic "stated figure" row (the old label for a number of unknown meaning) says nothing about the business.
    if (!isFactRestatement(row) && /^(?:current |target |proposed |conditional )?stated figure\b/i.test(row.metric.trim())) {
      log.downgraded.push({ metric: row.metric, reason: 'generic figure with no stated meaning; removed' });
      continue;
    }
    if (isFactRestatement(row)) {
      const f = byId.get(row.factId!);
      if (!f || !isEconomicFact(f)) { log.downgraded.push({ metric: row.metric, reason: 'restates a founder fact that is not a unit-economics quantity; removed' }); continue; }
      if (usedFacts.has(f.id)) continue;
      usedFacts.add(f.id);
      out.push(fixUnit(factRow(f), log));
      continue;
    }
    // 1. Proposed pricing is never revenue: a revenue row equal to a founder price is converted back.
    if (row.concept === 'revenue' && row.provenance !== 'CALCULATED') {
      const price = facts.find((f) => f.concept === 'selling_price' && f.value !== undefined && [row.conservative, row.base, row.upside].every((v) => v === f.value));
      if (price) {
        log.converted.push(row.metric);
        if (usedFacts.has(price.id) || rows.some((r) => r !== row && r.factId === price.id)) continue; // already shown
        row = factRow(price);
      }
    }

    // 2a. CALCULATED rows must trace to founder facts or explicitly labelled assumption rows.
    if (row.provenance === 'CALCULATED') {
      const inputs = Array.isArray(row.inputs) ? row.inputs.map(String) : [];
      const valid = inputs.length > 0 && inputs.every((ref) => {
        if (byId.has(ref)) return true;
        const other = metricsOf.get(ref.toLowerCase());
        return Boolean(other && other !== row && ['FOUNDER_STATED', 'ASSUMPTION', 'EXTERNAL', 'HYPOTHESIS'].includes(other.provenance!));
      });
      if (!valid) {
        log.downgraded.push({ metric: row.metric, reason: 'calculation inputs could not be traced to founder facts or stated assumptions' });
        row = { ...row, provenance: 'ASSUMPTION', basis: row.basis || 'Calculation inputs could not be traced to founder facts or stated assumptions.' };
      }
    }

    // 2b. Rows claiming to be founder data must match a real founder fact.
    const concept = row.concept as FactConcept;
    // A projection escapes the founder lock only if it is a traceable calculation or a labelled scenario with a basis.
    // An EXTERNAL figure citing a verified research finding (R#) is a labelled benchmark even without free-text basis.
    const researched = row.provenance === 'EXTERNAL' && (Array.isArray(row.inputs) ? row.inputs : []).some((x) => /^R\d+$/.test(String(x)));
    const labelled = researched || (['EXTERNAL', 'ASSUMPTION', 'HYPOTHESIS'].includes(row.provenance!) && (row.basis || '').trim().length >= 10);
    const legitimateProjection = row.provenance === 'CALCULATED' || labelled;
    const rowClass = cls(row.timeframe!) === 'projection' && (STATIC_CONCEPTS.includes(concept) || !legitimateProjection) ? 'now' : cls(row.timeframe!);
    const candidates = semanticCandidates(row, concept, facts, rowClass);
    let fact = row.factId ? byId.get(row.factId) : undefined;
    // A cited fact must be one this row is about: a semantic candidate, or the same figure with no conflicting label.
    // (A fact of unknown meaning — concept "other" — is never accepted on equal value alone: its meaning must match.)
    if (fact && !candidates.includes(fact) && !(fact.concept !== 'other' && valuesMatch(row, fact) && !contradicts(row, fact, facts))) fact = undefined;
    if (!fact) fact = candidates.length === 1 ? candidates[0] : undefined;
    if (fact && !NON_ECONOMIC_CONCEPTS.includes(fact.concept) && concept === 'other' && fact.concept !== 'other') row = { ...row, concept: fact.concept as RowConcept };

    if (fact && rowClass !== 'projection') {
      if (valuesMatch(row, fact)) {
        row = { ...row, provenance: 'FOUNDER_STATED', factId: fact.id, unit: row.unit || displayUnit(fact) };
      } else if (labelled) {
        // Allowed only as a clearly labelled alternative figure — never as founder data.
        const prefix = row.provenance === 'EXTERNAL' ? 'External benchmark: ' : 'Scenario: ';
        row = { ...row, metric: row.metric.startsWith(prefix) ? row.metric : `${prefix}${row.metric}`, differsFromFounder: true, factId: undefined };
        log.keptAsScenario.push(row.metric);
      } else {
        const fixed = factRow(fact);
        log.corrected.push({ metric: row.metric, factId: fact.id, from: [row.conservative, row.base, row.upside], to: [fixed.conservative, fixed.base, fixed.upside] });
        row = { ...row, conservative: fixed.conservative, base: fixed.base, upside: fixed.upside, unit: fixed.unit, provenance: 'FOUNDER_STATED', factId: fact.id, timeframe: fact.timeframe as RowTimeframe, assumption: fixed.assumption, commentary: `${row.commentary || ''} Corrected to the founder-stated value.`.trim() };
      }
      if (row.provenance === 'FOUNDER_STATED') {
        if (usedFacts.has(fact.id)) continue; // duplicate restatement of the same fact
        usedFacts.add(fact.id);
      }
    } else if (row.provenance === 'FOUNDER_STATED') {
      log.downgraded.push({ metric: row.metric, reason: 'claimed founder data but matches no confirmed founder fact' });
      row = { ...row, provenance: 'ASSUMPTION', factId: undefined, assumption: `ASSUMPTION: ${String(row.assumption || '').replace(/^FOUNDER[-_ ]STATED[^:]*:\s*/i, '')}` };
    }

    out.push(fixUnit(row, log));
  }

  // 4. Every numeric founder fact appears in unit economics.
  // Only economically relevant founder facts are added (with their subject in the label). Ages, unknown-meaning
  // "other" numbers, start year and channels stay founder facts but never become generic unit-economics rows.
  const missing = facts.filter((f) => isEconomicFact(f) && !usedFacts.has(f.id) && !out.some((r) => r.factId === f.id)).map((f) => { log.insertedFacts.push(f.id); return factRow(f); });
  rows = [...missing, ...out];

  // 5. Narrative contradictions → visible note (narrative is not silently rewritten).
  const notes: string[] = [];
  const narrative = [report.executiveSummary, report.oneLineVerdict, report.whatThisBusinessIs, ...(report.whyItCouldWork || []), ...(report.whatMustBeTrue || []), report.businessModel?.pricingLogic, report.marketView?.demandSignal]
    .filter((s): s is string => typeof s === 'string').join('\n');
  const sentences = narrative.split(/(?<=[.!?])\s+|\n+/);
  const SCENARIO = /\b(if|could|would|might|assum\w*|benchmark|industry|typical|scenario|projected|target|after|net of|competitor|market average|at scale)\b/i;
  const flag = (f: FounderFact, found: number, sentence: string) => {
    const msg = `FOUNDER FIGURE TAKES PRECEDENCE (${f.id}): ${formatFactValue(f)} as stated by the founder. The figure ${found.toLocaleString('en-IN')} in "${sentence.trim().slice(0, 140)}" is not the founder's figure.`;
    if (!notes.includes(msg)) { notes.push(msg); log.proseConflicts.push(msg); }
  };
  for (const s of sentences) {
    if (SCENARIO.test(s)) continue;
    for (const f of facts) {
      if (f.timeframe !== 'CURRENT' && f.timeframe !== 'PROPOSED') continue;
      if (f.concept === 'unit_cost' && f.value !== undefined) {
        for (const m of s.matchAll(/\bcosts?\b[^.₹\d]{0,25}₹\s?([\d,]+)|₹\s?([\d,]+)\s*(?:each\s*)?(?:unit\s*|per unit\s*)?cost/gi)) { const v = Number((m[1] || m[2]).replace(/,/g, '')); if (v !== f.value) flag(f, v, s); }
      }
      if (f.concept === 'margin') {
        for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:gross\s+)?margin|margin[^.%\d]{0,20}(\d+(?:\.\d+)?)\s*%/gi)) {
          const v = Number(m[1] || m[2]); const lo = f.low ?? f.value!; const hi = f.high ?? f.value!;
          if (v < lo - 0.5 || v > hi + 0.5) flag(f, v, s);
        }
      }
      if (f.concept === 'volume' && f.timeframe === 'CURRENT' && f.value !== undefined && /\b(current|currently|selling|sales)\b/i.test(s)) {
        for (const m of s.matchAll(/([\d,]{3,})\s*(?:units|orders|pieces)\s*(?:a|per|\/)\s*month/gi)) { const v = Number(m[1].replace(/,/g, '')); if (v !== f.value) flag(f, v, s); }
      }
    }
  }
  const assumptions = Array.isArray(report.assumptions) ? report.assumptions : [];
  return { report: { ...report, unitEconomics: rows, assumptions: [...assumptions, ...notes.filter((n) => !assumptions.includes(n))] }, log };
}
