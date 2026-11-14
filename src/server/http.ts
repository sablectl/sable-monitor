import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent } from '../agent/agent.js';
import type { Config } from '../config/config.js';
import type { MetricsStore } from '../store/database.js';
import { admit, SECURITY_HEADERS } from './security.js';
import {
  parseAlertQuery,
  parseHistoryQuery,
  parseProcessQuery,
} from './query.js';

/**
 * The HTTP API and the dashboard it serves.
 *
 * The surface is deliberately small: eight read-only JSON endpoints, one
 * event stream and a handful of static files. There is no endpoint that
 * changes anything, so there is no state-changing request to authorise,
 * forge or protect.
 *
 * Backpressure on the event stream is handled rather than ignored. A
 * client that cannot keep up — a laptop that was closed, a tab the
 * scheduler has not run for a minute — would otherwise fill the socket
 * buffer and then the process heap. Each subscriber therefore writes only
 * while the socket reports that it is drained, and drops the samples it
 * missed instead of queueing them: the next one carries the current state
 * anyway, which is the only state a monitoring view wants.
 */

export const API_VERSION = 1;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface MonitorServerOptions {
  readonly config: Config;
  readonly agent: Agent;
  readonly store: MetricsStore;
  readonly version: string;
  /** Overridden by the tests; defaults to the built dashboard. */
  readonly webRoot?: string;
}

interface StreamClient {
  readonly response: ServerResponse;
  /** Set while the socket is full, so samples are dropped not queued. */
  saturated: boolean;
  dropped: number;
}

export class MonitorServer {
  private readonly config: Config;
  private readonly agent: Agent;
  private readonly store: MetricsStore;
  private readonly version: string;
  private readonly webRoot: string;
  private readonly server: Server;
  private readonly clients = new Set<StreamClient>();
  private unsubscribe: (() => void)[] = [];

  constructor(options: MonitorServerOptions) {
    this.config = options.config;
    this.agent = options.agent;
    this.store = options.store;
    this.version = options.version;
    this.webRoot =
      options.webRoot ?? fileURLToPath(new URL('../web/', import.meta.url));

    this.server = createServer(
      {
        // The request head is everything a reader can send, since no
        // endpoint accepts a body. Node closes the connection with 431
        // when a request exceeds this, which bounds what one client can
        // make the server buffer.
        maxHeaderSize: this.config.server.maxRequestBytes,
      },
      (request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          this.fail(response, 500, 'internal error');
          console.error(`[sable-monitor] request failed: ${describe(error)}`);
        });
      },
    );

    // A client that opens a socket and says nothing must not hold a slot
    // for ever.
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 72_000;
    this.server.maxHeadersCount = 64;
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server.once('error', rejectListen);
      this.server.listen(
        this.config.server.port,
        this.config.server.host,
        () => {
          this.server.removeListener('error', rejectListen);
          resolveListen();
        },
      );
    });

    this.unsubscribe.push(
      this.agent.onSample((sample) => {
        this.broadcast('metrics', sample);
      }),
      this.agent.onAlert((change) => {
        this.broadcast('alert', change);
      }),
    );

    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      return { host: this.config.server.host, port: this.config.server.port };
    }
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];

    for (const client of this.clients) {
      client.response.end();
    }
    this.clients.clear();

    await new Promise<void>((resolveClose) => {
      this.server.close(() => {
        resolveClose();
      });
    });
    this.server.closeAllConnections();
  }

  get streamClients(): number {
    return this.clients.size;
  }

  /* Routing ------------------------------------------------------------ */

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rejection = admit(request, this.config.server);
    if (rejection !== null) {
      this.fail(response, rejection.status, rejection.reason);
      return;
    }

    // The base is a placeholder: only the path and the query are used,
    // and the host has already been validated.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    switch (path) {
      case '/api/health':
        this.json(response, 200, this.agent.health(this.clients.size));
        return;
      case '/api/system':
        this.json(response, 200, await this.agent.systemInfo());
        return;
      case '/api/metrics/current': {
        const current = this.agent.current();
        if (current === null) {
          // No sample has been taken yet. Saying so is the honest answer;
          // an empty object shaped like a sample would not be.
          this.fail(response, 503, 'no sample has been collected yet');
          return;
        }
        this.json(response, 200, current);
        return;
      }
      case '/api/metrics/history': {
        const query = parseHistoryQuery(url.searchParams, Date.now());
        if (!query.ok) {
          this.fail(response, 400, query.error);
          return;
        }
        const points = this.store.history(query.value);
        this.json(response, 200, {
          from: query.value.from,
          to: query.value.to,
          count: points.length,
          // The first sample ever stored, so the dashboard can show where
          // history begins rather than implying it goes back for ever.
          retainedFrom: this.store.oldestSample(),
          points,
        });
        return;
      }
      case '/api/processes': {
        const query = parseProcessQuery(
          url.searchParams,
          this.config.collection.processRows,
          this.config.collection.processRows,
        );
        if (!query.ok) {
          this.fail(response, 400, query.error);
          return;
        }
        this.json(response, 200, await this.agent.processes(query.value));
        return;
      }
      case '/api/alerts': {
        const query = parseAlertQuery(url.searchParams);
        if (!query.ok) {
          this.fail(response, 400, query.error);
          return;
        }
        this.json(response, 200, {
          active: this.store.activeAlerts(),
          alerts: this.store.alerts(query.value.limit, query.value.state),
        });
        return;
      }
      case '/api/config':
        this.json(response, 200, this.publicConfig());
        return;
      case '/api/stream':
        this.stream(request, response);
        return;
      default:
        if (path.startsWith('/api/')) {
          this.fail(response, 404, 'no such endpoint');
          return;
        }
        await this.static(request, response, path);
    }
  }

  /**
   * The configuration as the dashboard may see it.
   *
   * The token is not included, under any name. Neither is the database
   * path: the dashboard has no use for it, and it names a location on the
   * operator's disk.
   */
  private publicConfig(): Record<string, unknown> {
    return {
      version: this.version,
      apiVersion: API_VERSION,
      collection: {
        intervalMs: this.config.collection.intervalMs,
        bufferSize: this.config.collection.bufferSize,
        processRows: this.config.collection.processRows,
      },
      storage: {
        retentionDays: this.config.storage.retentionDays,
        writeIntervalMs: this.config.storage.writeIntervalMs,
      },
      alerts: {
        enabled: this.config.alerts.enabled,
        rules: this.config.alerts.rules,
      },
      security: {
        host: this.config.server.host,
        port: this.config.server.port,
        tokenRequired: this.config.server.token !== null,
        remoteAccess: this.config.server.allowRemote,
      },
    };
  }

  /* Event stream ------------------------------------------------------- */

  private stream(request: IncomingMessage, response: ServerResponse): void {
    if (this.clients.size >= this.config.server.maxStreamClients) {
      this.fail(response, 503, 'too many stream clients');
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      // Any proxy between the browser and this server must not buffer a
      // stream whose entire purpose is to arrive promptly.
      'X-Accel-Buffering': 'no',
    });

    const client: StreamClient = { response, saturated: false, dropped: 0 };
    this.clients.add(client);

    // Tells the browser how long to wait before reconnecting, which is
    // what makes recovery from a restart automatic.
    response.write(`retry: 2000\n\n`);
    const current = this.agent.current();
    if (current !== null) writeEvent(client, 'metrics', current);

    const heartbeat = setInterval(() => {
      // A comment frame keeps the connection alive through anything that
      // closes idle sockets, and detects a peer that has gone away.
      client.response.write(': keep-alive\n\n');
    }, 20_000);
    heartbeat.unref();

    const finish = (): void => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    };

    request.on('close', finish);
    response.on('close', finish);
    response.on('error', finish);
  }

  private broadcast(event: string, payload: unknown): void {
    for (const client of this.clients) writeEvent(client, event, payload);
  }

  /* Static files ------------------------------------------------------- */

  /**
   * Serves the dashboard.
   *
   * The resolved path is checked to be inside the web root and its
   * extension to be one of a handful, so no request can read a file the
   * dashboard is not made of, whatever it does with `..`, encoded
   * separators or a symbolic link.
   */
  private async static(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const relative = path === '/' ? '/index.html' : path;
    const root = resolve(this.webRoot);
    const candidate = resolve(join(root, normalize(relative)));

    if (candidate !== root && !candidate.startsWith(root + sep)) {
      this.fail(response, 403, 'forbidden');
      return;
    }

    const type = CONTENT_TYPES[extname(candidate)];
    if (type === undefined) {
      this.fail(response, 404, 'not found');
      return;
    }

    let size: number;
    try {
      const stats = await stat(candidate);
      if (!stats.isFile()) {
        this.fail(response, 404, 'not found');
        return;
      }
      size = stats.size;
    } catch {
      this.fail(response, 404, 'not found');
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': size,
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(candidate).pipe(response);
  }

  /* Responses ---------------------------------------------------------- */

  private json(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    response.end(text);
  }

  private fail(response: ServerResponse, status: number, reason: string): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    this.json(response, status, { error: { status, message: reason } });
  }
}

/**
 * Writes one event, or drops it if the socket has not drained.
 *
 * Dropping is correct here. The payload is the current state of the
 * machine, and another one is a second or two behind it; a client that
 * could not take this one has no use for it by the time it could.
 */
function writeEvent(
  client: StreamClient,
  event: string,
  payload: unknown,
): void {
  if (client.saturated) {
    client.dropped += 1;
    return;
  }

  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const drained = client.response.write(frame);
  if (!drained) {
    client.saturated = true;
    client.response.once('drain', () => {
      client.saturated = false;
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
