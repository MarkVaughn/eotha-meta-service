-- Guarded (IF NOT EXISTS) so it is safe to apply to a database that `prisma db push` already brought up to date.

-- AlterTable
ALTER TABLE "CrewMember" ADD COLUMN IF NOT EXISTS "detainedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AbandonedMission" ADD COLUMN IF NOT EXISTS "offer" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomsSeizure" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "missionId" TEXT,
    "stationEntityId" TEXT NOT NULL,
    "systemH3" TEXT NOT NULL,
    "controllingFactionId" TEXT NOT NULL DEFAULT '',
    "captureTier" INTEGER NOT NULL,
    "inspectionOutcome" INTEGER NOT NULL,
    "exposureScoreMilli" INTEGER NOT NULL,
    "seizedAtMs" BIGINT NOT NULL,
    "fineCredits" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomsSeizure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StationLockout" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "stationId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "tier" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationLockout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CustomsSeizure_playerId_missionId_idx" ON "CustomsSeizure"("playerId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CustomsSeizure_playerId_nonce_key" ON "CustomsSeizure"("playerId", "nonce");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StationLockout_playerId_until_idx" ON "StationLockout"("playerId", "until");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StationLockout_playerId_stationId_key" ON "StationLockout"("playerId", "stationId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CustomsSeizure" ADD CONSTRAINT "CustomsSeizure_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "StationLockout" ADD CONSTRAINT "StationLockout_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

