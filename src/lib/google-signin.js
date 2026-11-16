import { createHash, createHmac, randomBytes } from 'node:crypto';
import { authBaseUrl } from './auth.js';

/**
 * The browser flow of Sign in with Google, driven in-process through Better Auth (its HTTP handler
 * is never mounted; see src/lib/auth.js). Three steps, all under `/auth`:
 *
 *   1. start     POST /auth/google/start       -> { url }, the Google consent URL (and Better Auth's state cookie)
 *   2. callback  GET  /auth/callback/google    -> Google redirects here; the browser returns to the client
 *                                                 at `<origin><returnTo>#eotha_auth_code=<one-time code>`
 *   3. exchange  POST /auth/google/exchange    -> { token, refreshToken, expiresIn, player }, a game session
 *
 * The code is a one-time, 60-second, 256-bit value kept (hashed) in Better Auth's verification table.
 * It travels in the URL fragment so it never reaches a server, proxy log or Referer header, and the
 * long-lived refresh token is only ever returned in the exchange response body.
 */

export const GOOGLE_CODE_TTL_MS = 60_000;
const CODE_IDENTIFIER_PREFIX = 'eotha-google-code:';
const MAX_RETURN_TO_LENGTH = 512;

/** A failure the route reports as `{ error: code }` (start/exchange) or `#eotha_auth_error=code` (callback). */
export class GoogleSignInError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * A same-origin path (with optional query) to return the browser to, or null when `value` is anything
 * else: another origin, a protocol-relative or backslash path, control characters.
 * The hash is dropped because the one-time code is appended as the fragment.
 */
export function safeReturnTo(value, origin) {
  if (value === undefined || value === '') return '/';
  if (typeof value !== 'string' || value.length > MAX_RETURN_TO_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}`;
}

/** The value of a signed cookie as Better Auth reads it back: `value.base64(hmac-sha256)`, URL-encoded. */
const signedCookieValue = (value, secret) =>
  encodeURIComponent(`${value}.${createHmac('sha256', secret).update(value).digest('base64')}`);

const setCookiesOf = (response) => response.headers.getSetCookie();

/**
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {ReturnType<typeof import('./auth.js').createAuth>} deps.auth
 * @param {string} deps.publicBaseUrl Public base URL of the service, including any proxy path prefix.
 */
export function createGoogleSignIn({ prisma, auth, publicBaseUrl }) {
  const origin = new URL(publicBaseUrl).origin;
  // Better Auth redirects here, in-process, after the provider step; the browser is never sent to it.
  const doneUrl = `${authBaseUrl(publicBaseUrl)}/google/done`;
  const contextPromise = auth.$context;

  const callbackUrls = ({ returnTo, linkPlayerId }) => {
    const done = new URL(doneUrl);
    done.searchParams.set('r', returnTo);
    const errorURL = done.toString();
    if (linkPlayerId) done.searchParams.set('l', linkPlayerId);
    const callbackURL = done.toString();
    done.searchParams.set('n', '1');
    return { callbackURL, errorCallbackURL: errorURL, newUserCallbackURL: linkPlayerId ? callbackURL : done.toString() };
  };

  /** The consent URL, plus the cookies Better Auth wants the browser to keep until the callback. */
  async function start({ returnTo, linkPlayerId }) {
    const target = safeReturnTo(returnTo, origin);
    if (target === null) throw new GoogleSignInError(400, 'invalid_return_to');
    const urls = callbackUrls({ returnTo: target, linkPlayerId });

    let response;
    if (linkPlayerId) {
      // Better Auth links to the player of a session, and the browser holds none (the game's access
      // token is not one), so a short-lived session for the guest carries the request and is removed.
      const context = await contextPromise;
      const session = await context.internalAdapter.createSession(linkPlayerId, true);
      try {
        const headers = new Headers({
          cookie: `${context.authCookies.sessionToken.name}=${signedCookieValue(session.token, context.secret)}`
        });
        response = await auth.api.linkSocialAccount({
          body: { provider: 'google', disableRedirect: true, ...urls }, headers, asResponse: true
        });
      } finally {
        await context.internalAdapter.deleteSession(session.token);
      }
    } else {
      response = await auth.api.signInSocial({
        body: { provider: 'google', disableRedirect: true, ...urls }, headers: new Headers(), asResponse: true
      });
    }
    if (!response.ok) throw new GoogleSignInError(502, 'google_start_failed');
    const { url } = await response.json();
    if (!url) throw new GoogleSignInError(502, 'google_start_failed');
    return { url, cookies: setCookiesOf(response) };
  }

  /** Mints the one-time code for a player. */
  async function issueCode(playerId, created) {
    const code = randomBytes(32).toString('base64url');
    const now = new Date();
    await prisma.verification.deleteMany({
      where: { identifier: { startsWith: CODE_IDENTIFIER_PREFIX }, expiresAt: { lt: now } }
    });
    await prisma.verification.create({
      data: {
        identifier: `${CODE_IDENTIFIER_PREFIX}${sha256(code)}`,
        value: JSON.stringify({ playerId, created }),
        expiresAt: new Date(now.getTime() + GOOGLE_CODE_TTL_MS)
      }
    });
    return code;
  }

  const clientUrl = (returnTo, fragment) => {
    const params = new URLSearchParams(fragment);
    return `${origin}${returnTo}#${params.toString()}`;
  };

  /**
   * Finishes the Google callback: runs Better Auth's own callback, then resolves the player it
   * signed in or linked and hands the browser back to the client. Always yields a redirect target,
   * never throws for a provider or sign-in failure.
   * @returns {Promise<{ location: string, cookies: string[] }>}
   */
  async function callback({ query, cookie }) {
    const context = await contextPromise;
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);

    let response;
    try {
      response = await auth.api.callbackOAuth({ params: { id: 'google' }, query, headers, method: 'GET', asResponse: true });
    } catch (err) {
      return { location: clientUrl('/', { eotha_auth_error: 'server_error' }), cookies: [], error: err };
    }

    // Keep only the cookies that expire Better Auth's state; the session it just made is ours to
    // convert, never to hand to the browser.
    const cookies = setCookiesOf(response).filter((value) => /;\s*max-age=0\b/i.test(value));
    const sessionCookieName = context.authCookies.sessionToken.name;
    const sessionCookie = setCookiesOf(response).find((value) => value.startsWith(`${sessionCookieName}=`));

    let done;
    try {
      done = new URL(response.headers.get('location') ?? '', publicBaseUrl);
    } catch {
      done = null;
    }
    const isDone = done && `${done.origin}${done.pathname}` === doneUrl;
    const returnTo = (isDone && safeReturnTo(done.searchParams.get('r') ?? undefined, origin)) || '/';
    const fail = (code) => ({ location: clientUrl(returnTo, { eotha_auth_error: code }), cookies });

    if (!isDone) return fail('server_error');
    const error = done.searchParams.get('error');
    if (error) return fail(error);

    let playerId = done.searchParams.get('l');
    if (!playerId) {
      const sessionToken = sessionCookie && decodeURIComponent(sessionCookie.split(';')[0].slice(sessionCookieName.length + 1)).split('.')[0];
      const session = sessionToken && await prisma.authSession.findUnique({ where: { token: sessionToken } });
      if (!session) return fail('server_error');
      playerId = session.userId;
      // The game starts its own login at the exchange; this one only identified the player.
      await context.internalAdapter.deleteSession(session.token);
    }

    const code = await issueCode(playerId, done.searchParams.get('n') === '1');
    return { location: clientUrl(returnTo, { eotha_auth_code: code }), cookies };
  }

  /** Consumes a one-time code once; resolves to the player it names. */
  async function redeem(code) {
    const identifier = `${CODE_IDENTIFIER_PREFIX}${sha256(code)}`;
    const row = await prisma.verification.findFirst({ where: { identifier } });
    // Only one concurrent exchange can delete the row, so a code never yields two sessions.
    const { count } = row ? await prisma.verification.deleteMany({ where: { id: row.id } }) : { count: 0 };
    if (count !== 1 || row.expiresAt <= new Date()) throw new GoogleSignInError(401, 'invalid_code');
    return JSON.parse(row.value);
  }

  return { start, callback, redeem, origin };
}
