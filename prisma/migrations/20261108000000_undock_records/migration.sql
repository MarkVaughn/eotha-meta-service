-- Signed undock evidence: one UndockRecord per engine-signed undock receipt (replay key: playerId + nonce), and the
-- engine time of the last undocking applied to a ship. Guarded (IF NOT EXISTS) so it is safe to apply to a database
-- that `prisma db push` already brought up to date.

-- AlterTable
ALTER TABLE "Spaceship" ADD COLUMN IF NOT EXISTS "lastCrewUndockedAtMs" BIGINT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "UndockRecord" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "stationId" TEXT NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "controllingFactionId" TEXT NOT NULL,
    "dockedAtMs" BIGINT NOT NULL,
    "undockedAtMs" BIGINT NOT NULL,
    "nonce" TEXT NOT NULL,
    "departedCrewIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UndockRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UndockRecord_playerId_undockedAtMs_idx" ON "UndockRecord"("playerId", "undockedAtMs");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UndockRecord_playerId_nonce_key" ON "UndockRecord"("playerId", "nonce");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "UndockRecord" ADD CONSTRAINT "UndockRecord_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
