-- Phase 1: AI cost ledger, per-model prices, request rate limits.
-- ADDITIVE ONLY: three new tables, no existing table or row is changed. Safe to re-run (IF NOT EXISTS / ON CONFLICT).

CREATE TABLE IF NOT EXISTS "AiUsage" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "task" TEXT NOT NULL,
  "tier" INTEGER,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedTokens" INTEGER NOT NULL DEFAULT 0,
  "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
  "searchCalls" INTEGER NOT NULL DEFAULT 0,
  "searchCredits" INTEGER NOT NULL DEFAULT 0,
  "estimatedInr" DOUBLE PRECISION,
  "costInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "priceSource" TEXT NOT NULL,
  "priceId" TEXT,
  "usdInr" DOUBLE PRECISION NOT NULL,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "retries" INTEGER NOT NULL DEFAULT 0,
  "outcome" TEXT NOT NULL,
  "error" TEXT,
  "userId" TEXT,
  "founderId" TEXT,
  "organizationId" TEXT,
  "objectiveId" TEXT,
  "workId" TEXT,
  "auditId" TEXT,
  "parentType" TEXT,
  "parentId" TEXT,
  CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_purpose_createdAt_idx" ON "AiUsage"("purpose", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_organizationId_createdAt_idx" ON "AiUsage"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_auditId_idx" ON "AiUsage"("auditId");
CREATE INDEX IF NOT EXISTS "AiUsage_provider_model_idx" ON "AiUsage"("provider", "model");

CREATE TABLE IF NOT EXISTS "ModelPrice" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputUsdPerMTok" DOUBLE PRECISION,
  "outputUsdPerMTok" DOUBLE PRECISION,
  "cachedInputUsdPerMTok" DOUBLE PRECISION,
  "usdPerCredit" DOUBLE PRECISION,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ModelPrice_provider_model_effectiveFrom_key" ON "ModelPrice"("provider", "model", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "ModelPrice_provider_model_idx" ON "ModelPrice"("provider", "model");

CREATE TABLE IF NOT EXISTS "RateLimit" (
  "key" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key", "windowStart")
);
CREATE INDEX IF NOT EXISTS "RateLimit_windowStart_idx" ON "RateLimit"("windowStart");

-- Seed prices (only prices with a stated source).
-- Tavily: basic search = 1 credit, advanced = 2 credits; pay-as-you-go $0.008 per credit (docs.tavily.com/guides/api-credits).
INSERT INTO "ModelPrice" ("id", "provider", "model", "usdPerCredit", "effectiveFrom", "source")
VALUES ('mp_tavily_search_2026', 'tavily', 'search', 0.008, TIMESTAMP '2026-01-01 00:00:00', 'https://docs.tavily.com/guides/api-credits (pay-as-you-go)')
ON CONFLICT ("provider", "model", "effectiveFrom") DO NOTHING;
-- Default Gemini model: the rates the app has always used for every model (MODEL_*_USD_PER_MILLION defaults 0.20 / 1.20),
-- now pinned to THIS model only so ledger figures stay comparable with existing Audit.computePaise. Verify against Google's price list.
INSERT INTO "ModelPrice" ("id", "provider", "model", "inputUsdPerMTok", "outputUsdPerMTok", "effectiveFrom", "source")
VALUES ('mp_gemini_3_5_flash_lite_2026', 'gemini', 'gemini-3.5-flash-lite', 0.20, 1.20, TIMESTAMP '2026-01-01 00:00:00', 'carried over from the previous app-wide default; verify')
ON CONFLICT ("provider", "model", "effectiveFrom") DO NOTHING;
