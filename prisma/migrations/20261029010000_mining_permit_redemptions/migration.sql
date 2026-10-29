-- Guarded (IF NOT EXISTS) so it is safe to apply to a database that `prisma db push` already brought up to date.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MiningPermitRedemption" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "factionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiningPermitRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MiningPermitRedemption_playerId_nonce_key" ON "MiningPermitRedemption"("playerId", "nonce");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MiningPermitRedemption" ADD CONSTRAINT "MiningPermitRedemption_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
