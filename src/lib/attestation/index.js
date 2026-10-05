export const PLATFORMS = ['play-integrity', 'app-attest', 'device-check'];

/** A refused attestation; `status` and `code` go straight to the client. */
export class AttestationError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {object} Evidence
 * @property {string} platform  One of PLATFORMS.
 * @property {string} token     The Play Integrity token or App Attest / DeviceCheck assertion, as sent.
 * @property {string} [deviceId] The device id from the request body, so a verifier can check that the
 *                               token's nonce / challenge was issued for this request.
 *
 * @typedef {object} Verifier
 * @property {string} platform
 * @property {(evidence: Evidence) => Promise<{ ok: boolean, reason?: string }>} verify
 *   Resolves `{ ok: true }` only for a genuine, untampered client. Anything else (including a throw)
 *   is a refusal.
 */

/**
 * Registry of device-attestation verifiers. Strict by design: when a request cannot be verified
 * the sign-in is refused, with no restricted-token fallback. The only relaxation is development,
 * where an empty registry lets the local dev flow run without a real device.
 */
export function createAttestationService({ development = false, log } = {}) {
  const verifiers = new Map();

  return {
    /** @param {Verifier} verifier */
    register(verifier) {
      if (!PLATFORMS.includes(verifier?.platform)) throw new Error(`Unknown attestation platform: ${verifier?.platform}`);
      if (typeof verifier.verify !== 'function') throw new Error('An attestation verifier needs a verify() function');
      verifiers.set(verifier.platform, verifier);
    },

    get configured() {
      return verifiers.size > 0;
    },

    /** Resolves when the evidence is accepted; throws AttestationError otherwise. */
    async check({ platform, token, deviceId } = {}) {
      if (verifiers.size === 0) {
        if (development) return;
        throw new AttestationError(503, 'attestation_unavailable');
      }
      if (typeof platform !== 'string' || typeof token !== 'string' || !token) {
        throw new AttestationError(403, 'attestation_required');
      }
      const verifier = verifiers.get(platform);
      if (!verifier) throw new AttestationError(403, 'attestation_platform_unsupported');

      let outcome;
      try {
        outcome = await verifier.verify({ platform, token, deviceId });
      } catch (err) {
        log?.error({ err, platform }, 'attestation verifier failed');
      }
      if (outcome?.ok !== true) {
        log?.warn({ platform, reason: outcome?.reason }, 'attestation refused');
        throw new AttestationError(403, 'attestation_failed');
      }
    }
  };
}
