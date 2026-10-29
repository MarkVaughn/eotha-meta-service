-- Guarded (IF NOT EXISTS) so it is safe to apply to a database that `prisma db push` already brought up to date.

-- AlterTable
ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "customsFlaggedFactionId" TEXT;
ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "customsFlaggedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PlayerReputation" ADD COLUMN IF NOT EXISTS "domesticOreRemainder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CargoSale" ADD COLUMN IF NOT EXISTS "amnestyCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CargoSale" ADD COLUMN IF NOT EXISTS "domesticReputation" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SystemMiningPermit" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "factionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemMiningPermit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MiningViolation" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "factionId" TEXT NOT NULL,
    "issuedAtMs" BIGINT NOT NULL,
    "reputationChange" INTEGER NOT NULL,
    "flaggedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiningViolation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SystemMiningPermit_playerId_expiresAt_idx" ON "SystemMiningPermit"("playerId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SystemMiningPermit_playerId_systemH3_key" ON "SystemMiningPermit"("playerId", "systemH3");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MiningViolation_playerId_nonce_key" ON "MiningViolation"("playerId", "nonce");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SystemMiningPermit" ADD CONSTRAINT "SystemMiningPermit_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MiningViolation" ADD CONSTRAINT "MiningViolation_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
