# The agent

The agent is the part of Sable Monitor that reads the kernel. It runs a
sampling loop, keeps a bounded buffer of recent samples in memory, writes
a narrow row per sample to SQLite, evaluates alert rules and answers
questions about its own health.

It needs no privileges. Everything it reads is world readable on a stock
kernel, and the only thing it writes is its own database.

## The sampling loop

Sampling is a chain of `setTimeout` calls, not a `setInterval`, so a slow
sample delays the next one rather than having another queued behind it.
The interval is `collection.intervalMs`, 2000 ms by default.

The first sample is taken during startup, before the server begins
listening. It establishes the baseline for every counter, so its rates
are `null` by construction and it is held in the live buffer but not
written to the database.

Each tick runs four collectors in turn:

| Collector | Reads                                                            |
| --------- | ---------------------------------------------------------------- |
| `cpu`     | `/proc/stat`, `/proc/loadavg`, `/proc/cpuinfo`                   |
| `memory`  | `/proc/meminfo`                                                  |
| `disk`    | `/proc/self/mounts`, `statfs` per mount point, `/proc/diskstats` |
| `network` | `/proc/net/dev`, `/sys/class/net/<name>/operstate`               |

A collector that throws degrades that one metric for that one sample.
Its name is added to the sample's `degraded` array, the error is
reported, and the rest of the sample is produced, stored and served as
usual. A monitoring agent that stops at the first unreadable file is
least useful on the machine that needs it most.

CPU and memory are the exception. A sample without them describes
nothing, and storing it would draw a hole in every chart, so it is
discarded and counted in `collectionErrors`.

The process table is **not** read on the sampling timer. It is read when
`/api/processes` is requested, because reading several hundred
`/proc/<pid>/stat` files is the most expensive thing the agent does; see
[performance.md](performance.md).

## Honest data

Anything that cannot be measured is `null`, and the dashboard renders
`null` as an em dash rather than as a zero. The distinction survives the
whole path from `/proc` to the browser.

- The first sample has no previous reading, so every rate is `null`.
- A device, interface or process seen for the first time has `null`
  rates for one interval.
- A counter that went backwards — a wrapped 32-bit counter, a replaced
  device, a reused process identifier — yields `null` for that interval.
- A metric the kernel does not publish on this hardware, such as CPU
  frequency without a frequency driver, is `null` permanently.
- History shows real gaps where the agent was not running. Nothing is
  interpolated, averaged or carried forward.

## Buffers and bounds

Everything the agent holds is bounded, so nothing in it can grow until
the host runs out of memory.

| Buffer           | Bound                          | On overflow                |
| ---------------- | ------------------------------ | -------------------------- |
| Live sample ring | `collection.bufferSize` (900)  | Oldest sample discarded    |
| Pending writes   | 2000 samples                   | Oldest dropped and counted |
| Stream clients   | `server.maxStreamClients` (16) | Further requests get 503   |

The live ring is what `/api/metrics/current` and the dashboard's live
charts read; at the default interval, 900 samples is 30 minutes.

Pending samples are flushed to SQLite in one transaction every
`storage.writeIntervalMs`. If the write fails, the batch is dropped
rather than retried: a store that is failing will not be fixed by a
larger queue, and live monitoring has to keep working while it is.

## Timers

| Timer     | Period                      | Work                              |
| --------- | --------------------------- | --------------------------------- |
| Sample    | `collection.intervalMs`     | Collect, store, evaluate, publish |
| Write     | `storage.writeIntervalMs`   | Flush the pending batch           |
| Cleanup   | `storage.cleanupIntervalMs` | Apply retention                   |
| Staleness | 15 s                        | Evaluate the `agent-stale` rule   |

Staleness is checked on a timer of its own because the condition it
describes is one in which the sampling loop has stopped producing
anything to evaluate.

Every timer is unreferenced, so none of them keeps the process alive by
itself; the process stays up because the HTTP server is listening.

## Alerts

Alert evaluation runs on every sample, and on the staleness timer. Each
rule has the same shape: a measured value is bad when it is above a
threshold.

| Rule          | Measures                                 | Threshold | Clear | For (s) | Cooldown (s) | Severity |
| ------------- | ---------------------------------------- | --------- | ----- | ------- | ------------ | -------- |
| `cpu-high`    | Total CPU utilisation, %                 | 90        | 80    | 120     | 600          | warning  |
| `memory-high` | Memory utilisation, %                    | 90        | 80    | 120     | 600          | warning  |
| `disk-low`    | Filesystem used, % per mount point       | 90        | 85    | 300     | 3600         | critical |
| `load-high`   | 1-minute load average per logical CPU    | 2         | 1.5   | 300     | 900          | warning  |
| `agent-stale` | Seconds since the last successful sample | 60        | 30    | 0       | 300          | critical |

Despite its name, `disk-low` measures the percentage of a filesystem
that is **used**: the threshold is the point at which too little is
left. It is evaluated per mount point, and read-only filesystems are
skipped, because a mounted image or a recovery partition is full by
design and alerting on it is noise.

`load-high` is a ratio rather than an absolute load, so the same
threshold means the same thing on a machine of any size.

All of the above is configurable per rule; see
[configuration.md](configuration.md).

### Anti-flapping

Three mechanisms keep an alert from firing on noise.

- **Duration.** The condition must hold continuously for `forSeconds`
  before anything is raised, so a single spike between two samples is
  not an incident.
- **Hysteresis.** Once raised, the alert does not clear until the value
  falls back to `clearThreshold`, which is below the firing threshold. A
  value sitting on the boundary produces one alert rather than one per
  sample.
- **Cooldown.** After an alert resolves, the same rule and scope stay
  quiet for `cooldownSeconds`, so a slowly oscillating condition does
  not produce a stream of alerts.

A metric that could not be measured produces no observation, so a
missing reading never raises an alert and never clears one. The
`agent-stale` rule is what covers that case.

A scope that disappears — an unmounted filesystem — cannot be measured
again, so any alert active for it is resolved rather than left hanging.

### What an alert does

It is written to the local database and shown on the dashboard. That is
the whole of its effect.

Nothing is sent anywhere. There is no email, no SMS, no webhook, no
push, no integration with a paging service, and no outbound network
connection of any kind. If you need delivery, poll `/api/alerts` from
something that already does it.

Alerts survive a restart: active alerts are adopted from the database at
startup, and all of them are resolved on a clean shutdown.

## Health

`/api/health` reports what the agent knows about itself: whether the loop
is running, how many samples it has taken, how many collector failures
it has seen, the age of the last sample, which collectors are currently
degraded, how many rows are stored, the size of the database, the number
of active alerts and the number of stream subscribers.

`status` is derived: `stale` when the last sample is older than five
sampling intervals, `degraded` when the last sample listed a failed
collector, `ok` otherwise.

## Shutdown

On `SIGINT` or `SIGTERM` the server closes first, disconnecting stream
clients, then the agent stops.

Stopping clears the timers and waits — up to five seconds — for any
in-flight collection to finish, because abandoning one would leave the
counter snapshots describing a moment that never ended. It then flushes
the pending samples and resolves every active alert. Finally the store
folds the write-ahead log back into the database file, leaving one
self-contained file rather than three.

A second signal during shutdown exits immediately with status 130.

## Using it as a library

`src/index.ts` exports the agent, the alert engine, the collectors, the
configuration functions, the store, the server and every type, so the
agent can be embedded in another Node process without the server. Since
the package is not published to npm, import it from the built entry
point, `dist/index.js`, in the directory you extracted.

```ts
import { Agent, MetricsStore, parseConfig } from './dist/index.js';

const config = parseConfig({ collection: { intervalMs: 5000 } });
const store = new MetricsStore({
  path: ':memory:',
  retentionDays: config.storage.retentionDays,
  alertHistoryLimit: config.alerts.historyLimit,
});
const agent = new Agent({ config, store, version: '1.0.0' });

const unsubscribe = agent.onSample((sample) => {
  console.log(sample.cpu.usage);
});

await agent.start();
```

Call `unsubscribe()`, `agent.stop()` and `store.close()` when finished.
`onSample` and `onAlert` both return an unsubscribe function, and a
listener that throws is reported rather than allowed to break the loop.
