# Eotha: `eotha-meta-service`

The **Eotha Meta-Game Service** (`eotha-meta-service`) is the core orchestration backend for Eotha. Built on **Node.js 24 (ESM)**, **Fastify**, and **Prisma (PostgreSQL/PostGIS)**, it provides user authentication, space harbor base persistence, game session allocation, and asymmetric cryptographic JWT token minting (via Ed25519) that the Rust-based Real-Time Simulation Engine (RTSE) verifies in-memory.

## Architecture & Features

- **Asymmetric Authentication (Ed25519 / EdDSA)**: Mints cryptographic JWT tokens signed by a private key. The public key is shared out-of-band with the Rust RTSE cluster for zero-latency local verification without database queries.
- **Developer Bypass / Fake Auth (`GET /auth/dev-login`)**: Frictionless pilot simulation token generation for rapid CLI and integration testing without database prerequisites.
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
│   └── app.test.js             # Automated test suite
├── .env.example                # Sample environment configuration
├── package.json
└── README.md
```

---

## Quickstart

### 1. Prerequisites
- **Node.js 24+** (configured in `.nvmrc`)
- **PostgreSQL 15+** with PostGIS (optional for dev-login mode)

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
```bash
npm test
```

---

## API Endpoints

### Authentication & Meta
- `GET /health`
  - Health check endpoint returning `{ status: "healthy", service: "eotha-meta-service" }`.
- `GET /auth/dev-login`
  - Query parameters: `callsign` (default `DevPilot`), `latitude`, `longitude`, `h3` (default `8828308281fffff`).
  - Returns a signed Ed25519 JWT token, WebSocket gateway URL, and mock player profile.
- `POST /auth/register`
  - Registers a new player with an initial Space Harbor anchor coordinate and Uber H3 cell index.
- `POST /auth/login`
  - Validates credentials and returns a signed production JWT.

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
