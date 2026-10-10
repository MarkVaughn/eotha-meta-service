// Where a client reaches the RTSE WebSocket gateway. A phone behind a tunnel cannot use the
// localhost address the local dev flow hands out, so in development the address follows the
// tunnelled request it answers; anywhere else it is configured, never read from request headers.

export const LOCAL_GATEWAY_HOST = 'localhost:8080';

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const PORT = '(?::\\d{1,5})?';
// A DNS name, an IPv4 address or a bracketed IPv6 address, with an optional port. No userinfo,
// path, query or whitespace can pass, so nothing but a host can be reflected.
const HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]{2,45}\\])${PORT}$`);

const firstValue = (header) => {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' ? value.split(',')[0].trim() : undefined;
};

const validHost = (value) => {
  if (!value || value.length > 255 || !HOST.test(value)) return undefined;
  const port = value.match(/:(\d+)$/)?.[1];
  return port === undefined || Number(port) <= 65535 ? value.toLowerCase() : undefined;
};

/**
 * The public origin the request came through, or null for a direct call. A proxy or tunnel marks
 * itself with x-forwarded-proto / x-forwarded-host; without either the request is local and the
 * Host header (the meta service's own port) says nothing about the gateway. A forwarded value that
 * is not a plain scheme or hostname discards the derivation instead of being reflected.
 */
export function forwardedOrigin(request) {
  const proto = firstValue(request.headers['x-forwarded-proto'])?.toLowerCase();
  const forwardedHost = firstValue(request.headers['x-forwarded-host']);
  if (proto === undefined && forwardedHost === undefined) return null;
  if (proto !== undefined && proto !== 'http' && proto !== 'https') return null;

  const host = validHost(forwardedHost ?? firstValue(request.headers.host));
  if (!host) return null;
  return { secure: (proto ?? request.protocol) === 'https', host };
}

/**
 * The WebSocket URL of the gateway: GATEWAY_WS_URL when set; in development, derived from the
 * tunnelled request; otherwise the local default.
 */
export function gatewayWsUrl(request, configured, { development = false } = {}) {
  if (configured) return configured;
  const origin = development ? forwardedOrigin(request) : null;
  return origin ? `${origin.secure ? 'wss' : 'ws'}://${origin.host}/session` : `ws://${LOCAL_GATEWAY_HOST}/session`;
}

/** The engine host (no scheme) recorded for a game session when the caller names none. */
export function defaultRtseHost({ configuredUrl, configuredHost } = {}) {
  if (configuredHost) return configuredHost;
  if (configuredUrl) return new URL(configuredUrl).host;
  return LOCAL_GATEWAY_HOST;
}
