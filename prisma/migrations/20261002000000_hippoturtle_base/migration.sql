-- Hippoturtle base model. ADDITIVE ONLY: creates new tables; no existing table or row is changed.
-- Safe to re-run (IF NOT EXISTS everywhere). Apply to the Preview database first.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Founder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "timeCommitment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Founder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL,
    "founderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Objective" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'IDEA',
    "stage" TEXT NOT NULL DEFAULT 'FOUNDER_OBJECTIVE',
    "understanding" JSONB,
    "auditId" TEXT,
    "pathways" JSONB,
    "selectedPathways" JSONB,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Objective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BusinessIdea" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "offering" TEXT NOT NULL,
    "revenueMechanism" TEXT NOT NULL,
    "keyActivities" JSONB NOT NULL,
    "regulatedActivities" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchQuestion" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "whyItMatters" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchFinding" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "questionCode" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3),
    "geography" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Evidence" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "confidence" TEXT NOT NULL,
    "validation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DecisionMemo" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "pathways" JSONB,
    "founderChecklist" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DecisionMemo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Work" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "deliverable" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 3,
    "estimatedCost" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "executionMode" TEXT,
    "selectedProviderId" TEXT,
    "pathwayId" TEXT,
    "aiExecutable" BOOLEAN NOT NULL DEFAULT true,
    "paymentStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "amountPaise" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "Work_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkBrief" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "deliverable" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "successCriteria" JSONB NOT NULL,
    "expectedOutput" TEXT NOT NULL,
    "outOfScope" JSONB NOT NULL,
    "effort" JSONB NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CostEstimate" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "label" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "breakdown" JSONB NOT NULL,
    "drivers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Provider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "website" TEXT,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Quote" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "includes" JSONB NOT NULL,
    "excludes" JSONB NOT NULL,
    "turnaroundDays" INTEGER,
    "revisions" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "source" TEXT NOT NULL,
    "comparison" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Execution" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "input" JSONB NOT NULL,
    "output" TEXT,
    "outputSummary" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Outcome" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "workId" TEXT,
    "summary" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Outcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BusinessMemory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objectiveId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "value" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "sourceUrl" TEXT,
    "owner" TEXT NOT NULL,
    "confidence" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ActivityLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objectiveId" TEXT,
    "workId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Founder_userId_key" ON "Founder"("userId");
CREATE INDEX IF NOT EXISTS "Organization_founderId_idx" ON "Organization"("founderId");
CREATE UNIQUE INDEX IF NOT EXISTS "Objective_auditId_key" ON "Objective"("auditId");
CREATE INDEX IF NOT EXISTS "Objective_organizationId_createdAt_idx" ON "Objective"("organizationId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessIdea_objectiveId_key" ON "BusinessIdea"("objectiveId");
CREATE UNIQUE INDEX IF NOT EXISTS "ResearchQuestion_objectiveId_code_key" ON "ResearchQuestion"("objectiveId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "ResearchFinding_objectiveId_code_key" ON "ResearchFinding"("objectiveId", "code");
CREATE INDEX IF NOT EXISTS "Evidence_objectiveId_idx" ON "Evidence"("objectiveId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionMemo_objectiveId_key" ON "DecisionMemo"("objectiveId");
CREATE INDEX IF NOT EXISTS "Work_organizationId_status_idx" ON "Work"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "Work_objectiveId_idx" ON "Work"("objectiveId");
CREATE UNIQUE INDEX IF NOT EXISTS "WorkBrief_workId_key" ON "WorkBrief"("workId");
CREATE INDEX IF NOT EXISTS "CostEstimate_workId_idx" ON "CostEstimate"("workId");
CREATE INDEX IF NOT EXISTS "Provider_organizationId_idx" ON "Provider"("organizationId");
CREATE INDEX IF NOT EXISTS "Quote_workId_idx" ON "Quote"("workId");
CREATE INDEX IF NOT EXISTS "Execution_workId_idx" ON "Execution"("workId");
CREATE INDEX IF NOT EXISTS "Outcome_objectiveId_idx" ON "Outcome"("objectiveId");
CREATE INDEX IF NOT EXISTS "BusinessMemory_organizationId_occurredAt_idx" ON "BusinessMemory"("organizationId", "occurredAt");
CREATE INDEX IF NOT EXISTS "ActivityLog_organizationId_createdAt_idx" ON "ActivityLog"("organizationId", "createdAt");

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "Founder" ADD CONSTRAINT "Founder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Organization" ADD CONSTRAINT "Organization_founderId_fkey" FOREIGN KEY ("founderId") REFERENCES "Founder"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Objective" ADD CONSTRAINT "Objective_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BusinessIdea" ADD CONSTRAINT "BusinessIdea_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BusinessIdea" ADD CONSTRAINT "BusinessIdea_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ResearchQuestion" ADD CONSTRAINT "ResearchQuestion_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "DecisionMemo" ADD CONSTRAINT "DecisionMemo_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Work" ADD CONSTRAINT "Work_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Work" ADD CONSTRAINT "Work_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "WorkBrief" ADD CONSTRAINT "WorkBrief_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "CostEstimate" ADD CONSTRAINT "CostEstimate_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Provider" ADD CONSTRAINT "Provider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Quote" ADD CONSTRAINT "Quote_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Quote" ADD CONSTRAINT "Quote_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Execution" ADD CONSTRAINT "Execution_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "Objective"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BusinessMemory" ADD CONSTRAINT "BusinessMemory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
