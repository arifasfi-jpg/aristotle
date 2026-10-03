-- Phase 2: durable job runtime. Additive only.
CREATE TABLE IF NOT EXISTS "Job" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "progress" TEXT NOT NULL DEFAULT 'QUEUED',
  "checkpoint" TEXT,
  "state" JSONB,
  "budgetScopeType" TEXT NOT NULL,
  "budgetScopeId" TEXT NOT NULL,
  "budgetInr" DOUBLE PRECISION NOT NULL,
  "costInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reservedInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "lastError" TEXT,
  "waitingReason" TEXT,
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "cancelRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Job_dedupeKey_key" ON "Job"("dedupeKey");
CREATE INDEX IF NOT EXISTS "Job_status_runAfter_idx" ON "Job"("status", "runAfter");
CREATE INDEX IF NOT EXISTS "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "CostReservation" (
  "id" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "amountInr" DOUBLE PRECISION NOT NULL,
  "spec" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostReservation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CostReservation_scopeType_scopeId_releasedAt_idx" ON "CostReservation"("scopeType", "scopeId", "releasedAt");
