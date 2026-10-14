# Eotha: `eotha-meta-service`

The **Eotha Meta-Game Service** (`eotha-meta-service`) is the core orchestration backend for Eotha. Built on **Node.js 24 (ESM)**, **Fastify**, and **Prisma (PostgreSQL/PostGIS)**, it provides user authentication, space harbor base persistence, game session allocation, and asymmetric cryptographic JWT token minting (via Ed25519) that the Rust-based Real-Time Simulation Engine (RTSE) verifies in-memory.

## Architecture & Features

- **Asymmetric Authentication (Ed25519 / EdDSA)**: Mints cryptographic JWT tokens signed by a private key. The public key is shared out-of-band with the Rust RTSE cluster for zero-latency local verification without database queries.
- **Better Auth identity layer**: [Better Auth](https://better-auth.com) owns users, sessions, linked accounts and the anonymous-guest flow inside this Fastify app and database. Its `user` is the existing `Player` model, so the player id stays the one stable identity across guest, email and (later) Apple/Google accounts. See [Authentication model](#authentication-model).
- **Dev Login (`GET /auth/dev-login`)**: Development-only (`NODE_ENV=development`; not routed otherwise). Creates or reuses a persisted pilot with the given callsign and mints the same Ed25519 token a normal login would, for rapid CLI and integration testing. A pilot created by dev login (and an existing dev pilot that has never been granted, holds 0 credits and has no upgraded components) receives `DEV_STARTING_CREDITS` (default 20,000) exactly once, recorded in `Player.devCreditsGrantedAt`, so ship upgrades can be bought; later logins never add more, and guests, linked and registered accounts never get it.
- **`NODE_ENV`**: Defaults to `production` when unset. `npm run dev` and `.env.example` set it to `development`, the only value that enables `/auth/dev-login`.
- **Fail-Closed Signing Keys**: The service refuses to start if `keys/private.pem` or `keys/public.pem` is missing (there is no fallback secret). `KEYS_DIR` overrides the `keys/` directory.
- **Separate engine claim key**: Engine-signed claims (mission offers and completion, planet and system charts, docked receipts) are verified with a dedicated public key, `CLAIM_PUBLIC_KEY`, never with the login key in `keys/`. See [Engine claim key](#engine-claim-key).
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
│   │   ├── dev.js              # Development-login starting credits
│   │   ├── docking.js          # Docked-receipt validity window and clock skew
│   │   ├── env.js              # Environment validation via Zod
│   │   ├── missions.js         # Mission player rules (cooldown, payout cap, offer clock skew)
│   │   └── patterns.js         # Shapes of engine identifiers (H3 cells, station ids, UUIDs)
│   ├── lib/
│   │   ├── attestation/        # Device-attestation verifier registry, Play Integrity policy
│   │   ├── auth.js             # Better Auth instance (Player as user, anonymous plugin)
│   │   ├── claim-key.js        # Loads the public key engine-signed claims verify against
│   │   ├── docked-receipt.js   # Verifies the engine's signed docked receipts
│   │   ├── identity.js         # Guest -> linked player conversion
│   │   ├── mission-claim.js    # Verifies the engine's signed mission completion claims
│   │   ├── mission-offer.js    # Verifies the engine's signed mission offers
│   │   ├── refresh-tokens.js   # Refresh rotation with reuse detection
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
npx prisma db push
npm test
```

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

### Economy
- `POST /game/trade/sell` (Protected)
  - Sells `METAL` or `GAS` from the pilot's harbor stock. The stock decrement, trade record and credit increment commit together; a sale the stock cannot cover is refused with `409`.
- `POST /ship/upgrade` (Protected)
  - Body `{ componentType, targetTier, dockedReceipt }`. Raises a component tier, but only for a pilot the engine has vouched is docked (see [Docked upgrades](#docked-upgrades)): without a valid `dockedReceipt` it answers `403` with `docked_receipt_required`, `docked_receipt_invalid` or `docked_receipt_expired`, and `503 CLAIM_KEY_NOT_CONFIGURED` when no claim public key is configured. The credit cost (`TIER_UPGRADE_COST` in `src/config/components.js`, summed per tier step) is deducted in the same transaction as the tier change; insufficient credits return `402`. Guests are refused `HULL` upgrades with `403 guest_hull_locked` (see [Guest hull lock](#guest-hull-lock)).

- `GET /ship/loadout` (Protected)
  - The active ship's components and `ship_attributes`, including `passengers_aboard` (see [Passengers aboard](#passengers-aboard)).
- `POST /ship/dev/passengers` (Protected, **development only**)
  - Body `{ passengersAboard }`. A testing aid, not a game feature (passengers board when a mission is accepted): this sets the active ship's passenger count directly. It is registered only when `NODE_ENV` is not `production` (a production server answers `404`). A count above the ship's `passenger_capacity` is refused with `400 passengers_exceed_capacity`; on success it returns the loadout and a re-signed `token` carrying the new count.

### Missions
All Protected. See [Mission offers](#mission-offers).
- `GET /game/missions/cooldown?originId=<dock uuid>`
  - `{ active, remaining_ms, available_at_ms }`: whether the pilot's per-origin cooldown after a completion at that dock is still running. The board itself comes from the engine (`ClientFrame.mission_board_request`); this service builds none.
- `POST /game/missions/accept`
  - Body `{ offer, dockedReceipt }`: an engine-signed `MissionOffer` and a docked receipt at its origin. Returns `{ active, token }`, the `ActiveMission` and a re-signed token whose `passengers_aboard` includes the boarded passengers. Refusals, in the order they are checked: `403 mission_offer_invalid` (bad signature, or issued to another pilot), `410 mission_offer_expired`, `403 docked_receipt_required` / `docked_receipt_invalid` / `docked_receipt_expired` (as for upgrades), `403 not_docked_at_origin`, then `409 mission_active`, `409 origin_on_cooldown` (with `remaining_ms`), `409 mission_already_completed` and `400 insufficient_berths` (with `available_berths`). `503 CLAIM_KEY_NOT_CONFIGURED` when no claim public key is configured. See [Mission offers](#mission-offers).
- `GET /game/missions/active`
  - `{ active }`, `null` when there is no mission. A mission stored before offers were engine-signed (legacy id, no exact destination, or no signature) can never be claimed, so it is deleted on first read and the response is `{ active: null, cancelled_mission: { mission_id, reason: "format_changed", message } }`; nothing was charged.
- `POST /game/missions/abandon`
  - `{ abandoned, mission_id, token }`. No payout and no cooldown; the mission's passengers disembark wherever the ship is.
- `POST /game/missions/complete`
  - Body `{ claim }`: the RTSE-signed completion claim; settles the payout once, starts the origin's cooldown and disembarks the mission's passengers. Returns `{ success, credits, payout, token }`. `503 CLAIM_KEY_NOT_CONFIGURED` when no claim public key is configured; `403` when the signature does not verify against it.

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

The engine is the only source of world data, so it alone decides which docks offer work and what: destinations, payout, time limit, berths, wording, mission id and expiry. While the pilot is docked it answers `ClientFrame.mission_board_request` with `MissionOffer`s it signs with its claim key (`EOTHA_MISSION_OFFER_V1`, layout in eotha-contracts `rtse/v1/mission.proto`), each bound to the pilot (`pilot_id`) and stamped `offered_at_ms`. The client relays one, with a fresh docked receipt, to `POST /game/missions/accept`. This service keeps no copy of the world: it checks identifiers for syntax only, and checks signatures and its own player rules.

`accept` checks, in order:
1. The offer's signature verifies against `CLAIM_PUBLIC_KEY` (`src/lib/mission-offer.js`) and `pilot_id` is the caller. Every field is signed, the coordinates as their exact IEEE-754 bits.
2. `offered_at_ms` is no more than 5 s ahead of this server's clock (`MAX_OFFER_FUTURE_SKEW_MS`) and `expires_at_ms` has not passed.
3. The docked receipt is valid, fresh and for the caller (as for upgrades, see [Docked upgrades](#docked-upgrades)), and its `dockedEntityId` and `systemH3` are the offer's `origin_station_id` and `origin_system_h3`.
4. Under the player's lock: no mission is active, the origin is not cooling down, the mission was never completed, and the ship has `floor(passenger_capacity) - passengers_aboard` free berths for `required_berths`.

It then stores the offer (`accepted_at_ms` is never earlier than `offered_at_ms`) and boards its passengers. The offer is proto-JSON: snake_case fields, `type` as its enum name, `signature` as standard base64; zero-valued fields may be omitted and 64-bit integers may be strings. Fields the engine did not sign are dropped.

The engine verifies its own signature again when the pilot claims the mission, so `GET /game/missions/active` hands the offer back bit-exact. The JSON column moves some doubles by an ulp, so the coordinates are also stored as text (`exact_destination`) and restored from it.

A completion is settled from the engine-signed `MissionCompletionClaim` as before. Payout is capped at 125 % of the signed `reward_credits`, each (player, mission) is paid once, and a completion starts a 10-minute cooldown at the origin dock (`MISSION_COOLDOWN_MS`).

## Passengers aboard
Taking off takes 0.5 s longer per passenger, so the real-time engine needs the ship's manifest. Each ship stores its count in `Spaceship.passengersAboard` (integer, default `0`) and it travels as `ship_attributes.passengers_aboard` (`ShipAttributes.passengers_aboard`, field 19, in eotha-contracts `common/v1/ship.proto`): in the signed access token, in the `ship` of a dev-login response and in `GET /ship/loadout`, and it is recomputed whenever the token is minted or reissued.

The count never exceeds `ship_attributes.passenger_capacity` (from the LIFE_SUPPORT tier): the attributes clamp it on every read, and `POST /ship/upgrade` writes the clamped count back if a component change leaves it above the new capacity.

Passengers board when a passage mission is accepted (`passengers_aboard += required_berths`) and disembark when it is completed or abandoned (never below zero); each of those responses carries a re-signed token. `POST /ship/dev/passengers` sets the count directly for testing; it exists only outside production. Existing databases pick up the new column with `npx prisma db push` (the schema is applied that way, there are no migration files).

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
    "signature": "<base64, 64 bytes>"
  }
}
```

`dockedEntityId` is the lowercase hyphenated UUID of the station or outpost (outposts count as docked); the signed bytes are its raw 16. A receipt of the wrong shape is a schema `400`. Otherwise the checks run before any transaction, so a refusal charges and changes nothing, and each answers `403` with a `code`:

| `code` | When |
|---|---|
| `docked_receipt_required` | No `dockedReceipt` in the body. |
| `docked_receipt_invalid` | `pilotId` is not the token's `sub`, or the signature does not verify against the claim key. |
| `docked_receipt_expired` | `issuedAtMs` is more than `DOCKED_RECEIPT_TTL_MS` (30 s) in the past or more than `DOCKED_RECEIPT_MAX_SKEW_MS` (5 s) in the future, or `dockedAtMs` is after `issuedAtMs`. The client should fetch a new receipt and retry once. |

Both constants are in `src/config/docking.js`; the age (`now - issuedAtMs`) is logged at debug level so clock drift shows up. Enforcement is hard, with no environment flag. A receipt is **not single-use**: it can serve several upgrades inside its window, and `nonce` is signed but not tracked, so the real bound on an upgrade after undocking is the 30 s window. This service does not check that the entity is a known station, because the engine is the only authority on what it can dock at. The docked check runs before the guest hull lock, so an undocked guest is told to dock first.

## Authentication model

**Identity.** `Player` is Better Auth's `user` (`callsign` is its `name`), so every table keyed by `playerId` keeps working. Better Auth's `session` and `account` models live in `auth_session` and `auth_account`; a guest is a player with `isAnonymous = true`, a placeholder email and the unusable password hash `!`, bound to its device through `GuestDevice` (only a SHA-256 of the device id is stored).

**Better Auth's HTTP handler is not mounted.** Every sign-in goes through the routes above so the attestation check cannot be bypassed; they drive Better Auth in-process. Passwords are verified by `src/lib/password.js` against `Player.passwordHash`, so existing players, their argon2id hashes and the legacy SHA-256 upgrade-on-login keep working unchanged; Better Auth's `emailAndPassword` is not enabled. Better Auth's `jwt` plugin is not used either: it keeps its own generated keys, while the RTSE needs tokens signed by the shared keypair with the existing claims.

**Tokens.**
- *Access token*: an EdDSA JWT signed with `keys/private.pem` carrying exactly the claims the RTSE validates today (`sub`, `callsign`, `home_h3`, `ship_attributes`, `iat`, `exp`). `ship_attributes.hull_tier` (integer 1 to 5) is the tier of the pilot's HULL component, so the engine reads the hull tier directly instead of deriving it from `max_hull_hp`; it is recomputed with the other attributes whenever the token is minted or reissued (including after `POST /ship/upgrade`), and guests stay at 1 because they cannot upgrade the hull. `ship_attributes.passengers_aboard` is the persisted passenger count, bounded by `passenger_capacity` (see [Passengers aboard](#passengers-aboard)). It is stateless and short-lived (`ACCESS_TOKEN_TTL_SECONDS`, default 15 minutes). The only change to the token is a `kid` header, so the RTSE can keep pinning `keys/public.pem` or later fetch `/.well-known/jwks.json`. `POST /ship/upgrade` re-signs claims but keeps the original `exp`, so only a refresh extends a login.
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

The RTSE signs mission offers, mission completion claims, planet charts, system charts and docked receipts with its own Ed25519 key, and this service verifies them. That key pair is **not** the login key: the engine holds the private half (its `RTSE_EXPLORATION_SEED`, 32 bytes as hex) and this service is given only the public half.

- `CLAIM_PUBLIC_KEY`: the raw 32-byte Ed25519 public key as 64 hex characters.
- `CLAIM_PUBLIC_KEY_FILE`: optional path to a file holding the same hex or a PEM public key. If both are set they must name the same key, otherwise startup fails. An unreadable or malformed key also fails startup; a blank variable counts as unset.
- Startup logs `Engine claims are verified with Ed25519 key sha256:<16 hex>`, the fingerprint of the key in use, and never any key material.
- With neither set, startup logs a warning and `POST /game/missions/accept`, `POST /game/missions/complete`, `POST /game/charts/register-planet` `POST /game/charts/claim-system` and `POST /ship/upgrade` answer `503 { "error": "CLAIM_KEY_NOT_CONFIGURED" }` instead of rejecting every claim as a bad signature.
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
