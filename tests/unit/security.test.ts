import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig } from '../../src/config/config.js';
import {
  admit,
  isAuthorised,
  isHostAllowed,
  isOriginAllowed,
  SECURITY_HEADERS,
  splitHost,
  tokenMatches,
} from '../../src/server/security.js';

const SERVER = defaultConfig().server;

function request(
  headers: Record<string, string>,
  method = 'GET',
  url = '/api/health',
): IncomingMessage {
  // Only the fields `admit` reads are needed, and building a real socket
  // would test Node rather than this code.
  return { headers, method, url } as unknown as IncomingMessage;
}

describe('splitHost', () => {
  it('splits a name and a port', () => {
    expect(splitHost('127.0.0.1:7878')).toEqual({
      host: '127.0.0.1',
      port: '7878',
    });
  });

  it('splits a bracketed IPv6 address', () => {
    expect(splitHost('[::1]:7878')).toEqual({ host: '::1', port: '7878' });
    expect(splitHost('[::1]')).toEqual({ host: '::1', port: null });
  });

  it('handles a host with no port', () => {
    expect(splitHost('localhost')).toEqual({ host: 'localhost', port: null });
  });
});

describe('isHostAllowed', () => {
  it('accepts the loopback names and addresses on the right port', () => {
    for (const host of [
      'localhost:7878',
      '127.0.0.1:7878',
      '127.0.0.53:7878',
      '[::1]:7878',
    ]) {
      expect(isHostAllowed(host, SERVER)).toBe(true);
    }
  });

  it('refuses a name that merely resolves to loopback', () => {
    // This is the DNS rebinding case: the address is right, the name is
    // not one this server answers to.
    expect(isHostAllowed('rebind.attacker.example:7878', SERVER)).toBe(false);
  });

  it('refuses a request with no Host header at all', () => {
    expect(isHostAllowed(undefined, SERVER)).toBe(false);
    expect(isHostAllowed('', SERVER)).toBe(false);
  });

  it('refuses a Host naming another port', () => {
    expect(isHostAllowed('127.0.0.1:9999', SERVER)).toBe(false);
  });

  it('accepts a name the operator added', () => {
    const config = parseConfig({
      server: { allowedHosts: ['monitor.internal'] },
    }).server;
    expect(isHostAllowed('monitor.internal:7878', config)).toBe(true);
    expect(isHostAllowed('MONITOR.INTERNAL:7878', config)).toBe(true);
    expect(isHostAllowed('other.internal:7878', config)).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('accepts a request with no Origin', () => {
    expect(isOriginAllowed(undefined, SERVER)).toBe(true);
  });

  it('accepts the dashboard’s own origin', () => {
    expect(isOriginAllowed('http://127.0.0.1:7878', SERVER)).toBe(true);
  });

  it('refuses another site', () => {
    expect(isOriginAllowed('https://attacker.example', SERVER)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:9999', SERVER)).toBe(false);
    expect(isOriginAllowed('not a url', SERVER)).toBe(false);
  });

  it('accepts an origin the operator added', () => {
    const config = parseConfig({
      server: { allowedOrigins: ['https://monitor.internal'] },
    }).server;
    expect(isOriginAllowed('https://monitor.internal', config)).toBe(true);
  });
});

describe('tokens', () => {
  it('compares equal tokens and rejects the rest', () => {
    expect(
      tokenMatches('a-token-of-some-length', 'a-token-of-some-length'),
    ).toBe(true);
    expect(tokenMatches('a', 'b')).toBe(false);
    expect(tokenMatches('short', 'longer-token')).toBe(false);
  });

  it('is satisfied by any request when no token is configured', () => {
    expect(isAuthorised(undefined, SERVER)).toBe(true);
  });

  it('requires a bearer token when one is configured', () => {
    const config = parseConfig({
      server: { token: 'a-sufficiently-long-token' },
    }).server;
    expect(isAuthorised(undefined, config)).toBe(false);
    expect(isAuthorised('Bearer wrong-token-value', config)).toBe(false);
    expect(isAuthorised('Bearer a-sufficiently-long-token', config)).toBe(true);
    expect(isAuthorised('bearer a-sufficiently-long-token', config)).toBe(true);
    expect(isAuthorised('a-sufficiently-long-token', config)).toBe(false);
  });
});

describe('admit', () => {
  it('lets a well-formed loopback request through', () => {
    expect(admit(request({ host: '127.0.0.1:7878' }), SERVER)).toBeNull();
    expect(
      admit(request({ host: '127.0.0.1:7878' }, 'HEAD'), SERVER),
    ).toBeNull();
  });

  it('refuses every method that could change something', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(
        admit(request({ host: '127.0.0.1:7878' }, method), SERVER)?.status,
      ).toBe(405);
    }
  });

  it('refuses a rebound host', () => {
    expect(admit(request({ host: 'evil.example' }), SERVER)?.status).toBe(403);
  });

  it('refuses a cross-site origin', () => {
    expect(
      admit(
        request({ host: '127.0.0.1:7878', origin: 'https://evil.example' }),
        SERVER,
      )?.status,
    ).toBe(403);
  });

  it('refuses an over-long request target', () => {
    const long = `/api/processes?search=${'x'.repeat(4000)}`;
    expect(
      admit(request({ host: '127.0.0.1:7878' }, 'GET', long), SERVER)?.status,
    ).toBe(414);
  });

  it('refuses a missing token before looking at anything else', () => {
    const config = parseConfig({
      server: { token: 'a-sufficiently-long-token' },
    }).server;
    expect(admit(request({ host: '127.0.0.1:7878' }), config)?.status).toBe(
      401,
    );
  });
});

describe('SECURITY_HEADERS', () => {
  it('forbids everything the dashboard does not need', () => {
    const policy = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Cache-Control']).toBe('no-store');
  });
});
