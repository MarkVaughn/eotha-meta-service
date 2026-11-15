-- Station Intel unlocks are keyed by the gathered intel item, not the mission: the engine redacts a paid lead, so gathering
-- never learns its mission id. `missionId` is null until POST /game/missions/accept redeems the unlock for the offer's mission.
-- Postgres lets any number of NULLs through the existing (playerId, missionId) unique index.

-- AlterTable
ALTER TABLE "PlayerMissionUnlock" ALTER COLUMN "missionId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlayerMissionUnlock_playerId_intelId_key" ON "PlayerMissionUnlock"("playerId", "intelId");
