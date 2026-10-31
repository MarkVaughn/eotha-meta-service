# Eotha: `eotha-meta-service`

The **Eotha Meta-Game Service** (`eotha-meta-service`) is the core orchestration backend for Eotha. Built on **Node.js 24 (ESM)**, **Fastify**, and **Prisma (PostgreSQL/PostGIS)**, it provides user authentication, space harbor base persistence, game session allocation, and asymmetric cryptographic JWT token minting (via Ed25519) that the Rust-based Real-Time Simulation Engine (RTSE) verifies in-memory.

## Architecture & Features

- **Asymmetric Authentication (Ed25519 / EdDSA)**: Mints cryptographic JWT tokens signed by a private key. The public key is shared out-of-band with the Rust RTSE cluster for zero-latency local verification without database queries.
- **Better Auth identity layer**: [Better Auth](https://better-auth.com) owns users, sessions, linked accounts and the anonymous-guest flow inside this Fastify app and database. Its `user` is the existing `Player` model, so the player id stays the one stable identity across guest, email and (later) Apple/Google accounts. See [Authentication model](#authentication-model).
- **Dev Login (`GET /auth/dev-login`)**: Development-only (`NODE_ENV=development`; not routed otherwise). Creates or reuses a persisted pilot with the given callsign and mints the same Ed25519 token a normal login would, for rapid CLI and integration testing. A pilot created by dev login (and an existing dev pilot that has never been granted, holds 0 credits and has no upgraded components) receives `DEV_STARTING_CREDITS` (default 20,000) exactly once, recorded in `Player.devCreditsGrantedAt`, so ship upgrades can be bought; later logins never add more, and guests, linked and registered accounts never get it.
- **`NODE_ENV`**: Defaults to `production` when unset. `npm run dev` and `.env.example` set it to `development`, the only value that enables `/auth/dev-login`.
- **Fail-Closed Signing Keys**: The service refuses to start if `keys/private.pem` or `keys/public.pem` is missing (there is no fallback secret). `KEYS_DIR` overrides the `keys/` directory.
- **Separate engine claim key**: Engine-signed claims (mission offers and completion, planet and system charts, docked receipts, cargo manifests and sale records) are verified with a dedicated public key, `CLAIM_PUBLIC_KEY`, never with the login key in `keys/`. See [Engine claim key](#engine-claim-key).
- **Password Hashing**: argon2id. Legacy unsalted SHA-256 hashes still verify and are upgraded to argon2id on the next successful login.
- **Persisted cargo and ore sales**: Each pilot's hold is stored here and handed to the engine in a signed cargo lease; the engine's signed hold snapshots and sale records keep it current and turn a sale into real credits, each sale paid once. See [Cargo persistence and sales](#cargo-persistence-and-sales).
- **Geospatial Space Harbors**: Spatial anchor persistence for players using PostGIS and Uber H3 hexagonal spatial indexing.
- **Session Allocation**: Coordinates player assignment to internal RTSE simulation cluster instances.

---

## Directory Structure

```text
eotha-meta-service/
├── .github/
│   └── workflows/
│       └── ci.yml              # CI/CD workflow
├── keys/
│   ├── private.pem             # Ed25519 Private Key (gitignored)
│   └── public.pem              # Public Key (shared with Rust RTSE)
├── prisma/
│   ├── schema.prisma           # Database schema (PostgreSQL + PostGIS)
│   ├── migrations/             # Baseline migration (full schema as of the customs release) plus the additive migrations after it
│   └── sql/
│       └── player-mission-list.sql  # One-off step before db push on a single-mission database
├── scripts/
│   └── generate-keys.js        # Ed25519 keypair generation utility
├── src/
│   ├── config/
│   │   ├── auth.js             # Device-id length constants
│   │   ├── captain.js          # Captain leveling curve, XP table, trait catalog and prerequisites
│   │   ├── crew.js             # Crew constants, class and rank tables, signing bonuses, wage shares, quirk catalog Q01-Q20
│   │   ├── cargo.js            # Cargo lease rules (lot limit)
│   │   ├── dev.js              # Development-login starting credits
│   │   ├── docking.js          # Docked-receipt validity window and clock skew
│   │   ├── env.js              # Environment validation via Zod
│   │   ├── factions.js         # Faction ids, standing caps (clampStandingsWithCaps), Flying Colors rules
│   │   ├── missions.js         # Mission player rules (per-type limits, cooldown, abandon terms, late cutoff, payout cap, offer clock skew)
│   │   └── patterns.js         # Shapes of engine identifiers (H3 cells, station ids, UUIDs)
│   ├── lib/
│   │   ├── attestation/        # Device-attestation verifier registry, Play Integrity policy
│   │   ├── auth.js             # Better Auth instance (Player as user, anonymous plugin)
│   │   ├── captain.js          # Lazy captain creation, XP awards, captain view, the effect ids in force
│   │   ├── retirement.js       # RetiredCaptain snapshot and view
│   │   ├── cargo.js            # Verifies signed cargo manifests and sale records; the cargo fencing rule
│   │   ├── claim-key.js        # Loads the public key engine-signed claims verify against
│   │   ├── crew-generator.js   # The deterministic hiring board of a station and why a candidate is unavailable
│   │   ├── crew.js             # Active and standby crew, berth checks, the crew revenue share
│   │   ├── docked-receipt.js   # Verifies the engine's signed docked receipts
│   │   ├── hostage.js          # Hostage state of an abandoned passage: accrued penalty, drop-off place, base penalty
│   │   ├── identity.js         # Guest -> linked player conversion
│   │   ├── mission-claim.js    # Verifies the engine's signed mission completion claims
│   │   ├── mission-offer.js    # Verifies the engine's signed mission offers
│   │   ├── refresh-tokens.js   # Refresh rotation with reuse detection
│   │   ├── reputation.js       # Standings under the caps, the reputation ledger, the factions claim
│   │   └── ship.js             # Active ship under the player lock, loadout, token reissue
│   ├── plugins/
│   │   ├── attestation.js      # requireAttestation preHandler
│   │   ├── claim-key.js        # Decorates the claim verification key, requireClaimKey preHandler
│   │   ├── identity.js         # Wires Better Auth and refresh tokens into Fastify
│   │   ├── prisma.js           # Prisma client lifecycle plugin
│   │   └── security.js         # JWT plugin (Ed25519 / EdDSA), JWKS, key derivation
│   ├── routes/
│   │   ├── jwks.js             # GET /.well-known/jwks.json
│   │   ├── auth/
│   │   │   ├── index.js        # Guest, Register, Login, Refresh, Logout, Link, and Dev-Login routes
│   │   │   └── schema.js       # Fastify JSON request/response schemas
│   │   └── game/
│   │       ├── captain.js      # Captain view and docked trait unlocks
│       ├── captain-retirement.js # Docked captain retirement, succession and Legacy Doctrines
│   │       ├── cargo.js        # Cargo lease, stored hold, manifest relay and ore sale routes
│   │       ├── crew.js         # Crew roster, hiring board, hire, dismiss, standby and activate
│   │       ├── factions.js     # Docked Flying Colors toggle and Paragon renouncement
│   │       ├── index.js        # Game session allocation routes
│   │       └── schema.js       # Session route schemas
│   └── app.js                  # Fastify server entry point
├── tests/
│   ├── helpers.js              # Test DB guard, throwaway keys, pilot factory
│   └── *.test.js               # Automated test suite (real PostgreSQL)
├── .env.example                # Sample environment configuration
├── package.json
└── README.md
```

---

## Quickstart

### 1. Prerequisites
- **Node.js 24+** (configured in `.nvmrc`)
- **PostgreSQL 15+** (required; the service does not start without a database)

### 2. Installation
```bash
npm install
```

### 3. Environment Configuration
Copy the sample environment file:
```bash
cp .env.example .env
```
Default configuration:
```ini
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/eotha_meta?schema=public"
PORT=3000
HOST="0.0.0.0"
# Optional (defaults shown): token and session lifetimes, Better Auth settings
# ACCESS_TOKEN_TTL_SECONDS=900
# REFRESH_TOKEN_TTL_DAYS=30
# SESSION_TTL_DAYS=90
# DEV_STARTING_CREDITS=20000  # one-time credits for a new /auth/dev-login pilot (development only)
# BETTER_AUTH_URL=https://meta.example.com
# BETTER_AUTH_SECRET=  # defaults to a key derived from keys/private.pem
# Public key that engine-signed claims verify against (see "Engine claim key")
# CLAIM_PUBLIC_KEY=    # 64 hex characters, the raw Ed25519 public key
# CLAIM_PUBLIC_KEY_FILE=  # alternatively a file holding that hex or a PEM public key
# Fixed ws:// or wss:// URL of the RTSE gateway handed to clients (see "Gateway address")
# GATEWAY_WS_URL=wss://gateway.example.com/session
# Private RTSE control-plane auth (see "Trusted penalty delivery"): a random 32+ character development
# credential, or comma-separated verified TLS client-certificate SHA-256 fingerprints in production
# INTERNAL_RTSE_CREDENTIAL=
# INTERNAL_RTSE_MTLS_FINGERPRINTS=
# Key id RTSE's enforcement-projection key ring associates with keys/public.pem
# ENFORCEMENT_ISSUER_KEY_ID=eotha-meta-service-v1
```

### 4. Generate Asymmetric Cryptographic Keys
Generate the Ed25519 keypair inside `./keys/`:
```bash
npm run keys:generate
```

### 5. Generate Prisma Client
```bash
npm run build
```

### 6. Run the Service
For local development with hot reload:
```bash
npm run dev
```
For production:
```bash
npm start
```

### 7. Run Test Suite
Tests run against a real PostgreSQL database through Prisma and sign with throwaway Ed25519 keypairs (a login key and a separate claim key), so they need no `keys/` files and no `CLAIM_PUBLIC_KEY`. Use a dedicated database whose name ends in `_test` (the suite refuses to run against any other):
```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/eotha_meta_test?schema=public"
npx prisma migrate deploy
npm test
```

### Database migrations
`prisma/migrations` builds a database from empty: `20261027000000_baseline` creates the whole schema as it stood before the customs release, and the later migrations apply on top of it. Create or update a database with:
```bash
npx prisma migrate deploy
```
`npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` exits 0 when the database matches `schema.prisma`.

**An environment already built with `prisma db push`** has the baseline's tables but no migration history, so `migrate deploy` would try to create them again. Mark the baseline as applied first, then deploy the rest:
```bash
npx prisma migrate resolve --applied 20261027000000_baseline
npx prisma migrate deploy
```
Run this against a database that already has the baseline's tables, as a `db push` from before the customs release does; the later migrations are idempotent, so a database that `db push` has since brought up to date is also safe. Never edit an applied migration; add a new one with `npx prisma migrate dev`.

---

## API Endpoints

### Authentication & Meta
- `GET /health`
  - Health check endpoint returning `{ status: "healthy", service: "eotha-meta-service" }`.
- `GET /auth/dev-login`
  - Development only (`NODE_ENV=development`). Grants the one-time `DEV_STARTING_CREDITS` to a dev pilot (see above). Query parameters: `callsign` (default `DevPilot`), `latitude`, `longitude`, `h3` (default `8828308281fffff`).
  - Creates or reuses the pilot (and harbor) in the database; returns a signed Ed25519 JWT token, the WebSocket gateway URL (`gateway_ws_url`, see [Gateway address](#gateway-address)), and the pilot profile.
- `POST /auth/register`
  - Registers a new player with an initial Space Harbor anchor coordinate and Uber H3 cell index.
- `POST /auth/guest` (attested)
  - Body `{ deviceId }` (a client-generated random id, 16-128 chars, kept in the device keychain). The first call from a device creates an anonymous player; later calls resume it. Returns `{ token, refreshToken, expiresIn, created, player }`. Once the guest has linked an account the device id is refused with `409 device_account_linked`; sign in with the account instead.
- `POST /auth/login` (attested)
  - Body `{ email, password, deviceId }`. `deviceId` (16-128 chars) is required because the attestation nonce is bound to it.
  - Validates credentials and returns `{ token, refreshToken, expiresIn, player }`.
- `POST /auth/refresh`
  - Body `{ refreshToken }`. Rotates the refresh token and returns a new access token. A token that was already rotated revokes its whole family (`401 refresh_token_reused`).
- `POST /auth/logout`
  - Body `{ refreshToken }`. Ends that login.
- `POST /auth/link/email` (Protected, guests only)
  - Body `{ email, password, callsign? }`. Links an email and password to the calling guest, keeping the player id, so nothing is lost and guest-only restrictions lift (see [Guest hull lock](#guest-hull-lock)). Returns a fresh access token.
- `GET /.well-known/jwks.json`
  - The Ed25519 public key as a JWK Set (`kid` is the RFC 7638 thumbprint, also set in every token header).

(attested) endpoints require `X-Attestation-Platform` (`play-integrity`, `app-attest` or `device-check`) and `X-Attestation-Token`; see [Device attestation](#device-attestation).

### Trusted penalty delivery (private)
- `POST /internal/v1/rtse/penalty-events`
  - Server-side delivery of an engine-signed `CustomsSeizureClaim` or `MiningViolationNotice`. Body is a protobuf `PenaltyDelivery` (`application/x-protobuf`); the response is a protobuf `PenaltyDeliveryAck` whose status is `APPLIED`, `DUPLICATE`, `RETRYABLE` or `REJECTED`. The ack is sent only after an idempotent, nonce-keyed settlement commits the consequences and the pilot's `authorityRevision` together; delivery is at-least-once, so redelivery answers `DUPLICATE`. An applied or duplicate ack carries a signed `EnforcementProjection`. A bad envelope or source proof is `REJECTED`, as is a validly signed claim the settlement refuses on its merits (such as a mission that cannot be inspected, reported as `KIND_PROOF_MISMATCH` because the contract has no closer reason); a missing pilot or a settlement that failed before commit is `RETRYABLE`. The contracts (`PenaltyDelivery`, `PenaltyDeliveryAck`, `EnforcementProjection`) are in eotha-contracts (`internal/v1/penalty_delivery.proto`). The client relay endpoints (`POST /game/missions/seizure`, `POST /game/factions/mining-violation`) remain during migration.
- `GET /internal/v1/rtse/players/:pilotId/authority`
  - The pilot's current signed `EnforcementProjection` (protobuf), for RTSE session updates and strict reconnect admission; `404 PILOT_NOT_FOUND` for an unknown pilot.
  - Both routes require workload identity: the `X-Eotha-Workload-Credential` header matching `INTERNAL_RTSE_CREDENTIAL`, or a verified mTLS client certificate whose SHA-256 fingerprint is in `INTERNAL_RTSE_MTLS_FINGERPRINTS`. A player `Authorization: Bearer` token is always refused with `401 WORKLOAD_CREDENTIAL_REQUIRED`. Source proofs verify against `CLAIM_PUBLIC_KEY`. Login JWTs carry an `authority_revision` claim; RTSE admits a reconnect only at the pilot's current revision, so an older token cannot bypass a penalty.
- `GET /ready`
  - `200 { status: "ready", checks }` when the database, claim key and internal workload credential are all available, otherwise `503 { status: "not_ready", checks }`. `GET /health` only reports that the process is reachable.

### Economy
- `POST /game/trade/sell` (Protected)
  - Sells `METAL` or `GAS` from the pilot's harbor stock. The stock decrement, trade record and credit increment commit together; a sale the stock cannot cover is refused with `409`.
- `POST /ship/upgrade` (Protected)
  - Body `{ componentType, targetTier, dockedReceipt }`. Raises a component tier, but only for a pilot the engine has vouched is docked (see [Docked upgrades](#docked-upgrades)): without a valid `dockedReceipt` it answers `403` with `docked_receipt_required`, `docked_receipt_invalid` or `docked_receipt_expired`, and `503 CLAIM_KEY_NOT_CONFIGURED` when no claim public key is configured. The credit cost (`TIER_UPGRADE_COST` in `src/config/components.js`, summed per tier step) is deducted in the same transaction as the tier change; insufficient credits return `402`. Guests are refused `HULL` upgrades with `403 guest_hull_locked` (see [Guest hull lock](#guest-hull-lock)).

- `POST /ship/repair` (Protected)
  - Body `{ dockedReceipt, componentTypes? }`. Restores every damaged component (or only `componentTypes`) to 100 % `healthPct` for 5 credits per missing point, while docked (the same receipt rules as upgrades, plus the station lockout in [Customs](#customs)). Returns the loadout with `cost`, `credits`, `repaired: [{ type, healthBefore, cost }]` and a re-signed `token`; `409 nothing_to_repair`, `402` when the balance cannot cover the cost (nothing is charged), `403 station_locked_out`.

- `GET /ship/loadout` (Protected)
  - The active ship's components and `ship_attributes`, including `passengers_aboard` (see [Passengers aboard](#passengers-aboard)).
- `POST /ship/dev/passengers` (Protected, **development only**)
  - Body `{ passengersAboard }`. A testing aid, not a game feature (passengers board when a mission is accepted): this sets the active ship's passenger count directly. It is registered only when `NODE_ENV` is not `production` (a production server answers `404`). A count above the ship's `passenger_capacity` is refused with `400 passengers_exceed_capacity`; on success it returns the loadout and a re-signed `token` carrying the new count.

### Cargo
All Protected. See [Cargo persistence and sales](#cargo-persistence-and-sales).
- `POST /game/cargo/lease`
  - No body. Issues a new cargo lease, which fences every earlier one, and returns `{ token, cargo: { lease_id, generation, lots, used_m3 } }`: the stored hold and a re-signed access token carrying it in its `cargo` claim, to connect to the engine with. Call it before every new engine connection.
- `GET /game/cargo`
  - `{ lease_id, generation, lots, used_m3 }`: the stored hold, for display while no engine session is connected (`lease_id: null`, `generation: 0` and no lots before the first lease).
- `POST /game/cargo/manifest`
  - Body `{ manifest }`: an engine-signed `CargoManifest`. Returns `{ applied }`: `true` when it became the stored hold, `false` for a stale snapshot of the same session (nothing changes). `403 cargo_manifest_invalid` (bad signature, or another pilot's), `409 cargo_superseded`, `409 cargo_lease_unknown`, `503 CLAIM_KEY_NOT_CONFIGURED`.
- `POST /game/cargo/sell`
  - Body `{ saleRecord }`: an engine-signed `SaleRecord` (V3, lots carrying their provenance). Credits its `totalCredits`, less the [amnesty](#regulated-mining-and-ore-trade-factions-stage-f5) on poached ore sold at home and plus the active Quartermaster's [ore sale bonus](#crew), once and stores its `remaining` hold, in one transaction. Returns `{ credits, total_credits, grossCredits, crewShareCredits, netCredits, crewPayouts, lots, replayed }` and, with a Quartermaster aboard, `oreSaleBonusCredits`; `credits` is the new balance, `lots` the stored hold and `total_credits` the gross credited (the signed total and the bonus); the crew, active and on standby, take their [revenue share](#crew) of it, so the pilot is credited `netCredits = grossCredits - crewShareCredits` (`crewPayouts` lists each member's part). A replay of the same record answers `200` with the first sale's bonus and split (`oreSaleBonusCredits`, `grossCredits`, `crewShareCredits`, `netCredits`), the current balance and `replayed: true`, and pays nothing. With a docked receipt for the sale's station the answer also carries `amnestyCredits` and `domesticReputation` when non-zero (see [Regulated mining and ore trade](#regulated-mining-and-ore-trade-factions-stage-f5)). `403 docked_receipt_required` / `docked_receipt_wrong_station` (poached ore of a faction's system sold without a receipt for that very station), `403 sale_record_invalid`, `409 cargo_superseded` (the ore stays in the stored hold), `409 cargo_lease_unknown`, `409 credit_overflow` (nothing changes; the record stays creditable), `409 sale_nonce_conflict` (another pilot's sale already used the nonce), `503 CLAIM_KEY_NOT_CONFIGURED`.
- `POST /game/cargo/clear-export`
  - Body `{ dockedReceipt }`: a current docked receipt for a station of a faction's system. Pays the export toll on the stored ore mined in that system under that faction whose status is `DOMESTIC_OR_FREE` (mined legally, which the engine stamps under a permit or exemption) or `PERMITTED_UNDECLARED_EXPORT` (poached ore is left untouched), and marks it `EXPORT_CLEARED`; see [Regulated mining and ore trade](#regulated-mining-and-ore-trade-factions-stage-f5). Returns `{ success, system_h3, faction_id, cleared_lots, value_credits, toll_bp, toll_credits, credits, cargo, token }`, the cleared hold being a new cargo lease the token carries. `403 docked_receipt_required` / `docked_receipt_invalid` / `station_locked_out`, `409 export_not_regulated` (an independent dock), `409 nothing_to_clear`, `402 toll_unaffordable` (nothing changes).

### Missions
All Protected. See [Mission offers](#mission-offers).
- `GET /game/missions/cooldown?originId=<dock uuid>`
  - `{ active, remaining_ms, available_at_ms }`: whether the pilot's per-origin cooldown after a completion or abandon at that dock is still running. The board itself comes from the engine (`ClientFrame.mission_board_request`); this service builds none.
- `POST /game/missions/accept`
  - Body `{ offer, dockedReceipt }`: an engine-signed `MissionOffer` and a docked receipt at its origin. Returns `{ active, token }`, the `ActiveMission` and a re-signed token whose `passengers_aboard` includes the boarded passengers (plus `crew_morale` when a covert contract cost the [By-the-Book](#morale-seniority-and-crew-capabilities-phase-3) crew morale). Refusals, in the order they are checked: `403 mission_offer_invalid` (bad signature, or issued to another pilot), `410 mission_offer_expired`, `403 docked_receipt_required` / `docked_receipt_invalid` / `docked_receipt_expired` (as for upgrades), `403 not_docked_at_origin`, then `409 mission_already_active` (this mission is already held), `409 covert_mission_limit_reached` (one covert mission is already held, `limit: 1`), `409 mission_limit_reached` (with `type` and `limit`), `409 origin_on_cooldown` (with `remaining_ms`), `409 mission_already_completed`, `409 mission_abandoned` (the pilot abandoned this mission before) and `400 insufficient_berths` (with `available_berths`). `503 CLAIM_KEY_NOT_CONFIGURED` when no claim public key is configured. See [Mission offers](#mission-offers).
- `GET /game/missions/active`
  - `{ missions, limits, active, standings }`: every `ActiveMission` the pilot holds, oldest first; the most of each type a pilot may hold (`MISSION_LIMITS`, see [Missions held per type](#missions-held-per-type)); `active`, the oldest mission or `null`, kept for clients that hold one mission; and `standings`, the pilot's reputation by faction (see [Late completion, abandon and reputation](#late-completion-abandon-and-reputation)). `hostages` (present only while there are any) lists the passengers of abandoned passages still aboard, each the contract's `HostageState` (`mission_id`, `hostage_started_at_ms`, `accrued_penalty` as of `as_of_ms`, `required_berths`). A mission stored before offers were engine-signed (legacy id, no exact destination, or no signature) can never be claimed, so it is deleted on first read and listed in `cancelled_missions: [{ mission_id, reason: "format_changed", message }]` (the first also as `cancelled_mission`); nothing was charged.
- `POST /game/missions/abandon`
  - Body `{ missionId, dockedReceipt }`, the held mission to abandon; it may be left out while only one is held, and is otherwise refused with `400 mission_id_required`. `dockedReceipt` is optional and says where the ship is docked; abandoning is allowed docked or in flight. `404` when no such mission is held; a receipt is refused as for upgrades (`403 docked_receipt_invalid` / `docked_receipt_expired`, `503 CLAIM_KEY_NOT_CONFIGURED`) before anything changes. Returns `{ abandoned, mission_id, outcome, reputation_change, hostage?, standings, crew_morale?, docking?, departed_crew?, token }` (`mission_id`, `outcome`, `reputation_change` and `hostage` as in the contract's `MissionAbandonResponse`; `crew_morale` lists the crew who lost morale, see [Crew](#crew)). No payout; the reputation penalty and origin cooldown are in [Late completion, abandon and reputation](#late-completion-abandon-and-reputation). A passage abandoned away from its origin answers `MISSION_ABANDON_OUTCOME_HOSTAGE` with `reputation_change` 0: its passengers stay aboard until `POST /game/missions/disembark`.
- `POST /game/missions/disembark`
  - Body `{ missionId, dockedReceipt }`: the abandoned passage whose hostages to drop, and a docked receipt for the station or outpost where the pilot is docked. Charges the sponsoring faction the penalty in [Late completion, abandon and reputation](#late-completion-abandon-and-reputation), frees the hostages' berths and docks the crew as any receipt does. Returns `{ result, mission_id, place, base_penalty, time_penalty, hostage_minutes, reputation_change, standings, docking?, departed_crew?, token }` with `result` `DISEMBARK_RESULT_SUCCESS` and `place` a contract `DisembarkPlace`. A refusal changes nothing and carries the contract's `DisembarkResult` as `result`: `404` `DISEMBARK_RESULT_UNKNOWN_MISSION` (no such abandoned mission for the pilot), `409` `DISEMBARK_RESULT_NOT_HOSTAGE` (held, completed, cancelled in port or already disembarked), `403` `DISEMBARK_RESULT_RECEIPT_INVALID` / `DISEMBARK_RESULT_RECEIPT_EXPIRED` (also `code` `docked_receipt_required` when the receipt is missing), `503 CLAIM_KEY_NOT_CONFIGURED`. The contract defines the `DisembarkResult` enum but no request message, so the JSON body is this service's.
- `POST /game/missions/complete`
  - Body `{ claim }`: the RTSE-signed completion claim for one of the pilot's held missions (`claim.missionId`); settles the payout once, applies the signed reputation (with any [Flying Colors](#factions-1) bonus, which `reputation_change` includes), starts the origin's cooldown, awards captain XP and disembarks the mission's passengers. Returns `{ success, credits, payout, grossCredits, crewShareCredits, netCredits, crewPayouts, reputation_change, standings, xpGained, currentLevel, traitPointsAvailable, token }` (see [Captain progression](#captain-progression)); `payout` is the signed reward and any Smuggler bonus (`clandestineBonusCredits`, present when one was paid), which the crew, active and on standby, take their [revenue share](#crew) of, so the pilot is credited `netCredits` and `credits` is the new balance; `reputation_change` includes an active Diplomat's bonus. A claim completed after the deadline is still settled up to the late cutoff and refused beyond it with `400 mission_expired`; see [Late completion, abandon and reputation](#late-completion-abandon-and-reputation). `503 CLAIM_KEY_NOT_CONFIGURED` when no claim public key is configured; `403` when the signature does not verify against it. A gather claim also answers `400` when its cargo suffix is missing or misplaced, `409 cargo_superseded` / `409 cargo_lease_unknown`, and adds `lots` to the response; see [Gather completion](#gather-completion).

- `POST /game/missions/seizure`
  - Body `{ claim }`: the engine-signed `CustomsSeizureClaim`; see [Customs](#customs). Returns the capture's consequences and a re-signed `token`; a replay answers the first result with `replayed: true`.
- `GET /game/missions/lockouts`
  - `{ lockouts: [{ station_id, tier, until_ms, remaining_ms }] }`: the customs lockouts still running. `GET /game/missions/cooldown` also reports `locked_out: true` for a locked-out origin.

### Captain
All Protected. See [Captain progression](#captain-progression).
- `GET /game/captain`
  - `{ captain: { name, originType, innate?, level, xp, xpForLevel, xpForNextLevel, unlockedTraits, traitPoints, traitPointsAvailable, missionsCompleted } }` (`xpForNextLevel` is `null` at Level 10; `innate` is `{ crewClass, rank, quirkId }` for a captain promoted from the crew, plus `juryRig: { slots, selectedComponentTypes }` for an Engineer).
- `POST /game/captain/trait`
  - Body `{ traitId, dockedReceipt, stationId? }`. Spends one trait point on `traitId` while docked. Returns `{ captain, ship_attributes, token }`, the token re-signed with the new attributes. Refusals answer `{ error: <code>, message, ... }`: `403 docked_receipt_required` (no receipt, or an expired one), `403 docked_receipt_invalid`, `403 docked_receipt_wrong_station` (`stationId` sent and not the receipt's `dockedEntityId`), `409 trait_already_unlocked`, `400 prerequisite_not_met` (with `requiredPointsInBranch` and `currentPoints`), `409 no_trait_points` (with `traitPointsAvailable`), a schema `400` for an unknown trait, and `503 CLAIM_KEY_NOT_CONFIGURED`.
- `POST /game/captain/retire`, `POST /game/captain/doctrine`, `POST /game/captain/jury-rig`, `GET /game/captain/retired`
  - See [Retirement, succession and Legacy Doctrines](#retirement-succession-and-legacy-doctrines-phase-4).

### Crew
All Protected. See [Crew](#crew).
- `GET /game/crew`
  - `{ active, standby, limits }`: the crew aboard, the crew on Harbor Standby and `limits` (`hullTier`, `activeCrew`, `maxActiveCrew`, `passengerCapacity`, `passengersAboard`, `freeBerths`, `maxStandbyCrew`, `standbyTransferFeeCredits`).
- `POST /game/crew/board`
  - Body `{ dockedReceipt, stationId? }`, the same signed docking proof as hiring (`403 docked_receipt_required` / `docked_receipt_invalid` / `docked_receipt_wrong_station`; `503 CLAIM_KEY_NOT_CONFIGURED`). It replaces `GET /game/crew/board?stationId=`, which is gone (404): the receipt names the station and signs the faction that governs it. The docked station's four candidates for the current 30-minute window, the same for every pilot, with `stationId`, `stationFactionId` (the governing faction the receipt signs, `null` for an independent Free Port), `window` (`startsAt`, `expiresAt`), `credits` and, per candidate, the person, class, rank, home faction, the whole quirk (`quirk.summary` and the numeric `modifiers`), the class `effects`, `baseWageShareBp`, `effectiveWageShareBp`, `signingBonusCredits`, `hireable` and `unavailableReasons: [{ code, label, ... }]` (`INSUFFICIENT_FACTION_REP`, `INSUFFICIENT_CREDITS`, `CLASS_ALREADY_ACTIVE`, `HULL_CREW_CAP_REACHED`, `INSUFFICIENT_FREE_BERTHS`). The candidates are a pure function of the station and the window, and only what stops a pilot hiring them is the pilot's own; a candidate already on this pilot's roster (active or standby) is left out, so the others keep their places and fewer than four may show. `INSUFFICIENT_FACTION_REP` is judged against the pilot's standing with the station's governing faction, not the candidate's home faction (see Hiring terms below).
- `POST /game/crew/hire`
  - Body `{ candidateId, dockedReceipt, stationId? }`; the board hired from is the receipt's `dockedEntityId`. Pays the signing bonus and puts the candidate aboard in one transaction under the pilot's lock. Returns `{ crew, credits, ship_attributes, token }`. Refusals answer `{ error: <code>, message, ... }`: `403 docked_receipt_required` / `docked_receipt_invalid` / `docked_receipt_wrong_station`, `404 candidate_not_found` (not on the current board), `400 hull_crew_cap_reached` (with `maxCrew`), `400 insufficient_free_berths`, `409 candidate_already_hired` (that candidate is already on the roster; checked before the reasons below), `409 class_already_active`, `403 insufficient_faction_rep` (with `requiredScore`, `currentScore`), `402 insufficient_credits` (with `requiredCredits`); each carries the full `unavailableReasons`, and when several apply the first of those in that order is the `error`. `503 CLAIM_KEY_NOT_CONFIGURED`.
- `POST /game/crew/dismiss`
  - Body `{ crewId, dockedReceipt, stationId? }`. Lets a crew member go; the signing bonus is not refunded. Returns `{ dismissed, ship_attributes, token }`. `409 crew_locked_by_active_mission` while the pilot holds any mission; `404 crew_not_found`; receipt refusals as for hire.
- `POST /game/crew/standby`
  - Body as for dismiss. Moves an active crew member to Harbor Standby for 50 cr, freeing their berth and hull crew slot: `{ crew, credits, feeCredits, ship_attributes, token }`. The same `409` guards as dismiss, plus `409 standby_full` (two at most), `409 crew_not_active` and `402 insufficient_credits`.
- `POST /game/crew/activate`
  - Body as for dismiss. Brings a crew member back from Harbor Standby, free of charge, under the hire's hull, class and berth limits (`400 hull_crew_cap_reached`, `400 insufficient_free_berths`, `409 class_already_active`; `409 crew_not_on_standby`).
- `POST /game/crew/jury-rig`
  - Body `{ crewId, componentTypes, dockedReceipt, stationId? }`; selects an active Engineer's overdrive targets (see below). Novice/Adept/Master allow 0/1/2 distinct installed types from `ENGINES`, `ENERGY`, `RADAR`, `SHIELDS`; `[]` clears the selection. Requires the same verified docking proof as hiring and consumes that dock's ordinary fatigue/recovery. No component purchase, upgrade, downgrade or refund occurs. Returns `{ crew, credits, ship_attributes, token, docking? }`. Errors include `409 jury_rig_slots_exceeded`, `409 COMPONENT_NOT_INSTALLED` (T0/missing), `409 jury_rig_already_max_tier` (T5), `409 crew_not_engineer` / `crew_not_active`, `404 crew_not_found`, receipt `403`s, and schema `400` for duplicate or ineligible types.

### Factions
All Protected. See [Factions](#factions-1).
- `POST /game/factions/colors`
  - Body `{ factionId, dockedReceipt }`, `factionId` one of `alpha`, `beta`, `gamma`, or `null` to stop. Flies that faction's colors while docked; needs a standing of at least 500 with it. Returns `{ success, active_colors, factions, token }`, the token carrying the new `factions` claim. Refusals answer `{ error: <code>, message, ... }`: `403 docked_receipt_required` (no receipt, or an expired one), `403 docked_receipt_invalid`, `403 insufficient_reputation` (with `required: 500` and `current`), a schema `400` for any other faction or a missing `factionId`, and `503 CLAIM_KEY_NOT_CONFIGURED`.
- `POST /game/factions/renounce-paragon`
  - Body `{ currentParagonFactionId, dockedReceipt }`. While docked, lowers the pilot's Paragon standing (800 or more) with that faction to 799, freeing another faction to reach Paragon. Returns `{ success, <factionId>Score, factions, token }` (`gammaScore: 799` for `gamma`). Refusals as for colors, plus `409 not_paragon` (with `current`) when the standing is below 800.
- `GET /game/factions/mining-permits`
  - `{ permits: [{ system_h3, faction_id, expires_at_ms }] }`: the pilot's mining permits that still run.
- `POST /game/factions/mining-permit`
  - Body `{ hailReceipt }`: an engine-signed `StationHailReceipt` (`EOTHA_HAIL_RECEIPT_V1`) for a mining permit hail (`hailIntent` 2) at a faction's station, relayed within 60 s of `issuedAtMs`. No docking is needed. Sells a 2 hour permit for the receipt's system at the pilot's tier price and returns `{ success, replayed, permit, cost_credits, credits, factions, token }`; a permit that still runs is answered, uncharged, with `replayed: true`. `403 hail_receipt_invalid` / `hail_receipt_wrong_intent` / `hail_receipt_expired` / `permit_denied_hostile` / `station_locked_out`, `409 permit_not_required` (an independent system), `402 permit_unaffordable` (nothing changes).
- `POST /game/factions/mining-violation`
  - Body `{ notice }`: an engine-signed `MiningViolationNotice` (`EOTHA_MINING_VIOLATION_V1`). See [Regulated mining and ore trade](#regulated-mining-and-ore-trade-factions-stage-f5). Returns `{ success, replayed, faction_id, system_h3, reputation_change, flagged_until_ms, credits, standings, factions, token }`. `403 mining_violation_invalid`.

### Game Sessions
- `GET /game/session` (Protected)
  - Fetches the active game session and assigned RTSE host for the authenticated pilot.
- `POST /game/session` (Protected)
  - Allocates or updates an RTSE instance assignment for the authenticated pilot. Without a `rtseHost` in the body, the host is chosen as described in [Gateway address](#gateway-address).

### Gateway address

`/auth/dev-login` returns the gateway WebSocket address as `gateway_ws_url`, and `POST /game/session` defaults `rtseHost` to a gateway host. Both come from configuration, never from the request:

1. `GATEWAY_WS_URL`, when set, is returned as is (`rtseHost` is its host). Use it to pin a fixed staging or production host, e.g. `wss://gateway.example.com/session`.
2. Otherwise it is `ws://localhost:8080/session` (`rtseHost` `localhost:8080`), the local Minikube gateway port.

`GATEWAY_WS_URL` must be a `ws://` or `wss://` URL with a hostname, an optional port and an optional path, and no credentials (`user:pass@`), query or fragment. The service refuses to start with any other value. `POST /game/session` additionally honours an explicit `DEFAULT_RTSE_HOST` (ahead of `GATEWAY_WS_URL`), and a `rtseHost` in the request body always wins.

Forwarded headers (`x-forwarded-proto`, `x-forwarded-host`) and the `Host` header are ignored: a client can forge them, and the address is returned next to a signed token. Over an ngrok tunnel the dev client therefore derives the address itself: when the server returns a loopback address, its mobile mode builds `wss://<tunnel host>/session` from the tunnel base it already uses for `/auth` and `/game`. That only works when the tunnel fronts the cluster gateway, which routes `/auth` and `/game` to the meta-service and the `/session` WebSocket to the engine (`make gateway`, then `make tunnel-up` in eotha-kube).

---

## Mission offers

The engine is the only source of world data, so it alone decides which docks offer work and what: destinations, payout, time limit, berths, wording, mission id and expiry. While the pilot is docked it answers `ClientFrame.mission_board_request` with `MissionOffer`s it signs with its claim key (`EOTHA_MISSION_OFFER_V1` or `EOTHA_MISSION_OFFER_V2`, layouts in eotha-contracts `rtse/v1/mission.proto`), each bound to the pilot (`pilot_id`) and stamped `offered_at_ms`. The client relays one, with a fresh docked receipt, to `POST /game/missions/accept`. This service keeps no copy of the world: it checks identifiers for syntax only, and checks signatures and its own player rules.

`accept` checks, in order:
1. The offer's signature verifies against `CLAIM_PUBLIC_KEY` (`src/lib/mission-offer.js`) and `pilot_id` is the caller. Every field is signed, the coordinates as their exact IEEE-754 bits.
2. `offered_at_ms` is no more than 5 s ahead of this server's clock (`MAX_OFFER_FUTURE_SKEW_MS`) and `expires_at_ms` has not passed.
3. The docked receipt is valid, fresh and for the caller (as for upgrades, see [Docked upgrades](#docked-upgrades)), and its `dockedEntityId` and `systemH3` are the offer's `origin_station_id` and `origin_system_h3`.
4. Under the player's lock: the pilot does not already hold this mission, has no other covert mission when accepting a covert one, holds fewer than its type's limit (see [Missions held per type](#missions-held-per-type)), the origin is not cooling down, the mission was never completed, and the ship has `floor(passenger_capacity) - passengers_aboard` free berths for `required_berths`.

It then stores the offer (`accepted_at_ms` is never earlier than `offered_at_ms`) and boards its passengers. The offer is proto-JSON: snake_case fields, `type` as its enum name, `signature` as standard base64; zero-valued fields may be omitted and 64-bit integers may be strings. Fields the engine did not sign are dropped.

The engine verifies its own signature again when the pilot claims the mission, so `GET /game/missions/active` hands the offer back bit-exact. The JSON column moves some doubles by an ulp, so the coordinates are also stored as text (`exact_destination`) and restored from it.

A **gather** offer (`MISSION_TYPE_GATHER`: deliver a quantity of a rare ore to another dock) carries eight more signed fields, `resource_type`, `min_grade`, `quantity_m3`, `source_body_id`, `source_system_h3`, `source_node_h3`, `source_lat` and `source_lng`, appended to the payload for that type only; passage and research payloads are unchanged. The source coordinates are stored as text too (`exact_source`) and restored like the destination's. An offer of that type missing one of them never verifies.

A completion is settled from the engine-signed `MissionCompletionClaim`. Payout is capped at 125 % of the signed base `reward_credits`, plus the signed `clandestine_bonus_credits` for a clean covert completion only. Each (player, mission) is paid once, and a completion starts a 10-minute cooldown at the origin dock (`MISSION_COOLDOWN_MS`).

### Faction missions (V2)

Offer fields 30–36 are `visibility`, `archetype`, `opposed_faction_id`, `opposed_reputation_change`, `clandestine_bonus_credits`, `carries_contraband_or_operative`, and `required_flying_colors_faction_id`. Visibility and archetype accept the contracts' enum names or integer values. Nonzero visibility selects the V2 signing domain and suffix (after the gather suffix, if any). An unspecified/omitted visibility selects V1 only when all seven fields are zero/empty; unsigned V1/V2 mixtures are rejected. Previously held V1 missions keep their original signing rules and are not migrated or cancelled.

Completion claims accept camelCase `wasDetected`, `exposureScoreMilli` (0–100000), `opposedReputationChange` and `bribePaidCredits`, defaulting to zero/false. **The stored signed offer selects the claim version**, even for an overt V2 claim whose suffix is all zero. V1 claims cannot carry nonzero V2 fields. Meta trusts the engine's signed detection result: a clean covert claim has zero opposed harm, while a detected claim carries exactly the offer's opposed change. Overt claims have zero attribution fields. A nonzero `bribePaidCredits` (V2 claims only, for a covert mission that carries contraband or an operative) settles a bribed run: see [Customs](#customs).

The claim's signed `rewardCredits` already includes the clandestine bonus: settlement never adds it a second time. The one addition is an active Smuggler's (see [Crew](#crew)): a clean covert completion pays the offer's `clandestine_bonus_credits` at the Smuggler's rate rather than the base 25 %, and the extra credits are paid like the rest of the reward. Crew (active and standby) take their usual share of the entire signed payout, including the bonus. Sponsor reputation retains the Flying Colors bonus and caps. A detected covert completion also applies the signed opposed change to the offer's `opposed_faction_id`, softened by an active Diplomat and without a positive Flying Colors multiplier, in the same transaction as the payout. Sponsor and opposed changes to the three factions are capped together and recorded in one ledger entry. Ledger standing changes use `COMPLETE_COVERT_CLEAN` or `COMPLETE_COVERT_DETECTED`; overt/V1 completions retain `MISSION_COMPLETED`.

At most **one covert mission** may be held across all base types; the existing concurrent overt/V1 limits are unchanged. Login, refresh and every token reissue reconstruct the optional `active_mission` claim from that persisted covert mission. The engine expects snake_case Rust `ActiveMission` JSON: numeric enum values, numeric integer timestamps, and a 64-element signature byte array (not the API's base64 string). The exact signed coordinates are restored before encoding. Accepting or abandoning/completing an overt/V1 mission never replaces or clears covert tracking; abandoning/completing the covert mission omits the claim, which clears engine tracking. Reissues from old caller tokens cannot reintroduce a mission deleted from the database. Token reissues preserve the original expiry as before.

## Late completion, abandon and reputation

The pilot's **standing** with each faction is a `PlayerReputation` row (one per player and faction), an integer clamped to [-1000, 1000]; no row is neutral (0). A mission's reputation goes to its signed `faction_id`, or to `independent` when the offer has none. Every change is made in the transaction that settles or abandons the mission, under the player's lock, so it commits or rolls back with it. Standings with `alpha`, `beta` and `gamma` are also capped (see [Factions](#factions-1)).

**Late completion.** A claim completed after `deadline_ms` is not refused. The engine decays its pay and reputation by mission type and signs the result in the offer's claim layout (unchanged `EOTHA_MISSION_CLAIM_V1` for V1 and `EOTHA_MISSION_CLAIM_V2` for V2 passage and research claims, `EOTHA_MISSION_CLAIM_V3` for gather claims of either), and this service pays the signed `reward_credits` and applies the signed `reputation_change`, which may be negative. It accepts a claim up to the hard cutoff `deadline_ms + min(3 x duration_limit_ms, 24 h)` (`lateCutoffMs` in `src/config/missions.js`) and refuses one beyond it with `400 mission_expired`. A claim never gains more reputation than its offer (`400` otherwise). `CompletedMission` records the faction and the signed `reputationChange`.

**Abandon.** Abandoning pays nothing, costs reputation with the sponsoring faction and starts a cooldown at the mission's origin (`ABANDON_TERMS`). It is allowed while docked, from the port screen, as well as in flight:

| Type | Where | Reputation | Origin cooldown |
|---|---|---|---|
| Research | Docked or in flight | -8 | 15 min |
| Gather | Docked or in flight; the ore stays in the hold | -10 | 20 min |
| Passage | Docked at its origin (`dockedReceipt` at `origin_station_id` in `origin_system_h3`): the passengers step back off | -2 | 5 min |
| Passage | In flight or docked elsewhere: the passengers stay aboard as hostages | 0 at the abandon; the disembark charges it (see Hostages) | none |

An abandon cooldown never ends one already running at that dock sooner. Each abandon is an `AbandonedMission` row (unique per player and mission, with the type, faction, applied `reputationLoss` and `reason`: `in_port_origin`, `in_port_dock` or `in_flight`), and a mission the pilot abandoned is refused on a later accept with `409 mission_abandoned`, so the same offer cannot be taken and dropped again. With the cooldown and the cost of each abandon, accepting and abandoning cannot churn a dock's board for free. Every abandon answers `MISSION_ABANDON_OUTCOME_CANCELLED` except a passage abandoned away from its origin, which answers `MISSION_ABANDON_OUTCOME_HOSTAGE` (`reason` `in_flight` or `in_port_dock`).

**Hostages.** The passengers of a hostage passage stay in `passengers_aboard`, so their berths stay occupied across logout: no crew can be hired (`insufficient_free_berths`) and no mission needing those berths accepted until they are dropped. The `AbandonedMission` row keeps the state (`hostageBerths` above 0, `abandonedAt` the start, the origin system and the destination, which the drop-off place is judged against). While docked at any station or outpost the pilot drops them with `POST /game/missions/disembark` and a signed docked receipt; the sponsoring faction then loses reputation (recorded in the ledger as `HOSTAGE_DISEMBARKED`):

| Part | Amount |
|---|---|
| Base, docked at the mission's destination (station and system) | 10 |
| Base, docked at its origin | 12 |
| Base, docked anywhere else | 20 |
| Time, from the abandon to the disembark | 1 per 2 whole minutes (0.5 a minute), at most 60 |

The clock is the service's own and runs at that one rate whether or not the pilot is logged in; the contract's offline slowdown is not applied, since the service does not track presence. Only the hostages' berths are freed (other missions' passengers stay aboard), and the row records `hostageMinutes`, the `reputationLoss` applied and `reason` `hostage_returned`. A hostage state never expires on its own and no other action drops it.

`PlayerReputation`, `AbandonedMission` (and its hostage columns `hostageBerths`, `originSystemH3`, `destinationStationId` and `destinationSystemH3`, 0 or null on existing rows), `CompletedMission.factionId` and `reputationChange` (defaulting to `independent` and `0` on existing rows) and `MissionCooldown.availableAt` (null on existing rows, which keep ending 10 minutes after `completedAt`) are additions only, so existing databases pick them up with `npx prisma db push`.

## Factions

The three factions are `alpha`, `beta` and `gamma` (`FACTION_IDS` in `src/config/factions.js`). Every change to a standing with one of them is applied through `clampStandingsWithCaps(alpha, beta, gamma, previous)` together with the other two, in the same transaction under the pilot's lock:

1. Each standing is bounded to [-1000, 1000].
2. **Single Paragon**: at most one faction stands at 800 or above; while one does, the others are capped at 799.
3. **Rival cap**: `alpha` and `beta` are rivals. While one stands at 450 or above, the other is capped at 449. `gamma` has no rival.

When two factions contest a status, the one that already held it keeps it, so it is the rising standing that is capped. Standings with any other faction (`independent`, say) are only bounded.

**Flying Colors.** With a standing of 500 or more with a faction, a docked pilot may fly its colors (`POST /game/factions/colors`, stored as `Player.activeColorsFactionId`). A mission for that faction then gains 1.20 times its signed reputation, rounded (`withColorsBonus`; a loss is not multiplied), and `reputation_change` in the completion response is the change with that bonus. A standing change that leaves the flown faction below 500 stops flying its colors.

**Ledger.** Every standing change appends a `ReputationLedger` row: the `reason` (`MISSION_COMPLETED`, `COMPLETE_COVERT_CLEAN`, `COMPLETE_COVERT_DETECTED`, `MISSION_ABANDONED`, `RENOUNCE_PARAGON`, `DOMESTIC_ORE_SALE` or `MINING_VIOLATION`), the `missionId`, the faction the event was for and its `factionDelta`, and the `alphaDelta`, `betaDelta` and `gammaDelta` the caps produced. Rows are never updated.

**Token.** Every access token, minted or reissued, carries `factions: { alpha, beta, gamma, active_colors, mining_permits, active_lockouts, customs_flagged_until_ms, customs_flagged_faction_id }`: the three standings (0 without a row), the flown faction or `null`, the unexpired mining permits `{ system_h3: expires_at_ms }`, the lowercase ids of the stations whose customs lockout still runs, and, while a mining violation has the transponder flagged for inspection, when the flag ends (`customs_flagged_until_ms`, else 0) and the faction whose docks inspect the pilot (`customs_flagged_faction_id`, left out when several factions cited the pilot, which the engine reads as every faction). A lockout that ends first stays listed until the token is next reissued (the access token lives 15 minutes).

`Player.activeColorsFactionId` (null on existing rows) and `ReputationLedger` are additions only, so existing databases pick them up with `npx prisma db push`; existing standings are capped the next time one of them changes.

## Missions held per type

A pilot holds several missions at once, up to a limit per type in `MISSION_LIMITS` (`src/config/missions.js`):

| Type | Held at once |
|---|---|
| `MISSION_TYPE_PASSAGE` | 1 |
| `MISSION_TYPE_RESEARCH` | 3 |
| `MISSION_TYPE_GATHER` | 1 |

The types are independent, so one passage, three research and one gather mission can be held together. With one passage at a time, that passage owns its passengers; a held survey adds its one surveyor. `accept` counts the held missions of the offer's type under the player's lock, so concurrent accepts cannot pass the limit. Each held mission is a `PlayerMission` row, unique per (player, mission); its type is the signed offer's `type`. Complete and abandon address one mission by id. The per-origin cooldown is shared by all types.

A database created while a pilot could hold only one mission (`PlayerMission.playerId` unique) needs one step before `db push`, which would otherwise refuse to add the (player, mission) unique index without `--accept-data-loss`:
```bash
npx prisma db execute --file prisma/sql/player-mission-list.sql --schema prisma/schema.prisma
npx prisma db push
```
The script adds that index, which the existing rows (one per player) already satisfy, so `db push` only drops the old one and every row is kept. It is safe to run again and does nothing on a database without the table.

### Gather completion

A gather claim signs under `EOTHA_MISSION_CLAIM_V3` (no fallback to an older domain; a V2 offer's attribution suffix follows the cargo suffix) and also signs the pilot's cargo position and hold, each lot with its provenance (`originSystemH3`, `originFactionId`, `customsStatus`): `leaseId` and `sessionId` (lowercase hyphenated UUIDs of the 16 bytes), `cargoSeq` and `remaining` (the whole hold after the delivered ore left it, as `CargoLot`s; omitted when empty). The suffix is required exactly when the stored offer's signed `type` is GATHER and refused (400) on any other. In `POST /game/missions/complete`, after the mission and `CompletedMission` checks and in the same transaction as the payout, the claim goes through the cargo fencing rule (see [Cargo persistence and sales](#cargo-persistence-and-sales)): applied or already in the lineage, it pays, stores `remaining` as the hold and ends the mission; superseded (409 `cargo_superseded`) or naming no lease of the pilot's (409 `cargo_lease_unknown`), it changes nothing and the ore stays in the stored hold. A payout that would overflow the balance rolls the hold write back too. The response adds `lots`, the stored hold.

## Passengers aboard
Taking off takes 0.5 s longer per passenger, so the real-time engine needs the ship's manifest. Each ship stores its count in `Spaceship.passengersAboard` (integer, default `0`) and it travels as `ship_attributes.passengers_aboard` (`ShipAttributes.passengers_aboard`, field 19, in eotha-contracts `common/v1/ship.proto`): in the signed access token, in the `ship` of a dev-login response and in `GET /ship/loadout`, and it is recomputed whenever the token is minted or reissued.

The count never exceeds the berths the crew leave free, `ship_attributes.passenger_capacity - ship_attributes.crew_aboard` (capacity from the LIFE_SUPPORT tier; see [Crew](#crew)): the attributes clamp it on every read, and `POST /ship/upgrade` writes the clamped count back if a component change leaves it above the new capacity.

Passengers board when a passage or research mission is accepted (`passengers_aboard += required_berths`; a survey carries one surveyor, a gather none, and each counts against berth capacity like any passenger) and disembark when it is completed, abandoned at its origin (a survey or gather abandoned anywhere) or, for an abandoned passage, dropped by `POST /game/missions/disembark` (never below zero); each of those responses carries a re-signed token. `POST /ship/dev/passengers` sets the count directly for testing; it exists only outside production. Existing databases pick up the new column with `npx prisma db push`.

## Cargo persistence and sales

The pilot's hold lives here, not in the engine session, so it survives reconnects, and selling ore at a station pays real credits into `Player.credits`. The engine alone decides what is in the hold, each lot's grade and purity, and what a sale is worth: it signs every change with its claim key, and this service verifies those records and stores the newest hold its fencing rule admits. It never re-prices a sale or computes a hold by subtraction. The contract (`CargoLot`, `CargoManifest`, `SaleRecord` V2 and the `cargo` lease claim) is in eotha-contracts (`rtse/v1/cargo.proto`, `rtse/v1/simulation.proto` and its README, "Cargo lease claim").

**The lease.** Before every new engine connection the client calls `POST /game/cargo/lease`. Under the pilot's lock it adds a `CargoLease` row: the next `generation`, a fresh UUID `id` and a copy of the stored hold. That row is now the pilot's current lease, which fences every earlier one. The response's token is the presented access token re-signed (same `exp`, fresh `ship_attributes`) with one more claim, which the engine loads when a connection begins with it:

```json
"cargo": { "lease_id": "0b8b1c8e-5b0e-4c6e-9a53-3f4b2f0f6a11", "lots": [{ "resource_type": "TITANIUM", "units_milli": 12500, "grade": 4, "purity_bp": 8000 }] }
```

Tokens reissued for any other reason (upgrades, missions, dev passengers) drop `cargo`, so a stale hold is never loaded.

**The records.** The engine signs a `CargoManifest` (`EOTHA_CARGO_MANIFEST_V2`; the sale is `EOTHA_SALE_RECORD_V3`; both sign each lot's provenance, which the stored hold keeps as `origin_system_h3`, `origin_faction_id` and `customs_status` when set) (the whole hold, at most every 10 s while it changes and when a docking completes) and, on a sale, a `SaleRecord` whose `remaining` is the whole hold after it. Each carries its position `(lease_id, session_id, seq)`: the lease the session loaded, a random 16-byte id of the engine session, and a `seq` that strictly increases within that session. The client relays them in proto-JSON camelCase, with `leaseId` and `sessionId` as lowercase hyphenated UUID spellings of their 16 bytes, `nonce` and `signature` as standard base64, uint64s as numbers or decimal strings, and lots as `CargoLot` objects (`resourceType` 1 to 32 characters, `grade` 1 to 5, `purityBp` 0 to 10000, at most 32 lots):

```json
{
  "saleRecord": {
    "pilotId": "<JWT sub>",
    "stationId": "07070707-0707-4707-8707-070707070707",
    "items": [{ "resourceType": "TITANIUM", "unitsMilli": 12500, "grade": 4, "purityBp": 8000 }],
    "totalCredits": 720,
    "soldAtMs": 1791811012345,
    "nonce": "<base64, 16 bytes>",
    "leaseId": "0b8b1c8e-5b0e-4c6e-9a53-3f4b2f0f6a11",
    "sessionId": "5f2c0a9e-1d3b-4c7a-8e6f-0a1b2c3d4e5f",
    "seq": 8,
    "remaining": [],
    "signature": "<base64, 64 bytes>"
  }
}
```

The verifiers (`src/lib/cargo.js`) mirror the signing layouts and fixed vectors of eotha-contracts `scripts/check-cargo-manifest-vector.js` and `scripts/check-sale-record-vector.js`, and `tests/cargo.test.js` asserts this service reproduces both. No record expires on a clock; `issuedAtMs` and `soldAtMs` are informational.

**The rule** (`applyCargoWrite`). Every record passes it inside its transaction, under the pilot's lock:

| Outcome | When | Manifest | Sale |
|---|---|---|---|
| applied | The lease is the current one, its session is unbound or this one (the first applied write binds it), and `seq` is above the last applied | Stored: `{ applied: true }` | Credited, and `remaining` stored |
| in lineage | The lease's bound session is this one and it already applied a `seq` at or above this one | Nothing stored: `{ applied: false }` | Credited, nothing stored: the stored hold already lacks the ore |
| superseded | Anything else: a newer lease, another session on the lease, or a fenced lease that never reached this `seq` | `409 cargo_superseded` | `409 cargo_superseded`; the ore stays in the stored hold |
| unknown | The pilot has no lease with that id (another pilot's included) | `409 cargo_lease_unknown` | `409 cargo_lease_unknown` |

A sale is credited at most once, by its nonce (`CargoSale.nonce` is unique); the credit uses the same overflow guard as mission payouts. The client answers a `409 cargo_superseded` by flushing what it still holds, leasing again and reconnecting. A sale that never reached this service leaves the ore in the stored hold, which the next lease restores: the pilot keeps the ore or the credits, never both and never neither.

The hold belongs to the pilot (one active ship). A pilot with no lease has an empty hold, and session-only cargo from before this change is not imported. `CargoLease` and `CargoSale` are new tables, so existing databases pick them up with `npx prisma db push`, which only creates tables, indexes and foreign keys.

## Docked upgrades

Ship upgrades are offered only while docked, and the client cannot be trusted to say so. The engine therefore signs a short-lived **docked receipt** on request (`DockedReceipt` in eotha-contracts `rtse/v1/simulation.proto`), the client relays it in the `dockedReceipt` field of `POST /ship/upgrade`, and this service verifies it exactly as it verifies chart and mission claims: an Ed25519 signature over a domain-separated, length-prefixed payload, checked against `CLAIM_PUBLIC_KEY` (never the login key). The verifier is `src/lib/docked-receipt.js`; the layout and a fixed test vector are in the contracts repository (`scripts/check-docked-receipt-vector.js`), and `tests/docked-receipt.test.js` asserts this service reproduces it.

```json
{
  "componentType": "HULL",
  "targetTier": 2,
  "dockedReceipt": {
    "pilotId": "<JWT sub>",
    "dockedEntityId": "07070707-0707-4707-8707-070707070707",
    "systemH3": "8828308281fffff",
    "dockedAtMs": 1791811000000,
    "issuedAtMs": 1791811012345,
    "nonce": "<base64, 16 bytes>",
    "controllingFactionId": "",
    "signature": "<base64, 64 bytes>"
  }
}
```

`controllingFactionId` is the faction that governs the station's system, `alpha`, `beta` or `gamma`, or `""` for an independent system (`independent` is never a value). It is signed, so the hiring gate reads it from the engine, not from the client. The receipt is signed under `EOTHA_DOCKED_RECEIPT_V2`; a V1 receipt (the old domain, no faction) never verifies and is refused as `docked_receipt_invalid` rather than read as independent, and a receipt without the field, or with any other value, is a schema `400`.

`dockedEntityId` is the lowercase hyphenated UUID of the station or outpost (outposts count as docked); the signed bytes are its raw 16. A receipt of the wrong shape is a schema `400`. Otherwise the checks run before any transaction, so a refusal charges and changes nothing, and each answers `403` with a `code`:

| `code` | When |
|---|---|
| `docked_receipt_required` | No `dockedReceipt` in the body. |
| `docked_receipt_invalid` | `pilotId` is not the token's `sub`, or the signature does not verify against the claim key. |
| `docked_receipt_expired` | `issuedAtMs` is more than `DOCKED_RECEIPT_TTL_MS` (30 s) in the past or more than `DOCKED_RECEIPT_MAX_SKEW_MS` (5 s) in the future, or `dockedAtMs` is after `issuedAtMs`. The client should fetch a new receipt and retry once. |

Both constants are in `src/config/docking.js`; the age (`now - issuedAtMs`) is logged at debug level so clock drift shows up. Enforcement is hard, with no environment flag. A receipt is **not single-use**: it can serve several upgrades inside its window, and `nonce` is signed but not tracked, so the real bound on an upgrade after undocking is the 30 s window. This service does not check that the entity is a known station, because the engine is the only authority on what it can dock at. The docked check runs before the guest hull lock, so an undocked guest is told to dock first.

## Captain progression

Every pilot has one `Captain`. It is created at Level 1 (0 XP, no traits, named after the pilot) the first time the pilot logs in or its ship is next locked by any game route, so pilots from before captains need no backfill. `Captain` is a new table: existing databases pick it up with `npx prisma db push`, which only creates the table, its unique index and its foreign key.

**XP** is awarded only inside the transaction that records a verified engine-signed claim, so a replayed or concurrent duplicate, which that record refuses, earns nothing, and nothing the client sends sets it. Values are in `src/config/captain.js`:

| Source | XP |
|---|---|
| `POST /game/missions/complete`, passage | `100 + 40 x distance_hexes + 10 x required_berths` |
| research | `120 + 50 x distance_hexes` |
| gather | `150 + 60 x route`, the route (origin to source to destination) read from the signed `duration_limit_ms` (`route x 5 min + 5 min`) |
| any mission paid above its offer (the engine's speed bonus) | the above `x 1.25`, rounded down |
| `POST /game/charts/register-planet` | `35`, the first time the planet is registered |
| `POST /game/charts/claim-system` | `150`, once per system |

Those three responses add `xpGained`, `currentLevel` and `traitPointsAvailable` when XP is awarded. A late completion earns full XP; abandoning earns none.

**Levels** follow cumulative XP, `round_to_50(180 x (L - 1)^1.75)`: 0, 200, 600, 1250, 2050, 3000, 4150, 5400, 6850 and 8400 XP for Levels 1 to 10. Each level from 2 to 10 grants one trait point (9 in all).

**Traits** are 18, six per branch (Helmsman `H1`-`H6`, Astrogation `S1`-`S6`, Command `C1`-`C6`): three Tier I, two Tier II and one Tier III capstone. A Tier II trait needs 2 points already spent in its branch, a capstone 4. They are unlocked through `POST /game/captain/trait`, only with a valid docked receipt (see [Docked upgrades](#docked-upgrades)), under the pilot's lock, so a point is never spent twice. The ship traits are folded into `computeShipAttributes` and signed into every token from then on:

| Trait | Effect |
|---|---|
| `H1_TRIM_THRUSTERS` | `max_speed_mps x 1.08` (never above 343) |
| `H2_HARBOR_PILOT` | `docking_time_mult x 0.8` |
| `H3_BULKHEAD_PACKING` | `cargo_capacity_m3 x 1.15` |
| `H4_MODULAR_CABINS` | `passenger_capacity + 2` |
| `H6_FLEET_CAPTAIN` | hull subsystem budget `+ 1`, one more crew slot |
| `S1_LONG_BASELINE` | `radar_range_m` and `identification_range_m x 1.2` |
| `S2_PULSE_CYCLING` | `sensor_cooldown_mult x 0.85`, `sensor_range_m x 1.2` |
| `S3_RESONANCE_EAR` | `tuning_tolerance_hz + 25`, `extraction_rate_mult x 1.1` |
| `C3_COLD_RUNNING` | `stealth_rating + 0.15` |
| `C1_HARD_BARGAINER` | crew wage shares `x 0.85`, signing bonuses `x 0.75` |
| `C2_SHORE_CONTACTS` | new crew start with 10 more morale |

`docking_time_mult`, `extraction_rate_mult` and `tuning_tolerance_hz` (contracts `ShipAttributes` fields 21-23) are always signed, at `1.0`, `1.0` and `100` without traits. The other traits can be unlocked and count toward prerequisites, but their effects (payouts, mission slots and time limits, factions) belong to systems not built yet, so they change nothing today. The crew effects of `H6`, `C1` and `C2` are described under [Crew](#crew).

## Crew

A pilot hires up to one crew member per class (Pilot, Navigator, Science, Engineer, Chef, Doctor, Gunner, Quartermaster, Comms Officer, Diplomat, Smuggler) from the hiring board of the station it is docked at. Crew are `CrewMember` rows (`ACTIVE` aboard the active ship, or `STANDBY` with no ship) and everything is in `src/config/crew.js`.

- **Berths.** Every active crew member takes a life support berth: `ship_attributes.crew_aboard` (`ShipAttributes` field 24, merged in eotha-contracts; the plan's draft said 20) counts them and the free berths are `floor(passenger_capacity) - crew_aboard - passengers_aboard`. That is what mission accept, the dev passenger count and the crew routes check, so LIFE_SUPPORT Tier 1 to 5 now has `3, 6, 12, 22, 50` berths (it had `2, 5, 10, 20, 50`). Most active crew by hull tier: `1, 2, 3, 5, 7` (`H6_FLEET_CAPTAIN` adds one).
- **Board.** Four candidates per station per 30-minute window, seeded by `SHA256("crew_board_v1" || stationId || window_30m || slotIndex)` (window as a big-endian u64, slot as one byte), so every pilot sees the same people and refreshing cannot reroll them. Slot 3 is the hub specialist (Adept or Master only). Rank odds are 65/30/5 % (Novice/Adept/Master); the home faction is `alpha` 30 %, `beta` 30 %, `gamma` 20 %, `independent` 20 %; the quirk is one of Q01-Q20 with weights summing to 1000. A candidate the pilot cannot hire is still listed, with the reasons.
- **Hiring terms.** Rank sets the signing bonus (500 / 1500 / 4000 cr, non-refundable), the wage share (5 / 8 / 12 % of every payout) and the standing needed with the faction governing the station hired at, as its signed docked receipt names it, whatever the candidate's own home faction (-499 / -149 / +450). An independent Free Port has no faction to earn standing with: the pilot counts as neutral (0) there, so a Novice and an Adept are always hireable and a Master asks only for that 0, which unlocks the independent Masters no faction standing could. Quirks move the wage share and bonus (and `C1_HARD_BARGAINER` takes 15 % off wages and 25 % off bonuses, `C2_SHORE_CONTACTS` adds 10 starting morale), and a quirk's effect is shown on the board before hiring.
- **Revenue share.** Every payout the pilot is credited from a signed claim (`POST /game/missions/complete`, `POST /game/cargo/sell`, `POST /game/charts/sell`) is split under the pilot's lock: each crew member with morale above zero, active or on Harbor Standby, takes `floor(gross x effective wage share)`, all together at most 50 %, scaled down in proportion when they would ask for more. Standby crew take a share but still count for no berth or class effect. The responses carry `grossCredits`, `crewShareCredits`, `netCredits` and `crewPayouts`; the pilot's balance rises by `netCredits`.
- **Effects today.** Class modifiers act on `ship_attributes` through `computeShipAttributes` and scale with morale (Inspired x1.15, Nominal x1, Disgruntled x0.6, Mutinous 0), including quirk adjustments. An Adept or Master Engineer may overdrive 1 or 2 selected installed components by one effective operation tier while Nominal or better; this adds no hull budget. Morale, seniority, promotions, shore leave and the assigned capability bits are active (below). Chef and Doctor apply meta-service recovery/cooldown overrides. The expansion classes (rank Novice / Adept / Master, scaled by morale like the rest) are: **Quartermaster**, `cargo_capacity_m3` +10 / 17 / 25 % and +8 / 14 / 20 % on the credits of an ore sale (`POST /game/cargo/sell`); **Comms Officer**, `comms_range_m` +25 / 40 / 60 % and `covert_exposure_mult` -12 / 22 / 35 %; **Diplomat**, +15 / 25 / 35 % on a positive reputation gain and -15 / 25 / 40 % on the harm to the rival faction of a detected covert completion; **Smuggler**, the clean covert bonus paid at 32 / 40 / 50 % of the reward instead of 25 %. Their customs effects are described under [Customs](#customs). A promoted captain's innate class signs only the ship attribute effects, so these perks are not applied for it. Retirement is described under [Retirement, succession and Legacy Doctrines](#retirement-succession-and-legacy-doctrines-phase-4); the faction quirks that act on morale, XP, reputation and shore leave are described below, and the customs text of the rest remains future work.
- **Abuse guards.** Dismiss and standby are refused while any mission is held, so the crew cannot be fired just before a payout. Engineer departure never blocks on the loadout: effective operation falls to stored tiers without changing or removing installed components or refunding credits. Hire, dismiss, standby and activate all run under the pilot's lock, so berths, the class slot and credits are never over-spent.

`CrewMember` and `CargoSale.crewShareCredits` (default `0`, so a replayed sale reports its own split) are additions only, so existing databases pick them up with `npx prisma db push`. `CrewMember.sourceCandidateId` (the board candidate the member was hired as; null on existing rows, which never match a candidate) is likewise a nullable addition with no unique constraint, so plain `db push` applies it; a hire checks it under the pilot's lock.

### Morale, seniority and crew capabilities (phase 3)

Morale bands are Inspired (`85..100`, x1.15), Nominal (`50..84`, x1), Disgruntled (`25..49`, x0.6), Mutinous (`1..24`, x0), and Resigned (`0`). Quirks modify these rules: for example Eager gives no Disgruntled bonus, Perfectionist needs 88 for Inspired, and Good-Natured gains an extra morale point and loses one fewer. Captain Shore Contacts scales morale decay by 0.75. The roster includes `moraleBand`, `moraleMult`, `unutilizedStreak`, `seniorityXp`, `unpaidArrearsCredits`, `pendingStipendCredits`, promotion terms and capability availability.

**Engineer Jury-Rig Grid (final phase-3 rule).** Overdrive is effective operation, never a persisted upgrade or general hull subsystem budget. An Engineer's `juryRig` roster entry reports `selectedComponentTypes`, rank `slots` (Novice 0, Adept 1, Master 2), and `active`. Configure unique selections while verifiably docked using `/game/crew/jury-rig`; only **ENGINES, ENERGY, RADAR, SHIELDS** qualify. HULL, LIFE_SUPPORT, CARGO and all other categories are excluded. Selected installed T1..T4 components derive signed attributes at `min(storedTier + 1, 5)`; T0 means no component exists and is refused with `COMPONENT_NOT_INSTALLED`, while new T5 selections are refused as pointless. A later normal paid upgrade to T5 remains capped at T5, never T6. Stored tiers, health, upgrade prices and hull subsystem accounting remain unchanged. The default empty selection preserves existing ships' behavior. Morale below 50 or standby immediately disables overdrive but retains the Engineer's selection; reactivation/recovery restores it. Departure removes that Engineer's effects with **no loadout block, component removal, refund or persisted downgrade**, including legacy over-budget loadouts. Existing outstanding-mission dismiss/standby refusals remain in place.

Every unique mission completion, ore sale and chart sale evaluates utilization for active crew. Paid utilized crew gain 4 morale (up to 100, not the rested cap), reset their idle streak, and on missions earn the Captain's XP as Seniority XP (with quirk XP multipliers). Unused crew lose 6 morale per settlement after two grace settlements; Lazy and Ambitious adjust the grace/decay. Predicates are in `src/config/crew-morale.js`: Pilot distance >=1 hex; Navigator >=2 hexes/covert mission/system chart; Science research/chart; Engineer gather/ore/at least 80% subsystem use; Chef passengers/at least two active crew; Doctor passengers/covert; Gunner armed gather/ore; Quartermaster gather/ore; Comms Officer covert mission; Diplomat passage or a mission with a nonzero reputation change; Smuggler covert or `gamma` mission. Security, nebula and enforcement clauses cannot be evaluated without signed world data. Standby crew receive wages but no utilization or Seniority XP.

**Faction quirks (milestone 5A).** Four faction and core quirks now act on morale, Seniority XP, reputation and shore leave. A crew member's `homeFactionId` is a faction key or `independent`; a mission is *for* the faction named by its offer's `faction_id` (`independent` when it names none), and a covert mission is *against* the faction named by its `opposed_faction_id`. The governing faction of a dock is the `controllingFactionId` of its signed docked receipt (`''` is an independent system, the home space of `independent` crew). The mission completion response lists the quirk's effect as `quirkEffects` on the member's `crew_morale` entry.

- **`LOYALIST` (Faction Loyalist).** On a mission *for* its home faction a paid, utilized Loyalist gains 6 morale instead of 4, earns 40 % more Seniority XP, and an active working Loyalist (morale above 0) adds 10 % to the sponsor reputation gain the mission awards, together with a Diplomat's bonus (additive, and several Loyalists do not stack). On a covert mission *against* its home faction it loses 12 morale at completion, used or not, in place of the +4, and earns no extra XP or reputation. While such a mission is held its capabilities and resistances are signed off in `ship_attributes` (the loadout, roster and every reissued token), and they return when the mission is completed or abandoned. Abandoning a mission sponsored by its home faction costs it 8 morale, whether or not the pilot is docked. Its listed "+10% class modifiers" and "double leak risk" are not enforced: the latter waits for the customs stage.
- **`HOME_BOUND` (Home-Bound).** Shore leave at a dock governed by its home faction restores 25 morale at a station and 12 at an outpost, up to a rested cap of 86 (a Master Chef's 90 still applies); at any other dock it restores 8 and 2 up to the usual cap, and the flight leg that ends at such a dock counts 20 % longer towards fatigue. Every signed dock is still a station (see the shore-leave ruling above), so the outpost figures are dormant until receipts name dock kinds.
- **`PERFECTIONIST` (Perfectionist).** A mission completion that missed the speed bonus costs 8 morale, in addition to the usual settlement. The bonus is earned when the claim paid more than the offer's `reward_credits` (the signal that already doubles as the captain's speed-bonus XP); a clean covert mission's signed clandestine bonus is not counted towards it. A late completion paid less than the offer has missed it. Ore and chart sales are unaffected. Abandoning any mission also costs a working Perfectionist 8 morale.
- **`BY_THE_BOOK` (By-the-Book).** Accepting a covert contract (`POST /game/missions/accept`) costs every working By-the-Book crew member aboard 8 morale after the dock is applied; the accept response lists them as `crew_morale`. Overt contracts and refused accepts cost nothing.

The customs terms of the faction quirks that are not a flat share of the inspection odds (the high-security discount of `BY_THE_BOOK`, the high-security penalty of `SYNDICATE_TIES`, the Gunner terms) cannot be signed into a ship attribute and remain dormant; the rest act through `customs_evasion_mult` and `bribe_cost_mult` (see [Customs](#customs)).

The three payout routes accept optional `deferCrewPay: true`: the pilot receives all gross credits, each unpaid cut is added to that member's arrears and costs 25 morale. Utilized deferred crew get no +4. An optional signed `dockedReceipt` on those routes also consumes that dock, after settlement, so a flight that just paid out incurs no flight stipend. Invalid receipts are refused before settlement. Replays do not pay, change morale or consume another dock again.

- **`POST /game/crew/promote`**: `{ crewId, dockedReceipt, stationId? }`, same signed port proof as hiring. Novice -> Adept requires 1,500 cumulative Seniority XP and 800 cr; Adept -> Master requires 5,000 XP and 2,500 cr (quirks adjust fees). Wage share becomes 800/1200 bp. Mutinous or Resigned crew refuse, and Masters cannot promote again. XP is not spent. Standby members may train too. The response includes `crew`, `credits`, `feeCredits`, `ship_attributes` and the updated token.
- **`POST /game/crew/pay-arrears`**: `{ crewId? }` pays one member or the eligible active/standby roster atomically, clears debt, restores 15 morale up to the rested cap, and returns `paid`, `paidCredits`, `credits` and updated attributes/token. Normally no receipt is needed. A morale-zero member instead requires a **new** signed `dockedReceipt` (and optional matching `stationId`) and costs **2x unpaid arrears** to stay. Without a new receipt, bulk payment still pays non-resigned members and lists morale-zero members under `skipped` with `resignation_requires_new_dock`; requesting a specific resigned `crewId` without one returns `409`. Ordinary payout morale gains cannot reverse resignation. No debt returns `409 no_arrears`; insufficient credits returns `402` with no partial payment.
- **`POST /game/crew/shore-leave`**: `{ dockedReceipt, stationId?, payResignedArrears?: boolean }`. A fresh signed receipt must belong to this pilot and match an optional station id. Mission acceptance/abandonment also consume their verified dock receipts, and hiring/activation settle the previous leg against the old crew **before** the new member boards. These routes report applied `docking` outcomes, including fatigue and pending resignation. Each signed `dockedAtMs` consumes flight/recovery once; renewing the nonce/issue time cannot repeat those effects. Explicit shore leave may still resolve pending active/standby resignations at the already-consumed current dock, without repeating flight or recovery. The first receipt establishes the baseline. **Current captain ruling (A+C): every signed dock is treated as a station; time between consecutive receipts includes dwell/offline time but is capped at two hours per leg; resignation departures happen only on explicit shore leave.** Accurate undocked-only timing and an authoritative station/outpost distinction require future protocol changes; an unsigned client dock kind is never accepted.

Cumulative flight beyond 45 minutes costs 5 morale per completed 15-minute excess interval (60 minutes: one interval; 90: three). Station leave restores 15 morale up to 80 and resets accumulated flight, with a **15-minute per-station cooldown**. Visiting B does not bypass A's cooldown; a dock still advances the flight baseline when recovery is cooling down. Inspired morale is never lowered to the rested cap. An active Nominal-or-better Master Chef raises the cap to 90. Outpost +5/half-accumulator and Adept Chef +15/reset rules are implemented as pure policy, but intentionally unreachable until receipts identify dock kinds. Standby crew neither fatigue nor receive ordinary ship leave recovery, but their pending resignations are settled by explicit shore leave. Morale-zero members cannot activate until rescued, earn no wages/arrears, and cannot be revived by ordinary utilization or station recovery.

A counted flight **over** 60 minutes with no payouts settled assesses a 40/80/150 cr stipend per working active Novice/Adept/Master. Fatigue is applied first. Affordable stipends are paid for members who stay; otherwise the stipend becomes arrears and costs 25 morale. If fatigue exhausts a member on an implicit dock, the member remains aboard at zero efficiency with `resignationPending: true`, and any flight stipend is held as `pendingStipendCredits` rather than charged before the captain can choose. Implicit docks never delete resigned members or heal their morale. Explicit shore leave settles active **and standby** zero-morale members: they leave unless `payResignedArrears: true` authorizes an affordable rescue. Rescuing settles any pending stipend and costs 2x unpaid arrears; a failed/declined rescue charges no stipend to a departing member. A working FLAKY departure during that same mission acceptance refunds its just-assessed stipend. Rescue grants exactly one +15 morale gain (quirks still apply), not another station +15, using the current post-fatigue crew for the rested cap. The literal 2x debt formula is zero for zero arrears. Repeating the same receipt cannot repeat a rescue or recovery.

Payouts persist `lastCrewPayoutAtMs`; a timestamp strictly after the preceding signed dock and at/before the current signed dock waives that leg's stipend. A payout supplied together with the current dock also waives it. The old boolean remains only for additive deployment compatibility and is no longer authoritative. Accurate separation of a payout while still at the departure station from an in-flight payout remains impossible without a signed undock time; this timestamp rule uses the approved consecutive-receipt approximation.

The shore response includes updated crew, credits, token and a `docking` breakdown (`applied`, capped `flightMs`, raw `receiptGapMs`, `recovery`, member effects and `departed` ids). An old/same dock with no pending resignations returns `applied: false`. At 2 hours the bounded flight contributes five fatigue intervals, regardless of how much longer the signed receipt gap was.

An active Nominal-or-better Doctor shortens newly started completion cooldowns by 20/35/50% for Novice/Adept/Master. Already-running cooldowns never shorten, and a stored completion time still works for pre-phase-3 rows.

`ShipAttributes.ion_fog_shield_resist`, `node_interference_resist` and `crew_capability_flags` use the **merged contracts fields 25, 26, 27** (not the plan draft's colliding 24..26), and `covert_exposure_mult` field 28 (the Comms Officer's cut, `1.0` without one). Only the assigned bits are signed: Hot Cast-Off `0x01`, Cold Drift `0x02`, Coarse Grade Reveal `0x04`, Harmonic Auto-Trim `0x40`, Belt Clearance `0x80`; the contracts also assign Transponder Spoof `0x08` and Stealth Floor `0x10`, which no class signs while customs is dormant, and `0x20` is unassigned. Rank unlocks them, but all require morale >=50. Resistances are clamped to `0..1`; crew-less ships sign zeros. Engine enforcement is separate work and consumes only signed attributes.

**FLAKY phase-3 scope:** evaluated on **successful mission acceptance only**, as authorized by the captain. Active Q12 crew below 85 morale roll a 10% departure chance, deterministically seeded by SHA-256 of the UTF-8 concatenation `flaky_undock_v1 + crewId + dockedEntityId + decimal floor(nowMs / 900000)`. The first four digest bytes, unsigned big-endian, divided by 2^32, are compared with 0.10. Retrying/reconnecting within the window cannot reroll; departures persist in the same transaction and the response token loses their attributes. Shore leave itself never rolls. **Mining-only departures need a signed-undock contracts/engine followup**; no unsigned departure notification is trusted.

Deployment uses plain `npx prisma db push` (no migrations). Additions are `Spaceship.flightMsSinceLeave` (default 0), `lastLeaveStationId`/`lastLeaveAt` (nullable), `lastCrewDockedAtMs`/`lastCrewPayoutAtMs` (nullable), legacy `crewPayoutSinceDock` (default false), `CrewMember.pendingStipendCredits` (default 0), `CrewMember.juryRigComponentTypes` (JSON, default `[]`), and the per-ship/station `CrewShoreLeave` cooldown table. They preserve existing rows. Standby/dismiss during an outstanding mission still return the phase-2 `409`; replacing that refusal with a morale cost awaits a separate decision.

## Customs

Factions stage F4. The engine rolls customs inspections and signs their outcome; the meta-service applies what they cost. The design is `design-factions` §6 and `design-crew` §6.3.

**Bribed completion.** A V2 completion claim with `bribePaidCredits > 0` (accepted only for a covert mission whose offer `carries_contraband_or_operative`) settles as a saved mission. The bribe is deducted from the balance as the payout leaves it, so the claim is refused with `402 bribe_unaffordable` (the mission stays held, nothing changes) when `credits + net payout < bribe`. The Captain and crew earn full XP; the sponsor's reputation *gain* is 75 % of the signed one (`BRIBE_SAVED_REP_MULTIPLIER`; a late completion's loss is unchanged); the rival and the inspecting station lose nothing (the claim must sign `opposedReputationChange` 0); no clandestine bonus is paid (the engine signs none for a bribed run, and the Smuggler's rate does not apply) and no Flying Colors bonus (design-factions §4.3). The ledger row has reason `COMPLETE_BRIBED` and records `bribePaidCredits` (written even when no standing moved). The response adds `bribe_paid_credits`.

**Seizure.** `POST /game/missions/seizure` takes `{ claim }`, the engine's `CustomsSeizureClaim` in camelCase (`pilotId`, `stationEntityId`, `systemH3`, `controllingFactionId` (default `""`), `missionId` (default `""`), `inspectionOutcome` (3 SEIZED or 4 ARMED_BOARDING), `captureTier` (1 to 4), `exposureScoreMilli`, `seizedAtMs`, `nonce` (base64, 16 bytes), `signature` (base64, 64 bytes)), signed over the `EOTHA_CUSTOMS_SEIZURE_V1` payload (`src/lib/customs-seizure.js`; `tests/customs-seizure.test.js` checks the engine's fixed vector). `403` for another pilot's claim or a bad signature, `400` for a claim from the future (more than a minute ahead). Applied once per `(pilot, nonce)` (`CustomsSeizure`): a replay, or a concurrent copy, answers the first body with `replayed: true` and changes nothing.

| Tier | Fine (of the offer's reward) | Sponsor / station reputation loss (× the offer's reputation gain) | Morale (each working crew) | Components | Lockout |
| --- | --- | --- | --- | --- | --- |
| 1 | 15 % | 0.60 / 0.60 | -4 | none | none |
| 2 | 25 % | 0.80 / 1.00 | -8 | CARGO or COMMS -5 points | 15 min |
| 3 | 30 % | 0.80 / 1.20 | -12 | HULL and SHIELDS -15 to -25 | 30 min |
| 4 | 35 % | 1.00 / 1.50 | -18 | HULL, SHIELDS and WEAPONS -20 to -35; one crew member held 30 min | 30 min |

If the claim names a held mission it fails: the mission and its passengers are removed, it can never be accepted again (`409 mission_failed_inspection`), the pilot is fined (never more than the balance; the rest is reported as `fine_unpaid_credits`) and the sponsor and the faction governing the station (`controllingFactionId`) lose reputation (one combined ledger row, reason `CUSTOMS_CAUGHT`). A mission without `carries_contraband_or_operative` answers `409 mission_not_inspectable` and changes nothing. A claim naming no held mission still damages components, takes morale and locks the station out. The same holds for a further claim (new nonce) naming a mission that already has a seizure: no second fine, reputation loss or refund, and no more hostages freed. Only installed components are damaged, none below 10 %, and the pick and the damage depend only on the claim's nonce. Lockout and detention run from `seizedAtMs`, so holding a claim back does not shorten them; one that has already run out is not recorded. The engine confiscates the cargo itself and signs the lighter hold in its next manifest, so the stored cargo lease is not edited here; the response lists the contraband informationally.

**Lockout.** While a lockout stands, the pilot is refused (`403 station_locked_out`, with `until_ms` and `remaining_ms`) at that station: `POST /game/missions/accept` for an offer originating there, the mission board (`GET /game/missions/cooldown`), and every docked-receipt service with a receipt for it: `POST /ship/upgrade`, `POST /ship/repair`, crew (`/game/crew/*` with a receipt), cargo (`POST /game/cargo/sell`, by the station the sale record names, with or without a receipt), captain (`/game/captain/trait`, `retire`, `doctrine`, `jury-rig`), factions (`/game/factions/colors`, `renounce-paragon`) and charts (`POST /game/charts/sell`, by its `stationId`, with or without a receipt). Mission complete, abandon and disembark are never gated, so a lockout cannot strand a held mission or its hostages. Other stations and other pilots are unaffected. The engine does not enforce this; the meta-service does.

**Component health.** Each component carries `healthPct` (default 100; the upgrade route resets it). `computeShipAttributes` scales the attributes the component supplies by `healthPct / 100`: `max_hull_hp`; `max_shield_hp` and `shield_regen_rate`; `radar_range_m` and `identification_range_m`; `cargo_capacity_m3`; `stealth_rating`; `weapon_dps` and `weapon_range_m`; `energy_capacity` and `energy_regen_rate`; `comms_range_m`; `max_speed_mps`; `sensor_range_m`. Tiers, mass, berths and cooldown multipliers do not wear. Repair is 5 credits per missing point.

**Crew mitigation.** `ship_attributes` gains `customs_evasion_mult` (the engine multiplies both the inspection and the catch chance by it; 1.0 for no crew) and `bribe_cost_mult` (multiplies a bribe demand). `customs_evasion_mult = clamp(1 - Σ M_inspect + Σ L_leak, 0.25, 1.5)`: `M_inspect` is a working member's class term by rank (Doctor 0.12 / 0.18 / 0.25, Engineer 0.10 / 0.16 / 0.22, Navigator and Science 0.08 / 0.13 / 0.18, Pilot 0.05 / 0.08 / 0.12, Chef 0.05 / 0.08 / 0.10, Quartermaster 0.10 / 0.18 / 0.25, Comms Officer 0.10 / 0.18 / 0.28, Diplomat 0.12 / 0.20 / 0.30) times the morale multiplier, plus the flat quirk terms (Cool-Headed 0.05, Charming 0.08, Discreet 0.10, Syndicate Ties 0.15, Nervous Tell -0.06) and the Smuggler's Hold captain trait (0.18); a By-the-Book member contributes no class term. `L_leak` is 0.10 for a Disgruntled (25 to 49) and 0.25 for a Mutinous (1 to 24) member (+0.05 Nervous Tell, doubled for a Loyalist flying against its home faction), and 0 with a Discreet member, the Shadow Broker trait or a Nominal Master Chef aboard. `bribe_cost_mult = 1 - min(0.25, Σ η)` with `η` Doctor and Diplomat 0.05 / 0.10 / 0.15 and Smuggler 0.10 / 0.18 / 0.25 by rank, times the morale multiplier. A detained member (`detainedUntil` in the future) is aboard and keeps their berth but counts for none of it; `crew` listings show `detained` and `detainedUntil`.

**Interpreted values.** The design leaves these open and this service chose them: the Smuggler and the Doctor/Diplomat bribe discounts; that the class inspection terms hold for any payload (the payload specialities are not modelled); the 10 % damage floor; the deterministic damage and detainee picks; the combined ledger row when the sponsor is the governing faction; reputation losses figured on the offer's `reputation_change` (floored at 0) rather than the claim; that a seizure is applied on submission, not on the engine's clock (the 25 % light-injury chance of tier 3 and the 500 credit bail are not implemented); and that a seizure claim never relayed leaves the mission held (the engine refuses its completion); abandoning it first does not avoid the fine, since the abandon keeps the offer (`AbandonedMission.offer`, covert contraband missions only: a mission abandoned before this change has none, and a capture then only frees its hostages). A crew member customs hold cannot be dismissed, moved to standby or promoted to Captain until the hold ends (`409 crew_detained`).

**Schema.** `CrewMember.detainedUntil` (nullable), `AbandonedMission.offer` (nullable JSON), the new `CustomsSeizure` and `StationLockout` tables, `ReputationLedger.bribePaidCredits` (already present) and no other change: additions only. `prisma/migrations/20261028000000_customs_seizure/migration.sql` holds just this change as additive, idempotent (`IF NOT EXISTS`) SQL on top of the baseline (see Database migrations), and applies cleanly on a `db push`ed database too.

## Regulated mining and ore trade (Factions stage F5)

The engine knows where a ship mines and what the ore is; this service owns the wallet, the standings and the stored hold. Constants are in `src/config/regulation.js`; the design is `design-factions` §7. Systems of an `independent` faction need no permit, levy no toll and have no patrol.

**Standing tiers.** Paragon 800+, Trusted 450 to 799, Friendly 150 to 449, Neutral -149 to 149, Unfriendly -499 to -150, Hostile -749 to -500, Nemesis -750 and below.

**Mining permits.** A pilot who hails a faction's station within 500 m gets a signed hail receipt from the engine and redeems it with `POST /game/factions/mining-permit` (the receipt is checked for the pilot, signature, intent, and age: 60 s, 5 s of future skew; a customs lockout at that station refuses it). The price follows the standing with the faction governing the system, read under the pilot's lock: Paragon and Trusted 0, Friendly 150, Neutral 400, Unfriendly 900; Hostile and Nemesis are refused (`403 permit_denied_hostile`); flying the faction's colors is free. A permit lasts 2 hours (`SystemMiningPermit`, one per pilot and system) and is listed in the token's `factions.mining_permits`, which the engine reads. Each receipt is redeemed once, by its nonce (`MiningPermitRedemption`): a repeat of it, even after the permit has expired, is answered with its first result, uncharged; a new receipt for a permit that still runs renews it to 2 hours from then and charges the tier price again.

**Mining violations.** When a Patrol Alert fills, the engine signs a `MiningViolationNotice` and the client relays it with `POST /game/factions/mining-violation`. The faction governing the system takes 10 standing (through the usual caps, ledger reason `MINING_VIOLATION`) and the pilot's transponder is flagged for a mandatory customs inspection for an hour (`Player.customsFlaggedFactionId` / `customsFlaggedUntil`, the later of any running flag and an hour from now), signed into `factions.customs_flagged_until_ms` and `customs_flagged_faction_id`. A second faction citing the pilot while the first citation runs clears the faction (null), so the pilot is cited at every faction's docks until the hour ends. A notice never expires on a clock: its nonce is applied once (`MiningViolation`); a replay changes nothing and answers the first result with the current standings. A notice dated more than a minute ahead of this service's clock is refused. The alert meter itself lives in the engine; only the citation is persisted.

**Export toll.** `POST /game/cargo/clear-export` charges, on the stored ore mined in the dock's system under its governing faction with status `DOMESTIC_OR_FREE` or `PERMITTED_UNDECLARED_EXPORT` (poached ore is never cleared by the toll; the amnesty or seizure applies to it), a share of its baseline market value (`units x base price x purity x (1 + grade x 0.2)`, FERRITE 10, TITANIUM 25, others 10, computed exactly and rounded once): 12 % by default, 6 % Friendly, 3 % Trusted, none for a Paragon or a pilot flying the faction's colors. The cleared lots become `EXPORT_CLEARED` in a new cargo lease generation (the response's token carries it in `cargo`), so the engine session of the old lease cannot overwrite the paid clearance with its next record.

**Domestic sales and the amnesty.** The sale record signs each lot's provenance but not the station's system or faction, so those come from a docked receipt for the sale's own station. Ore mined in the station's system under its faction sold as `DOMESTIC_OR_FREE` earns the faction one standing per 50 units, at most 6 a sale; the part short of a point is kept in `PlayerReputation.domesticOreRemainder` and what a capped sale exceeds is dropped (ledger reason `DOMESTIC_ORE_SALE`, no crew or colors multiplier). `UNLICENSED_POACHED` ore (or any status this service does not know) sold at home is not seized: the permit the pilot should have bought plus a 10 % surcharge comes off the proceeds (Friendly 165, Neutral 440, Unfriendly 990; Hostile and Nemesis pay the Unfriendly price), never more than the proceeds, and nothing if the pilot holds a running permit for the system. The amnesty comes off before the Quartermaster bonus and the crew share. Poached ore of a faction's system sold without a docked receipt for that station is refused (`403 docked_receipt_required` / `docked_receipt_wrong_station`), so leaving the receipt out cannot dodge the fee; a replay of a credited sale needs none and answers the first sale's amnesty and standing.

**Schema.** `SystemMiningPermit`, `MiningPermitRedemption` and `MiningViolation` tables, `Player.customsFlaggedFactionId` / `customsFlaggedUntil`, `PlayerReputation.domesticOreRemainder`, `CargoSale.amnestyCredits` / `domesticReputation`: additions only. `prisma/migrations/20261029000000_mining_permits/migration.sql` is the same change as idempotent SQL, as for Customs; `20261029010000_mining_permit_redemptions` adds the redemption table.

## Retirement, succession and Legacy Doctrines (phase 4)

A captain retires while docked with `POST /game/captain/retire`, and a successor takes the seat at Level 1 with no traits. Everything is in `src/config/captain.js` and `src/routes/game/captain-retirement.js`.

**`RetiredCaptain`** is a new table (`npx prisma db push` creates it; the existing `Captain` columns for promoted crew were already there) and **nothing deletes a row** (`RETAIN_ALL_RETIRED_CAPTAINS`) but the account itself. It snapshots the captain as it left: name, origin and innate class, `finalLevel`, `finalXp`, `missionsCompleted`, `unlockedTraits`, `capstoneTraitId` (the Tier III trait held, if any), `factionStandingsSnapshot` `{ alpha, beta, gamma }`, `primaryFactionId` (the faction stood highest with, or `null` when none is above neutral), the station and system retired at, `assignmentStatus = "RETIRED_IDLE"` and a null `assignedSpaceshipId` (hooks for fleet features). Beyond the plan's columns it stores `receiptNonce`, unique per pilot, which keys retry safety (below). Standings themselves belong to the pilot and are not reset.

| Level | Tier | Fee | Doctrine |
|---|---|---|---|
| 1-7 | `EARLY_DISCHARGE` | 1,000 cr | none |
| 8-9 | `HONORS` | free | one Tier I slot |
| 10 | `MASTER` | free | one slot, Tier I or II |

The body is `{ successorType: "ACADEMY_RECRUIT" | "PROMOTED_CREW", successorCrewId?, successorName?, retirementTier?, legacyDoctrineId?, dockedReceipt, stationId? }`. `retirementTier`, when sent, must be the one the level qualifies for (`400 retirement_tier_mismatch` with `eligibleTier`); an early discharge must be named (`400 retirement_tier_required`), so a retried request can never discharge the new Level 1 captain by accident. The receipt is checked like a trait unlock's (`403 docked_receipt_required | _invalid | _wrong_station`), and a receipt for a dock older than the last the ship's crew settled at is `403 docked_receipt_stale`. A held mission refuses retirement (`409 captain_locked_by_active_mission`, the guard that keeps crew from being shed before a payout).

Everything commits together under the pilot's lock or not at all: the fee (a guarded decrement; `402 insufficient_credits` otherwise), the archive row, the successor, the crew leaving and the doctrine. **The docked receipt's nonce makes it idempotent**: the same receipt sent again (a lost response, a concurrent duplicate) answers `200` with `replayed: true`, the archived captain and a token for the pilot's current state, and changes and charges nothing.

**Successors.** `ACADEMY_RECRUIT` (the default name is `Academy Recruit`, or `successorName`) has no innate class. `PROMOTED_CREW` names `successorCrewId`, one of the pilot's own crew, active or on standby, who must be an Adept or Master (`400 insufficient_rank_for_promotion`) with morale of at least 80 (`400 insufficient_morale_for_promotion` with `minMorale` and `currentMorale`); an unknown or another pilot's id is `404 crew_not_found`. The member leaves the roster (its berth and wage share with it), and the Captain becomes `originType = "PROMOTED_CREW"` with `promotedFromCrewId`, `innateClass`, `innateRank` and the member's `quirkId` (the stored `Q01`-`Q20` id; the plan's names such as `COOL_HEADED` are the quirk `key`s). The innate class is signed into the ship attributes with the effects of that class at that rank at the Nominal morale band plus the quirk's additive class terms (so a Master Engineer with Cool-Headed adds `50 x 1.03` Hz of tuning tolerance), with no wage share, berth, capability bit or resistance. A promoted Engineer also keeps its Phase 3 overdrive, applied as described under [Engineer captains](#engineer-captains-overdrive) below. Any Master with the AMBITIOUS quirk (`Q11`) on the ship **or on standby** who is not the successor resigns at once and appears in the response's `resigned`.

The captain's own traits do not carry over; with them go their berths, crew slots and hull budget point. Crew already aboard stay even if the hull's new limit is lower.

**Legacy Doctrines.** An honors retirement unlocks one slot on its `RetiredCaptain`, a master retirement one that may hold a Tier II doctrine. Name `legacyDoctrineId` in the retire body to fill it and switch it on, or fill it later with `POST /game/captain/doctrine`. At most `MAX_ACTIVE_LEGACY_DOCTRINES = 2` distinct doctrines are active across the account, whoever commands; several retired captains holding the same doctrine count it once, for its effects and for the limit. A retirement naming a doctrine that is not already in force while two others are is `409 doctrine_limit_reached` and changes nothing; switch one off first.

| Doctrine (Tier I / II) | Effect | Applied |
|---|---|---|
| `LEGACY_XP_BOOST` / `_II` | `+10%` / `+20%` Captain XP (rounded down) | XP awards; crew Seniority XP follows the XP awarded |
| `LEGACY_DOCKING_SPEED` / `_II` | `docking_time_mult x 0.9` / `x 0.8` | signed ship attributes |
| `LEGACY_WAGE_CUT` / `_II` | crew wage shares `x 0.9` / `x 0.8` (the 2.5% floor holds) | revenue share and the roster |

- `POST /game/captain/doctrine`: `{ retiredCaptainId, active, legacyDoctrineId?, dockedReceipt, stationId? }` (docked like a trait unlock, since the signed attributes change). `legacyDoctrineId` fills an empty slot once (`409 doctrine_already_chosen` afterwards, `400 doctrine_tier_locked`, `409 no_doctrine_slot` after an early discharge); `active` switches the slot on (`409 doctrine_limit_reached` for a third distinct doctrine) or off. Another pilot's `retiredCaptainId` is `404 retired_captain_not_found`. Returns `{ retiredCaptain, activeDoctrineIds, ship_attributes, token }`.
- `POST /game/captain/jury-rig`: see [Engineer captains](#engineer-captains-overdrive).
- `GET /game/captain/retired`: the Hall of Command, `{ retiredCaptains, activeDoctrineIds, maxActiveDoctrines, doctrines }`, oldest first, with the doctrine catalog.

#### Engineer captains (overdrive)

A captain promoted from an Engineer overdrives components exactly as a crew Engineer does (the final Phase 3 rule above), at the innate rank: a **Master Engineer captain can overdrive 2 components**, an Adept 1. The captain is the Engineer: **the "+2" is two overdrive slots, each lifting one selected component one effective tier, not +2 tiers**. Everything else of the Phase 3 rule holds unchanged: only installed `ENGINES`, `ENERGY`, `RADAR` and `SHIELDS` qualify, a selected T1 to T4 component is signed at `min(storedTier + 1, 5)`, a T0 or missing one is `409 COMPONENT_NOT_INSTALLED`, a T5 one `409 jury_rig_already_max_tier`, and stored tiers, health, prices and the hull budget never change (the innate Engineer gives **no hull budget point**). A captain has no morale, so its overdrive is always on, as at the Nominal band the rest of its innate class uses. The Master Pilot keeps the merged Phase 3 terms (`+25%` speed, `-40%` docking time), and the other classes theirs.

- `POST /game/captain/jury-rig`: `{ componentTypes, dockedReceipt, stationId? }`, docked like a trait unlock; `[]` clears the selection and a new selection replaces the old. Refused with `409 captain_not_engineer`, `409 jury_rig_slots_exceeded` (with `slots`), `409 COMPONENT_NOT_INSTALLED`, `409 jury_rig_already_max_tier`, the receipt `403`s, and a schema `400` for duplicate, ineligible or more than two types. Returns `{ captain, ship_attributes, token }`, where `captain.innate.juryRig` is `{ slots, selectedComponentTypes }`.
- The selection is stored on `Captain.juryRigComponentTypes` (a new additive `Json` column, default `[]`) and is carried in the signed innate effect id, so login and every reissue sign it. A new captain, whether an Academy recruit or another promoted member, starts with none; a promoted crew Engineer's own selection leaves with it.
- If an Engineer crew member is aboard as well, the two selections are joined as a set: a component both pick is lifted one tier, never two.

Every response that changes state (retire, doctrine, captain jury-rig) carries `ship_attributes` and a `token` re-signed for the pilot as it now stands; login tokens include the active doctrines and the innate class too.

## Authentication model

**Identity.** `Player` is Better Auth's `user` (`callsign` is its `name`), so every table keyed by `playerId` keeps working. Better Auth's `session` and `account` models live in `auth_session` and `auth_account`; a guest is a player with `isAnonymous = true`, a placeholder email and the unusable password hash `!`, bound to its device through `GuestDevice` (only a SHA-256 of the device id is stored).

**Better Auth's HTTP handler is not mounted.** Every sign-in goes through the routes above so the attestation check cannot be bypassed; they drive Better Auth in-process. Passwords are verified by `src/lib/password.js` against `Player.passwordHash`, so existing players, their argon2id hashes and the legacy SHA-256 upgrade-on-login keep working unchanged; Better Auth's `emailAndPassword` is not enabled. Better Auth's `jwt` plugin is not used either: it keeps its own generated keys, while the RTSE needs tokens signed by the shared keypair with the existing claims.

**Tokens.**
- *Access token*: an EdDSA JWT signed with `keys/private.pem` carrying exactly the claims the RTSE validates today (`sub`, `callsign`, `home_h3`, `ship_attributes`, `factions`, `iat`, `exp`, plus optional `active_mission`; see [Factions](#factions-1) for `factions` and [Faction missions (V2)](#faction-missions-v2) for `active_mission`). `ship_attributes.hull_tier` (integer 1 to 5) is the tier of the pilot's HULL component, so the engine reads the hull tier directly instead of deriving it from `max_hull_hp`; it is recomputed with the other attributes whenever the token is minted or reissued (including after `POST /ship/upgrade`), and guests stay at 1 because they cannot upgrade the hull. `ship_attributes.passengers_aboard` is the persisted passenger count, bounded by `passenger_capacity` (see [Passengers aboard](#passengers-aboard)). It is stateless and short-lived (`ACCESS_TOKEN_TTL_SECONDS`, default 15 minutes). Tokens retain a `kid` header, so the RTSE can keep pinning `keys/public.pem` or later fetch `/.well-known/jwks.json`. `POST /ship/upgrade` re-signs claims but keeps the original `exp`, so only a refresh extends a login. A token from `POST /game/cargo/lease` also carries a `cargo` claim (see [Cargo persistence and sales](#cargo-persistence-and-sales)); no other token does.
- *Refresh token*: opaque, single-use, stored hashed. Every login creates a Better Auth session; that session's refresh tokens form the token family. Each refresh consumes the presented token and issues its successor. Presenting a consumed token means a copy exists, so the family is revoked and the Better Auth session deleted. A refresh also fails once the session expires (`SESSION_TTL_DAYS`, default 90) or is logged out. Better Auth has no built-in rotation or reuse detection, so this is implemented in `src/lib/refresh-tokens.js`.
- `/auth/dev-login` keeps minting its 24-hour token, because the dev client has no refresh flow.

**Linking.** `POST /auth/link/email` converts a guest in place (same id, `isAnonymous` becomes false). The conversion is a single guarded update, so concurrent link attempts cannot both win.

### Guest hull lock

Guests cannot upgrade the `HULL` component: `POST /ship/upgrade` refuses it with `403` and `{ "code": "guest_hull_locked" }`; nothing is charged or changed. Other components upgrade as usual. Whether a player is a guest is read server-side from the identity record (`Player.isAnonymous`) on every request, never from the token or the request body, and the access-token claims are unchanged, so the RTSE sees exactly what it did before. Linking an account (email today, Apple/Google later) keeps the same player id and lifts the lock immediately, even for tokens issued while the player was still a guest.

### Device attestation

> **Production sign-in is intentionally unavailable until real verifiers are wired.** Outside `NODE_ENV=development`, `POST /auth/guest` and `POST /auth/login` (including existing email/password players) are refused with `503 attestation_unavailable` until Play Integrity and App Attest verifiers and their credentials are registered. Wiring them is the first follow-up.

`POST /auth/guest` and `POST /auth/login` are guarded by `fastify.requireAttestation`. It is strict: when verification fails, or when no verifier is configured outside `NODE_ENV=development`, the request is refused (`403 attestation_failed` / `attestation_required`, or `503 attestation_unavailable` when unconfigured). There is no restricted-token fallback. In development with no verifier registered the check is skipped so local flows work.

Verifiers implement `{ platform, verify({ token, deviceId }) => { ok } }` (`src/lib/attestation/index.js`) and are registered with `fastify.attestation.register(...)` or the plugin's `verifiers` option. `createPlayIntegrityVerifier` implements the Play Integrity verdict policy (package name, `PLAY_RECOGNIZED`, `MEETS_DEVICE_INTEGRITY`, freshness, nonce = base64url SHA-256 of the device id); the Google call that decodes the token is injected as `decode`. **No verifier is registered by default**, so a deployment must register one before clients can sign in. App Attest / DeviceCheck verifiers are not written yet.

### Linking Apple and Google later

Nothing for Apple or Google is configured or registered today. The wiring is in place:

1. **Apple**: add `socialProviders: { apple: { clientId, clientSecret, appBundleIdentifier } }` to `createAuth` in `src/lib/auth.js` (credentials from env) and add an attested, authenticated route that calls `auth.api.linkSocialAccount` with the iOS `identityToken` for the calling player (`linkSocial`, not `signIn.social`, so the guest keeps its id; Better Auth's sign-in path would create a second user and delete the guest).
2. **Google**: the same with `socialProviders.google` and the Android ID token.
3. **Play Games**: Google's general ID token does not carry the Play Games `playerId`, so it needs a small Better Auth plugin that exchanges the `serverAuthCode`, reads `playerId` from `games/v1/players/me` and records an `account` with `providerId: 'play-games'` for the calling guest (rejecting an identity already linked to another player; the `(providerId, accountId)` unique key backs this up).

Whichever way the account row is created, the `databaseHooks.account.create.after` hook in `src/lib/auth.js` calls `linkExternalAccount`, which promotes the guest, lifting the hull lock. A returning player on a new device signs in with the provider identity instead of linking.

### Engine claim key

The RTSE signs mission offers, mission completion claims, planet charts, system charts, docked receipts, cargo manifests and sale records with its own Ed25519 key, and this service verifies them. That key pair is **not** the login key: the engine holds the private half (its `RTSE_EXPLORATION_SEED`, 32 bytes as hex) and this service is given only the public half.

- `CLAIM_PUBLIC_KEY`: the raw 32-byte Ed25519 public key as 64 hex characters.
- `CLAIM_PUBLIC_KEY_FILE`: optional path to a file holding the same hex or a PEM public key. If both are set they must name the same key, otherwise startup fails. An unreadable or malformed key also fails startup; a blank variable counts as unset.
- Startup logs `Engine claims are verified with Ed25519 key sha256:<16 hex>`, the fingerprint of the key in use, and never any key material.
- With neither set, startup logs a warning and `POST /game/missions/accept`, `POST /game/missions/complete`, `POST /game/missions/disembark`, `POST /game/charts/register-planet` `POST /game/charts/claim-system`, `POST /game/cargo/manifest`, `POST /game/cargo/sell` and `POST /ship/upgrade` answer `503 { "error": "CLAIM_KEY_NOT_CONFIGURED" }` instead of rejecting every claim as a bad signature.
- System charts are verified under `EOTHA_SYSTEM_CHART_V2`: `POST /game/charts/claim-system` requires `systemKey.systemDigest` (base64 of the 32-byte SHA-256 of the system's planet survey hashes, in planet id order) beside the signed fields, and the signature must cover it. V1 keys without a digest are refused.
- `keys/public.pem` is the login key and is never used to verify claims, so a claim signed with the login key is refused with `403`.

In the cluster the seed comes from the Secret `eotha-claim-key` (key `seed`) and the public key from the ConfigMap `eotha-claim-pubkey` (key `public_key`). To derive the public key from a seed locally without printing the seed:

```bash
node -e "const {createPrivateKey,createPublicKey}=require('node:crypto');const seed=Buffer.from(process.env.RTSE_EXPLORATION_SEED,'hex');const k=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});console.log(createPublicKey(k).export({format:'der',type:'spki'}).subarray(-32).toString('hex'))"
```

---

## RTSE Integration

1. The service signs JWTs using Ed25519 (`keys/private.pem`).
2. The corresponding public key (`keys/public.pem`) is mounted or configured in the Rust RTSE engine.
3. The RTSE engine verifies client JWT claims locally without issuing database lookups.
4. The same key is published at `/.well-known/jwks.json`, so the RTSE can later fetch it instead of pinning the PEM (not implemented in the RTSE yet).
5. In the other direction, the RTSE signs claims with a separate key whose public half is `CLAIM_PUBLIC_KEY` (see [Engine claim key](#engine-claim-key)).
