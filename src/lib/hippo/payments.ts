// Payment abstraction for Work. Aristotle's ₹99 audit keeps using the existing Razorpay flow unchanged.
// Per-work payment is designed in but NOT integrated yet: nothing here ever marks work as paid.
import type { ExecutionMode, WorkPaymentStatus } from './types';

export type PaymentPlan = { required: boolean; status: WorkPaymentStatus; note: string };

/**
 * HIPPO_WORK_PAYMENTS:
 *   'early_access' (default) → AI execution is not charged during early access; the real AI cost is recorded.
 *   'razorpay'               → reserved for per-work Razorpay orders (pending integration: execution is blocked).
 */
export function workPaymentPlan(mode: ExecutionMode): PaymentPlan {
  const setting = process.env.HIPPO_WORK_PAYMENTS || 'early_access';
  if (mode === 'HUMAN') return { required: false, status: 'PENDING_INTEGRATION', note: 'Payments to external providers are not handled by Hippoturtle yet. Nothing is charged here; you pay a provider only after accepting their quote.' };
  if (setting === 'razorpay') return { required: true, status: 'PENDING_INTEGRATION', note: 'Pay-per-work checkout is not integrated yet, so this work cannot be paid or executed here.' };
  return {
    required: false, status: 'INCLUDED_EARLY_ACCESS',
    note: mode === 'HYBRID'
      ? 'The AI draft is not charged during early access. The human review is quoted and paid separately (provider payments are not integrated yet).'
      : 'Not charged during early access. The actual AI cost of this work is recorded and shown to you.',
  };
}

export const canExecuteNow = (plan: PaymentPlan) => !plan.required;
