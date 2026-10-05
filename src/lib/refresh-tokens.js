import { createHash, randomBytes } from 'node:crypto';

/** A refresh attempt that must be answered with 401; `code` is safe to show the client. */
export class RefreshError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Refresh-token rotation with reuse detection, layered on Better Auth sessions (which provide
 * neither). Every login creates a Better Auth session; the refresh tokens of that session are its family. Each refresh
 * consumes the presented token and issues its successor in the same family. Presenting a token that
 * was already consumed means a copy exists somewhere, so the whole family is revoked and the
 * Better Auth session is deleted, ending that login everywhere.
 */
export function createRefreshTokens({ prisma, auth, refreshTtlMs }) {
  const contextPromise = auth.$context;

  const newToken = ({ playerId, sessionId }) => {
    const token = randomBytes(32).toString('base64url');
    return prisma.refreshToken
      .create({
        data: { playerId, sessionId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + refreshTtlMs) }
      })
      .then(() => token);
  };

  /** Revokes a family and ends its Better Auth session (which cascades the rows away). */
  async function revokeFamily(sessionId) {
    const { internalAdapter } = await contextPromise;
    const session = await prisma.authSession.findUnique({ where: { id: sessionId }, select: { token: true } });
    await prisma.refreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (session) await internalAdapter.deleteSession(session.token);
  }

  return {
    /** Starts a login for a player: a Better Auth session plus the first refresh token. */
    async start(playerId, { ipAddress, userAgent } = {}) {
      const { internalAdapter } = await contextPromise;
      const session = await internalAdapter.createSession(playerId, false, {
        ipAddress: ipAddress ?? '',
        userAgent: userAgent ?? ''
      });
      const refreshToken = await newToken({ playerId, sessionId: session.id });
      return { refreshToken, sessionId: session.id };
    },

    /** Starts the refresh family for a Better Auth session that already exists (a new guest's). */
    async adopt(session) {
      return { refreshToken: await newToken({ playerId: session.userId, sessionId: session.id }) };
    },

    /** Consumes `presented` and returns its successor, or throws RefreshError. */
    async rotate(presented) {
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
      if (!row) throw new RefreshError('invalid_refresh_token');
      if (row.revokedAt) throw new RefreshError('invalid_refresh_token');
      if (row.usedAt) {
        await revokeFamily(row.sessionId);
        throw new RefreshError('refresh_token_reused');
      }
      if (row.expiresAt <= new Date()) throw new RefreshError('invalid_refresh_token');

      const session = await prisma.authSession.findUnique({ where: { id: row.sessionId } });
      if (!session || session.expiresAt <= new Date()) throw new RefreshError('invalid_refresh_token');

      // Only one concurrent request can flip usedAt; the loser presented an already-consumed token.
      const { count } = await prisma.refreshToken.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() }
      });
      if (count === 0) {
        await revokeFamily(row.sessionId);
        throw new RefreshError('refresh_token_reused');
      }

      let refreshToken;
      try {
        refreshToken = await newToken({ playerId: row.playerId, sessionId: row.sessionId });
      } catch (err) {
        // A concurrent reuse detection deleted the session between the check above and here.
        if (err.code === 'P2003') throw new RefreshError('invalid_refresh_token');
        throw err;
      }
      // Expired tokens are rejected anyway, so keeping their rows only grows the table.
      await prisma.refreshToken.deleteMany({ where: { sessionId: row.sessionId, expiresAt: { lt: new Date() } } });
      return { refreshToken, playerId: row.playerId, sessionId: row.sessionId };
    },

    /** Ends the login a refresh token belongs to. Unknown tokens are ignored. */
    async revoke(presented) {
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
      if (row) await revokeFamily(row.sessionId);
    }
  };
}
