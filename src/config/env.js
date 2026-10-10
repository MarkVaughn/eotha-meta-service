import 'dotenv/config';
import { z } from 'zod';

// An empty variable (a blank ConfigMap value, `FOO=` in a dotenv file) counts as unset.
const optionalString = (schema) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(3000),
  // Directory holding the shared Ed25519 keypair (private.pem, public.pem).
  KEYS_DIR: z.string().default('keys'),
  HOST: z.string().default('0.0.0.0'),
  // Lifetime of the stateless EdDSA access token the RTSE verifies; refresh tokens renew it.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(15 * 60),
  // Sliding lifetime of one refresh token; each rotation issues a fresh one.
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  // Hard cap on a login (Better Auth session); refresh stops here and the client signs in again.
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(90),
  // Better Auth's own secret. Defaults to a key derived from the Ed25519 signing key, so every
  // replica agrees on it without extra configuration.
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  // Public base URL of this service, handed to Better Auth (needed by the social providers added later).
  BETTER_AUTH_URL: z.string().url().optional(),
  // Raw Ed25519 public key (64 hex characters) that engine-signed claims verify against. This is a
  // dedicated claim key pair, never the login key in KEYS_DIR; the engine holds the private half.
  CLAIM_PUBLIC_KEY: optionalString(z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (a raw Ed25519 public key)')),
  // File holding the same key as hex or a PEM public key; when both are set they must agree.
  CLAIM_PUBLIC_KEY_FILE: optionalString(z.string().min(1)),
  // Credits a development-login pilot receives once, on its first dev login (never in production).
  DEV_STARTING_CREDITS: z.coerce.number().int().min(0).default(20_000),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/eotha_meta?schema=public')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export default env;
