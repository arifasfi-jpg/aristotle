-- Migration: add per-objective company name column
-- This column stores the business identity for each objective independently.
-- It is immutable after creation and eliminates the shared-org-name contamination vector.
-- See design doc §1 (PRIMARY fix) and §7 (Legacy Data Migration Strategy).

-- Step 1: Add the column (nullable — existing rows start as NULL).
ALTER TABLE "Objective" ADD COLUMN IF NOT EXISTS "companyName" TEXT;

-- Step 2: Backfill Category A — single-objective orgs with non-generic org names.
-- Safe: when an org has exactly one objective, the org name unambiguously belongs to it.
-- Condition: org.name is a real business name AND COUNT(objectives for this org) = 1.
-- Generic placeholders are excluded the same way the app's isGenericOrgName() does: empty/blank, "My company"
-- (any case/spacing), or the platform's own name (Hippoturtle). Only NULL rows are touched (re-run safe).
UPDATE "Objective" o
SET "companyName" = btrim(org.name)
FROM "Organization" org
WHERE o."organizationId" = org.id
  AND o."companyName" IS NULL
  AND org.name IS NOT NULL
  AND btrim(org.name) <> ''
  AND lower(regexp_replace(btrim(org.name), '\s+', ' ', 'g')) <> 'my company'
  AND org.name !~* 'hippo\s*turtle'
  AND (
    SELECT COUNT(*) FROM "Objective" o2
    WHERE o2."organizationId" = org.id
  ) = 1;

-- Step 3: Category B — multi-objective orgs (COUNT >= 2): companyName intentionally left NULL.
-- The org name may have been contaminated by the bug being fixed.
-- companyFor() runtime guard (design §7.3) prevents org name from being used as AI identity.
-- These rows receive null, which causes companyFor() to return null (conservative: no wrong identity).

-- ================================================================
-- VERIFICATION QUERIES (run after migration to confirm correctness):
-- ================================================================

-- Verify 1: no Category A row has companyName = NULL after migration
-- Expected result: 0 rows
-- SELECT COUNT(*) FROM "Objective" o
-- JOIN "Organization" org ON o."organizationId" = org.id
-- WHERE o."companyName" IS NULL
--   AND btrim(org.name) <> '' AND lower(regexp_replace(btrim(org.name), '\s+', ' ', 'g')) <> 'my company'
--   AND org.name !~* 'hippo\s*turtle'
--   AND (SELECT COUNT(*) FROM "Objective" o2 WHERE o2."organizationId" = org.id) = 1;

-- Verify 2: no Category B row was backfilled (multi-objective orgs still have companyName = NULL)
-- Expected result: 0 rows
-- SELECT COUNT(*) FROM "Objective" o
-- JOIN "Organization" org ON o."organizationId" = org.id
-- WHERE o."companyName" IS NOT NULL
--   AND (SELECT COUNT(*) FROM "Objective" o2 WHERE o2."organizationId" = org.id) > 1;
