# Architecture

Sable Monitor is a TypeScript program compiled to ECMAScript modules and
run on Node.js. It has no runtime dependencies: storage is `node:sqlite`,
the server is `node:http`, and everything else comes from the rest of the
standard library. It reads `/proc` and `/sys`, so it runs on Linux and
nowhere else.

One process does all of the work. A sampling agent reads the kernel's
pseudo-filesystems on a timer, a store keeps a narrow row per sample in
SQLite, an alert engine applies thresholds to each sample, and an HTTP
server publishes the result as JSON, as an event stream and as a
dashboard.

## Module map

```text
src/
  bin/sable-monitor.ts   process entry: arguments, signals, exit codes
  config/config.ts       defaults, parsing, validation, precedence
  collect/               procfs access and the four metric collectors
  agent/agent.ts         the sampling loop, the live buffer, health
  alerts/engine.ts       threshold evaluation and anti-flapping
  store/database.ts      schema, migrations, history, retention
  server/                admission checks, query parsing, routes
  web/                   the dashboard, compiled separately
  types.ts               the shapes everything exchanges
  index.ts               the library surface
```

The dependency direction is one way:

```text
bin  ->  server  ->  agent  ->  collect
             |         |
             +---------+---->  store
                       |
                       +---->  alerts
```

`collect` imports nothing but `types` and its own `procfs` module. The
agent knows about collectors, the store and the alert engine; the server
knows about the agent and the store; nothing lower reaches back up. The
dashboard in `src/web` shares no code with the server at all — it is
compiled against its own `api-types.ts` and talks to the API over HTTP
like any other client.

## No runtime dependencies

The two dependencies a program of this kind usually carries are a SQLite
binding and an HTTP framework. Node.js supplies both. `node:sqlite` is
part of the standard library and unflagged from Node.js 24, so there is
no native module to compile at install time and nothing to rebuild when
Node is upgraded; `node:http` is enough for a handful of routes that
only answer `GET`. Argument parsing, configuration validation, `/proc`
parsing, chart drawing and byte formatting are each a small amount of
code in this repository.

## Reading the kernel

Every read of `/proc` and `/sys` goes through `src/collect/procfs.ts`.
The class holds the two roots, validates relative paths before joining
them, and distinguishes a read that must succeed from one that may not.

The roots are injectable, which is what makes the unit tests
deterministic: they point the collector at a directory of captured
fixtures and assert exact numbers instead of asserting on whatever the
machine running the suite happens to be doing.

Path validation matters because several of the paths are built from
strings the kernel supplied — a device name, an interface name, a process
identifier. Each segment must match a conservative character class, so no
value can escape the root through `..` or an absolute path.

A missing file is an ordinary outcome on Linux. A `/proc/<pid>` entry
disappears the moment the process exits, and a `/sys` attribute is simply
absent on hardware that does not have it. `readProcOptional` and
`readSysOptional` return `null` for those cases rather than throwing.

### Counters and rates

Most of what the kernel publishes is a counter that has been increasing
since boot, not a rate. Utilisation, throughput and per-process CPU are
all differences between two readings divided by the elapsed time, which
has three consequences the code handles explicitly.

- The first sample has nothing to subtract from, so its rates are `null`.
- A device, an interface or a process that appeared since the last
  reading has no baseline, so its rate is `null` for one interval.
- A counter that went backwards — a 32-bit counter wrapping, a device
  removed and replaced, a reused process identifier — is not a rate. The
  interval reports `null` instead of an implausible spike, and the next
  one recovers.

In each case the value is `null`, never zero. See
[performance.md](performance.md) for what the collection costs and
[known-limitations.md](known-limitations.md) for what the arithmetic
assumes.

## The sampling loop

The agent runs one timer. It is a chain of `setTimeout` calls rather than
a `setInterval`, so a slow sample delays the next one instead of having
another queued on top of it.

Each tick runs the four collectors — CPU, memory, disk, network — and
assembles a `MetricsSample`. A collector that throws degrades that one
metric for that one sample: its name is appended to the sample's
`degraded` array, the error is reported through the agent's error
callback, and the rest of the sample is still produced, stored and
served. The exception is CPU or memory failing, which leaves nothing
useful to describe, so that sample is discarded and counted as a
collection error instead.

Everything the agent holds is bounded. The live buffer is a ring of
`collection.bufferSize` samples, the queue of samples waiting to be
written holds at most 2000 before the oldest are dropped, and the
subscriber list is capped by `server.maxStreamClients`.

Three further timers run alongside the sampling one: a write timer that
flushes the queue to SQLite every `storage.writeIntervalMs`, a cleanup
timer that applies retention every `storage.cleanupIntervalMs`, and a
15-second timer that evaluates the staleness rule. Staleness has to be
noticed when sampling has stopped, so it cannot be checked inside the
sampling loop. All of them are unreferenced, so they never hold the
process open by themselves.

The process table is not part of the sampling loop. It is read on demand
when `/api/processes` is requested, because reading several hundred
`/proc/<pid>/stat` files is the most expensive thing the agent does and
nothing needs it between requests.

## Storage

The store holds two tables in one SQLite file.

`metrics` is one narrow row per written sample: timestamp, CPU, memory,
swap, disk usage, disk read and write rates, network receive and transmit
rates, and the one-minute load average. The full sample is not stored.
Everything else it contains — per-core utilisation, per-filesystem
capacity, per-interface counters — is only interesting while it is
current, and keeping it would grow the file without bound.

`alerts` is one row per alert, so alert history survives a restart.

The database is opened in WAL mode with `synchronous = NORMAL`. WAL keeps
a reader — an HTTP request drawing a chart — from blocking the writer,
and `NORMAL` is the right trade for metrics: a crash can cost the last
sample, which the next one replaces anyway. Growth is bounded from both
ends by the retention sweep and the alert history limit. On a clean
close, the write-ahead log is folded back into the main file.

Migrations are a list of statement batches, and the applied version lives
in SQLite's own `user_version`. A database written by a newer schema
version is refused rather than written to.

Reading a window of history that holds more rows than the caller's limit
takes every nth stored row, with n chosen so the result fits. The rows
returned are real stored samples: nothing is interpolated, averaged or
invented, so a period when the agent was not running stays a gap.

## The alert engine

Every rule has the same shape: a measured value is bad when it is above a
threshold. That uniformity is what lets the anti-flapping logic be
written once. A rule produces no observation at all when its metric could
not be measured, so a missing reading never raises an alert and never
clears one; the staleness rule covers the case where readings stop
arriving. See [agent.md](agent.md) for the rules and their behaviour.

The engine decides and records; it does not notify. An alert is written
to the local database and shown on the dashboard, and that is the whole
of its effect.

## The server

`node:http` with a hand-written router. Every request passes through
`admit` in `src/server/security.ts` before it reaches a route: method,
request-target length, `Host`, `Origin` and bearer token are all checked
there. Only `GET` and `HEAD` exist, so there is no state-changing request
to authorise or forge. [security-model.md](security-model.md) covers the
reasoning.

Each query parameter is validated by `src/server/query.ts`. A parameter
that is absent takes its default; a parameter that is present and wrong
is a 400 naming it, never a silent substitution. Each parser also bounds
what it accepts, so no request can ask the server for an unbounded amount
of work.

Backpressure on the event stream is handled rather than ignored. Each
subscriber writes only while its socket reports that it has drained, and
drops the events it missed instead of queueing them: the payload is the
current state of the machine, and the next one is a second or two behind
it.

Static files are served from the built dashboard directory. The resolved
path must be inside that directory and its extension must be one of a
handful, so no request can read a file the dashboard is not made of.

## The dashboard

The dashboard is a separate TypeScript program with no framework and no
chart library; the SVG charts are drawn by `src/web/chart.ts`. It
receives live samples over Server-Sent Events, keeps its own capped
buffer of 900 samples, and fetches history, processes, alerts, health and
configuration over the JSON API on a configurable interval. See
[dashboard.md](dashboard.md).

## Build

```sh
npm run build        # build:server then build:web
```

`build:server` compiles `src/` to `dist/` with `tsconfig.build.json`,
preserving the layout, so the entry point is `dist/bin/sable-monitor.js`.
`build:web` compiles `src/web` to `dist/web` with `tsconfig.web.json`,
then runs `scripts/copy-web.js` to place `index.html` and `styles.css`
beside the compiled modules, because `tsc` emits JavaScript and nothing
else.

`npm run verify` runs the type check, the linter, the format check, both
test projects and both builds. See [testing.md](testing.md).
