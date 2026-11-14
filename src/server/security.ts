import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ServerConfig } from '../config/config.js';
import { isLoopbackHost } from '../config/config.js';

/**
 * Request admission.
 *
 * Binding to the loopback address is the first line of defence and not the
 * whole of one. A page in a browser on the same machine can issue requests
 * to `127.0.0.1`, and a hostile name that resolves to `127.0.0.1` — the
 * DNS rebinding attack — turns that into a way to read this API from a
 * site the user merely visited. Three checks close that path.
 *
 * - The `Host` header must name a host this server is willing to answer
 *   to. A rebound name does not, so the request is refused before it
 *   reaches a route.
 * - The `Origin` header, which a browser always sets on a cross-origin
 *   request and cannot be forged by the page, must be absent or allowed.
 *   A page on another site therefore cannot read a response.
 * - Only `GET` and `HEAD` exist. There is no state-changing request to
 *   protect, which is the strongest form the protection can take.
 *
 * A token may be required on top of that, and is mandatory when the server
 * is bound off loopback.
 */

export type Rejection =
  | { readonly status: 400; readonly reason: string }
  | { readonly status: 401; readonly reason: string }
  | { readonly status: 403; readonly reason: string }
  | { readonly status: 405; readonly reason: string }
  | { readonly status: 414; readonly reason: string };

export const MAX_URL_LENGTH = 2048;

/** Splits a `Host` header into its host and port, IPv6 included. */
export function splitHost(value: string): {
  host: string;
  port: string | null;
} {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(value);
  if (bracketed !== null) {
    return { host: bracketed[1] ?? '', port: bracketed[2] ?? null };
  }
  const index = value.lastIndexOf(':');
  if (index === -1) return { host: value, port: null };
  return { host: value.slice(0, index), port: value.slice(index + 1) };
}

export function isHostAllowed(
  value: string | undefined,
  config: ServerConfig,
): boolean {
  if (value === undefined || value.length === 0) return false;
  const { host, port } = splitHost(value.trim().toLowerCase());

  // A request that names a different port was not meant for this server.
  if (port !== null && Number(port) !== config.port) return false;

  if (isLoopbackHost(host)) return true;
  if (host === config.host.toLowerCase()) return true;
  return config.allowedHosts.some((allowed) => allowed.toLowerCase() === host);
}

export function isOriginAllowed(
  value: string | undefined,
  config: ServerConfig,
): boolean {
  // No origin means the request did not come from a page: a terminal, a
  // script, or the dashboard's own same-origin navigation.
  if (value === undefined || value === 'null') return true;

  if (config.allowedOrigins.includes(value)) return true;

  // The dashboard's own origin is allowed, which is what the browser
  // sends for a same-origin fetch in some configurations.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (Number(parsed.port || '80') !== config.port) return false;
  return isLoopbackHost(parsed.hostname) || parsed.hostname === config.host;
}

/** Constant-time comparison, so the token cannot be guessed by timing. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isAuthorised(
  header: string | undefined,
  config: ServerConfig,
): boolean {
  if (config.token === null) return true;
  if (header === undefined) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;
  return tokenMatches(presented, config.token);
}

/**
 * Applies every check to one request, returning the rejection to send or
 * `null` if the request may proceed.
 */
export function admit(
  request: IncomingMessage,
  config: ServerConfig,
): Rejection | null {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, reason: 'only GET and HEAD are supported' };
  }

  const url = request.url ?? '/';
  if (url.length > MAX_URL_LENGTH) {
    return { status: 414, reason: 'request target is too long' };
  }

  if (!isHostAllowed(request.headers.host, config)) {
    return { status: 403, reason: 'host not allowed' };
  }

  const origin = request.headers.origin;
  if (
    !isOriginAllowed(typeof origin === 'string' ? origin : undefined, config)
  ) {
    return { status: 403, reason: 'origin not allowed' };
  }

  if (!isAuthorised(request.headers.authorization, config)) {
    return { status: 401, reason: 'a bearer token is required' };
  }

  return null;
}

/**
 * Headers sent on every response.
 *
 * The content security policy allows this origin's own scripts and styles
 * and nothing else: no inline script, no remote font, no image from
 * anywhere. The dashboard is built to live inside it.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  // Metrics are current by definition; a cached copy is a wrong copy.
  'Cache-Control': 'no-store',
};
