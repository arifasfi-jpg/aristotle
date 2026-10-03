-- Phase 1.1: authoritative prices + explicit cost certainty.
-- ADDITIVE: new nullable/defaulted columns, new price rows; the only update deactivates the unverified Gemini price that
-- Phase 1 seeded (it was carried over from an app-wide default and is NOT Google's price for that model).

ALTER TABLE "ModelPrice" ADD COLUMN IF NOT EXISTS "reasoningUsdPerMTok" DOUBLE PRECISION;
ALTER TABLE "ModelPrice" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "ModelPrice" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "ModelPrice" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);

-- Rows written before this migration were costed with an unverified price: they are estimates.
ALTER TABLE "AiUsage" ADD COLUMN IF NOT EXISTS "costStatus" TEXT NOT NULL DEFAULT 'ESTIMATED';

UPDATE "ModelPrice" SET "active" = false, "source" = 'SUPERSEDED: app-wide default, not the provider price (see mp_gemini_3_5_flash_lite_v)'
WHERE "id" = 'mp_gemini_3_5_flash_lite_2026';

-- Verified on 2026-10-03 against the providers' published standard (paid, non-batch) price pages.
-- Gemini output prices include thinking tokens (reasoningUsdPerMTok NULL = output rate).
INSERT INTO "ModelPrice" ("id", "provider", "model", "inputUsdPerMTok", "outputUsdPerMTok", "cachedInputUsdPerMTok", "usdPerCredit", "currency", "effectiveFrom", "verificationStatus", "verifiedAt", "source") VALUES
  ('mp_gemini_3_5_flash_lite_v', 'gemini', 'gemini-3.5-flash-lite', 0.30, 2.50, 0.03, NULL, 'USD', TIMESTAMP '2026-10-03 00:00:00', 'VERIFIED', TIMESTAMP '2026-10-03 00:00:00', 'https://ai.google.dev/gemini-api/docs/pricing (Standard, paid tier; output incl. thinking)'),
  ('mp_gemini_3_5_flash_v',      'gemini', 'gemini-3.5-flash',      1.50, 9.00, 0.15, NULL, 'USD', TIMESTAMP '2026-10-03 00:00:00', 'VERIFIED', TIMESTAMP '2026-10-03 00:00:00', 'https://ai.google.dev/gemini-api/docs/pricing (Standard, paid tier; output incl. thinking)'),
  ('mp_gemini_3_1_flash_lite_v', 'gemini', 'gemini-3.1-flash-lite', 0.25, 1.50, NULL, NULL, 'USD', TIMESTAMP '2026-10-03 00:00:00', 'VERIFIED', TIMESTAMP '2026-10-03 00:00:00', 'https://ai.google.dev/gemini-api/docs/pricing (Standard, paid tier, text input; caching price not confirmed: cached billed at input rate)'),
  ('mp_openai_gpt_5_6_luna_v',   'openai', 'gpt-5.6-luna',          0.20, 1.20, 0.02, NULL, 'USD', TIMESTAMP '2026-10-03 00:00:00', 'VERIFIED', TIMESTAMP '2026-10-03 00:00:00', 'https://developers.openai.com/api/docs/models/gpt-5.6-luna (standard tier)'),
  ('mp_anthropic_opus_5_5_v',    'anthropic', 'claude-opus-5-5',    4.00, 20.00, 0.20, NULL, 'USD', TIMESTAMP '2026-10-03 00:00:00', 'VERIFIED', TIMESTAMP '2026-10-03 00:00:00', 'https://platform.claude.com/docs/en/about-claude/pricing (base; cache hits $0.20; cache writes not used by Hippoturtle)')
ON CONFLICT ("provider", "model", "effectiveFrom") DO NOTHING;

-- Tavily: re-checked 2026-10-03 (basic = 1 credit, advanced = 2 credits, pay-as-you-go $0.008 per credit).
UPDATE "ModelPrice" SET "verificationStatus" = 'VERIFIED', "verifiedAt" = TIMESTAMP '2026-10-03 00:00:00'
WHERE "id" = 'mp_tavily_search_2026';
