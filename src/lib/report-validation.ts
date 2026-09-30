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
import { COUNT_CONCEPTS, MONEY_CONCEPTS, formatFactValue, isNumericFact, type FactConcept, type FounderFact } from './founder-facts';

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
    channel: 'Channel', start_year: 'Operating since', other: 'Stated figure',
  }[f.concept];
  const tf = f.timeframe === 'CURRENT' ? 'Current ' : f.timeframe === 'TARGET' ? 'Target ' : f.timeframe === 'PROPOSED' ? 'Proposed ' : f.timeframe === 'CONDITIONAL' ? 'Conditional ' : '';
  return {
    metric: `${tf}${label.toLowerCase()} (founder-stated)`.replace(/^\w/, (c) => c.toUpperCase()),
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
      concept: (r.concept && r.concept !== 'other' ? r.concept : inferConcept(metric, unit)) as RowConcept,
      timeframe: (TIMEFRAMES.includes(r.timeframe as RowTimeframe) ? r.timeframe : inferTimeframe(metric)) as RowTimeframe,
      provenance: (PROVENANCES.includes(r.provenance as Provenance) ? r.provenance : inferProvenance(String(r.assumption ?? ''))) as Provenance,
    };
  });

  const usedFacts = new Set<string>();
  const out: UnitEconomicsRow[] = [];
  const metricsOf = new Map(rows.map((r) => [r.metric.toLowerCase(), r]));

  for (let row of rows) {
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
    let fact = row.factId ? byId.get(row.factId) : undefined;
    if (fact && (fact.concept !== concept && !(fact.concept === 'customers' && concept === 'volume'))) fact = undefined;
    if (!fact) fact = facts.find((f) => f.concept === concept && cls(f.timeframe) === rowClass);

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
  const missing = facts.filter((f) => !usedFacts.has(f.id) && !out.some((r) => r.factId === f.id)).map((f) => { log.insertedFacts.push(f.id); return factRow(f); });
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
