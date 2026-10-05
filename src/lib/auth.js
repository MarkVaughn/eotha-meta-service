import { randomBytes, randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { anonymous } from 'better-auth/plugins/anonymous';

/**
 * Builds the Better Auth instance. Better Auth owns users, sessions, linked accounts and the
 * anonymous-guest flow; `Player` is its `user` model, so the player id is the one stable identity.
 *
 * Its HTTP handler is deliberately never mounted: every sign-in goes through our own routes so the
 * app-attestation check cannot be bypassed, and they call `auth.api` / `auth.$context` in-process.
 * Passwords are verified by src/lib/password.js against `Player.passwordHash` (argon2id plus the
 * legacy SHA-256 upgrade), which is why `emailAndPassword` is not enabled here.
 *
 * Adding Apple or Google later: see "Linking Apple and Google later" in the README.
 *
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma
 * @param {string} opts.secret
 * @param {string} opts.baseURL
 * @param {number} opts.sessionTtlSeconds
 * @param {(link: { userId: string, provider: string }) => Promise<void>} opts.onAccountLinked
 *   Runs after Better Auth records a new external account on a player (any provider but the password).
 */
export function createAuth({ prisma, secret, baseURL, sessionTtlSeconds, onAccountLinked }) {
  return betterAuth({
    appName: 'Eotha',
    baseURL,
    secret,
    telemetry: { enabled: false },
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    advanced: {
      database: { generateId: () => randomUUID() }
    },
    user: {
      modelName: 'player',
      fields: { name: 'callsign' }
    },
    session: {
      modelName: 'authSession',
      expiresIn: sessionTtlSeconds
    },
    account: { modelName: 'account' },
    verification: { modelName: 'verification' },
    plugins: [
      anonymous({
        emailDomainName: 'guest.eotha.invalid',
        generateName: () => `Pilot-${randomBytes(6).toString('hex')}`
      })
    ],
    databaseHooks: {
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
