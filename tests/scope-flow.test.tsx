// End-to-end route flow with the REAL routes and REAL session code; only the database, cookies,
// Razorpay SDK, Gemini HTTP and the AI engine are faked.
import crypto from 'crypto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const db = { users: new Map<string, Row>(), sessions: new Map<string, Row>(), audits: new Map<string, Row>(), files: [] as Row[] };
let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;
const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
  if (v && typeof v === 'object' && !(v instanceof Date)) { if ('not' in v) return row[k] !== v.not; if ('lt' in v) return row[k] < v.lt; }
  return row[k] === v;
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
    projectFile: {
      findUnique: async ({ where }: Row) => db.files.find(fileKey(where)) ?? null,
      upsert: async ({ where, update, create }: Row) => { const f = db.files.find(fileKey(where)); if (f) { Object.assign(f, update); return f; } db.files.push({ ...create }); return create; },
    },
  },
}));
let jar = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => { jar.set(n, v); } }) }));
vi.mock('razorpay', () => ({ default: class { orders = { create: async (o: Row) => ({ id: `order_${o.receipt}`, amount: o.amount, currency: 'INR' }) }; } }));
const runAudit = vi.fn(async (input: Row) => {
  const { deterministicAudit } = await import('@/lib/audit');
  const { validateReport } = await import('@/lib/report-validation');
  return { report: validateReport(deterministicAudit(input as any), input.founderFacts).report, pricing: { computeInr: 1, marginInr: 0.1 }, provider: 'test' };
});
vi.mock('@/lib/ai', () => ({ runAudit: (i: Row) => runAudit(i) }));

const { POST: createAudit } = await import('@/app/api/audits/route');
const { POST: scopeRoute } = await import('@/app/api/audits/[id]/scope/route');
const { POST: createOrder } = await import('@/app/api/payments/create-order/route');
const { POST: verify } = await import('@/app/api/payments/verify/route');
const { GET: exportAudit } = await import('@/app/api/audits/[id]/export/route');

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
  db.users.clear(); db.sessions.clear(); db.audits.clear(); db.files.length = 0; jar = new Map(); runAudit.mockClear();
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
    expect((await call(verify(post({ auditId: id, demo: true })))).status).toBe(502);
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
