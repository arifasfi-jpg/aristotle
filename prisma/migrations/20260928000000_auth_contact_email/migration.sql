-- Security fix: email is no longer used to identify / log in a user.
--
-- NOT YET APPLIED ANYWHERE. Do not run against production until the actual Neon schema
-- has been verified and the migration baseline has been decided.
--
-- Additive and data-preserving:
--  * DROP NOT NULL only relaxes a constraint; no row is rewritten. Existing users keep their email,
--    and the unique index "User_email_key" stays (PostgreSQL allows multiple NULLs in a unique index).
--  * contactEmail is a new nullable column; existing audits read NULL.
--  * Both statements are safe to re-run.

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Audit" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
