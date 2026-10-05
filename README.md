# Eotha: `eotha-meta-service`

The **Eotha Meta-Game Service** (`eotha-meta-service`) is the core orchestration backend for Eotha. Built on **Node.js 24 (ESM)**, **Fastify**, and **Prisma (PostgreSQL/PostGIS)**, it provides user authentication, space harbor base persistence, game session allocation, and asymmetric cryptographic JWT token minting (via Ed25519) that the Rust-based Real-Time Simulation Engine (RTSE) verifies in-memory.

## Architecture & Features

- **Asymmetric Authentication (Ed25519 / EdDSA)**: Mints cryptographic JWT tokens signed by a private key. The public key is shared out-of-band with the Rust RTSE cluster for zero-latency local verification without database queries.
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
│   │   └── env.js              # Environment validation via Zod
│   ├── plugins/
│   │   ├── prisma.js           # Prisma client lifecycle plugin
│   │   └── security.js         # JWT plugin (Ed25519 / EdDSA)
│   ├── routes/
│   │   ├── auth/
│   │   │   ├── index.js        # Register, Login, and Dev-Login routes
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
- `POST /auth/login`
  - Validates credentials and returns a signed production JWT.

### Economy
- `POST /game/trade/sell` (Protected)
  - Sells `METAL` or `GAS` from the pilot's harbor stock. The stock decrement, trade record and credit increment commit together; a sale the stock cannot cover is refused with `409`.
- `POST /ship/upgrade` (Protected)
  - Raises a component tier. The credit cost (`TIER_UPGRADE_COST` in `src/config/components.js`, summed per tier step) is deducted in the same transaction as the tier change; insufficient credits return `402`.

### Game Sessions
- `GET /game/session` (Protected)
  - Fetches the active game session and assigned RTSE host for the authenticated pilot.
- `POST /game/session` (Protected)
  - Allocates or updates an RTSE instance assignment for the authenticated pilot.

---

## RTSE Integration

1. The service signs JWTs using Ed25519 (`keys/private.pem`).
2. The corresponding public key (`keys/public.pem`) is mounted or configured in the Rust RTSE engine.
3. The RTSE engine verifies client JWT claims locally without issuing database lookups.
