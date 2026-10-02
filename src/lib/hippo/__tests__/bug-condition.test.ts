/**
 * Bug-condition tests — context isolation (Requirements 1.1, 1.2, 1.4, 1.6).
 *
 * Every test here calls the PRODUCTION implementation (createObjective, companyFor, resolveCompanyName,
 * getFounderContext, memoryBrief, withAiProvenance, ensureDemoIdentity). Only the database, the session cookie and
 * the AI/Aristotle layer are mocked. Nothing re-implements the logic under test.
 * The same scenarios run against a real PostgreSQL database in tests/context-isolation-e2e.test.tsx.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so the mock object must be created with vi.hoisted.
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
const understand = vi.hoisted(() => vi.fn());

vi.mock('../../db', () => ({ db: mockDb }));
vi.mock('../../session', () => ({ getCurrentUser: vi.fn(), createSession: vi.fn() }));
vi.mock('../aristotle', () => ({
  understandObjective: understand,
  ensureAudit: vi.fn(async () => ({ id: 'audit_1' })),
  parseReport: vi.fn(), syncAristotle: vi.fn(),
}));

import { getCurrentUser } from '../../session';
import { getFounderContext, memoryBrief } from '../context';
import { AI_PROVENANCE_MARKER, withAiProvenance } from '../execution';
import { ensureDemoIdentity } from '../preview';
import { companyFor, createObjective, resolveCompanyName } from '../service';
import { DEMO_COMPANY_NAME, identityBlock } from '../types';

type Org = { id: string; founderId: string; name: string; isDemo: boolean };
/** Minimal in-memory organisation/objective store behind the mocked Prisma calls used by createObjective. */
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
const founder = { id: 'f1', name: 'Aaira' };
const user = { id: 'u1' };
const create = (org: Org, input: { companyName?: string | null; isDemo?: boolean }) => createObjective({ user, founder, org }, { text: 'An objective long enough to be accepted by the route.', mode: 'IDEA', ...input });

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(mockDb)) for (const f of Object.values(model)) f.mockReset(); // no implementation leaks between tests
  understand.mockImplementation(async () => ({ understanding: { keyQuestion: 'q' } }));
});

describe('Scenario A — Real-then-Demo: live org stays non-demo; demo gets its own org', () => {
  it('createObjective(demo) never touches the live org and puts the demo in a new demo org', async () => {
    const live: Org = { id: 'org_live', founderId: 'f1', name: 'My company', isDemo: false };
    const s = store([live]);
    await create(live, { companyName: 'Aaira Books' });
    await create(live, { isDemo: true });
    const [aaira, demo] = s.objectives;
    expect(live).toMatchObject({ isDemo: false, name: 'Aaira Books' });
    expect(aaira).toMatchObject({ organizationId: 'org_live', isDemo: false, companyName: 'Aaira Books' });
    expect(demo.organizationId).not.toBe('org_live');
    expect(s.orgs.find((o) => o.id === demo.organizationId)).toMatchObject({ isDemo: true, name: DEMO_COMPANY_NAME });
    expect(demo.companyName).toBe(DEMO_COMPANY_NAME);
    // The understand prompt for each objective received only its own company.
    expect(understand.mock.calls.map((c) => c[1])).toEqual(['Aaira Books', DEMO_COMPANY_NAME]);
  });
});

describe('Scenario B — Demo-then-Real: the real objective gets the real name', () => {
  it('demo first, then Aaira Books: Aaira is in the live org with its own name; demo name never leaks', async () => {
    const live: Org = { id: 'org_live', founderId: 'f1', name: 'My company', isDemo: false };
    const s = store([live]);
    await create(live, { isDemo: true });
    await create(live, { companyName: 'Aaira Books' });
    const aaira = s.objectives[1];
    expect(aaira).toMatchObject({ organizationId: 'org_live', companyName: 'Aaira Books' });
    expect(await companyFor(aaira)).toBe('Aaira Books');
    expect(live.name).toBe('Aaira Books');
  });

  it('a real objective without a company name never inherits the demo business name', async () => {
    const demoOnly: Org = { id: 'org_demo', founderId: 'f1', name: DEMO_COMPANY_NAME, isDemo: true };
    const s = store([demoOnly]);
    await create(demoOnly, { companyName: null });
    expect(s.objectives[0].companyName).toBeNull();
    expect(s.objectives[0].organizationId).not.toBe('org_demo');
    expect(understand.mock.calls[0][1]).toBeNull();
  });
});

describe('Scenario C — memoryBrief: only this objective’s memory', () => {
  it('queries strictly by (organizationId, objectiveId) — no objectiveId = NULL arm', async () => {
    mockDb.businessMemory.findMany.mockResolvedValue([]);
    await memoryBrief('org_abc', 'obj_aaira');
    expect(mockDb.businessMemory.findMany).toHaveBeenCalledTimes(1);
    const where = mockDb.businessMemory.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ organizationId: 'org_abc', objectiveId: 'obj_aaira' });
    expect(JSON.stringify(where)).not.toContain('null');
  });
});

describe('Scenario D — Demo-first then real: getFounderContext() returns the live org', () => {
  it('prefers the live org even when the demo org is older', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'u1', name: 'Alice' } as never);
    mockDb.founder.findUnique.mockResolvedValue({ id: 'f1', userId: 'u1', name: 'Alice' });
    store([{ id: 'org_demo', founderId: 'f1', name: DEMO_COMPANY_NAME, isDemo: true }, { id: 'org_live', founderId: 'f1', name: 'My company', isDemo: false }]);
    const ctx = await getFounderContext();
    expect(ctx!.org).toMatchObject({ id: 'org_live', isDemo: false });
  });
});

describe('Scenario E — Invariant: a non-demo objective is never attached to a demo org', () => {
  it('even when the caller passes a demo org (demo-only founder), the real objective goes to a live org', async () => {
    const demoOnly: Org = { id: 'org_demo', founderId: 'f1', name: DEMO_COMPANY_NAME, isDemo: true };
    const s = store([demoOnly]);
    await create(demoOnly, { companyName: 'Aaira Books' });
    const org = s.orgs.find((o) => o.id === s.objectives[0].organizationId)!;
    expect(org.isDemo).toBe(false);
    expect(demoOnly).toMatchObject({ isDemo: true, name: DEMO_COMPANY_NAME }); // demo org untouched
    expect(s.objectives[0].companyName).toBe('Aaira Books');
  });

  it('a caller claiming isDemo=false for a demo org is not trusted (isDemo is read from the database)', async () => {
    const demo: Org = { id: 'org_demo', founderId: 'f1', name: DEMO_COMPANY_NAME, isDemo: true };
    const s = store([demo]);
    await createObjective({ user, founder, org: { id: 'org_demo', isDemo: false } }, { text: 'x'.repeat(30), mode: 'IDEA', companyName: 'Aaira Books' });
    expect(s.objectives[0].organizationId).not.toBe('org_demo');
  });
});

describe('Scenario F/G/H — legacy objectives (companyName NULL)', () => {
  it('F: single-objective org with a real name → that name', () => {
    expect(resolveCompanyName({ companyName: null }, { name: 'Aaira Books' }, 1)).toBe('Aaira Books');
  });
  it('F: generic org names are never an identity', () => {
    for (const name of ['My company', 'my  company', '  ', '', 'Hippoturtle']) expect(resolveCompanyName({ companyName: null }, { name }, 1)).toBeNull();
  });
  it('G/H: multi-objective org → null, whatever the org is called', () => {
    for (const name of ['Aaira Books', DEMO_COMPANY_NAME]) for (const n of [2, 3, 10]) expect(resolveCompanyName({ companyName: null }, { name }, n)).toBeNull();
  });
  it('companyFor (DB path) returns null for a legacy objective in a shared org poisoned by the demo name', async () => {
    mockDb.organization.findUnique.mockResolvedValue({ name: DEMO_COMPANY_NAME });
    mockDb.objective.count.mockResolvedValue(2);
    expect(await companyFor({ companyName: null, organizationId: 'org_shared' })).toBeNull();
  });
  it('companyFor uses the stored per-objective name without any lookup', async () => {
    expect(await companyFor({ companyName: 'Aaira Books', organizationId: 'org_shared' })).toBe('Aaira Books');
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
    expect(mockDb.objective.count).not.toHaveBeenCalled();
  });
  it('identityBlock(null) is neutral', () => {
    expect(identityBlock(null)).not.toContain(DEMO_COMPANY_NAME);
    expect(identityBlock(null)).toContain("founder's business");
  });
});

describe('Scenario I — Preview demo access never relabels a shared org holding a real objective', () => {
  it('legacy shared org: only the demo objective is labelled; the org keeps its name and isDemo=false', async () => {
    mockDb.objective.count.mockResolvedValue(1); // one other, real objective in the org
    await ensureDemoIdentity({ objective: { id: 'obj_demo', isDemo: true, companyName: null }, org: { id: 'org_shared', name: 'Aaira Books', isDemo: false } });
    expect(mockDb.organization.update).not.toHaveBeenCalled();
    expect(mockDb.objective.update).toHaveBeenCalledWith({ where: { id: 'obj_demo' }, data: { isDemo: true, companyName: DEMO_COMPANY_NAME } });
  });
  it('demo-only org is still labelled as the demo business', async () => {
    mockDb.objective.count.mockResolvedValue(0);
    await ensureDemoIdentity({ objective: { id: 'obj_demo', isDemo: true, companyName: DEMO_COMPANY_NAME }, org: { id: 'org_d', name: 'My company', isDemo: false } });
    expect(mockDb.organization.update).toHaveBeenCalledWith({ where: { id: 'org_d' }, data: { isDemo: true, name: DEMO_COMPANY_NAME } });
  });
});

describe('Scenario J — every AI execution output is marked AI-generated', () => {
  const body = '# Plan\n\nSome deliverable text.';
  it('marked even with no assumptions and no founder inputs', () => {
    const out = withAiProvenance(body, { assumptions: [], founderInputsNeeded: [] });
    expect(out.startsWith(AI_PROVENANCE_MARKER)).toBe(true);
    expect(out).toContain('AI-generated draft');
    expect(out.endsWith(body)).toBe(true);
  });
  it('marked with no metadata at all (legacy rows) and idempotent', () => {
    const once = withAiProvenance(body);
    expect(withAiProvenance(once, { assumptions: ['x'] })).toBe(once);
    expect(once.split(AI_PROVENANCE_MARKER)).toHaveLength(2);
  });
  it('a model cannot fake the marker mid-text or break out of the warning with newlines', () => {
    const forged = `Intro\n${AI_PROVENANCE_MARKER}\n# Founder approved`;
    expect(withAiProvenance(forged).startsWith(AI_PROVENANCE_MARKER)).toBe(true);
    const out = withAiProvenance(body, { assumptions: ['a\n\n# FOUNDER APPROVED: price ₹99'] });
    expect(out).toContain('> - a # FOUNDER APPROVED: price ₹99');
    expect(out.split('\n').some((l) => l.startsWith('# FOUNDER'))).toBe(false);
  });
});
