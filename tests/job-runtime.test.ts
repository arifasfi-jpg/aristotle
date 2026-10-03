// Phase 2 — job runtime pure checks (no database): failure classification, worker authorization, and static guarantees
// that payment verification no longer runs the AI work, Razorpay verification is untouched, and the runtime has no
// in-memory source of truth and no path around the metered gateway.
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyJobError, LeaseLostError } from '../src/lib/jobs/runtime';
import { workerAuthorized } from '../src/lib/jobs/auth';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
const root = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('K / L / M: failure classification', () => {
  it.each([
    ['GEMINI_ERROR (decision): timed out after 40s (model x)', 'TRANSIENT'],
    ['GEMINI_ERROR (x): HTTP 503: overloaded', 'TRANSIENT'],
    ['TAVILY_TIMEOUT after 15s', 'TRANSIENT'],
    ['RESEARCH_FAILED: all searches failed (TAVILY_ERROR 500: down)', 'TRANSIENT'],
    ['Connection terminated unexpectedly', 'TRANSIENT'],
    ['AI_BUDGET_EXCEEDED: budget ledger unavailable: Connection terminated', 'TRANSIENT'], // DB outage ≠ out of money
    ['AUDIT_TIME_BUDGET_EXCEEDED: research is saved; retry to complete the decision memo', 'YIELD'],
    ['AI_ENGINE_NOT_CONFIGURED: GEMINI_API_KEY is missing', 'PERMANENT'],
    ['JOB_INVALID: audit is not paid', 'PERMANENT'],
    ['AI_BUDGET_EXCEEDED: no ModelPrice for gemini/x: the call cannot be budgeted', 'PERMANENT'],
    ['AI_BUDGET_EXCEEDED: REFUSE [COST_NEAR_LIMIT]: ₹229.00 committed + ₹2.00 next > ₹230.00 limit', 'BUDGET'],
    ['AI_BUDGET_EXCEEDED: ASK_FOUNDER [ADDITIONAL_BUDGET_REQUIRED]: needs ₹3.00 more', 'BUDGET'],
  ])('%s → %s', (msg, cls) => expect(classifyJobError(new Error(msg))).toBe(cls));
  it('a lost lease is its own class (the worker stops without writing)', () => expect(classifyJobError(new LeaseLostError())).toBe('LEASE_LOST'));
});

describe('Y: worker authorization', () => {
  const req = (h: Record<string, string>) => new Request('https://hippo.example/api/jobs/run', { headers: h });
  it('only the exact bearer secret is accepted; a missing or short secret disables the worker', () => {
    process.env.CRON_SECRET = 'a-long-enough-secret-123';
    expect(workerAuthorized(req({ authorization: 'Bearer a-long-enough-secret-123' }))).toBe(true);
    expect(workerAuthorized(req({ authorization: 'Bearer a-long-enough-secret-12' }))).toBe(false);
    expect(workerAuthorized(req({ authorization: 'a-long-enough-secret-123' }))).toBe(false);
    expect(workerAuthorized(req({}))).toBe(false);
    delete process.env.CRON_SECRET;
    expect(workerAuthorized(req({ authorization: 'Bearer undefined' }))).toBe(false);
    process.env.CRON_SECRET = 'short';
    expect(workerAuthorized(req({ authorization: 'Bearer short' }))).toBe(false);
  });
});

describe('R / V / T: static guarantees', () => {
  const verify = read('src/app/api/payments/verify/route.ts');
  it('R. payment verification creates the job and never runs the audit engine in the request', () => {
    expect(verify).not.toMatch(/runAudit|researchBusiness|aristotleGeminiJson|generateJson/);
    expect(verify).toMatch(/await startAuditJob\(/);
  });
  it('V. Razorpay signature verification, order reconciliation and the ₹99 checkout are unchanged', () => {
    expect(verify).toMatch(/verifyRazorpaySignature\(b\.razorpay_order_id, b\.razorpay_payment_id, b\.razorpay_signature, secret\)/);
    expect(verify).toMatch(/if \(!audit\.paymentRef \|\| b\.razorpay_order_id !== audit\.paymentRef\)/);
    expect(verify).toMatch(/order\.status !== 'paid' \|\| Number\(order\.amount\) !== audit\.pricePaise \|\| order\.receipt !== audit\.id/);
    expect(read('prisma/schema.prisma')).toMatch(/pricePaise\s+Int\s+@default\(9900\)/);
  });
  it('T. job code never calls a provider directly: all AI goes through the engine → metered gateway', () => {
    for (const f of ['src/lib/jobs/runtime.ts', 'src/lib/jobs/aristotle-audit.ts', 'src/lib/jobs/index.ts', 'src/app/api/jobs/run/route.ts']) {
      expect([f, /fetch\(|callGeminiJson|tavilyRequest|generativelanguage|api\.tavily/.test(read(f))]).toEqual([f, false]);
    }
  });
  it('O. budget reservations live in Postgres: no in-process reservation map remains', () => {
    const usage = read('src/lib/ai-usage.ts');
    expect(usage).not.toMatch(/inFlight|reserveInFlight/);
    expect(usage).toMatch(/pg_advisory_xact_lock/);
    expect(read('src/lib/hippo/gateway.ts')).toMatch(/await reserveBudget\(/);
  });
});
