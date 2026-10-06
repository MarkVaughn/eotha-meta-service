# Eotha: `eotha-meta-service`

The **Eotha Meta-Game Service** (`eotha-meta-service`) is the core orchestration backend for Eotha. Built on **Node.js 24 (ESM)**, **Fastify**, and **Prisma (PostgreSQL/PostGIS)**, it provides user authentication, space harbor base persistence, game session allocation, and asymmetric cryptographic JWT token minting (via Ed25519) that the Rust-based Real-Time Simulation Engine (RTSE) verifies in-memory.

## Architecture & Features

- **Asymmetric Authentication (Ed25519 / EdDSA)**: Mints cryptographic JWT tokens signed by a private key. The public key is shared out-of-band with the Rust RTSE cluster for zero-latency local verification without database queries.
- **Better Auth identity layer**: [Better Auth](https://better-auth.com) owns users, sessions, linked accounts and the anonymous-guest flow inside this Fastify app and database. Its `user` is the existing `Player` model, so the player id stays the one stable identity across guest, email and (later) Apple/Google accounts. See [Authentication model](#authentication-model).
- **Dev Login (`GET /auth/dev-login`)**: Development-only (`NODE_ENV=development`; not routed otherwise). Creates or reuses a persisted pilot with the given callsign and mints the same Ed25519 token a normal login would, for rapid CLI and integration testing.
- **`NODE_ENV`**: Defaults to `production` when unset. `npm run dev` and `.env.example` set it to `development`, the only value that enables `/auth/dev-login`.
- **Fail-Closed Signing Keys**: The service refuses to start if `keys/private.pem` or `keys/public.pem` is missing (there is no fallback secret). `KEYS_DIR` overrides the `keys/` directory.
- **Password Hashing**: argon2id. Legacy unsalted SHA-256 hashes still verify and are upgraded to argon2id on the next successful login.
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
│   └── schema.prisma           # Database schema (PostgreSQL + PostGIS)
├── scripts/
│   └── generate-keys.js        # Ed25519 keypair generation utility
├── src/
│   ├── config/
│   │   ├── auth.js             # Device-id length constants
│   │   ├── env.js              # Environment validation via Zod
│   │   └── missions.js         # Mission offers, derived exactly as the RTSE derives them
│   ├── lib/
│   │   ├── attestation/        # Device-attestation verifier registry, Play Integrity policy
│   │   ├── auth.js             # Better Auth instance (Player as user, anonymous plugin)
│   │   ├── crmath.js           # Correctly rounded sin/cos/asin/atan2 (matches the RTSE's libm)
│   │   ├── fma.js              # Exactly rounded fused multiply-add
│   │   ├── h3geo.js            # Bit-compatible port of h3o's cell center and vertex arithmetic
│   │   ├── identity.js         # Guest -> linked player conversion
│   │   ├── procedural.js       # Port of the RTSE's procedural stations, nodes and names
│   │   └── refresh-tokens.js   # Refresh rotation with reuse detection
│   ├── plugins/
│   │   ├── attestation.js      # requireAttestation preHandler
│   │   ├── identity.js         # Wires Better Auth and refresh tokens into Fastify
│   │   ├── prisma.js           # Prisma client lifecycle plugin
│   │   └── security.js         # JWT plugin (Ed25519 / EdDSA), JWKS, key derivation
│   ├── routes/
│   │   ├── jwks.js             # GET /.well-known/jwks.json
│   │   ├── auth/
│   │   │   ├── index.js        # Guest, Register, Login, Refresh, Logout, Link, and Dev-Login routes
│   │   │   └── schema.js       # Fastify JSON request/response schemas
│   │   └── game/
│   │       ├── index.js        # Game session allocation routes
│   │       └── schema.js       # Session route schemas
│   └── app.js                  # Fastify server entry point
├── tests/
│   ├── fixtures/               # Offers and nodes the RTSE itself produced, and the Rust exporter
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
# BETTER_AUTH_URL=https://meta.example.com
# BETTER_AUTH_SECRET=  # defaults to a key derived from keys/private.pem
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
Tests run against a real PostgreSQL database through Prisma and sign with a throwaway Ed25519 keypair, so they need no `keys/` files. Use a dedicated database whose name ends in `_test` (the suite refuses to run against any other):
```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/eotha_meta_test?schema=public"
npx prisma db push
npm test
```

---

## API Endpoints

### Authentication & Meta
- `GET /health`
  - Health check endpoint returning `{ status: "healthy", service: "eotha-meta-service" }`.
- `GET /auth/dev-login`
  - Development only (`NODE_ENV=development`). Query parameters: `callsign` (default `DevPilot`), `latitude`, `longitude`, `h3` (default `8828308281fffff`).
  - Creates or reuses the pilot (and harbor) in the database; returns a signed Ed25519 JWT token, WebSocket gateway URL, and the pilot profile.
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

### Economy
- `POST /game/trade/sell` (Protected)
  - Sells `METAL` or `GAS` from the pilot's harbor stock. The stock decrement, trade record and credit increment commit together; a sale the stock cannot cover is refused with `409`.
- `POST /ship/upgrade` (Protected)
  - Raises a component tier. The credit cost (`TIER_UPGRADE_COST` in `src/config/components.js`, summed per tier step) is deducted in the same transaction as the tier change; insufficient credits return `402`. Guests are refused `HULL` upgrades with `403 guest_hull_locked` (see [Guest hull lock](#guest-hull-lock)).

### Missions
All Protected. See [Mission offers](#mission-offers).
- `GET /game/missions/available?stationId=...&systemH3=...`
  - The board at a station: `stationId` is the station's RTSE id (a UUID) and `systemH3` the Resolution 8 cell it sits in (`400` for anything else). Returns `{ offers, cooldown, passenger_capacity }`; offers fit the ship's passenger berths.
- `POST /game/missions/accept`
  - Body `{ missionId, offer }`. The offer must be exactly one this service derives for the window it names (`400` otherwise, `410` once expired, `409` if a mission is active or the station cooling down).
- `GET /game/missions/active`, `POST /game/missions/abandon`
- `POST /game/missions/complete`
  - Body `{ claim }`: the RTSE-signed completion claim; settles the payout once.

### Game Sessions
- `GET /game/session` (Protected)
  - Fetches the active game session and assigned RTSE host for the authenticated pilot.
- `POST /game/session` (Protected)
  - Allocates or updates an RTSE instance assignment for the authenticated pilot.

---

## Mission offers

The RTSE re-derives an accepted offer from the procedural content it names and signs a completion claim only for offers it would itself have generated, so the meta-service derives offers by the engine's rules (`src/config/missions.js`, `src/lib/procedural.js`; the engine's `simulation/missions/generator.rs` is authoritative): a station is identified by its RTSE UUID, a mission id is a UUID hashed from the destination's rank in the 30-minute window and the origin station, a passage of `d` systems with `b` passengers pays `1000 + 500d + 250b` credits with `300 000 d` ms allowed, destinations lie 1-3 systems out, and offers expire 30 minutes after the request. Passage and research offers both count as transport missions; travel is real flight at the ship's speed.

Offers are a pure function of (system, origin station, passenger berths, window), so `accept` regenerates what the client presents rather than storing boards. A ship is only ever offered passage for as many passengers as it has berths (1 to `min(berths, 4)`), so a Tier 1 ship (2 berths) is never shown a mission it cannot take.

What the meta-service chooses to *show* among the engine's valid offers differs from the engine's top three in two ways, both so that every shown offer authenticates and no pilot sees an empty board:
- A destination whose coordinates cannot be reproduced bit for bit is passed over for the next one. The engine compares an offer's destination latitude and longitude for exact equality, and its libm and ours can disagree in the last bit when a result is within about 0.01 ulp of a rounding tie (`MIN_ROUNDING_MARGIN` leaves a wide safety factor); pentagon systems and systems on an icosahedron face edge are never used. A survey of a node that shares its node cell with an earlier research-grade node of the same system is skipped as well, because the engine would authenticate it as that earlier node.
- If the engine's rule leaves a ship with berths nothing to carry passengers to (no usable station within 3 systems), it is shown surveys instead of an empty board.

`tests/fixtures/rtse-mission-vectors.json` holds nodes and offers generated by the engine itself (`tests/fixtures/rtse-mission-vectors.rs` regenerates it in an `eotha-rtse` checkout); `tests/mission-vectors.test.js` asserts this service reproduces them.

## Authentication model

**Identity.** `Player` is Better Auth's `user` (`callsign` is its `name`), so every table keyed by `playerId` keeps working. Better Auth's `session` and `account` models live in `auth_session` and `auth_account`; a guest is a player with `isAnonymous = true`, a placeholder email and the unusable password hash `!`, bound to its device through `GuestDevice` (only a SHA-256 of the device id is stored).

**Better Auth's HTTP handler is not mounted.** Every sign-in goes through the routes above so the attestation check cannot be bypassed; they drive Better Auth in-process. Passwords are verified by `src/lib/password.js` against `Player.passwordHash`, so existing players, their argon2id hashes and the legacy SHA-256 upgrade-on-login keep working unchanged; Better Auth's `emailAndPassword` is not enabled. Better Auth's `jwt` plugin is not used either: it keeps its own generated keys, while the RTSE needs tokens signed by the shared keypair with the existing claims.

**Tokens.**
- *Access token*: an EdDSA JWT signed with `keys/private.pem` carrying exactly the claims the RTSE validates today (`sub`, `callsign`, `home_h3`, `ship_attributes`, `iat`, `exp`). It is stateless and short-lived (`ACCESS_TOKEN_TTL_SECONDS`, default 15 minutes). The only change to the token is a `kid` header, so the RTSE can keep pinning `keys/public.pem` or later fetch `/.well-known/jwks.json`. `POST /ship/upgrade` re-signs claims but keeps the original `exp`, so only a refresh extends a login.
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

---

## RTSE Integration

1. The service signs JWTs using Ed25519 (`keys/private.pem`).
2. The corresponding public key (`keys/public.pem`) is mounted or configured in the Rust RTSE engine.
3. The RTSE engine verifies client JWT claims locally without issuing database lookups.
4. The same key is published at `/.well-known/jwks.json`, so the RTSE can later fetch it instead of pinning the PEM (not implemented in the RTSE yet).
