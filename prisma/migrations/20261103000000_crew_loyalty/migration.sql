-- Factions F6: each crew member's loyalty to the three great factions, 0 to 100. Guarded (IF NOT EXISTS)
-- so it is safe to apply to a database that `prisma db push` already brought up to date. The default of
-- 50 (neutral) is what every member hired before this migration holds.

-- AlterTable
ALTER TABLE "CrewMember" ADD COLUMN IF NOT EXISTS "loyaltyAlpha" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "CrewMember" ADD COLUMN IF NOT EXISTS "loyaltyBeta" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "CrewMember" ADD COLUMN IF NOT EXISTS "loyaltyGamma" INTEGER NOT NULL DEFAULT 50;
