-- Outfitting redesign M1-1: the quality grade of each installed component (CHEAP, BASIC or ARTISAN, the
-- contracts' QualityGrade). Guarded (IF NOT EXISTS) so it is safe to apply to a database that
-- `prisma db push` already brought up to date. The default grandfathers every row that exists before
-- this migration as BASIC, which is what the component always was: its stats are unchanged.

-- AlterTable
ALTER TABLE "ShipComponentRecord" ADD COLUMN IF NOT EXISTS "quality" TEXT NOT NULL DEFAULT 'BASIC';
