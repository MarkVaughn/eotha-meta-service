-- Planetary away-team expeditions: crew trauma (CrewMember.traumaUntil / traumaType) and one ExpeditionRecord per
-- settled RTSE-signed AwayTeamClaim (replay key: nonceHex). Guarded (IF NOT EXISTS) so it is safe to apply to a
-- database that `prisma db push` already brought up to date.

-- AlterTable
ALTER TABLE "CrewMember" ADD COLUMN IF NOT EXISTS "traumaUntil" TIMESTAMP(3);
ALTER TABLE "CrewMember" ADD COLUMN IF NOT EXISTS "traumaType" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ExpeditionRecord" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "spaceshipId" UUID NOT NULL,
    "systemH3" TEXT NOT NULL,
    "planetId" TEXT NOT NULL,
    "siteNodeH3" TEXT NOT NULL,
    "missionId" TEXT,
    "outcomeTier" INTEGER NOT NULL,
    "grossCredits" INTEGER NOT NULL,
    "crewWageShareCredits" INTEGER NOT NULL,
    "netCredits" INTEGER NOT NULL,
    "captainXp" INTEGER NOT NULL,
    "sponsorRepChange" INTEGER NOT NULL DEFAULT 0,
    "rivalRepChange" INTEGER NOT NULL DEFAULT 0,
    "nonceHex" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpeditionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ExpeditionRecord_nonceHex_key" ON "ExpeditionRecord"("nonceHex");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpeditionRecord_playerId_createdAt_idx" ON "ExpeditionRecord"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpeditionRecord_systemH3_planetId_idx" ON "ExpeditionRecord"("systemH3", "planetId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ExpeditionRecord" ADD CONSTRAINT "ExpeditionRecord_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
