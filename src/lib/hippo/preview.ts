// PREVIEW-ONLY test access to the existing demo objective.
//
// Hippoturtle identity is an anonymous cookie session (same as Aristotle), so a fresh browser cannot see an objective
// created in another browser. To test an EXISTING paid demo objective on Vercel Preview, this signs the current
// browser into the account that owns that one objective. It is never available in Production.
import { db } from '../db';
import { isDemoMode } from '../payments';
import { DEMO_COMPANY_NAME, isGenericOrgName } from './types';

/** Same guard as Demo checkout: DEMO_MODE=true AND not Vercel Production AND not self-hosted production. */
export const previewDemoAccessEnabled = () => isDemoMode();

/**
 * The single objective Preview access may open:
 *  - HIPPO_PREVIEW_DEMO_OBJECTIVE_ID (server env, set by whoever administers the Preview deployment), otherwise
 *  - the most recent objective created with "Use the demo example" (isDemo = true).
 * Either way its Aristotle audit must already be paid and completed. Nothing is created, copied or charged.
 */
export async function findPreviewDemoObjective() {
  if (!previewDemoAccessEnabled()) return null;
  const configured = process.env.HIPPO_PREVIEW_DEMO_OBJECTIVE_ID?.trim();
  const candidates = configured
    ? await db.objective.findMany({ where: { id: configured }, take: 1 })
    : await db.objective.findMany({ where: { isDemo: true, auditId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 20 });
  for (const objective of candidates) {
    const audit = objective.auditId ? await db.audit.findUnique({ where: { id: objective.auditId } }) : null;
    if (!audit || audit.paymentStatus !== 'paid' || audit.status !== 'completed') continue;
    const org = await db.organization.findUnique({ where: { id: objective.organizationId }, include: { founder: true } });
    if (!org) continue;
    return { objective, audit, org, ownerUserId: org.founder.userId };
  }
  return null;
}

/**
 * The demo objective belongs to a separate, clearly fictional demo BUSINESS — never to Hippoturtle.
 * The objective itself is labelled as demo data with the fictional company name. The owning organisation is
 * flagged/renamed as the demo business ONLY when every objective in it is demo data: an organisation that also
 * holds a real objective (legacy shared organisation) is left untouched, so the demo can never re-label a real
 * business. Updates in place: no new objective, audit, order or payment; founder text and facts untouched.
 */
export async function ensureDemoIdentity(found: { objective: { id: string; isDemo: boolean; companyName?: string | null }; org: { id: string; name: string; isDemo: boolean } }) {
  const realObjectives = await db.objective.count({ where: { organizationId: found.org.id, isDemo: false, id: { not: found.objective.id } } });
  if (realObjectives === 0 && (isGenericOrgName(found.org.name) || !found.org.isDemo)) {
    await db.organization.update({ where: { id: found.org.id }, data: { isDemo: true, ...(isGenericOrgName(found.org.name) ? { name: DEMO_COMPANY_NAME } : {}) } });
  }
  if (!found.objective.isDemo || found.objective.companyName == null) {
    await db.objective.update({ where: { id: found.objective.id }, data: { isDemo: true, ...(found.objective.companyName == null ? { companyName: DEMO_COMPANY_NAME } : {}) } });
  }
}
