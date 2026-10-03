// End-to-end route flow with the REAL routes and REAL session code; only the database, cookies,
// Razorpay SDK, Gemini HTTP and the AI engine are faked.
import crypto from 'crypto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const db = { users: new Map<string, Row>(), sessions: new Map<string, Row>(), audits: new Map<string, Row>(), files: [] as Row[], jobs: new Map<string, Row>() };
let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;
const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('not' in v) return row[k] !== v.not; if ('lt' in v) return row[k] !== null && row[k] < v.lt; if ('lte' in v) return row[k] !== null && row[k] <= v.lte; if ('in' in v) return (v.in as unknown[]).includes(row[k]);
  }
  return (row[k] ?? null) === v;
});
const fileKey = (w: Row) => (f: Row) => f.auditId === w.auditId_path.auditId && f.path === w.auditId_path.path;

vi.mock('@/lib/db', () => ({
  db: {
    user: { create: async ({ data }: Row) => { const u = { id: nid('user'), email: null, name: null, ...data }; db.users.set(u.id, u); return { ...u }; } },
    session: {
      create: async ({ data }: Row) => { db.sessions.set(data.tokenHash, { id: nid('s'), ...data }); return data; },
      findUnique: async ({ where }: Row) => { const s = db.sessions.get(where.tokenHash); return s ? { ...s, user: { ...db.users.get(s.userId) } } : null; },
    },
    audit: {
      create: async ({ data }: Row) => { const a = { id: nid('audit'), status: 'completed', paymentStatus: 'pending', paymentRef: null, computePaise: 0, marginPaise: 0, contactEmail: null, createdAt: new Date(), updatedAt: new Date(), ...data }; db.audits.set(a.id, a); return { ...a }; },
      findFirst: async ({ where, include }: Row) => { const a = [...db.audits.values()].find((x) => matches(x, where)); if (!a) return null; return include?.artifacts ? { ...a, artifacts: db.files.filter((f) => f.auditId === a.id) } : { ...a }; },
      findUnique: async ({ where }: Row) => (db.audits.get(where.id) ? { ...db.audits.get(where.id) } : null),
      findMany: async ({ where }: Row) => [...db.audits.values()].filter((x) => matches(x, where)),
      update: async ({ where, data }: Row) => { const a = db.audits.get(where.id)!; Object.assign(a, data, { updatedAt: new Date() }); return { ...a }; },
      updateMany: async ({ where, data }: Row) => { let count = 0; for (const a of db.audits.values()) if (matches(a, where)) { Object.assign(a, data, { updatedAt: new Date() }); count++; } return { count }; },
    },
    // Phase 2: the paid audit runs as a durable Job (in-memory stand-in for the Job table; same Prisma calls).
    job: {
      findUnique: async ({ where }: Row) => { const j = where.id ? db.jobs.get(where.id) : [...db.jobs.values()].find((x) => x.dedupeKey === where.dedupeKey); return j ? { ...j } : null; },
      findUniqueOrThrow: async ({ where }: Row) => ({ ...db.jobs.get(where.id)! }),
      findFirst: async ({ where }: Row) => { const j = [...db.jobs.values()].find((x) => matches(x, where)); return j ? { ...j } : null; },
      findMany: async ({ where }: Row) => [...db.jobs.values()].filter((x) => matches(x, where)).map((x) => ({ ...x })),
      create: async ({ data }: Row) => { const j = { id: nid('job'), status: 'QUEUED', progress: 'QUEUED', checkpoint: null, state: null, costInr: 0, reservedInr: 0, attempts: 0, maxAttempts: 3, lastError: null, waitingReason: null, runAfter: new Date(), leaseOwner: null, leaseUntil: null, cancelRequestedAt: null, organizationId: null, createdAt: new Date(), startedAt: null, completedAt: null, updatedAt: new Date(), ...data }; db.jobs.set(j.id, j); return { ...j }; },
      update: async ({ where, data }: Row) => { const j = db.jobs.get(where.id)!; Object.assign(j, data, { updatedAt: new Date() }); return { ...j }; },
      updateMany: async ({ where, data }: Row) => { let count = 0; for (const j of db.jobs.values()) if (matches(j, where)) { for (const [k, v] of Object.entries(data)) j[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? j[k] + (v as Row).increment : v; j.updatedAt = new Date(); count++; } return { count }; },
    },
    projectFile: {
      findUnique: async ({ where }: Row) => db.files.find(fileKey(where)) ?? null,
      upsert: async ({ where, update, create }: Row) => { const f = db.files.find(fileKey(where)); if (f) { Object.assign(f, update); return f; } db.files.push({ ...create }); return create; },
    },
  },
}));
let jar = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); } }) }));
// Fake Razorpay account: orders can be marked paid to simulate "paid but browser never reported back".
const rzOrders = new Map<string, Row>();
vi.mock('razorpay', () => ({ default: class { orders = {
  create: async (o: Row) => { const ord = { id: `order_${o.receipt}`, amount: o.amount, currency: 'INR', receipt: o.receipt, status: 'created' }; rzOrders.set(ord.id, ord); return { ...ord }; },
  fetch: async (id: string) => ({ ...rzOrders.get(id) }),
  fetchPayments: async (id: string) => ({ items: rzOrders.get(id)?.status === 'paid' ? [{ id: 'pay_reconciled1', status: 'captured' }] : [] }),
}; } }));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
const runAudit = vi.fn(async (input: Row) => {
  const { deterministicAudit } = await import('@/lib/audit');
  const { validateReport } = await import('@/lib/report-validation');
  return { report: validateReport(deterministicAudit(input as any), input.founderFacts).report, pricing: { computeInr: 1, marginInr: 0.1 }, provider: 'test' };
});
vi.mock('@/lib/ai', () => ({ runAudit: (i: Row) => runAudit(i) }));

const { POST: createAudit } = await import('@/app/api/audits/route');
const { POST: scopeRoute } = await import('@/app/api/audits/[id]/scope/route');
const { POST: createOrder } = await import('@/app/api/payments/create-order/route');
const { POST: verifyRoute } = await import('@/app/api/payments/verify/route');
// Phase 2: verification returns once the audit job is durable; the job runs after the response. The harness waits for
// that background run so each test observes the finished audit, exactly as a founder refreshing the page later would.
const { settleDetached } = await import('@/lib/jobs');
const verify = async (r: Request) => { const res = await verifyRoute(r); await settleDetached(); return res; };
const { GET: exportAudit } = await import('@/app/api/audits/[id]/export/route');
const verifyModule = await import('@/app/api/payments/verify/route');
const { default: AuditPage } = await import('@/app/audit/[id]/page');
const { renderToStaticMarkup } = await import('react-dom/server');
const page = async (id: string) => { try { return renderToStaticMarkup(await AuditPage({ params: Promise.resolve({ id }) })); } catch (e: any) { return String(e?.digest ?? e); } };

const post = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const call = async (fn: Promise<Response>) => { const r = await fn; return { status: r.status, body: await r.json() }; };
const scope = (id: string, body: Row) => call(scopeRoute(post(body), ctx(id)));
const order = (id: string) => call(createOrder(post({ auditId: id })));
async function newAudit(idea: string, stage = 'Idea / pre-launch') {
  const r = await call(createAudit(post({ name: 'Founder', email: 'f@x.in', idea, sector: 'Healthtech', stage, geography: 'India', language: 'Simple English' })));
  expect(r.status).toBe(200);
  return r.body.id as string;
}
const PHARMA = 'I want to launch a pharmacy SaaS at ₹1,499/month and target 200 pharmacies by March.';
const GLUCO = 'Glucometer business: currently selling 1,400 units/month. Cost is ₹500 per item. Margin is 10–12%.';

beforeEach(() => {
  db.users.clear(); db.sessions.clear(); db.audits.clear(); db.files.length = 0; db.jobs.clear(); jar = new Map(); runAudit.mockClear(); rzOrders.clear();
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'DEMO_MODE', 'VERCEL_ENV', 'GEMINI_API_KEY']) delete process.env[k];
  process.env.DEMO_MODE = 'true'; process.env.VERCEL_ENV = 'preview';
  vi.unstubAllGlobals();
});

describe('Scope confirmation before payment', () => {
  it('suggestion alone is not payable; founder must confirm scope AND review detected numbers', async () => {
    const id = await newAudit(PHARMA);
    const s = await scope(id, { action: 'suggest' });
    expect(s.body.suggestion).toBe('NEW_IDEA');
    expect(s.body.facts.map((f: Row) => f.concept)).toEqual(['selling_price', 'customers']);
    expect((await order(id)).status).toBe(403);                                       // not confirmed yet
    expect((await scope(id, { action: 'confirm', scope: 'NEW_IDEA' })).status).toBe(400); // numbers not reviewed
    const c = await scope(id, { action: 'confirm', scope: 'NEW_IDEA', facts: s.body.facts, factsReviewed: true });
    expect(c.body.confirmed).toEqual({ scope: 'NEW_IDEA', payable: true });
    expect(c.body.lockedFacts.every((f: Row) => f.locked && f.source === 'FOUNDER_STATED')).toBe(true);
    expect((await order(id)).body).toMatchObject({ demo: true, amount: 9900 });
    expect((await call(verify(post({ auditId: id, demo: true })))).status).toBe(200);
    const input = runAudit.mock.calls[0][0];
    expect(input.scope).toBe('NEW_IDEA');
    expect(input.founderFacts.find((f: Row) => f.concept === 'selling_price')).toMatchObject({ value: 1499, timeframe: 'PROPOSED', locked: true });
    const report = JSON.parse(db.audits.get(id)!.report);
    expect(report.unitEconomics.some((r: Row) => r.concept === 'revenue' && r.base === 1499)).toBe(false);
  });

  it('founder confirmation overrides the suggestion (NEW_IDEA suggestion → confirmed GROWTH_PLAN), still ₹99', async () => {
    const id = await newAudit(PHARMA);
    const s = await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'GROWTH_PLAN', facts: s.body.facts, factsReviewed: true });
    expect((await order(id)).body.amount).toBe(9900);
    await verify(post({ auditId: id, demo: true }));
    expect(runAudit.mock.calls[0][0].scope).toBe('GROWTH_PLAN');
  });

  it('founder corrections to numbers are what gets locked', async () => {
    const id = await newAudit(GLUCO);
    const s = await scope(id, { action: 'suggest' });
    expect(s.body.suggestion).toBe('GROWTH_PLAN');
    const corrected = s.body.facts.map((f: Row) => (f.concept === 'unit_cost' ? { ...f, value: 520 } : f));
    await scope(id, { action: 'confirm', scope: 'GROWTH_PLAN', facts: corrected, factsReviewed: true });
    await order(id); await verify(post({ auditId: id, demo: true }));
    expect(runAudit.mock.calls[0][0].founderFacts.find((f: Row) => f.concept === 'unit_cost').value).toBe(520);
  });
});

describe('OUT_OF_SCOPE', () => {
  it('15. confirmed OUT_OF_SCOPE never creates a payable order and never generates', async () => {
    const id = await newAudit('Please help me file my ITR for this financial year.');
    expect((await scope(id, { action: 'suggest' })).body).toMatchObject({ suggestion: 'OUT_OF_SCOPE' });
    const c = await scope(id, { action: 'confirm', scope: 'OUT_OF_SCOPE' });
    expect(c.body.confirmed).toEqual({ scope: 'OUT_OF_SCOPE', payable: false });
    expect(db.audits.get(id)).toMatchObject({ status: 'out_of_scope', paymentStatus: 'not_required', pricePaise: 0 });
    expect((await order(id)).status).toBe(403);
    expect((await call(verify(post({ auditId: id, demo: true })))).status).toBe(403);
    expect(runAudit).not.toHaveBeenCalled();
  });
  it('founder can override an OUT_OF_SCOPE suggestion ("This is actually my business") → ₹99 flow', async () => {
    const id = await newAudit('Can you build me a website for my coaching classes business?');
    expect((await scope(id, { action: 'suggest' })).body.suggestion).toBe('OUT_OF_SCOPE');
    await scope(id, { action: 'confirm', scope: 'GROWTH_PLAN', facts: [], factsReviewed: false });
    expect((await order(id)).body.amount).toBe(9900);
  });
});

describe('Scope freeze, Not sure, ownership', () => {
  it('scope cannot change once the order exists', async () => {
    process.env.DEMO_MODE = 'false'; process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 's3cret';
    const id = await newAudit('I want to launch a pharmacy platform in Pune for chemists.');
    await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'NEW_IDEA', facts: [] });
    expect((await order(id)).body.demo).toBe(false);
    expect((await scope(id, { action: 'confirm', scope: 'GROWTH_PLAN', facts: [] })).status).toBe(409);
    expect((await scope(id, { action: 'classify' })).status).toBe(409);
  });

  it('"Not sure" calls Gemini once, caches it, and still requires founder confirmation', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ scope: 'GROWTH_PLAN', confidence: 0.9, reason: 'operating' }) }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const id = await newAudit('A WhatsApp tool for kirana stores to manage udhaar ledgers.');
    await scope(id, { action: 'suggest' });
    const a = await scope(id, { action: 'classify' });
    const b = await scope(id, { action: 'classify' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a.body.classifier).toEqual({ scope: 'GROWTH_PLAN', confidence: 0.9, confident: true });
    expect(b.body.classifier).toEqual(a.body.classifier);
    expect((await order(id)).status).toBe(403); // classifier result is NOT a confirmation
  });

  it('classifier failure is cached, returns a generic message, and never picks a scope', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const fetchSpy = vi.fn(async () => { throw new Error('internal: upstream 503 at gemini-host-42'); });
    vi.stubGlobal('fetch', fetchSpy);
    const id = await newAudit('A WhatsApp tool for kirana stores to manage udhaar ledgers.');
    await scope(id, { action: 'suggest' });
    const a = await scope(id, { action: 'classify' });
    await scope(id, { action: 'classify' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(a.body)).not.toMatch(/gemini-host|503|internal/);
    expect(a.body.classifier.error).toMatch(/choose/);
  });

  it('scope endpoint requires the owner (404) and a session (401)', async () => {
    const id = await newAudit(PHARMA);
    jar = new Map();
    expect((await scope(id, { action: 'suggest' })).status).toBe(401);
    await newAudit('Someone else entirely different idea for a bakery in Pune.'); // new browser/user
    expect((await scope(id, { action: 'suggest' })).status).toBe(404);
    expect((await scope(id, { action: 'confirm', scope: 'NEW_IDEA', facts: [] })).status).toBe(404);
  });
});

describe('Payment safety', () => {
  it('16. demo mode never activates in production, and missing keys fail closed (no free audit)', async () => {
    process.env.VERCEL_ENV = 'production';
    const id = await newAudit('I want to launch a pharmacy platform in Pune for chemists.');
    await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'NEW_IDEA', facts: [] });
    expect((await order(id)).status).toBe(503);
    expect((await call(verify(post({ auditId: id, demo: true })))).status).toBe(400);
    expect(runAudit).not.toHaveBeenCalled();
    process.env.VERCEL_ENV = 'preview'; delete process.env.DEMO_MODE;
    expect((await order(id)).status).toBe(503); // a missing key alone never enables demo mode
  });

  it('17/18. failed generation can be retried without paying again; a second verify never regenerates', async () => {
    const id = await newAudit(GLUCO);
    const s = await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'GROWTH_PLAN', facts: s.body.facts, factsReviewed: true });
    await order(id);
    runAudit.mockImplementationOnce(async () => { throw new Error('GEMINI_ERROR: timeout'); });
    // Phase 2 (intentional): verification succeeds once the job is durable (200, not 502); the engine failure is
    // recorded on the job and shown on the audit page, exactly as before.
    expect((await call(verify(post({ auditId: id, demo: true })))).status).toBe(200);
    expect(db.audits.get(id)).toMatchObject({ paymentStatus: 'paid', status: 'failed' });
    expect((await order(id)).status).toBe(409);                                   // no second payment
    expect((await call(verify(post({ auditId: id })))).status).toBe(200);          // retry, no payment payload
    expect((await call(verify(post({ auditId: id })))).body).toMatchObject({ alreadyGenerated: true });
    expect(runAudit).toHaveBeenCalledTimes(2);
  });

  it('legacy audit whose order was created before the router is still honoured as NEW_IDEA', async () => {
    process.env.DEMO_MODE = 'false'; process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 's3cret';
    const id = await newAudit('Legacy kirana ordering platform idea from before the router shipped.');
    db.audits.get(id)!.paymentRef = 'order_legacy1';
    const sig = crypto.createHmac('sha256', 's3cret').update('order_legacy1|pay_1').digest('hex');
    expect((await call(verify(post({ auditId: id, razorpay_order_id: 'order_legacy1', razorpay_payment_id: 'pay_1', razorpay_signature: sig })))).status).toBe(200);
    expect(runAudit.mock.calls[0][0]).toMatchObject({ scope: 'NEW_IDEA', founderFacts: [] });
  });
});

describe('Lock-and-Barrel Export', () => {
  it('includes confirmed scope, founder facts, report provenance and the portable scope/fact files', async () => {
    const id = await newAudit(GLUCO);
    const s = await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'GROWTH_PLAN', facts: s.body.facts, factsReviewed: true });
    await order(id); await verify(post({ auditId: id, demo: true }));
    const res = await exportAudit(new Request('http://x'), ctx(id));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const audit = JSON.parse(await zip.file('audit.json')!.async('string'));
    expect(audit.scope).toBe('GROWTH_PLAN');
    expect(audit.founderFacts.find((f: Row) => f.concept === 'unit_cost')).toMatchObject({ value: 500, locked: true });
    expect(audit.report.unitEconomics.find((r: Row) => r.concept === 'unit_cost')).toMatchObject({ base: 500, provenance: 'FOUNDER_STATED' });
    expect(zip.file('project/scope.json')).toBeTruthy();
    expect(zip.file('project/founder-facts.json')).toBeTruthy();
    expect(audit.pricing.platformMargin).toBe('10% of disclosed compute');
  });
});

describe('Razorpay TEST/LIVE flow and recovery', () => {
  const live = () => { process.env.DEMO_MODE = 'false'; process.env.RAZORPAY_KEY_ID = 'rzp_test_KEYID'; process.env.RAZORPAY_KEY_SECRET = 's3cret'; };
  const sign = (o: string, p: string) => crypto.createHmac('sha256', 's3cret').update(`${o}|${p}`).digest('hex');
  async function paidReadyAudit() {
    const id = await newAudit('I want to launch a pharmacy platform in Pune for chemists.');
    await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'NEW_IDEA', facts: [] });
    return id;
  }

  it('Checkout gets the same key id the order was created with; order is ₹99 and tied to this audit', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    expect(o).toMatchObject({ demo: false, keyId: 'rzp_test_KEYID', amount: 9900, orderId: `order_${id}` });
    expect(rzOrders.get(o.orderId)).toMatchObject({ amount: 9900, receipt: id });
  });

  it('valid signature → paid → report generated → shown on the audit page', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    const r = await call(verify(post({ auditId: id, razorpay_order_id: o.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(o.orderId, 'pay_1') })));
    expect(r.status).toBe(200);
    expect(db.audits.get(id)).toMatchObject({ paymentStatus: 'paid', status: 'completed', paymentRef: 'pay_1' });
    expect(await page(id)).toContain('THE ANSWER IN 60 SECONDS');
  });

  it('invalid signature → rejected, nothing generated, not paid', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    const r = await call(verify(post({ auditId: id, razorpay_order_id: o.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' })));
    expect(r.status).toBe(400);
    expect(runAudit).not.toHaveBeenCalled();
    expect(db.audits.get(id)!.paymentStatus).toBe('pending');
  });

  it('missing Razorpay secret at verification → configuration error, nothing generated', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    delete process.env.RAZORPAY_KEY_SECRET;
    const r = await call(verify(post({ auditId: id, razorpay_order_id: o.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'x' })));
    expect(r.status).toBe(500);
    expect(runAudit).not.toHaveBeenCalled();
  });

  it('paid but the browser never reported back → "Check payment & continue" asks Razorpay and generates, without charging again', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    expect(await page(id)).toContain('Check payment &amp; continue');
    // Not paid at Razorpay yet → refused
    expect((await call(verify(post({ auditId: id })))).status).toBe(402);
    expect(runAudit).not.toHaveBeenCalled();
    // Razorpay reports the order as paid → recovered
    rzOrders.get(o.orderId)!.status = 'paid';
    expect((await call(verify(post({ auditId: id })))).status).toBe(200);
    expect(db.audits.get(id)).toMatchObject({ paymentStatus: 'paid', status: 'completed', paymentRef: 'pay_reconciled1' });
    expect(runAudit).toHaveBeenCalledTimes(1);
  });

  it('recovery refuses an order whose amount or receipt does not match this audit', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    Object.assign(rzOrders.get(o.orderId)!, { status: 'paid', amount: 100 });
    expect((await call(verify(post({ auditId: id })))).status).toBe(402);
    expect(runAudit).not.toHaveBeenCalled();
  });

  it('AI failure after payment → page shows "payment was successful" + Retry; retry generates without new payment', async () => {
    live();
    const id = await paidReadyAudit();
    const o = (await order(id)).body;
    runAudit.mockImplementationOnce(async () => { throw new Error('TAVILY_TIMEOUT'); });
    // Phase 2 (intentional): 200 once the payment is verified and the job is durable; the failure is on the page.
    expect((await call(verify(post({ auditId: id, razorpay_order_id: o.orderId, razorpay_payment_id: 'pay_9', razorpay_signature: sign(o.orderId, 'pay_9') })))).status).toBe(200);
    const html = await page(id);
    expect(html).toContain('Your payment was successful, but Aristotle could not complete the analysis yet.');
    expect(html).toContain('Retry Analysis');
    expect((await order(id)).status).toBe(409); // cannot be charged again
    expect((await call(verify(post({ auditId: id })))).status).toBe(200);
    expect(db.audits.get(id)!.paymentRef).toBe('pay_9');
    expect(await page(id)).toContain('THE ANSWER IN 60 SECONDS');
  });

  it('unpaid audits never render a report (no free sample report)', async () => {
    const id = await newAudit('I want to launch a pharmacy platform in Pune for chemists.');
    const html = await page(id);
    expect(html).toContain('Audit not paid yet');
    expect(html).not.toContain('THE ANSWER IN 60 SECONDS');
  });

  it('verify route allows 60 seconds for generation', () => {
    expect(verifyModule.maxDuration).toBe(60);
  });
});

describe('Evidence layer end to end', () => {
  it('research sources are saved, exported, and cited in the decision memo on the report page', async () => {
    const { toResearchRecord } = await import('@/lib/evidence');
    const { deterministicAudit } = await import('@/lib/audit');
    const research = toResearchRecord([{ query: 'pharmacy saas pricing india', results: [{ title: 'Pharmacy SaaS pricing', url: 'https://example.org/pricing', content: 'Tools cost ₹999–₹2,499 a month' }] }]);
    runAudit.mockImplementationOnce(async (input: Row) => {
      const base = deterministicAudit(input as any);
      return { research, provider: 'test', pricing: { computeInr: 1, marginInr: 0.1 }, report: { ...base, decisionMemo: { ...base.decisionMemo!, criticalAssumptions: [{ ...base.decisionMemo!.criticalAssumptions[0], evidenceStatus: 'PARTIAL', evidence: 'Competing tools charge ₹999–₹2,499', evidenceIds: ['S1'] }, ...base.decisionMemo!.criticalAssumptions.slice(1)] }, evidence: [{ claim: 'Comparable tools charge ₹999–₹2,499 a month.', type: 'FACT', sourceIds: ['S1'], confidence: 'MEDIUM', validation: 'Check vendor pricing pages', verified: true }] } };
    });
    const id = await newAudit('I want to launch a pharmacy platform in Pune for chemists.');
    await scope(id, { action: 'suggest' });
    await scope(id, { action: 'confirm', scope: 'NEW_IDEA', facts: [] });
    await order(id); await verify(post({ auditId: id, demo: true }));
    expect(JSON.parse(db.files.find((f) => f.auditId === id && f.path === 'research.json')!.content).sources[0]).toMatchObject({ id: 'S1', url: 'https://example.org/pricing' });
    const html = await page(id);
    expect(html).toContain('>The decision</h2>');
    expect(html).toContain('Partly supported');
    expect(html).toContain('href="https://example.org/pricing"');
    expect(html).toContain('Evidence register');
    expect(html).toContain('Sourced fact');
    const zip = await JSZip.loadAsync(await (await exportAudit(new Request('http://x'), ctx(id))).arrayBuffer());
    expect(zip.file('project/research.json')).toBeTruthy();
  });

  it('research-first report: shows what was researched and never back-fills missing sections from a template', async () => {
    const id = await newAudit('An AI-powered platform that helps Indian small businesses manage their GST compliance.');
    const research = {
      version: 2, generatedAt: new Date().toISOString(), queries: ['gst software pricing india'],
      businessModel: { summary: 'Subscription GST filing software for MSMEs', customer: 'MSME owners', payer: 'Owner', offering: 'GST filing', revenueMechanism: 'Subscription', keyActivities: [], regulatedActivities: [] },
      sources: [{ id: 'S1', title: 'Zoho Books pricing', url: 'https://example.org/zoho', snippet: '₹749/month', query: 'gst software pricing india', retrievedAt: '', questionId: 'Q1' }],
      questions: [
        { id: 'Q1', category: 'ALTERNATIVES_PRICING', question: 'What do GST tools charge?', whyItMatters: 'Price ceiling', query: 'gst software pricing india', status: 'ANSWERED', sourceIds: ['S1'], findingIds: ['R1'] },
        { id: 'Q2', category: 'CHANNEL', question: 'Do CAs choose the software?', whyItMatters: 'Channel', query: 'ca choose gst software', status: 'NOT_FOUND', sourceIds: [], findingIds: [] },
      ],
      findings: [{ id: 'R1', questionId: 'Q1', statement: 'Zoho Books Standard costs ₹749/month.', sourceId: 'S1', quote: 'Standard plan costs ₹749', confidence: 'HIGH' }],
    };
    db.files.push({ auditId: id, path: 'research.json', content: JSON.stringify(research) });
    Object.assign(db.audits.get(id)!, { paymentStatus: 'paid', status: 'completed', report: JSON.stringify({
      score: 55, oneLineVerdict: 'Undercut ₹749 incumbents or sell through CAs.', unitEconomics: [{ metric: 'Gross margin', conservative: null, base: 'x', upside: 60, unit: '%' }],
      unknownEconomics: [{ metric: 'Customer acquisition cost', whyUnknown: 'No research found', howToEstablish: 'Run a ₹5,000 ad test' }],
    }) });
    const html = await page(id);
    expect(html).toContain('What Aristotle researched');
    expect(html).toContain('Zoho Books Standard costs ₹749/month.');
    expect(html).toContain('No evidence found');
    expect(html).toContain('Not yet established');
    expect(html).toContain('Customer acquisition cost');
    expect(html).toContain('Not produced for this audit.');
    expect(html).not.toMatch(/Sector-default|₹455|55%/);
  });

  it('older reports without an evidence layer do not get a template decision memo', async () => {
    const id = await newAudit('I want to launch a pharmacy platform in Pune for chemists.');
    Object.assign(db.audits.get(id)!, { paymentStatus: 'paid', status: 'completed', report: JSON.stringify({ score: 70, oneLineVerdict: 'Old report' }) });
    const html = await page(id);
    expect(html).toContain('Old report');
    expect(html).not.toContain('>The decision</h2>');
    expect(html).not.toContain('No research was performed');
  });
});
