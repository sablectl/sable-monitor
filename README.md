# Sable Monitor

**Real-time Linux monitoring and diagnostics** — a local metrics agent, a
historical store, configurable alerts and a terminal-styled web dashboard.

[![CI](https://github.com/sablectl/sable-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/sablectl/sable-monitor/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Sable Monitor watches one Linux machine and tells you what it is doing. It
reads the kernel's own interfaces — `/proc`, `/sys` and `statfs` — samples
them on a timer, keeps a bounded history in a local SQLite database, raises
alerts against thresholds you set, and serves all of it to a dashboard bound
to the loopback address.

It has no runtime dependencies. Storage is Node's built-in SQLite, the server
is `node:http`, and the dashboard is plain ES modules with hand-drawn SVG
charts, so there is nothing to compile at install time and nothing to audit
beyond this repository.

## What it does

- **CPU** — overall and per-core utilisation computed from counter deltas,
  load averages, logical CPU count, model and current frequency where the
  kernel publishes them, and I/O wait and steal time.
- **Memory** — total, available, used, free, buffers, cache and swap. Used
  memory is `MemTotal - MemAvailable`, so reclaimable page cache is not
  counted against you.
- **Disk** — capacity per mounted filesystem from `statfs`, and read and
  write throughput and busy time per block device from `/proc/diskstats`.
  Pseudo filesystems are excluded, a filesystem mounted twice is counted
  once, and partitions are not added to the devices they sit on.
- **Network** — per-interface counters and throughput from `/proc/net/dev`
  with link state from `/sys`, handling counter resets and interfaces that
  appear or disappear. Loopback is excluded from the totals.
- **Processes** — a searchable, sortable table of PID, name, state, CPU,
  resident memory, thread count and uptime.
- **History** — one narrow row per sample in a local database, with
  configurable retention, automatic cleanup and indexed timestamps.
- **Alerts** — thresholds for CPU, memory, disk, load and stale data, with
  an evaluation window, hysteresis and a cooldown, held locally and shown on
  the dashboard.
- **Dashboard** — eight views, live updates over Server-Sent Events,
  automatic reconnection and a visible connection status.

Anything the kernel does not report is reported as unavailable. A rate needs
two readings, so the first sample has none; a counter that went backwards is
a reset, not a spike; a period when the agent was not running stays a gap in
the chart. Sable Monitor never substitutes a zero for a measurement it does
not have.

## What it does not do

It does not kill processes, run commands, change any setting on the host,
install a service, open a firewall port or send anything anywhere. It reads,
stores locally and displays. There is no telemetry, and no endpoint that
changes state.

## Requirements

- **Linux.** The collectors read `/proc` and `/sys`. macOS and Windows are
  not supported.
- **Node.js 24 or later.** `node:sqlite` is available without a flag from 24. CI runs 24 and 26.
- **No runtime dependencies.** Nothing is installed at run time.

Root is not required and not recommended. Everything Sable Monitor reads is
world readable on a stock kernel.

## Install

Sable Monitor is distributed through GitHub only. **It is not published to
npm.** If you find a package by this name on a registry, it is not this
project.

### From a release tarball

```sh
base=https://github.com/sablectl/sable-monitor/releases/download/v1.0.0
curl -fsSLO "$base/sable-monitor-v1.0.0.tar.gz"
curl -fsSLO "$base/sable-monitor-v1.0.0.tar.gz.sha256"
sha256sum -c sable-monitor-v1.0.0.tar.gz.sha256
tar -xzf sable-monitor-v1.0.0.tar.gz
cd sable-monitor-v1.0.0
node dist/bin/sable-monitor.js --version
```

### From source

```sh
git clone https://github.com/sablectl/sable-monitor.git
cd sable-monitor
npm ci
npm run build
node dist/bin/sable-monitor.js --version
```

Full instructions, including a systemd user service example and how to
uninstall, are in [docs/installation.md](docs/installation.md).

## Use

```sh
node dist/bin/sable-monitor.js start
```

```text
sable-monitor 1.0.0
  configuration  defaults (no file)
  dashboard      http://127.0.0.1:7878
  sampling       every 2000 ms
  database       /home/you/.local/state/sable-monitor/metrics.db
  retention      7 days
  alerts         enabled
  authentication none (loopback only)
```

Open <http://127.0.0.1:7878> in a browser on the same machine. Press Ctrl-C,
or send `SIGTERM`, to stop: the agent writes what it has buffered, resolves
its active alerts and closes the database.

Useful flags:

```sh
sable-monitor start --port 9000 --interval 5000 --retention-days 30
sable-monitor start --db /srv/monitor/metrics.db --config ./monitor.json
sable-monitor check          # validate the configuration and exit
sable-monitor --help
```

Everything a flag can set can also be set in
`~/.config/sable-monitor/config.json` or through a `SABLE_MONITOR_*`
environment variable. The reference is
[docs/configuration.md](docs/configuration.md).

## Reaching it from another machine

Do not expose the port. Forward it over SSH:

```sh
ssh -N -L 7878:127.0.0.1:7878 you@host
```

Then open <http://127.0.0.1:7878> locally. A private network such as
Tailscale works equally well.

Binding to an address other machines can reach is possible and deliberately
awkward: it requires both `server.allowRemote` and a `server.token` of at
least sixteen characters, and startup fails with an explanation if either is
missing. See [docs/security-model.md](docs/security-model.md).

## API

Eight read-only endpoints and one event stream, all served from the same
origin as the dashboard.

```text
GET /api/health           agent state, sample counts, storage size
GET /api/system           hostname, OS, kernel, architecture, uptime
GET /api/metrics/current  the most recent sample
GET /api/metrics/history  ?range=15m|1h|6h|24h|7d or ?from=&to=
GET /api/processes        ?search=&sort=&direction=&limit=
GET /api/alerts           ?state=active|resolved&limit=
GET /api/config           the settings, without the token or database path
GET /api/stream           Server-Sent Events: metrics and alerts
```

Only `GET` and `HEAD` exist; anything else is refused with 405. Response
schemas and error codes are in [docs/api.md](docs/api.md).

## Security

A monitoring tool knows a great deal about a machine, so the defaults are
the careful ones.

- Bound to `127.0.0.1`, with no port opened and no service installed.
- `Host` and `Origin` are checked on every request, which is what stops a
  web page — or a hostile name that resolves to `127.0.0.1` — from reading
  the API. Binding to loopback is not treated as sufficient on its own.
- No state-changing request exists, so there is nothing to forge.
- A strict content security policy, `nosniff`, `no-referrer` and
  `Cache-Control: no-store` on every response.
- Process command lines, environments, working directories and open file
  descriptors are never read, so credentials passed as arguments cannot
  leak through the dashboard.
- The database and its directory are created with owner-only permissions.
- An optional bearer token, compared in constant time, and required when
  the server is not on loopback.

The full model, including what is explicitly out of scope, is in
[docs/security-model.md](docs/security-model.md). Report a vulnerability
through [SECURITY.md](SECURITY.md).

## Performance

Measured with `npm run bench` on one laptop — Node v26.3.1, linux-x64, an
Intel Core i7-8750H with 12 logical CPUs and 467 running processes. These
are measurements from one machine, not guarantees:

| Measurement                       | Result                 |
| --------------------------------- | ---------------------- |
| Collection, mean                  | 5.05 ms per sample     |
| Collection, 95th percentile       | 5.82 ms per sample     |
| CPU cost                          | 5.11 ms per sample     |
| Equivalent duty at a 1 s interval | 0.51% of one core      |
| Resident memory                   | 87.92 MiB              |
| Stored size                       | 184.3 bytes per sample |
| Seven days at the 2 s default     | about 53 MiB           |
| Listing 467 processes             | 70.64 ms               |

Run the benchmark yourself rather than trusting the table:

```sh
npm run build && npm run bench
```

## Documentation

| Document                                       | Contents                                     |
| ---------------------------------------------- | -------------------------------------------- |
| [Installation](docs/installation.md)           | Install, run, autostart, uninstall           |
| [Configuration](docs/configuration.md)         | Every setting, with defaults and precedence  |
| [Dashboard](docs/dashboard.md)                 | The eight views and what each number means   |
| [API](docs/api.md)                             | Endpoints, schemas, errors, the event stream |
| [Monitoring agent](docs/agent.md)              | Sampling, degradation, alerts, shutdown      |
| [Architecture](docs/architecture.md)           | How the pieces fit together, and why         |
| [Security model](docs/security-model.md)       | Guarantees, threat model, remote access      |
| [Performance](docs/performance.md)             | What was measured and how to repeat it       |
| [Troubleshooting](docs/troubleshooting.md)     | Symptoms and what they mean                  |
| [Known limitations](docs/known-limitations.md) | What is wrong, missing or approximate        |
| [Testing](docs/testing.md)                     | How the suites are organised and run         |

## Development

```sh
npm ci
npm run verify   # type check, lint, format, unit, integration, build
```

Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md)
first. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Known limitations

- `USER_HZ` is assumed to be 100 and the page size 4096 bytes. On a kernel
  built with a different clock rate, or with 16K or 64K pages, per-process
  CPU and resident memory are wrong by that ratio.
- Per-process CPU is a share of one logical CPU, and is unavailable on the
  first read because it is a rate.
- Disk throughput is a property of block devices and capacity is a property
  of filesystems. Both are reported; they cannot be added together.
- Network latency and packet loss are not measured, and so are not shown.
- Container and cgroup-aware accounting, temperature, fan, SMART and GPU
  metrics, and monitoring more than one host, are all absent.
- A history window holding more rows than the request limit is thinned by
  taking every nth stored row. The points returned are real samples; none
  is interpolated.
- The dashboard is built to be keyboard navigable and semantically marked
  up, and has not been tested with a screen reader.

The full list, with what would resolve each item, is in
[docs/known-limitations.md](docs/known-limitations.md).

## Licence and author

Released under the [MIT licence](LICENSE).

Written by Sable (<https://github.com/sablectl>) — <https://sablectl.dev>.
