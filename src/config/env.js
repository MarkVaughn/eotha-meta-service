import 'dotenv/config';
import { z } from 'zod';
import { parseGatewayWsUrl } from '../lib/gateway-url.js';

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
  // Public base URL of this service as browsers reach it, including any path a reverse proxy adds
  // (https://demo.eotha.com/api when the proxy strips /api). Sign in with Google derives its callback
  // (<BETTER_AUTH_URL>/auth/callback/google) and the browser's return address (the origin) from it.
  BETTER_AUTH_URL: optionalString(z.string().url()),
  // Sign in with Google. Both set turns the provider on; both unset leaves it off and changes nothing else.
  GOOGLE_CLIENT_ID: optionalString(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optionalString(z.string().min(1)),
  // Lets POST /auth/guest and POST /auth/login run without a registered device-attestation verifier
  // outside development (a browser demo cannot attest). Off by default; a registered verifier still applies.
  ALLOW_UNATTESTED_SIGNIN: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['true', 'false']).default('false')).transform((value) => value === 'true'),
  // Raw Ed25519 public key (64 hex characters) that engine-signed claims verify against. This is a
  // dedicated claim key pair, never the login key in KEYS_DIR; the engine holds the private half.
  CLAIM_PUBLIC_KEY: optionalString(z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (a raw Ed25519 public key)')),
  // File holding the same key as hex or a PEM public key; when both are set they must agree.
  CLAIM_PUBLIC_KEY_FILE: optionalString(z.string().min(1)),
  // Development workload credential for the private RTSE control plane. Production can use the
  // mTLS fingerprint allowlist instead; neither accepts a player bearer token.
  INTERNAL_RTSE_CREDENTIAL: optionalString(z.string().min(32)),
  // Comma-separated SHA-256 client-certificate fingerprints. mTLS is checked from the verified
  // TLS socket rather than a forwarded header, so it is safe to enable at the service boundary.
  INTERNAL_RTSE_MTLS_FINGERPRINTS: optionalString(z.string().min(1)),
  // Base URL of the engine's private internal listener (its RTSE_INTERNAL_PORT, never the public gateway), such as
  // http://eotha-rtse:9090. A new player's harbor asks it which factions control the spawn cell and its neighbors,
  // presenting INTERNAL_RTSE_CREDENTIAL. Unset (or the credential unset), new players start with no spawn standing.
  RTSE_INTERNAL_URL: optionalString(z.string().url().refine((value) => /^https?:$/.test(new URL(value).protocol), 'must be an http or https URL')),
  // Identifies the public key RTSE has provisioned to verify signed enforcement projections.
  ENFORCEMENT_ISSUER_KEY_ID: z.string().min(1).default('eotha-meta-service-v1'),
  // This service's own Ed25519 key (PEM file) for MissionUnlockVoucher signatures, and the id the engine knows its public
  // half by. Never the login or claim key; unset, no intel can be gathered.
  INTEL_VOUCHER_PRIVATE_KEY_FILE: optionalString(z.string().min(1)),
  INTEL_VOUCHER_KEY_ID: z.string().min(1).default('eotha-meta-service-voucher-v1'),
  // Credits every registered account starts with: a new email or Google account at creation, a guest once when it links one.
  ACCOUNT_STARTING_CREDITS: z.coerce.number().int().min(0).default(500),
  // Credits a development-login pilot receives once, on its first dev login (never in production).
  DEV_STARTING_CREDITS: z.coerce.number().int().min(0).default(20_000),
  // Full WebSocket URL of the RTSE gateway handed to clients (a fixed staging host, say). Unset, it is
  // ws://localhost:8080/session; it is never derived from the request.
  GATEWAY_WS_URL: optionalString(z.string().superRefine((value, ctx) => {
    try {
      parseGatewayWsUrl(value);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err.message });
    }
  })),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/eotha_meta?schema=public')
}).superRefine((value, ctx) => {
  if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) {
    ctx.addIssue({ code: 'custom', path: ['GOOGLE_CLIENT_SECRET'], message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together' });
  }
  if (value.GOOGLE_CLIENT_ID && !value.BETTER_AUTH_URL && value.NODE_ENV === 'production') {
    ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_URL'], message: 'BETTER_AUTH_URL (the public base URL) is required when Sign in with Google is enabled' });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export default env;
