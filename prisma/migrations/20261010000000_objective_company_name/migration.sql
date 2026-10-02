-- Migration: add per-objective company name column
-- This column stores the business identity for each objective independently.
-- It is immutable after creation and eliminates the shared-org-name contamination vector.
-- See design doc §1 (PRIMARY fix) and §7 (Legacy Data Migration Strategy).

-- Step 1: Add the column (nullable — existing rows start as NULL).
ALTER TABLE "Objective" ADD COLUMN "companyName" TEXT;

-- Step 2: Backfill Category A — single-objective orgs with non-generic org names.
-- Safe: when an org has exactly one objective, the org name unambiguously belongs to it.
-- Condition: org.name NOT IN generic placeholders AND COUNT(objectives for this org) = 1.
UPDATE "Objective" o
SET "companyName" = org.name
FROM "Organization" org
WHERE o."organizationId" = org.id
  AND org.name NOT IN ('My company', 'My Company', '')
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
--   AND org.name NOT IN ('My company', 'My Company', '')
--   AND (SELECT COUNT(*) FROM "Objective" o2 WHERE o2."organizationId" = org.id) = 1;

-- Verify 2: no Category B row was backfilled (multi-objective orgs still have companyName = NULL)
-- Expected result: 0 rows
-- SELECT COUNT(*) FROM "Objective" o
-- JOIN "Organization" org ON o."organizationId" = org.id
-- WHERE o."companyName" IS NOT NULL
--   AND (SELECT COUNT(*) FROM "Objective" o2 WHERE o2."organizationId" = org.id) > 1;
