-- V1 Moves: the Move, the native public surface, and Signal fields on Outcome. Additive only; safe to re-run.
ALTER TABLE "Outcome" ADD COLUMN IF NOT EXISTS "moveId" TEXT;
ALTER TABLE "Outcome" ADD COLUMN IF NOT EXISTS "rung" INTEGER;
ALTER TABLE "Outcome" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "Outcome" ADD COLUMN IF NOT EXISTS "polarity" TEXT;
ALTER TABLE "Outcome" ADD COLUMN IF NOT EXISTS "proof" TEXT;
ALTER TABLE "Outcome" ADD COLUMN IF NOT EXISTS "external" BOOLEAN;
CREATE INDEX IF NOT EXISTS "Outcome_moveId_idx" ON "Outcome"("moveId");

CREATE TABLE IF NOT EXISTS "Move" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "objectiveId" TEXT NOT NULL,
  "conversationId" TEXT,
  "kind" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "why" TEXT NOT NULL,
  "bet" TEXT NOT NULL,
  "hippoWill" TEXT NOT NULL,
  "needs" JSONB NOT NULL,
  "costInr" DOUBLE PRECISION,
  "costBasis" TEXT NOT NULL,
  "expectedSignal" TEXT NOT NULL,
  "artifactType" TEXT NOT NULL DEFAULT 'NONE',
  "artifactBrief" TEXT NOT NULL DEFAULT '',
  "alternative" JSONB,
  "routeKey" TEXT NOT NULL,
  "consequential" BOOLEAN NOT NULL DEFAULT false,
  "consequentialReasons" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "rung" INTEGER NOT NULL DEFAULT 1,
  "workId" TEXT,
  "publicPageId" TEXT,
  "proof" TEXT,
  "proofSource" TEXT,
  "authorizedBy" TEXT,
  "authorizedAt" TIMESTAMP(3),
  "actedAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL DEFAULT 'START',
  "previousMoveId" TEXT,
  "closeReason" TEXT,
  "reply" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Move_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Move_objectiveId_createdAt_idx" ON "Move"("objectiveId", "createdAt");
CREATE INDEX IF NOT EXISTS "Move_organizationId_createdAt_idx" ON "Move"("organizationId", "createdAt");
-- Exactly one current Move per objective, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS "Move_one_current_per_objective" ON "Move"("objectiveId")
  WHERE "status" IN ('PROPOSED', 'PREPARING', 'READY', 'APPROVED', 'LIVE', 'SIGNALLED', 'PARKED');

CREATE TABLE IF NOT EXISTS "PublicPage" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "objectiveId" TEXT NOT NULL,
  "moveId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "headline" TEXT NOT NULL,
  "subhead" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL,
  "cta" TEXT NOT NULL,
  "priceInr" DOUBLE PRECISION,
  "views" INTEGER NOT NULL DEFAULT 0,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublicPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PublicPage_slug_key" ON "PublicPage"("slug");
CREATE INDEX IF NOT EXISTS "PublicPage_moveId_idx" ON "PublicPage"("moveId");

CREATE TABLE IF NOT EXISTS "PublicResponse" (
  "id" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "name" TEXT,
  "contact" TEXT NOT NULL,
  "message" TEXT,
  "ipHash" TEXT,
  "fromOwner" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicResponse_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicResponse_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "PublicPage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PublicResponse_pageId_createdAt_idx" ON "PublicResponse"("pageId", "createdAt");
