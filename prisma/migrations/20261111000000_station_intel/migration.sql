-- Station Intel: the pilot's hourly gathering budget (PlayerIntelBudget), the mission unlocks a gathered lead leaves
-- (PlayerMissionUnlock) and the per-station ship sighting ring buffer (StationSightingRecord). Guarded (IF NOT EXISTS)
-- so it is safe to apply to a database that `prisma db push` already brought up to date.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlayerIntelBudget" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "hourEpoch" BIGINT NOT NULL,
    "gatheredCount" INTEGER NOT NULL DEFAULT 0,
    "unlockedIntelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "PlayerIntelBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlayerMissionUnlock" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "missionId" TEXT NOT NULL,
    "stationEntityId" TEXT NOT NULL,
    "intelId" TEXT NOT NULL,
    "category" INTEGER NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "voucherNonce" BYTEA NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isAccepted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PlayerMissionUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StationSightingRecord" (
    "id" UUID NOT NULL,
    "stationEntityId" TEXT NOT NULL,
    "shipName" TEXT NOT NULL,
    "captainName" TEXT NOT NULL,
    "hullTier" INTEGER NOT NULL,
    "weaponTier" INTEGER NOT NULL,
    "shieldTier" INTEGER NOT NULL,
    "flyingColors" TEXT,
    "isStealthed" BOOLEAN NOT NULL DEFAULT false,
    "undockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationSightingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlayerIntelBudget_playerId_hourEpoch_key" ON "PlayerIntelBudget"("playerId", "hourEpoch");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlayerMissionUnlock_playerId_expiresAt_idx" ON "PlayerMissionUnlock"("playerId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlayerMissionUnlock_playerId_missionId_key" ON "PlayerMissionUnlock"("playerId", "missionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StationSightingRecord_stationEntityId_undockedAt_idx" ON "StationSightingRecord"("stationEntityId", "undockedAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PlayerIntelBudget" ADD CONSTRAINT "PlayerIntelBudget_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PlayerMissionUnlock" ADD CONSTRAINT "PlayerMissionUnlock_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

