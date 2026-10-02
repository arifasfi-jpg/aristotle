# Hippoturtle base model — deploy & demo runbook

## What this branch adds
One founder journey on top of the existing Aristotle app (nothing in Aristotle, auth or Razorpay was rewritten):

`/start` objective → understanding → founder confirms numbers → **existing** ₹99 Aristotle audit (scope → Razorpay order → verify)
→ `/objectives/[id]` research + 23-section decision memo → "How could we actually achieve this?" pathways → founder picks pathways
→ Mogli creates Work → `/work/[id]` brief + cost estimates (AI / human / agency / hybrid) → founder chooses → real AI execution
→ download output → quotes (honest broker) → outcomes → `/company` dashboard + `/memory` business memory.

Code: `src/lib/hippo/*` (capabilities, gateway, workflow types, costs, payments, services), `src/app/api/hippo/*`, pages
`start`, `objectives/[id]`, `work/[id]`, `company`, `memory`. Aristotle's own pages keep their dark theme under `/audit`, `/history`.

## Before the demo (Preview)
1. Push branch `hippoturtle`.
2. Apply `prisma/migrations/20261002000000_hippoturtle_base/migration.sql` to the **Preview** database (Neon SQL editor).
   Additive only (17 new tables, no change to existing tables), idempotent (`IF NOT EXISTS`). Do not run it on Production until reviewed.
3. Preview env vars: `GEMINI_API_KEY`, `TAVILY_API_KEY`, `DEMO_MODE=true` (skips the ₹99 payment only; research is real).
4. Redeploy Preview, open `/start`, click **Use the demo example**.

## Honesty rules enforced in code
- Research findings must quote their source verbatim; no evidence → "Not yet established".
- Pathway evidence must cite real R#/F# ids; ungrounded numbers are removed.
- Human/agency costs are labelled "AI-generated benchmark estimate — external quote required"; AI cost is computed from model rates + 10% margin; actual cost recorded after execution.
- Quotes are only founder-entered (or, in demo orgs, an explicitly labelled example). No provider is invented.
- Work is never marked paid: per-work payment is `INCLUDED_EARLY_ACCESS` / `PENDING_INTEGRATION`.
- Legal / tax capabilities never offer AI-only execution.
