# Eotha: `eotha-meta-service` Bootstrap & Architecture Guide

This document outlines the step-by-step setup and implementation of the **Eotha Meta-Game Service** (`eotha-meta-service`). Built on **Node.js 24 (ESM)**, **Fastify**, and **Prisma (PostgreSQL/PostGIS)**, this service is responsible for user registration, space harbor base persistence [2], game session instantiation, and signing asymmetric cryptographic JWT tokens (using Ed25519) that the Rust-based Real-Time Simulation Engine (RTSE) verifies in-memory [3].

---

## 1. Project Directory Structure

Use this clean, modular, domain-driven structure for Node.js 24 with native ESM:

```text
eotha-meta-service/
├── prisma/
│   ├── schema.prisma           # Prisma database schema with PostgreSQL + PostGIS
│   └── migrations/             # Database migration history
├── src/
│   ├── config/
│   │   └── env.js              # Environment variable validation via Fluent-Schema/Zod
│   ├── plugins/
│   │   ├── prisma.js           # Shared database client lifecycle plugin
│   │   └── security.js         # JWT signing/verification plugin (Ed25519)
│   ├── routes/
│   │   ├── auth/
│   │   │   ├── index.js        # Auth controller (Register, Login, Dev-Login)
│   │   │   └── schema.js       # Fastify JSON schemas for request validation
│   │   └── game/
│   │       ├── index.js        # Game session lookup/instantiation
│   │       └── schema.js       # JSON schemas for game endpoints
│   └── app.js                  # Fastify application entry point
├── keys/
│   ├── private.pem             # RS256/Ed25519 Private Key (gitignored)
│   └── public.pem              # Public Key (synchronized with Rust RTSE)
├── package.json
└── README.md
```

---

## 2. Configuration & Manifests

### `package.json`
Configure Node.js to use modern EcmaScript Modules (`"type": "module"`) and native TypeScript execution using tsx.

```json
{
  "name": "eotha-meta-service",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/app.js",
    "build": "prisma generate",
    "start": "node src/app.js",
    "db:migrate": "prisma migrate dev",
    "keys:generate": "node scripts/generate-keys.js"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.0",
    "@fastify/jwt": "^9.0.0",
    "@prisma/client": "^6.0.0",
    "dotenv": "^16.4.5",
    "fastify": "^5.0.0",
    "jose": "^5.9.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "prisma": "^6.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.2"
  }
}
```

---

## 3. Database Schema (`prisma/schema.prisma`)

The database captures player meta-data, account details, and geographical space harbor coordinate assets utilizing PostgreSQL/PostGIS extensions [1, 2].

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

model Player {
  id           String        @id @default(uuid()) @db.Uuid
  email        String        @unique
  passwordHash String
  callsign     String        @unique
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  harbor       SpaceHarbor?
  session      GameSession?
}

model SpaceHarbor {
  id         String   @id @default(uuid()) @db.Uuid
  playerId   String   @unique @db.Uuid
  player     Player   @relation(fields: [playerId], references: [id], onDelete: Cascade)
  
  // Geographical representation for real-world home anchor points [1, 2]
  latitude   DoublePrecision
  longitude  DoublePrecision
  h3Index    String   @db.VarChar(15) // Uber H3 Resolution 8 or 9 index string

  level      Int      @default(1)
  metalStock Float    @default(0.0)
  gasStock   Float    @default(0.0)
  updatedAt  DateTime @updatedAt
}

model GameSession {
  id         String   @id @default(uuid()) @db.Uuid
  playerId   String   @unique @db.Uuid
  player     Player   @relation(fields: [playerId], references: [id], onDelete: Cascade)
  rtseHost   String   // Internal domain/service of the allocated RTSE instance [3]
  connected  Boolean  @default(false)
  updatedAt  DateTime @updatedAt
}
```

---

## 4. Key Generation Utility (`scripts/generate-keys.js`)

To enable asymmetric "fake auth" and secure JWT signatures, run this script to generate high-performance **Ed25519** cryptographic key pairs.

```javascript
import { writeFileSync, mkdirSync } from 'fs';
import { generateKeyPair } from 'crypto';
import { join } from 'path';

mkdirSync('./keys', { recursive: true });

generateKeyPair('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' }
}, (err, publicKey, privateKey) => {
  if (err) {
    console.error("Failed to generate keys:", err);
    process.exit(1);
  }
  writeFileSync(join('./keys', 'private.pem'), privateKey);
  writeFileSync(join('./keys', 'public.pem'), publicKey);
  console.log("🚀 Cryptographic asymmetric key pair successfully generated inside ./keys/");
});
```

---

## 5. Security & JWT Fastify Plugin (`src/plugins/security.js`)

Integrate `fastify-jwt` to sign outgoing tokens utilizing the private key. (The public key is shared out-of-band with the Rust RTSE cluster deployment for instant, local token decryption without database hits [3]).

```javascript
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { readFileSync } from 'fs';
import { join } from 'path';

async function securityPlugin(fastify, opts) {
  let privateKey;
  let publicKey;

  try {
    privateKey = readFileSync(join(process.cwd(), 'keys', 'private.pem'), 'utf8');
    publicKey = readFileSync(join(process.cwd(), 'keys', 'public.pem'), 'utf8');
  } catch (err) {
    fastify.log.warn("⚠️ Security keys not found. Falling back to local symmetric development secret!");
    privateKey = 'super-secret-dev-key';
    publicKey = 'super-secret-dev-key';
  }

  const isAsymmetric = privateKey.includes('PRIVATE KEY');

  fastify.register(fastifyJwt, {
    secret: {
      private: privateKey,
      public: publicKey
    },
    sign: {
      algorithm: isAsymmetric ? 'EdDSA' : 'HS256',
      issuer: 'eotha.meta-service',
      expiresIn: '24h'
    }
  });

  // Decorator to protect specific meta endpoints
  fastify.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized credentials' });
    }
  });
}

export default fp(securityPlugin);
```

---

## 6. Authentication Routes (`src/routes/auth/index.js`)

Implements standard credential endpoints alongside the crucial friction-free **`GET /auth/dev-login`** "fake auth" endpoint. This bypasses structural login barriers for local CLI testing, and mints fully valid payloads containing geospatial pilot parameters.

```javascript
import crypto from 'crypto';

export default async function authRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  // Endpoint 1: Register Player
  fastify.post('/register', async (request, reply) => {
    const { email, password, callsign, latitude, longitude, h3Index } = request.body;
    
    // Hash password (simplistic for prototyping, use bcrypt/argon2 in prod)
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    try {
      const player = await prisma.player.create({
        data: {
          email,
          passwordHash,
          callsign,
          harbor: {
            create: {
              latitude,
              longitude,
              h3Index
            }
          }
        },
        include: { harbor: true }
      });

      return reply.code(201).send({ id: player.id, callsign: player.callsign });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(400).send({ error: 'Callsign or Email already exists.' });
    }
  });

  // Endpoint 2: Standard Cryptographic Login
  fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body;
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    const player = await prisma.player.findUnique({
      where: { email },
      include: { harbor: true }
    });

    if (!player || player.passwordHash !== passwordHash) {
      return reply.code(401).send({ error: 'Invalid user credentials.' });
    }

    const token = fastify.jwt.sign({
      sub: player.id,
      callsign: player.callsign,
      home_h3: player.harbor?.h3Index || "881f1d4887fffff"
    });

    return { token, player: { id: player.id, callsign: player.callsign } };
  });

  // Endpoint 3: Dev-Login Bypass ("Fake Auth" strategy for easy CLI testing)
  fastify.get('/dev-login', async (request, reply) => {
    const { callsign = 'DevPilot', latitude = '37.7749', longitude = '-122.4194', h3 = '8828308281fffff' } = request.query;

    // Simulate an instant development ID
    const mockId = crypto.randomUUID();

    // Sign complete production claims. The Rust RTSE verifies this token as if it were production [3].
    const token = fastify.jwt.sign({
      sub: mockId,
      callsign,
      home_h3: h3,
      mock: true
    });

    fastify.log.info(`🎯 Dev token minted for pilot ${callsign} located at H3: ${h3}`);

    return {
      token,
      gateway_ws_url: "ws://localhost:8080/session", // Local Minikube RTSE WebSocket port [3]
      player: {
        id: mockId,
        callsign,
        dev: true,
        spawn_point: {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          h3_index: h3
        }
      }
    };
  });
}
```

---

## 7. App Entry Point (`src/app.js`)

Bootstraps the Fastify server container, registering routes and dependency modules.

```javascript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prismaPlugin from './plugins/prisma.js';
import securityPlugin from './plugins/security.js';
import authRoutes from './routes/auth/index.js';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
});

// Register Plugins
await fastify.register(cors, { origin: '*' });
await fastify.register(prismaPlugin);
await fastify.register(securityPlugin);

// Register Routes
await fastify.register(authRoutes, { prefix: '/auth' });

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'healthy', service: 'eotha-meta-service' };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`🌐 Eotha Meta Service listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
```

---

## 8. Run & Setup Instructions

To execute this service locally for rapid prototyping:

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Setup environment variables** (Create a `.env` in root):
   ```text
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/eotha_meta?schema=public"
   PORT=3000
   ```
3. **Generate cryptographic keys**:
   ```bash
   npm run keys:generate
   ```
4. **Boot the service in watch mode**:
   ```bash
   npm run dev
   ```
5. **Get Dev-Login Token**:
   Open a browser or terminal and hit `http://localhost:3000/auth/dev-login?callsign=Spectre`. It returns the WebSocket destination and signed JWT to feed immediately into your CLI client!
