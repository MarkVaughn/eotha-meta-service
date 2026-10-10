// Where a client reaches the RTSE WebSocket gateway. It is configuration (GATEWAY_WS_URL) or the
// local default, never anything read from the request: forwarded headers can be forged by a
// client, and the address is handed out next to a signed token.

export const LOCAL_GATEWAY_HOST = 'localhost:8080';
export const LOCAL_GATEWAY_URL = `ws://${LOCAL_GATEWAY_HOST}/session`;

/**
 * Checks a configured gateway URL: ws or wss, a hostname, an optional port and path, and no
 * credentials, query or fragment. Returns the URL, or throws an Error naming the problem.
 */
export function parseGatewayWsUrl(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error('must be a URL without whitespace or backslashes');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('must be a valid URL');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('must use the ws:// or wss:// scheme');
  // Judged on the text as written, since URL parsing normalises away an empty userinfo or host.
  const authority = value.slice(url.protocol.length + 2).split('/')[0];
  if (value.slice(0, url.protocol.length + 2).toLowerCase() !== `${url.protocol}//` || authority === '') throw new Error('must include a hostname');
  if (authority.includes('@')) throw new Error('must not embed credentials');
  if (value.includes('?') || value.includes('#')) throw new Error('must not include a query or fragment');
  return value;
}

/** The WebSocket URL of the gateway: GATEWAY_WS_URL when set, else the local default. */
export const gatewayWsUrl = (configured) => configured || LOCAL_GATEWAY_URL;

/** The engine host (no scheme) recorded for a game session when the caller names none. */
export function defaultRtseHost({ configuredUrl, configuredHost } = {}) {
  if (configuredHost) return configuredHost;
  if (configuredUrl) return new URL(configuredUrl).host;
  return LOCAL_GATEWAY_HOST;
}
