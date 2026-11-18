import { randomBytes, randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { anonymous } from 'better-auth/plugins/anonymous';
import { ACCOUNT_STARTING_CREDITS } from '../config/auth.js';

/** Better Auth's base URL for a public service base URL: the service's `/auth` routes sit under it. */
export const authBaseUrl = (publicBaseUrl) => `${publicBaseUrl.replace(/\/+$/, '')}/auth`;

/**
 * Builds the Better Auth instance. Better Auth owns users, sessions, linked accounts and the
 * anonymous-guest flow; `Player` is its `user` model, so the player id is the one stable identity.
 *
 * Its HTTP handler is deliberately never mounted: every sign-in goes through our own routes so the
 * app-attestation check cannot be bypassed, and they call `auth.api` / `auth.$context` in-process.
 * Passwords are verified by src/lib/password.js against `Player.passwordHash` (argon2id plus the
 * legacy SHA-256 upgrade), which is why `emailAndPassword` is not enabled here.
 *
 * Sign in with Google is a Better Auth social provider, on only when `google` credentials are given;
 * without them nothing here changes. The browser flow around it lives in src/lib/google-signin.js.
 * Adding Apple later: see "Linking Apple and Google later" in the README.
 *
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma
 * @param {string} opts.secret
 * @param {string} opts.baseURL Public base URL of this service as browsers reach it, including any
 *   proxy path prefix (https://demo.eotha.com/api). Better Auth's own base is `<baseURL>/auth`, so the
 *   Google redirect URI is `<baseURL>/auth/callback/google`.
 * @param {{ clientId: string, clientSecret: string }} [opts.google]
 * @param {number} opts.sessionTtlSeconds
 * @param {(link: { userId: string, provider: string }) => Promise<void>} opts.onAccountLinked
 *   Runs after Better Auth records a new external account on a player (any provider but the password).
 */
export function createAuth({ prisma, secret, baseURL, sessionTtlSeconds, onAccountLinked, google }) {
  return betterAuth({
    appName: 'Eotha',
    baseURL: authBaseUrl(baseURL),
    secret,
    telemetry: { enabled: false },
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    advanced: {
      database: { generateId: () => randomUUID() }
    },
    user: {
      modelName: 'player',
      fields: { name: 'callsign' },
      // Columns the user-create hook below writes; never accepted from a request body.
      additionalFields: {
        credits: { type: 'number', input: false, defaultValue: 0 },
        accountCreditsGrantedAt: { type: 'date', input: false, required: false }
      }
    },
    session: {
      modelName: 'authSession',
      expiresIn: sessionTtlSeconds
    },
    account: {
      modelName: 'account',
      // Google may be attached to a guest in place (the guest's placeholder email never matches), but a
      // Google sign-in never silently attaches to an existing player just because the emails match.
      accountLinking: { enabled: true, trustedProviders: ['google'], allowDifferentEmails: true, disableImplicitLinking: true }
    },
    verification: { modelName: 'verification' },
    ...(google && {
      socialProviders: {
        google: {
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          // A callsign is public in the game and unique; never derive it from the Google profile name.
          mapProfileToUser: () => ({ name: `Pilot-${randomBytes(6).toString('hex')}` })
        }
      }
    }),
    plugins: [
      anonymous({
        emailDomainName: 'guest.eotha.invalid',
        generateName: () => `Pilot-${randomBytes(6).toString('hex')}`
      })
    ],
    databaseHooks: {
      user: {
        create: {
          // A new Google player starts with the account credits. A guest (the anonymous plugin's user) starts
          // with none; it is granted them once, when it links an account (src/lib/identity.js convertGuest).
          before: async (user) => {
            if (user.isAnonymous) return;
            return { data: { ...user, credits: ACCOUNT_STARTING_CREDITS, accountCreditsGrantedAt: new Date() } };
          }
        }
      },
      account: {
        create: {
          after: async (account) => {
            if (account.providerId === 'credential') return;
            await onAccountLinked({ userId: account.userId, provider: account.providerId });
          }
        }
      }
    }
  });
}
