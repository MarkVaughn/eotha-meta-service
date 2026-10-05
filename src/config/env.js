import 'dotenv/config';
import { z } from 'zod';

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
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/eotha_meta?schema=public')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export default env;
