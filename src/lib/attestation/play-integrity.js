import { createHash } from 'node:crypto';

const MAX_TOKEN_AGE_MS = 2 * 60 * 1000;

/**
 * Play Integrity verdict policy: accepts only an unmodified, Play-installed app on a certified
 * device, for this package, bound to this device id, and fresh.
 *
 * The call to Google that turns the opaque token into a verdict (`decodeIntegrityToken`, which
 * needs the project's service-account credentials) is injected as `decode`; it must resolve the
 * decoded `tokenPayloadExternal` object. Keeping it out of here keeps the policy testable offline.
 *
 * The client must set the integrity request's nonce to base64url(SHA-256(deviceId)).
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {(token: string) => Promise<object>} opts.decode
 * @returns {import('./index.js').Verifier}
 */
export function createPlayIntegrityVerifier({ packageName, decode, now = Date.now }) {
  return {
    platform: 'play-integrity',
    async verify({ token, deviceId }) {
      const payload = await decode(token);
      const { requestDetails, appIntegrity, deviceIntegrity } = payload ?? {};

      if (requestDetails?.requestPackageName !== packageName) return { ok: false, reason: 'wrong package' };
      if (!deviceId || requestDetails.nonce !== createHash('sha256').update(deviceId).digest('base64url')) {
        return { ok: false, reason: 'nonce mismatch' };
      }
      const issuedAt = Number(requestDetails.timestampMillis);
      if (!Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_TOKEN_AGE_MS) {
        return { ok: false, reason: 'stale token' };
      }
      if (appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return { ok: false, reason: 'app not recognized' };
      if (!deviceIntegrity?.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY')) {
        return { ok: false, reason: 'device not certified' };
      }
      return { ok: true };
    }
  };
}
