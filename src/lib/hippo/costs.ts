// Cost intelligence. Deterministic arithmetic over clearly labelled inputs.
// AI may propose effort (hours, specialist, rate assumptions); the maths, the labels and the margins are code.
import { estimateCompute } from '../pricing';
import type { Capability } from './capabilities';
import { allowedModes } from './capabilities';
import type { EffortModel, ExecutionMode } from './types';

export const PLATFORM_MARGIN = 0.10; // Hippoturtle's disclosed margin on execution cost (cost + 10%)

export const LABELS = {
  COMPUTED: 'Calculated from the configured AI model rates — actual cost is recorded after execution',
  AI_BENCHMARK: 'AI-generated benchmark estimate — indicative only, external quote required',
} as const;

export type Estimate = {
  mode: 'AI' | 'HUMAN' | 'HYBRID' | 'AGENCY';
  low: number; high: number; label: keyof typeof LABELS; basis: string;
  breakdown: Record<string, number | string>; drivers: string[];
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const r0 = (n: number) => Math.round(n);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function normaliseEffort(raw: Partial<EffortModel> | undefined, cap: Capability): EffortModel {
  const h = raw?.humanHours || { low: 4, high: 8 };
  const rate = raw?.hourlyRateInr || { low: 0, high: 0 };
  const review = raw?.hybridReviewHours || { low: 1, high: 2 };
  const ag = raw?.agencyMultiplier || { low: 1.5, high: 2.5 };
  const hl = clamp(h.low, 0.5, 400, 4); const hh = Math.max(hl, clamp(h.high, 0.5, 400, 8));
  // A missing/zero rate means "not established": no human figure is produced rather than an invented one.
  const rl = Number(rate.low) > 0 ? clamp(rate.low, 100, 25_000, 0) : 0; const rh = rl > 0 ? Math.max(rl, clamp(rate.high, 100, 25_000, rl)) : 0;
  const vl = clamp(review.low, 0.25, 100, 1); const vh = Math.max(vl, clamp(review.high, 0.25, 100, 2));
  const al = clamp(ag.low, 1, 5, 1.5); const ah = Math.max(al, clamp(ag.high, 1, 5, 2.5));
  return {
    aiFeasible: Boolean(raw?.aiFeasible ?? cap.aiExecutable) && cap.aiExecutable,
    aiOutputTokens: clamp(raw?.aiOutputTokens, 1000, 9000, cap.costModel.defaultOutputTokens),
    specialist: (raw?.specialist || cap.costModel.specialist).slice(0, 80),
    humanHours: { low: hl, high: hh }, hourlyRateInr: { low: rl, high: rh }, hybridReviewHours: { low: vl, high: vh }, agencyMultiplier: { low: al, high: ah },
    costDrivers: (raw?.costDrivers || []).map(String).filter(Boolean).slice(0, 8),
    rateBasis: (raw?.rateBasis || '').slice(0, 300),
  };
}

const COMMON_DRIVERS = ['Scope and number of deliverables', 'Human effort and specialist expertise', 'Turnaround time', 'Number of revision rounds', 'Compliance or professional sign-off'];

/**
 * Estimates for every execution option this WORK allows (`modes` from classifyWork). Rates of 0 mean "not established"
 * → no human estimate. Without `modes` (legacy callers) the capability's modes and the model's aiFeasible are used.
 */
export function computeEstimates(effort: EffortModel, cap: Capability, promptTokens: number, workModes?: ExecutionMode[]): Estimate[] {
  const out: Estimate[] = [];
  const drivers = [...effort.costDrivers, ...COMMON_DRIVERS].filter((d, i, a) => a.indexOf(d) === i).slice(0, 8);
  const modes = workModes ?? allowedModes(cap);
  const aiAllowed = modes.includes('AI') && (workModes ? true : effort.aiFeasible);
  const ai = estimateCompute(promptTokens + 1500, effort.aiOutputTokens);
  const aiLow = ai.computeInr * (1 + PLATFORM_MARGIN);
  const aiHigh = estimateCompute(promptTokens + 3000, Math.min(12000, effort.aiOutputTokens * 1.5)).computeInr * (1 + PLATFORM_MARGIN);
  const rateKnown = effort.hourlyRateInr.low > 0;
  const human = rateKnown ? { low: effort.humanHours.low * effort.hourlyRateInr.low, high: effort.humanHours.high * effort.hourlyRateInr.high } : null;

  if (aiAllowed) {
    out.push({ mode: 'AI', low: r2(aiLow), high: r2(aiHigh), label: 'COMPUTED',
      basis: `≈${(promptTokens + 1500).toLocaleString('en-IN')} input + ≈${effort.aiOutputTokens.toLocaleString('en-IN')} output tokens at the configured model rates, plus ${PLATFORM_MARGIN * 100}% platform margin.`,
      breakdown: { 'AI / API cost (₹)': r2(ai.computeInr), 'Platform margin (₹)': r2(ai.computeInr * PLATFORM_MARGIN), 'Human effort (₹)': 0, 'Infrastructure': 'included' }, drivers: ['Length of the deliverable (output tokens)', 'Amount of context provided'] });
  }
  if (modes.includes('HUMAN') && human) {
    out.push({ mode: 'HUMAN', low: r0(human.low), high: r0(human.high), label: 'AI_BENCHMARK',
      basis: `${effort.humanHours.low}–${effort.humanHours.high} hours of a ${effort.specialist} at an assumed ₹${effort.hourlyRateInr.low.toLocaleString('en-IN')}–₹${effort.hourlyRateInr.high.toLocaleString('en-IN')}/hour.${effort.rateBasis ? ` Rate assumption: ${effort.rateBasis}` : ''}`,
      breakdown: { 'Hours (low)': effort.humanHours.low, 'Hours (high)': effort.humanHours.high, 'Assumed rate low (₹/h)': effort.hourlyRateInr.low, 'Assumed rate high (₹/h)': effort.hourlyRateInr.high }, drivers });
    out.push({ mode: 'AGENCY', low: r0(human.low * effort.agencyMultiplier.low), high: r0(human.high * effort.agencyMultiplier.high), label: 'AI_BENCHMARK',
      basis: `Human estimate × ${effort.agencyMultiplier.low}–${effort.agencyMultiplier.high} for agency overheads (account management, QA, margin).`,
      breakdown: { 'Agency multiplier (low)': effort.agencyMultiplier.low, 'Agency multiplier (high)': effort.agencyMultiplier.high }, drivers });
  }
  if (modes.includes('HYBRID') && rateKnown) {
    const reviewLow = effort.hybridReviewHours.low * effort.hourlyRateInr.low; const reviewHigh = effort.hybridReviewHours.high * effort.hourlyRateInr.high;
    out.push({ mode: 'HYBRID', low: r0(aiLow + reviewLow), high: r0(aiHigh + reviewHigh), label: 'AI_BENCHMARK',
      basis: `AI prepares the draft (≈₹${r2(aiLow)}), then a ${effort.specialist}${cap.requiresProfessional && !modes.includes('AI') ? ' (qualified professional, required)' : ''} reviews for ${effort.hybridReviewHours.low}–${effort.hybridReviewHours.high} hours at the assumed rate.`,
      breakdown: { 'AI draft (₹)': r2(aiLow), 'Review hours (low)': effort.hybridReviewHours.low, 'Review hours (high)': effort.hybridReviewHours.high }, drivers });
  }
  return out;
}

export function midpoint(e: { low: number; high: number }) { return (e.low + e.high) / 2; }
