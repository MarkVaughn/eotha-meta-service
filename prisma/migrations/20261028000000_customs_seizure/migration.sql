-- AlterTable
ALTER TABLE "CrewMember" ADD COLUMN     "detainedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CustomsSeizure" (
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
CREATE TABLE "StationLockout" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "stationId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "tier" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationLockout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomsSeizure_playerId_missionId_idx" ON "CustomsSeizure"("playerId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomsSeizure_playerId_nonce_key" ON "CustomsSeizure"("playerId", "nonce");

-- CreateIndex
CREATE INDEX "StationLockout_playerId_until_idx" ON "StationLockout"("playerId", "until");

-- CreateIndex
CREATE UNIQUE INDEX "StationLockout_playerId_stationId_key" ON "StationLockout"("playerId", "stationId");

-- AddForeignKey
ALTER TABLE "CustomsSeizure" ADD CONSTRAINT "CustomsSeizure_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLockout" ADD CONSTRAINT "StationLockout_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

