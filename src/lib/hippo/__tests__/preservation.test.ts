/**
 * Preservation tests — behaviour that must NOT change with the isolation fix (Requirements 3.1, 3.2, 3.4, 3.8).
 * Every test calls the production implementation; only the database, session and AI/Aristotle layer are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    organization: { findFirst: fn(), findUnique: fn(), create: fn(), update: fn() },
    objective: { findFirst: fn(), findUnique: fn(), findUniqueOrThrow: fn(), create: fn(), update: fn(), count: fn() },
    founder: { findUnique: fn(), create: fn(), update: fn() },
    user: { create: fn() },
    businessMemory: { findMany: fn(), findFirst: fn(), findUnique: fn(), findFirstOrThrow: fn(), create: fn(), createMany: fn() },
    activityLog: { create: fn() },
  };
});
vi.mock('../../db', () => ({ db: mockDb }));
vi.mock('../../session', () => ({ getCurrentUser: vi.fn(), createSession: vi.fn() }));
vi.mock('../aristotle', () => ({
  understandObjective: vi.fn(async () => ({ understanding: { keyQuestion: 'q' } })),
  ensureAudit: vi.fn(async () => ({ id: 'audit_1' })),
  parseReport: vi.fn(), syncAristotle: vi.fn(),
}));

import { getCurrentUser } from '../../session';
import { getFounderContext, memoryBrief, requireObjective } from '../context';
import { companyFor, createObjective, resolveCompanyName } from '../service';
import { businessName, DEFAULT_ORG_NAME, DEMO_COMPANY_NAME, isGenericOrgName } from '../types';

type Org = { id: string; founderId: string; name: string; isDemo: boolean };
function store(orgs: Org[]) {
  const objectives: { id: string; organizationId: string; isDemo: boolean; companyName: string | null }[] = [];
  let n = 0;
  mockDb.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null);
  // Array order = creation order. Supports the filters getFounderContext/createObjective use.
  mockDb.organization.findFirst.mockImplementation(async ({ where, orderBy }: { where: { founderId: string; isDemo?: boolean; objectives?: object }; orderBy?: { createdAt: 'asc' | 'desc' } }) => {
    const list = orgs.filter((o) => o.founderId === where.founderId && (where.isDemo === undefined || o.isDemo === where.isDemo) && (!where.objectives || objectives.some((x) => x.organizationId === o.id)));
    return (orderBy?.createdAt === 'desc' ? list.reverse() : list)[0] ?? null;
  });
  mockDb.organization.create.mockImplementation(async ({ data }: { data: Omit<Org, 'id'> & { isDemo?: boolean } }) => { const o: Org = { id: `org_new_${++n}`, ...data, isDemo: data.isDemo ?? false }; orgs.push(o); return o; });
  mockDb.organization.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Org> }) => Object.assign(orgs.find((o) => o.id === where.id)!, data));
  mockDb.objective.count.mockImplementation(async ({ where }: { where: { organizationId: string } }) => objectives.filter((o) => o.organizationId === where.organizationId).length);
  mockDb.objective.create.mockImplementation(async ({ data }: { data: { organizationId: string; isDemo: boolean; companyName: string | null } }) => { const o = { id: `obj_${++n}`, ...data }; objectives.push(o); return o; });
  mockDb.objective.update.mockImplementation(async ({ where }: { where: { id: string } }) => objectives.find((o) => o.id === where.id));
  mockDb.businessMemory.findFirst.mockResolvedValue({ id: 'bm' });
  return { orgs, objectives };
}
const create = (org: Org, input: { companyName?: string | null; isDemo?: boolean }) => createObjective({ user: { id: 'u1' }, founder: { id: 'f1', name: null }, org }, { text: 'An objective long enough to be accepted.', mode: 'IDEA', ...input });
const row = (id: string, status: string, title: string) => ({ id, organizationId: 'org1', objectiveId: 'obj1', kind: 'FACT', title, detail: '', value: null, status, source: null, sourceUrl: null, owner: 'sys', confidence: null, refType: null, refId: null, occurredAt: new Date(), createdAt: new Date() });

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(mockDb)) for (const f of Object.values(model)) f.mockReset(); // no implementation leaks between tests
});

describe('Property 2a — first-objective org naming', () => {
  it('generic-name helpers behave as before (and "My company" in any case/spacing is generic)', () => {
    expect(businessName('Aaira Books')).toBe('Aaira Books');
    expect(isGenericOrgName(DEMO_COMPANY_NAME)).toBe(false);
    for (const n of [DEFAULT_ORG_NAME, 'my company', ' My   Company ', '', null, 'Hippoturtle']) expect(isGenericOrgName(n)).toBe(true);
  });
  it('the first objective names the org; later objectives never rename it', async () => {
    const live: Org = { id: 'org1', founderId: 'f1', name: DEFAULT_ORG_NAME, isDemo: false };
    const s = store([live]);
    await create(live, { companyName: 'Aaira Books' });
    await create(live, { companyName: 'Other Venture' });
    expect(live.name).toBe('Aaira Books');
    expect(s.objectives.map((o) => o.companyName)).toEqual(['Aaira Books', 'Other Venture']);
  });
  it('a first objective with no company name leaves the org unnamed', async () => {
    const live: Org = { id: 'org1', founderId: 'f1', name: DEFAULT_ORG_NAME, isDemo: false };
    const s = store([live]);
    await create(live, { companyName: null });
    expect(mockDb.organization.update).not.toHaveBeenCalled();
    expect(s.objectives[0].companyName).toBeNull();
  });
});

describe('Property 2b — cross-founder 404', () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user_alice', name: 'Alice' } as never);
    mockDb.founder.findUnique.mockResolvedValue({ id: 'f_alice', userId: 'user_alice', name: 'Alice' });
    mockDb.organization.findFirst.mockResolvedValue({ id: 'org_alice', founderId: 'f_alice', isDemo: false });
  });
  it('requireObjective scopes the lookup to the founder and 404s otherwise', async () => {
    mockDb.objective.findFirst.mockResolvedValue(null);
    await expect(requireObjective('obj_bob_secret')).rejects.toMatchObject({ status: 404 });
    expect(mockDb.objective.findFirst).toHaveBeenCalledWith({ where: { id: 'obj_bob_secret', organization: { founderId: 'f_alice' } } });
  });
  it('requireObjective succeeds for the correct founder', async () => {
    mockDb.objective.findFirst.mockResolvedValue({ id: 'obj_alice', organizationId: 'org_alice', companyName: 'Aaira Books' });
    expect((await requireObjective('obj_alice')).objective.id).toBe('obj_alice');
  });
});

describe('Property 2c/2d — memoryBrief output and provenance grouping unchanged', () => {
  it('rows are rendered and grouped into the 5 provenance tiers', async () => {
    mockDb.businessMemory.findMany.mockResolvedValue([row('1', 'FOUNDER_STATED', 'Founder said X'), row('2', 'VERIFIED_FACT', 'Research says Y'), row('3', 'ASSUMPTION', 'AI assumed Z'), row('4', 'UNKNOWN', 'Not yet known'), row('5', 'RECORD', 'Decision recorded')]);
    const out = await memoryBrief('org1', 'obj1');
    for (const h of ['FOUNDER-STATED OR FOUNDER-APPROVED', 'SOURCED RESEARCH', 'AI PROPOSALS, HYPOTHESES, ASSUMPTIONS AND INFERENCES', 'NOT YET ESTABLISHED', 'RECORDS OF DECISIONS AND WORK']) expect(out).toContain(h);
    for (const t of ['Founder said X', 'Research says Y', 'AI assumed Z']) expect(out).toContain(t);
  });
  it('limit is preserved and empty memory reads "No business memory yet."', async () => {
    mockDb.businessMemory.findMany.mockResolvedValue([]);
    expect(await memoryBrief('org1', 'obj1', 60)).toBe('No business memory yet.');
    expect(mockDb.businessMemory.findMany.mock.calls[0][0]).toMatchObject({ take: 60, orderBy: { occurredAt: 'desc' } });
  });
});

describe('Property 2e/2f — real objectives share the live org; each demo gets its own org', () => {
  it('two real objectives → same live org; two demos → two different demo orgs', async () => {
    const live: Org = { id: 'org_live', founderId: 'f1', name: DEFAULT_ORG_NAME, isDemo: false };
    const s = store([live]);
    await create(live, { companyName: 'Aaira Books' });
    await create(live, { isDemo: true });
    await create(live, { companyName: null });
    await create(live, { isDemo: true });
    const [r1, d1, r2, d2] = s.objectives;
    expect([r1.organizationId, r2.organizationId]).toEqual(['org_live', 'org_live']);
    expect(d1.organizationId).not.toBe(d2.organizationId);
    for (const d of [d1, d2]) expect(s.orgs.find((o) => o.id === d.organizationId)).toMatchObject({ isDemo: true, name: DEMO_COMPANY_NAME });
    expect(r2.companyName).toBe('Aaira Books'); // second real objective of the same founder: the founder's own company
  });
});

describe('Property 2g — getFounderContext()', () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'u3', name: 'Carol' } as never);
    mockDb.founder.findUnique.mockResolvedValue({ id: 'f3', userId: 'u3', name: 'Carol' });
  });
  it('returns the live org even when the demo org is older', async () => {
    store([{ id: 'org_demo3', founderId: 'f3', name: DEMO_COMPANY_NAME, isDemo: true }, { id: 'org_live3', founderId: 'f3', name: 'x', isDemo: false }]);
    expect((await getFounderContext())!.org!.id).toBe('org_live3');
  });
  it('a live org holding a real objective always wins over a demo org (older or newer)', async () => {
    const s = store([{ id: 'org_demo_old', founderId: 'f3', name: DEMO_COMPANY_NAME, isDemo: true }, { id: 'org_live3', founderId: 'f3', name: 'Aaira Books', isDemo: false }, { id: 'org_demo_new', founderId: 'f3', name: DEMO_COMPANY_NAME, isDemo: true }]);
    s.objectives.push({ id: 'd1', organizationId: 'org_demo_old', isDemo: true, companyName: DEMO_COMPANY_NAME }, { id: 'a1', organizationId: 'org_live3', isDemo: false, companyName: 'Aaira Books' }, { id: 'd2', organizationId: 'org_demo_new', isDemo: true, companyName: DEMO_COMPANY_NAME });
    expect((await getFounderContext())!.org!.id).toBe('org_live3');
  });
  it('a founder who has only tried the demo sees the demo org, not an empty live org', async () => {
    const s = store([{ id: 'org_live_empty', founderId: 'f3', name: DEFAULT_ORG_NAME, isDemo: false }, { id: 'org_demo', founderId: 'f3', name: DEMO_COMPANY_NAME, isDemo: true }]);
    s.objectives.push({ id: 'd1', organizationId: 'org_demo', isDemo: true, companyName: DEMO_COMPANY_NAME });
    expect((await getFounderContext())!.org!.id).toBe('org_demo');
  });
  it('falls back to the demo org for a demo-only founder (for display only; createObjective never uses it for real work)', async () => {
    store([{ id: 'org_demo4', founderId: 'f3', name: DEMO_COMPANY_NAME, isDemo: true }]);
    expect((await getFounderContext())!.org!.id).toBe('org_demo4');
  });
});

describe('Property 2h/2i/2j — company identity resolution', () => {
  it('2h: a backfilled legacy objective returns its stored name', async () => {
    expect(await companyFor({ companyName: 'Aaira Books', organizationId: 'org_single' })).toBe('Aaira Books');
  });
  it('2i: ambiguous multi-objective legacy org → null (never a possibly wrong name)', () => {
    expect(resolveCompanyName({ companyName: null }, { name: 'Aaira Books' }, 2)).toBeNull();
  });
  it('2j: stored names take the fast path (no DB lookup); the demo name is returned for demo objectives', async () => {
    expect(await companyFor({ companyName: DEMO_COMPANY_NAME, organizationId: 'org_demo' })).toBe(DEMO_COMPANY_NAME);
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
    expect(mockDb.objective.count).not.toHaveBeenCalled();
  });
});
