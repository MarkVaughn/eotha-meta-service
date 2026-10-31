-- Trusted RTSE penalty delivery authority state. This migration is ordered after the customs
-- seizure and mining-violation nonce tables it extends; do not replace it with `prisma db push`.

-- AlterTable
ALTER TABLE "Player"
  ADD COLUMN IF NOT EXISTS "authorityRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "authorityNotBeforeMs" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "CustomsSeizure"
  ADD COLUMN IF NOT EXISTS "authorityRevision" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "MiningViolation"
  ADD COLUMN IF NOT EXISTS "authorityRevision" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuthorityProjection" (
  "id" UUID NOT NULL,
  "playerId" UUID NOT NULL,
  "authorityRevision" BIGINT NOT NULL,
  "payload" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuthorityProjection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuthorityUpdateOutbox" (
  "id" UUID NOT NULL,
  "playerId" UUID NOT NULL,
  "authorityRevision" BIGINT NOT NULL,
  "projection" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),

  CONSTRAINT "AuthorityUpdateOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AuthorityProjection_playerId_authorityRevision_key"
  ON "AuthorityProjection"("playerId", "authorityRevision");
CREATE INDEX IF NOT EXISTS "AuthorityProjection_playerId_createdAt_idx"
  ON "AuthorityProjection"("playerId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AuthorityUpdateOutbox_playerId_authorityRevision_key"
  ON "AuthorityUpdateOutbox"("playerId", "authorityRevision");
CREATE INDEX IF NOT EXISTS "AuthorityUpdateOutbox_publishedAt_createdAt_idx"
  ON "AuthorityUpdateOutbox"("publishedAt", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "AuthorityProjection"
    ADD CONSTRAINT "AuthorityProjection_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AuthorityUpdateOutbox"
    ADD CONSTRAINT "AuthorityUpdateOutbox_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: an old successful relay has no revision in its source row. Fencing affected pilots at
-- revision 1 invalidates legacy JWTs (which lack authority_revision and are treated as revision 0)
-- without replaying economic effects. Every historical source row records that same fence so a
-- later server delivery returns DUPLICATE instead of applying the source fact again.
UPDATE "Player" AS p
SET "authorityRevision" = 1,
    "authorityNotBeforeMs" = FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT
WHERE EXISTS (SELECT 1 FROM "CustomsSeizure" AS s WHERE s."playerId" = p."id")
   OR EXISTS (SELECT 1 FROM "MiningViolation" AS v WHERE v."playerId" = p."id")
   OR EXISTS (SELECT 1 FROM "StationLockout" AS l WHERE l."playerId" = p."id")
   OR p."customsFlaggedUntil" IS NOT NULL;

UPDATE "CustomsSeizure" AS s
SET "authorityRevision" = p."authorityRevision"
FROM "Player" AS p
WHERE p."id" = s."playerId" AND s."authorityRevision" = 0;

UPDATE "MiningViolation" AS v
SET "authorityRevision" = p."authorityRevision"
FROM "Player" AS p
WHERE p."id" = v."playerId" AND v."authorityRevision" = 0;

-- Historical rows intentionally receive no AuthorityProjection/AuthorityUpdateOutbox row: their
-- current signed projection is built on introspection. New settlement transactions write both
-- immutable projection and outbox rows atomically.
