// Cumulative cost governor + commercial maths. Pure functions (no I/O): the gateway feeds them ledger totals.
//
// A BudgetPolicy is attached to a unit of paid work (an audit today; a job / work item / Deep Intelligence run later).
// Before every provider call the gateway asks `decideNext` whether the call's worst case still fits:
//   spent (ACTUAL + ESTIMATED rows in the ledger) + reserved (calls in flight) + projected next ≤ limit → ALLOW.
// When it does not fit, only quality-preserving alternatives may be chosen automatically (valid cached evidence, an
// equivalent cheaper route). DOWNGRADE / REDUCE_SCOPE lower research quality, so they are only ever OFFERED to the
// founder (ASK_FOUNDER) — never applied silently. Without a founder to ask, the call is REFUSED.

export type BudgetScope = { type: 'AUDIT' | 'WORK' | 'JOB' | 'TURN'; id: string };
export type BudgetState = 'COST_OK' | 'COST_WARNING' | 'COST_NEAR_LIMIT' | 'COST_LIMIT_REACHED' | 'ADDITIONAL_BUDGET_REQUIRED';
export type Decision = 'ALLOW' | 'DOWNGRADE' | 'USE_CHEAPER_ROUTE' | 'REDUCE_SCOPE' | 'USE_VALID_CACHED_EVIDENCE' | 'ASK_FOUNDER' | 'REFUSE';

/** All amounts are internal cost in rupees (what providers charge us), never the founder's price. */
export type BudgetPolicy = {
  scope: BudgetScope;
  /** Cost included in the product price (Deep Intelligence: ₹230). */
  includedInr: number;
  /** Additional cost the founder has approved (and paid for) on top of the included budget. */
  approvedAdditionalInr?: number;
  /** Additional cost requested from the founder and not yet approved. */
  requestedAdditionalInr?: number;
  warningInr: number;
  nearLimitInr: number;
  /** Per-call ceiling for this work (in addition to the platform-wide HIPPO_MAX_CALL_INR). */
  perCallInr?: number;
  /** Whether a founder is available to approve extra budget (interactive work). Otherwise over-limit calls are refused. */
  canAskFounder?: boolean;
};

export type BudgetSnapshot = {
  scope: BudgetScope;
  includedInr: number; requestedAdditionalInr: number; approvedAdditionalInr: number;
  limitInr: number; spentInr: number; reservedInr: number; remainingInr: number;
  warningInr: number; nearLimitInr: number; perCallInr: number | null;
  state: BudgetState;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function budgetStatus(p: BudgetPolicy, spentInr: number, reservedInr = 0): BudgetSnapshot {
  const approved = Math.max(0, p.approvedAdditionalInr ?? 0);
  const requested = Math.max(0, p.requestedAdditionalInr ?? 0);
  const limit = p.includedInr + approved;
  const committed = spentInr + reservedInr;
  // Thresholds move up with approved extensions so an approved ₹50 is usable, not immediately "near limit".
  const warning = p.warningInr + approved; const near = p.nearLimitInr + approved;
  const state: BudgetState = requested > 0 ? 'ADDITIONAL_BUDGET_REQUIRED'
    : committed >= limit - 1e-9 ? 'COST_LIMIT_REACHED'
    : committed >= near ? 'COST_NEAR_LIMIT'
    : committed >= warning ? 'COST_WARNING' : 'COST_OK';
  return { scope: p.scope, includedInr: p.includedInr, requestedAdditionalInr: requested, approvedAdditionalInr: approved, limitInr: limit,
    spentInr: r4(spentInr), reservedInr: r4(reservedInr), remainingInr: r4(Math.max(0, limit - committed)), warningInr: warning, nearLimitInr: near,
    perCallInr: p.perCallInr ?? null, state };
}

/** Quality-preserving options the caller can offer for the next step (the gateway offers none). */
export type Alternatives = {
  /** Evidence already gathered for this exact question and still valid (not stale): reuse costs ₹0. */
  validCachedEvidence?: boolean;
  /** Projected cost of an equivalent route of the same quality (e.g. same model, prompt caching / batch). */
  equivalentCheaperRouteInr?: number;
};

export type GovernorDecision = {
  decision: Decision;
  reason: string;
  /** What the founder could choose instead (only with ASK_FOUNDER). DOWNGRADE / REDUCE_SCOPE appear ONLY here. */
  options: Decision[];
  /** Internal cost that would have to be added to the limit for the projected call to fit (ASK_FOUNDER / REFUSE). */
  additionalNeededInr: number;
  projectedNextInr: number;
  state: BudgetState;
  snapshot: BudgetSnapshot;
};

export function decideNext(p: BudgetPolicy, snap: BudgetSnapshot, projectedNextInr: number, alt: Alternatives = {}): GovernorDecision {
  const base = { projectedNextInr: r4(projectedNextInr), state: snap.state, snapshot: snap, options: [] as Decision[], additionalNeededInr: 0 };
  const committed = snap.spentInr + snap.reservedInr;
  const fits = (inr: number) => committed + inr <= snap.limitInr + 1e-9;
  if (p.perCallInr !== undefined && projectedNextInr > p.perCallInr) {
    if (alt.validCachedEvidence) return { ...base, decision: 'USE_VALID_CACHED_EVIDENCE', reason: `next call ₹${projectedNextInr.toFixed(2)} exceeds the per-call limit ₹${p.perCallInr}; valid cached evidence reused` };
    return { ...base, decision: 'REFUSE', reason: `per-call limit ₹${p.perCallInr} < projected ₹${projectedNextInr.toFixed(2)}` };
  }
  if (snap.requestedAdditionalInr > 0) {
    return { ...base, decision: p.canAskFounder ? 'ASK_FOUNDER' : 'REFUSE', options: ['ASK_FOUNDER', 'REDUCE_SCOPE', 'DOWNGRADE'], additionalNeededInr: snap.requestedAdditionalInr, reason: `additional budget ₹${snap.requestedAdditionalInr.toFixed(2)} awaits founder approval` };
  }
  if (fits(projectedNextInr)) return { ...base, decision: 'ALLOW', reason: `₹${committed.toFixed(2)} committed + ₹${projectedNextInr.toFixed(2)} next ≤ ₹${snap.limitInr.toFixed(2)} limit` };
  if (alt.validCachedEvidence) return { ...base, decision: 'USE_VALID_CACHED_EVIDENCE', reason: 'over the limit; valid cached evidence reused at no cost' };
  if (alt.equivalentCheaperRouteInr !== undefined && fits(alt.equivalentCheaperRouteInr)) return { ...base, decision: 'USE_CHEAPER_ROUTE', reason: `equivalent route ₹${alt.equivalentCheaperRouteInr.toFixed(2)} fits the remaining ₹${snap.remainingInr.toFixed(2)}` };
  const needed = r2(committed + projectedNextInr - snap.limitInr);
  const reason = `₹${committed.toFixed(2)} committed + ₹${projectedNextInr.toFixed(2)} next > ₹${snap.limitInr.toFixed(2)} limit (needs ₹${needed.toFixed(2)} more)`;
  if (p.canAskFounder) return { ...base, decision: 'ASK_FOUNDER', state: 'ADDITIONAL_BUDGET_REQUIRED', options: ['ASK_FOUNDER', 'REDUCE_SCOPE', 'DOWNGRADE'], additionalNeededInr: needed, reason };
  return { ...base, decision: 'REFUSE', additionalNeededInr: needed, reason };
}

// ---------------------------------------------------------------- commercial maths (integer paise: no float drift)
export const GST_RATE = 0.18;
export const PLATFORM_MARGIN = 0.10;

/** Price excluding GST from a GST-inclusive price: ₹299 → ₹253.39. */
export const netOfGstPaise = (inclusivePaise: number) => Math.round(inclusivePaise / (1 + GST_RATE));
/** Largest internal cost that still leaves the 10% platform margin: ₹253.39 ÷ 1.10 = ₹230.35. */
export const maxCostPaise = (inclusivePaise: number) => Math.floor(netOfGstPaise(inclusivePaise) / (1 + PLATFORM_MARGIN));
/** Hard cost ceiling in whole rupees, rounded DOWN so the margin is never eaten: ₹230. */
export const costCeilingInr = (inclusivePaise: number) => Math.floor(maxCostPaise(inclusivePaise) / 100);

export type AdditionalQuote = { internalCostPaise: number; marginPaise: number; netPaise: number; gstPaise: number; totalPaise: number; presentedInr: number };
/** Founder price of extra budget: internal ₹50 → +10% = ₹55 → +18% GST ₹9.90 → ₹64.90 → presented as ₹65 (rounded UP). */
export function quoteAdditional(internalCostPaise: number): AdditionalQuote {
  const marginPaise = Math.round(internalCostPaise * PLATFORM_MARGIN);
  const netPaise = internalCostPaise + marginPaise;
  const gstPaise = Math.round(netPaise * GST_RATE);
  const totalPaise = netPaise + gstPaise;
  return { internalCostPaise, marginPaise, netPaise, gstPaise, totalPaise, presentedInr: Math.ceil(totalPaise / 100) };
}

/** Raises the limit by an approved extension (the founder accepted a quote for `internalInr` of extra cost). */
export function approveAdditional(p: BudgetPolicy, internalInr: number): BudgetPolicy {
  return { ...p, approvedAdditionalInr: (p.approvedAdditionalInr ?? 0) + internalInr, requestedAdditionalInr: 0 };
}
/** Records that extra budget was requested (blocks further spend until approved or declined). */
export const requestAdditional = (p: BudgetPolicy, internalInr: number): BudgetPolicy => ({ ...p, requestedAdditionalInr: internalInr });

// ---------------------------------------------------------------- products
const envInr = (name: string, def: number) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n > 0 ? n : def; };

/**
 * Future ₹299 (GST-inclusive) Deep Intelligence product. The ceiling derived from the price is the maximum: a
 * configured HIPPO_DI_COST_CEILING_INR above it is ignored (it would sell at a loss). Thresholds are configurable.
 */
export function deepIntelligencePolicy(scope: BudgetScope, opts: { canAskFounder?: boolean } = {}): BudgetPolicy & { pricePaise: number } {
  const pricePaise = Math.round(envInr('HIPPO_DI_PRICE_INR', 299) * 100);
  const derived = costCeilingInr(pricePaise);
  const included = Math.min(derived, envInr('HIPPO_DI_COST_CEILING_INR', derived));
  const near = Math.min(included, envInr('HIPPO_DI_NEAR_LIMIT_INR', 220));
  const warning = Math.min(near, envInr('HIPPO_DI_WARNING_INR', 210));
  return { pricePaise, scope, includedInr: included, warningInr: warning, nearLimitInr: near, perCallInr: envInr('HIPPO_DI_PER_CALL_INR', 25), canAskFounder: opts.canAskFounder ?? false };
}

/**
 * Founder-facing cost statement ("No hidden AI costs"): what was included, what was spent (and how much of it is an
 * estimate rather than a provider-reported figure), what remains, and any extension and its price.
 */
export function costDisclosure(snap: BudgetSnapshot, breakdown: { actualInr: number; estimatedInr: number; searchInr: number; modelInr: number }) {
  const extra = snap.requestedAdditionalInr > 0 ? quoteAdditional(Math.round(snap.requestedAdditionalInr * 100)) : null;
  return {
    state: snap.state,
    includedInr: snap.includedInr,
    spentInr: r2(snap.spentInr),
    spentProviderReportedInr: r2(breakdown.actualInr),
    spentEstimatedInr: r2(breakdown.estimatedInr),
    modelInr: r2(breakdown.modelInr),
    searchInr: r2(breakdown.searchInr),
    remainingInr: r2(snap.remainingInr),
    approvedAdditionalInr: snap.approvedAdditionalInr,
    additionalRequest: extra ? { internalCostInr: snap.requestedAdditionalInr, priceInr: extra.presentedInr, gstInr: extra.gstPaise / 100 } : null,
    note: 'All AI and search costs are shown. Estimated amounts are calls whose provider usage was not reported (for example a timeout after the request was sent); they are counted at their maximum.',
  };
}
