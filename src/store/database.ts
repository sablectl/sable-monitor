import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Alert,
  AlertRuleId,
  AlertSeverity,
  AlertState,
  HistoryPoint,
  MetricsSample,
  Timestamp,
} from '../types.js';

/**
 * Historical storage, on the SQLite engine built into Node.
 *
 * Choosing the built-in engine keeps the project free of native modules:
 * there is nothing to compile at install time, nothing to rebuild when
 * Node is upgraded, and no runtime dependency at all.
 *
 * The store holds two things. `metrics` is one narrow row per written
 * sample, carrying the handful of aggregate values the historical charts
 * draw — not the full sample, which would grow without bound and is only
 * interesting while it is current. `alerts` is one row per alert, kept so
 * that history survives a restart.
 *
 * Growth is bounded from both ends: rows older than the retention window
 * are deleted on a timer, and the alert table is trimmed to its configured
 * limit. The database and its directory are created with owner-only
 * permissions, because what the machine was doing and when is the
 * operator's business and nobody else's.
 */

export const SCHEMA_VERSION = 1;

const MIGRATIONS: readonly (readonly string[])[] = [
  // Version 1.
  [
    `CREATE TABLE IF NOT EXISTS metrics (
       timestamp  INTEGER PRIMARY KEY,
       cpu        REAL,
       memory     REAL,
       swap       REAL,
       disk       REAL,
       disk_read  REAL,
       disk_write REAL,
       net_rx     REAL,
       net_tx     REAL,
       load1      REAL
     ) STRICT`,
    `CREATE TABLE IF NOT EXISTS alerts (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       rule        TEXT    NOT NULL,
       severity    TEXT    NOT NULL,
       state       TEXT    NOT NULL,
       scope       TEXT,
       message     TEXT    NOT NULL,
       value       REAL    NOT NULL,
       threshold   REAL    NOT NULL,
       started_at  INTEGER NOT NULL,
       resolved_at INTEGER
     ) STRICT`,
    `CREATE INDEX IF NOT EXISTS alerts_started_at ON alerts (started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS alerts_state ON alerts (state, rule)`,
  ],
];

export interface StoreOptions {
  readonly path: string;
  readonly retentionDays: number;
  readonly alertHistoryLimit: number;
}

export interface HistoryQuery {
  readonly from: Timestamp;
  readonly to: Timestamp;
  /** Upper bound on the rows returned; the series is thinned to fit. */
  readonly limit: number;
}

interface MetricsRow {
  readonly timestamp: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly swap: number | null;
  readonly disk: number | null;
  readonly disk_read: number | null;
  readonly disk_write: number | null;
  readonly net_rx: number | null;
  readonly net_tx: number | null;
  readonly load1: number | null;
}

interface AlertRow {
  readonly id: number;
  readonly rule: string;
  readonly severity: string;
  readonly state: string;
  readonly scope: string | null;
  readonly message: string;
  readonly value: number;
  readonly threshold: number;
  readonly started_at: number;
  readonly resolved_at: number | null;
}

export class MetricsStore {
  private readonly database: DatabaseSync;
  private readonly options: StoreOptions;
  private closed = false;

  constructor(options: StoreOptions) {
    this.options = options;

    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    }

    this.database = new DatabaseSync(options.path);
    // WAL keeps a reader — the HTTP request drawing a chart — from
    // blocking the writer, and NORMAL synchronous is the right trade for
    // metrics: a crash can cost the last sample, which the next one
    // replaces anyway.
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec('PRAGMA foreign_keys = ON');

    this.migrate();

    if (options.path !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          chmodSync(`${options.path}${suffix}`, 0o600);
        } catch {
          // The sidecar files exist only while the database is open in
          // WAL mode; a missing one is not a problem.
        }
      }
    }
  }

  /**
   * Applies any migration the file has not seen.
   *
   * The applied version is kept in SQLite's own `user_version`, so no
   * table has to exist before the first migration runs, and a database
   * from a future version is refused rather than written to.
   */
  private migrate(): void {
    const row = this.database.prepare('PRAGMA user_version').get();
    const current =
      typeof row?.['user_version'] === 'number' ? row['user_version'] : 0;

    if (current > SCHEMA_VERSION) {
      throw new Error(
        `database at ${this.options.path} has schema version ${current}, ` +
          `which is newer than this build understands (${SCHEMA_VERSION})`,
      );
    }

    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const statements = MIGRATIONS[version];
      if (statements === undefined) continue;
      this.database.exec('BEGIN');
      try {
        for (const statement of statements) this.database.exec(statement);
        this.database.exec(`PRAGMA user_version = ${version + 1}`);
        this.database.exec('COMMIT');
      } catch (error: unknown) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /** Writes the aggregate values of one sample. */
  insertSample(sample: MetricsSample): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO metrics
           (timestamp, cpu, memory, swap, disk, disk_read, disk_write,
            net_rx, net_tx, load1)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sample.timestamp,
        sample.cpu.usage,
        sample.memory.usage,
        sample.memory.swapUsage,
        sample.disk.usage,
        sample.disk.readBytesPerSecond,
        sample.disk.writeBytesPerSecond,
        sample.network.receiveBytesPerSecond,
        sample.network.transmitBytesPerSecond,
        sample.cpu.loadAverage.one,
      );
  }

  /** Writes several samples in one transaction. */
  insertSamples(samples: readonly MetricsSample[]): void {
    if (samples.length === 0) return;
    this.database.exec('BEGIN');
    try {
      for (const sample of samples) this.insertSample(sample);
      this.database.exec('COMMIT');
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Reads a window of history.
   *
   * A seven-day window at a two-second interval is three hundred thousand
   * rows, which no chart can draw and no browser should be asked to parse.
   * When the window holds more rows than the caller asked for, every nth
   * row is taken, with n chosen so that the result fits. The rows returned
   * are real stored samples: nothing is interpolated, averaged or invented
   * to fill a gap, so a period when the agent was not running stays a gap.
   */
  history(query: HistoryQuery): HistoryPoint[] {
    const limit = Math.max(1, Math.min(query.limit, 5000));

    const countRow = this.database
      .prepare(
        'SELECT COUNT(*) AS total FROM metrics WHERE timestamp BETWEEN ? AND ?',
      )
      .get(query.from, query.to);
    const total =
      typeof countRow?.['total'] === 'number' ? countRow['total'] : 0;
    const stride = total > limit ? Math.ceil(total / limit) : 1;

    const rows = this.database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp) - 1 AS position
           FROM metrics
           WHERE timestamp BETWEEN ? AND ?
         )
         WHERE position % ? = 0
         ORDER BY timestamp
         LIMIT ?`,
      )
      .all(query.from, query.to, stride, limit);

    return rows.map((row) => toHistoryPoint(row));
  }

  /** Deletes samples older than the retention window. Returns rows removed. */
  prune(now: Timestamp = Date.now()): number {
    const cutoff = now - this.options.retentionDays * 86_400_000;
    const metrics = this.database
      .prepare('DELETE FROM metrics WHERE timestamp < ?')
      .run(cutoff);

    // Resolved alerts beyond the history limit go too; an active alert is
    // never deleted, however old it is.
    this.database
      .prepare(
        `DELETE FROM alerts
         WHERE state = 'resolved'
           AND id NOT IN (
             SELECT id FROM alerts WHERE state = 'resolved'
             ORDER BY started_at DESC LIMIT ?
           )`,
      )
      .run(this.options.alertHistoryLimit);

    return Number(metrics.changes);
  }

  /** Reclaims the space freed by a prune. Slow; called rarely. */
  vacuum(): void {
    this.database.exec('VACUUM');
  }

  countSamples(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS total FROM metrics')
      .get();
    return typeof row?.['total'] === 'number' ? row['total'] : 0;
  }

  oldestSample(): Timestamp | null {
    const row = this.database
      .prepare('SELECT MIN(timestamp) AS first FROM metrics')
      .get();
    return typeof row?.['first'] === 'number' ? row['first'] : null;
  }

  /** Size of the database file in bytes, or `null` for an in-memory one. */
  sizeBytes(): number | null {
    if (this.options.path === ':memory:') return null;
    try {
      return statSync(this.options.path).size;
    } catch {
      return null;
    }
  }

  insertAlert(alert: Omit<Alert, 'id'>): number {
    const result = this.database
      .prepare(
        `INSERT INTO alerts
           (rule, severity, state, scope, message, value, threshold,
            started_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.rule,
        alert.severity,
        alert.state,
        alert.scope,
        alert.message,
        alert.value,
        alert.threshold,
        alert.startedAt,
        alert.resolvedAt,
      );
    return Number(result.lastInsertRowid);
  }

  resolveAlert(id: number, at: Timestamp): void {
    this.database
      .prepare(
        `UPDATE alerts SET state = 'resolved', resolved_at = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(at, id);
  }

  /** Marks every alert still active as resolved, used on a clean shutdown. */
  resolveAllActive(at: Timestamp): void {
    this.database
      .prepare(
        `UPDATE alerts SET state = 'resolved', resolved_at = ?
         WHERE state = 'active'`,
      )
      .run(at);
  }

  activeAlerts(): Alert[] {
    return this.database
      .prepare(
        `SELECT * FROM alerts WHERE state = 'active' ORDER BY started_at DESC`,
      )
      .all()
      .map((row) => toAlert(row));
  }

  alerts(limit = 100, state?: AlertState): Alert[] {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const rows =
      state === undefined
        ? this.database
            .prepare('SELECT * FROM alerts ORDER BY started_at DESC LIMIT ?')
            .all(bounded)
        : this.database
            .prepare(
              'SELECT * FROM alerts WHERE state = ? ORDER BY started_at DESC LIMIT ?',
            )
            .all(state, bounded);
    return rows.map((row) => toAlert(row));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Folding the write-ahead log back into the main file leaves one
      // self-contained database behind rather than three files.
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // A checkpoint failure must not stop the shutdown.
    }
    this.database.close();
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toHistoryPoint(row: Record<string, unknown>): HistoryPoint {
  const typed: MetricsRow = {
    timestamp: numberOrNull(row['timestamp']) ?? 0,
    cpu: numberOrNull(row['cpu']),
    memory: numberOrNull(row['memory']),
    swap: numberOrNull(row['swap']),
    disk: numberOrNull(row['disk']),
    disk_read: numberOrNull(row['disk_read']),
    disk_write: numberOrNull(row['disk_write']),
    net_rx: numberOrNull(row['net_rx']),
    net_tx: numberOrNull(row['net_tx']),
    load1: numberOrNull(row['load1']),
  };
  return {
    timestamp: typed.timestamp,
    cpu: typed.cpu,
    memory: typed.memory,
    swap: typed.swap,
    disk: typed.disk,
    diskReadBps: typed.disk_read,
    diskWriteBps: typed.disk_write,
    netRxBps: typed.net_rx,
    netTxBps: typed.net_tx,
    load1: typed.load1,
  };
}

function toAlert(row: Record<string, unknown>): Alert {
  const typed: AlertRow = {
    id: numberOrNull(row['id']) ?? 0,
    rule: typeof row['rule'] === 'string' ? row['rule'] : 'cpu-high',
    severity: typeof row['severity'] === 'string' ? row['severity'] : 'warning',
    state: typeof row['state'] === 'string' ? row['state'] : 'resolved',
    scope: typeof row['scope'] === 'string' ? row['scope'] : null,
    message: typeof row['message'] === 'string' ? row['message'] : '',
    value: numberOrNull(row['value']) ?? 0,
    threshold: numberOrNull(row['threshold']) ?? 0,
    started_at: numberOrNull(row['started_at']) ?? 0,
    resolved_at: numberOrNull(row['resolved_at']),
  };

  const severity: AlertSeverity =
    typed.severity === 'critical' ? 'critical' : 'warning';
  const state: AlertState = typed.state === 'active' ? 'active' : 'resolved';

  return {
    id: typed.id,
    rule: typed.rule as AlertRuleId,
    severity,
    state,
    scope: typed.scope,
    message: typed.message,
    value: typed.value,
    threshold: typed.threshold,
    startedAt: typed.started_at,
    resolvedAt: typed.resolved_at,
  };
}
