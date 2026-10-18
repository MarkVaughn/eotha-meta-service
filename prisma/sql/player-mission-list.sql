-- Run once, before `prisma db push`, on a database created while a pilot could hold only one
-- mission (PlayerMission.playerId was unique). It adds the (playerId, missionId) unique index the
-- schema now declares, which those rows already satisfy, so `db push` only drops the old index and
-- needs no --accept-data-loss. Safe to run again, and a no-op on a database without the table.
DO $$
BEGIN
  IF to_regclass('"PlayerMission"') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "PlayerMission_playerId_missionId_key" ON "PlayerMission" ("playerId", "missionId");
  END IF;
END $$;
