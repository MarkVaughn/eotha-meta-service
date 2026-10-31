-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Player" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL DEFAULT '!',
    "callsign" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "devCreditsGrantedAt" TIMESTAMP(3),
    "activeColorsFactionId" TEXT,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Captain" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "unlockedTraits" JSONB NOT NULL DEFAULT '[]',
    "originType" TEXT NOT NULL DEFAULT 'STARTER',
    "promotedFromCrewId" UUID,
    "innateClass" TEXT,
    "innateRank" TEXT,
    "quirkId" TEXT,
    "juryRigComponentTypes" JSONB NOT NULL DEFAULT '[]',
    "missionsCompleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Captain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetiredCaptain" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "originType" TEXT NOT NULL DEFAULT 'STARTER',
    "promotedFromCrewId" UUID,
    "innateClass" TEXT,
    "innateRank" TEXT,
    "quirkId" TEXT,
    "finalLevel" INTEGER NOT NULL,
    "finalXp" INTEGER NOT NULL,
    "retirementTier" TEXT NOT NULL,
    "missionsCompleted" INTEGER NOT NULL,
    "unlockedTraits" JSONB NOT NULL,
    "capstoneTraitId" TEXT,
    "legacyDoctrineId" TEXT,
    "activeDoctrine" BOOLEAN NOT NULL DEFAULT false,
    "factionStandingsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "primaryFactionId" TEXT,
    "retiredAtStationId" TEXT,
    "retiredAtSystemH3" TEXT,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'RETIRED_IDLE',
    "assignedSpaceshipId" UUID,
    "receiptNonce" TEXT,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetiredCaptain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewMember" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "spaceshipId" UUID,
    "name" TEXT NOT NULL,
    "crewClass" TEXT NOT NULL,
    "rank" TEXT NOT NULL,
    "quirkId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "morale" INTEGER NOT NULL DEFAULT 75,
    "seniorityXp" INTEGER NOT NULL DEFAULT 0,
    "wageShareBp" INTEGER NOT NULL DEFAULT 500,
    "unutilizedStreak" INTEGER NOT NULL DEFAULT 0,
    "unpaidArrearsCredits" INTEGER NOT NULL DEFAULT 0,
    "pendingStipendCredits" INTEGER NOT NULL DEFAULT 0,
    "juryRigComponentTypes" JSONB NOT NULL DEFAULT '[]',
    "homeFactionId" TEXT NOT NULL DEFAULT 'independent',
    "hiredAtStationId" TEXT NOT NULL,
    "sourceCandidateId" TEXT,
    "hiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrewMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpaceHarbor" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "h3Index" VARCHAR(15) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "metalStock" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "gasStock" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpaceHarbor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameSession" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "rtseHost" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Spaceship" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "callsign" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "passengersAboard" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "flightMsSinceLeave" INTEGER NOT NULL DEFAULT 0,
    "lastLeaveStationId" TEXT,
    "lastLeaveAt" TIMESTAMP(3),
    "lastCrewDockedAtMs" BIGINT,
    "crewPayoutSinceDock" BOOLEAN NOT NULL DEFAULT false,
    "lastCrewPayoutAtMs" BIGINT,

    CONSTRAINT "Spaceship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewShoreLeave" (
    "spaceshipId" UUID NOT NULL,
    "stationId" TEXT NOT NULL,
    "lastLeaveAtMs" BIGINT NOT NULL,

    CONSTRAINT "CrewShoreLeave_pkey" PRIMARY KEY ("spaceshipId","stationId")
);

-- CreateTable
CREATE TABLE "ShipComponentRecord" (
    "id" UUID NOT NULL,
    "spaceshipId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "healthPct" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipComponentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeTransaction" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerMission" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "missionId" TEXT NOT NULL,
    "originStationId" TEXT NOT NULL,
    "offer" JSONB NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerMission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionCooldown" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "originStationId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3),

    CONSTRAINT "MissionCooldown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompletedMission" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "missionId" TEXT NOT NULL,
    "factionId" TEXT NOT NULL DEFAULT 'independent',
    "rewardCredits" INTEGER NOT NULL,
    "reputationChange" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompletedMission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbandonedMission" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "missionId" TEXT NOT NULL,
    "originStationId" TEXT NOT NULL,
    "factionId" TEXT NOT NULL,
    "missionType" TEXT NOT NULL,
    "reputationLoss" INTEGER NOT NULL,
    "hostageMinutes" INTEGER NOT NULL DEFAULT 0,
    "hostageBerths" INTEGER NOT NULL DEFAULT 0,
    "originSystemH3" TEXT,
    "destinationStationId" TEXT,
    "destinationSystemH3" TEXT,
    "abandonedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "AbandonedMission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerReputation" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "factionId" TEXT NOT NULL,
    "standing" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerReputation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReputationLedger" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "missionId" TEXT,
    "reason" TEXT NOT NULL,
    "factionId" TEXT,
    "factionDelta" INTEGER NOT NULL DEFAULT 0,
    "alphaDelta" INTEGER NOT NULL DEFAULT 0,
    "betaDelta" INTEGER NOT NULL DEFAULT 0,
    "gammaDelta" INTEGER NOT NULL DEFAULT 0,
    "bribePaidCredits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReputationLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargoLease" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "sessionId" BYTEA,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "lots" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CargoLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargoSale" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "nonce" BYTEA NOT NULL,
    "leaseId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "stationId" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "totalCredits" INTEGER NOT NULL,
    "crewShareCredits" INTEGER NOT NULL DEFAULT 0,
    "soldAtMs" BIGINT NOT NULL,
    "creditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CargoSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanetChart" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "planetId" TEXT NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "completedAtMs" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "surveyJson" JSONB NOT NULL,
    "soldAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanetChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemChart" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "systemH3" VARCHAR(15) NOT NULL,
    "totalBodiesCharted" INTEGER NOT NULL,
    "chartedAtMs" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "systemDigest" BYTEA,
    "soldAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_account" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestDevice" (
    "deviceHash" TEXT NOT NULL,
    "playerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestDevice_pkey" PRIMARY KEY ("deviceHash")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_email_key" ON "Player"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Player_callsign_key" ON "Player"("callsign");

-- CreateIndex
CREATE UNIQUE INDEX "Captain_playerId_key" ON "Captain"("playerId");

-- CreateIndex
CREATE INDEX "RetiredCaptain_playerId_activeDoctrine_idx" ON "RetiredCaptain"("playerId", "activeDoctrine");

-- CreateIndex
CREATE INDEX "RetiredCaptain_playerId_assignmentStatus_idx" ON "RetiredCaptain"("playerId", "assignmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "RetiredCaptain_playerId_receiptNonce_key" ON "RetiredCaptain"("playerId", "receiptNonce");

-- CreateIndex
CREATE INDEX "CrewMember_playerId_status_idx" ON "CrewMember"("playerId", "status");

-- CreateIndex
CREATE INDEX "CrewMember_spaceshipId_idx" ON "CrewMember"("spaceshipId");

-- CreateIndex
CREATE UNIQUE INDEX "SpaceHarbor_playerId_key" ON "SpaceHarbor"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "GameSession_playerId_key" ON "GameSession"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipComponentRecord_spaceshipId_type_key" ON "ShipComponentRecord"("spaceshipId", "type");

-- CreateIndex
CREATE INDEX "TradeTransaction_playerId_createdAt_idx" ON "TradeTransaction"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerMission_playerId_missionId_key" ON "PlayerMission"("playerId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "MissionCooldown_playerId_originStationId_key" ON "MissionCooldown"("playerId", "originStationId");

-- CreateIndex
CREATE INDEX "CompletedMission_playerId_completedAt_idx" ON "CompletedMission"("playerId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompletedMission_playerId_missionId_key" ON "CompletedMission"("playerId", "missionId");

-- CreateIndex
CREATE INDEX "AbandonedMission_playerId_abandonedAt_idx" ON "AbandonedMission"("playerId", "abandonedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbandonedMission_playerId_missionId_key" ON "AbandonedMission"("playerId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerReputation_playerId_factionId_key" ON "PlayerReputation"("playerId", "factionId");

-- CreateIndex
CREATE INDEX "ReputationLedger_playerId_createdAt_idx" ON "ReputationLedger"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CargoLease_playerId_generation_key" ON "CargoLease"("playerId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "CargoSale_nonce_key" ON "CargoSale"("nonce");

-- CreateIndex
CREATE INDEX "CargoSale_playerId_creditedAt_idx" ON "CargoSale"("playerId", "creditedAt");

-- CreateIndex
CREATE INDEX "PlanetChart_playerId_systemH3_idx" ON "PlanetChart"("playerId", "systemH3");

-- CreateIndex
CREATE UNIQUE INDEX "PlanetChart_playerId_planetId_key" ON "PlanetChart"("playerId", "planetId");

-- CreateIndex
CREATE INDEX "SystemChart_playerId_idx" ON "SystemChart"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemChart_playerId_systemH3_key" ON "SystemChart"("playerId", "systemH3");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");

-- CreateIndex
CREATE INDEX "auth_session_userId_idx" ON "auth_session"("userId");

-- CreateIndex
CREATE INDEX "auth_account_userId_idx" ON "auth_account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_account_providerId_accountId_key" ON "auth_account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "GuestDevice_playerId_key" ON "GuestDevice"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- AddForeignKey
ALTER TABLE "Captain" ADD CONSTRAINT "Captain_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetiredCaptain" ADD CONSTRAINT "RetiredCaptain_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_spaceshipId_fkey" FOREIGN KEY ("spaceshipId") REFERENCES "Spaceship"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceHarbor" ADD CONSTRAINT "SpaceHarbor_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Spaceship" ADD CONSTRAINT "Spaceship_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewShoreLeave" ADD CONSTRAINT "CrewShoreLeave_spaceshipId_fkey" FOREIGN KEY ("spaceshipId") REFERENCES "Spaceship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipComponentRecord" ADD CONSTRAINT "ShipComponentRecord_spaceshipId_fkey" FOREIGN KEY ("spaceshipId") REFERENCES "Spaceship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeTransaction" ADD CONSTRAINT "TradeTransaction_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerMission" ADD CONSTRAINT "PlayerMission_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionCooldown" ADD CONSTRAINT "MissionCooldown_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompletedMission" ADD CONSTRAINT "CompletedMission_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbandonedMission" ADD CONSTRAINT "AbandonedMission_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerReputation" ADD CONSTRAINT "PlayerReputation_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReputationLedger" ADD CONSTRAINT "ReputationLedger_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoLease" ADD CONSTRAINT "CargoLease_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoSale" ADD CONSTRAINT "CargoSale_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanetChart" ADD CONSTRAINT "PlanetChart_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemChart" ADD CONSTRAINT "SystemChart_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestDevice" ADD CONSTRAINT "GuestDevice_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

