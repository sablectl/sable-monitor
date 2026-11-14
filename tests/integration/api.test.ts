import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { parseConfig } from '../../src/config/config.js';
import { MonitorServer } from '../../src/server/http.js';
import { MetricsStore } from '../../src/store/database.js';
import { VERSION } from '../../src/version.js';

/**
 * A real server on a real loopback port, answering real requests.
 *
 * The port is taken from the operating system by binding to 0, so the
 * suite cannot collide with a Sable Monitor the developer happens to be
 * running.
 */

let directory: string;
let store: MetricsStore;
let agent: Agent;
let server: MonitorServer;
let origin: string;
let port: number;

const WEB_ROOT = fileURLToPath(new URL('../../src/web/', import.meta.url));

/**
 * A port the operating system says is free. The configuration refuses
 * port 0, because a monitoring service that lands on an unpredictable
 * port is not one an operator can reach, so the test asks for a real
 * number instead.
 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen =
        address !== null && typeof address !== 'string' ? address.port : 0;
      probe.close(() => {
        resolve(chosen);
      });
    });
  });
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${origin}${path}`, { headers });
}

/**
 * A request with a `Host` header of our choosing.
 *
 * `fetch` refuses to send one — `Host` is a forbidden header there — so
 * the rebinding case has to be exercised through the lower-level client.
 */
async function rawGet(
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const call = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    call.on('error', reject);
    call.end();
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sable-monitor-api-'));
  port = await freePort();
  const config = parseConfig({
    server: { port },
    collection: { intervalMs: 300_000, bufferSize: 10, processRows: 25 },
    storage: { path: join(directory, 'metrics.db'), writeIntervalMs: 300_000 },
  });

  store = new MetricsStore({
    path: config.storage.path,
    retentionDays: config.storage.retentionDays,
    alertHistoryLimit: config.alerts.historyLimit,
  });
  agent = new Agent({ config, store, version: VERSION });
  await agent.start();
  // A second sample, so that the rates are measured rather than null.
  await agent.collect();
  agent.flush();

  server = new MonitorServer({
    config,
    agent,
    store,
    version: VERSION,
    webRoot: WEB_ROOT,
  });
  const address = await server.listen();
  expect(address.port).toBe(port);
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  await agent.stop();
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports a running agent', async () => {
    const response = await get('/api/health');
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ agentRunning: true, version: VERSION });
  });

  it('sends the security headers on every response', async () => {
    const response = await get('/api/health');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/system', () => {
  it('describes the host without leaking anything sensitive', async () => {
    const response = await get('/api/system');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['hostname']).toBeTypeOf('string');
    expect(body['kernel']).toBeTypeOf('string');
    expect(Object.keys(body)).not.toContain('environment');
  });
});

describe('GET /api/metrics/current', () => {
  it('returns the latest sample', async () => {
    const response = await get('/api/metrics/current');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['timestamp']).toBeTypeOf('number');
    expect(body['cpu']).toBeTypeOf('object');
    expect(body['memory']).toBeTypeOf('object');
  });
});

describe('GET /api/metrics/history', () => {
  it('returns the stored points for the default window', async () => {
    const response = await get('/api/metrics/history');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Array.isArray(body['points'])).toBe(true);
    expect(body['retainedFrom']).toBeTypeOf('number');
  });

  it('accepts each documented range', async () => {
    for (const range of ['15m', '1h', '6h', '24h', '7d']) {
      expect((await get(`/api/metrics/history?range=${range}`)).status).toBe(
        200,
      );
    }
  });

  it('refuses an invalid range, limit or window', async () => {
    for (const query of [
      'range=1y',
      'limit=abc',
      'limit=999999',
      'from=2000&to=1000',
      'range=1h&from=1',
    ]) {
      const response = await get(`/api/metrics/history?${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('GET /api/processes', () => {
  it('returns a bounded, sorted table', async () => {
    const response = await get('/api/processes?limit=5&sort=memory');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      returned: number;
      processes: { pid: number; memoryBytes: number }[];
    };
    expect(body.returned).toBeLessThanOrEqual(5);
    expect(body.total).toBeGreaterThan(body.returned - 1);
    const sizes = body.processes.map((entry) => entry.memoryBytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it('refuses a request for more rows than the server allows', async () => {
    expect((await get('/api/processes?limit=5000')).status).toBe(400);
  });

  it('refuses an unknown sort key', async () => {
    expect((await get('/api/processes?sort=rss')).status).toBe(400);
  });
});

describe('GET /api/alerts', () => {
  it('returns the active alerts and the history', async () => {
    const response = await get('/api/alerts');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Array.isArray(body['active'])).toBe(true);
    expect(Array.isArray(body['alerts'])).toBe(true);
  });

  it('refuses an unknown state', async () => {
    expect((await get('/api/alerts?state=pending')).status).toBe(400);
  });
});

describe('GET /api/config', () => {
  it('never includes the token or the database path', async () => {
    const response = await get('/api/config');
    const text = await response.text();
    expect(text).not.toContain('token"');
    expect(text).not.toContain(directory);
    expect(JSON.parse(text)).toMatchObject({ version: VERSION });
  });
});

describe('GET /api/stream', () => {
  it('sends the current sample and then live ones', async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/stream`, {
      headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let text = '';

    // The first frame is the retry hint and the sample already held.
    while (!text.includes('event: metrics')) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain('retry: 2000');
    expect(text).toContain('event: metrics');

    // A new sample reaches the client that is already connected.
    const before = text.length;
    await agent.collect();
    while (text.length === before) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text.slice(before)).toContain('data: {');

    controller.abort();
    // The server must notice the client has gone.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.streamClients).toBe(0);
  });
});

describe('the dashboard', () => {
  it('serves the entry document', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('Sable Monitor');
  });

  it('serves the stylesheet', async () => {
    const response = await get('/styles.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
  });

  it('refuses to read anything outside the web root', async () => {
    for (const path of [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/../../../../etc/passwd',
    ]) {
      const response = await get(path);
      expect([400, 403, 404]).toContain(response.status);
      const text = await response.text();
      expect(text).not.toContain('"dependencies"');
      expect(text).not.toContain('root:x:');
    }
  });

  it('refuses a file type the dashboard is not made of', async () => {
    expect((await get('/index.ts')).status).toBe(404);
  });
});

describe('request admission', () => {
  it('accepts the loopback host it is bound to', async () => {
    const response = await rawGet('/api/health', `127.0.0.1:${port}`);
    expect(response.status).toBe(200);
  });

  it('refuses a rebound host', async () => {
    const response = await rawGet('/api/health', 'evil.example');
    expect(response.status).toBe(403);
    expect(response.body).toContain('host not allowed');
  });

  it('refuses a host naming another port', async () => {
    const response = await rawGet('/api/health', '127.0.0.1:1');
    expect(response.status).toBe(403);
  });

  it('refuses a request head larger than the configured limit', async () => {
    // No endpoint accepts a body, so the head is the whole of what a
    // client can send, and `server.maxRequestBytes` bounds it. Node
    // answers 431 and closes the connection.
    const enormous = 'x'.repeat(32 * 1024);
    const response = await new Promise<number>((resolve, reject) => {
      const call = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/health',
          method: 'GET',
          headers: { 'X-Padding': enormous },
        },
        (reply) => {
          reply.resume();
          resolve(reply.statusCode ?? 0);
        },
      );
      call.on('error', reject);
      call.end();
    });
    expect(response).toBe(431);
  });

  it('refuses a cross-site origin', async () => {
    const response = await get('/api/health', {
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
  });

  it('refuses every method that is not a read', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${origin}/api/health`, { method });
      expect(response.status).toBe(405);
    }
  });

  it('answers a HEAD request with headers and no body', async () => {
    const response = await fetch(`${origin}/api/health`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('reports an unknown endpoint as not found', async () => {
    const response = await get('/api/nope');
    expect(response.status).toBe(404);
  });
});
