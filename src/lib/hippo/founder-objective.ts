// The founder's stated business is authoritative: founder fact > Business State inference > model hypothesis.
// Hippo may clarify, challenge or suggest an alternative — but never silently swap the founder's customer or use-case for
// another one ("MSME BNPL" must never quietly become "salary advances for blue-collar workers"). Pure helpers, no I/O.

const n0 = (s: string) => s.toLowerCase().replace(/[’']/g, "'");

/** The founder named a concrete business (a product/model and/or who it serves) in their own words. */
export function statesBusiness(text: string): boolean {
  const t = n0(text);
  if (!/\b(build|start|create|launch|run|open|sell|make|offer|do|set up|setup|grow|scale)\b|\b(business|startup|company|platform|app|marketplace|service)\b/.test(t)) return false;
  if (vagueDomain(text)) return false;
  if (/\b(don'?t|do not) know (what|which|how)|no idea (what|which|how)|not sure (what|which)|any ideas|suggest (some|a few|an?|options|ideas|something)|nothing in mind\b/.test(t)) return false;
  // A concrete thing — "business" or "startup" alone is not one.
  const thing = /\b(platform|app|marketplace|service|shop|store|brand|agency|product|msmes?|smes?|bnpl|buy ?now,? ?pay ?later|lending|loans?|credit|emi|insurance|salary advance|payday|tiffin|bakery|cafe|tailor\w*|clothing|quiz books?|books?|tuition|classes|course|saas|software|delivery|subscription|franchise|clinic|salon|gym)\b/;
  return thing.test(t);
}

/** "Something in lending" — a sector without who it serves or what it does: worth one clarifying question. */
export function vagueDomain(text: string): string | null {
  const m = n0(text).match(/\b(?:something|anything|some business|a business|some startup)\s+(?:in|around|with|related to|to do with|about)\s+([a-z][a-z ]{1,30}?)(?=[.,!?]|$| but| and| because| maybe)/);
  return m ? m[1].trim() : null;
}

export const clarifyQuestion = (domain: string) =>
  `${domain[0].toUpperCase()}${domain.slice(1)} for whom, and for what? For example — small businesses, employees, students or shoppers; and what would they use it for? Tell me in a line, or say "not sure" and I'll suggest a few.`;

// Who a business serves, grouped so that synonyms match (an MSME is a merchant / shop owner / supplier; a worker is an employee).
const SEGMENTS: Record<string, RegExp> = {
  SMALL_BUSINESSES: /\b(msmes?|smes?|small (and medium )?business(es)?|merchants?|shop ?owners?|shopkeepers?|retailers?|kiranas?|wholesalers?|distributors?|stockists?|chemists?|pharmacies|suppliers?|traders?|b2b|businesses)\b/,
  EMPLOYEES: /\b(employees?|workers?|blue[- ]collar|salaried|staff|labou?r(ers)?|salary|payday|earned wage)\b/,
  STUDENTS: /\b(students?|learners?|edtechs?|courses?)\b/,
  CONSUMERS: /\b(consumers?|shoppers?|individuals?|households?)\b/,
  FARMERS: /\b(farmers?|agri\w*)\b/,
  GIG: /\b(gig workers?|drivers?|delivery partners?)\b/,
};
export function segmentsOf(text: string): Set<string> {
  const t = n0(text);
  return new Set(Object.entries(SEGMENTS).filter(([, re]) => re.test(t)).map(([k]) => k));
}

/** A Move (or direction) that replaces the founder's stated customer with a different one. Null when it stays on objective. */
export function offObjective(objective: string, proposal: string): string | null {
  const want = segmentsOf(objective);
  const got = segmentsOf(proposal);
  if (!want.size || !got.size) return null;
  for (const g of got) if (want.has(g)) return null;
  return `the founder's business serves ${[...want].join('/').toLowerCase().replace(/_/g, ' ')}, but this targets ${[...got].join('/').toLowerCase().replace(/_/g, ' ')}`;
}

export const FOUNDER_OBJECTIVE_RULES = `THE FOUNDER'S OBJECTIVE IS AUTHORITATIVE (founder fact > Hippo's inference > model hypothesis). Keep their stated customer,
product and business model exactly (e.g. "MSME BNPL" stays deferred payment for MSMEs). You may clarify, challenge it, flag risks, or
suggest a safer way to test it. If you believe a different opportunity is better, say so openly ("You said X. I also see Y —
want to consider it?") and put it in "alternative" — never replace their customer or use-case with another one.`;
