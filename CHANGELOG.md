# Changelog

All notable changes to Sable Monitor are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `minimatch` is pinned to `^11.0.1` through an override, resolving a moderate
  advisory reached through the ESLint toolchain. Development dependencies only;
  the published package still has no runtime dependencies.

## [1.0.0] — 2026-11-14

First release.

### Added

- A monitoring agent that samples the host on a configurable timer,
  reading CPU times from `/proc/stat`, memory from `/proc/meminfo`,
  filesystem capacity through `statfs`, block device activity from
  `/proc/diskstats`, interface counters from `/proc/net/dev` and link
  state from `/sys/class/net`.
- Utilisation and throughput computed from the difference between two
  readings, with counter resets, hot-plugged CPUs, new interfaces and
  reused PIDs each reported as unmeasured rather than as a spike.
- Memory accounting based on `MemAvailable`, with a documented fallback
  for kernels that predate it, so reclaimable page cache is not counted as
  used.
- Filesystem totals that exclude pseudo filesystems and count a filesystem
  mounted more than once only once; device throughput that excludes
  partitions and loop, ram and zram devices.
- Process inspection from `/proc/<pid>/stat` with sorting, filtering and
  search. Command lines, environments, working directories, open file
  descriptors and memory maps are never read.
- Historical storage in a local SQLite database through Node's built-in
  `node:sqlite`, with schema migrations, write-ahead logging, batched
  writes, indexed timestamps, configurable retention and automatic
  cleanup. The database and its directory are created with owner-only
  permissions.
- An alerting engine with five rules — high CPU, high memory, low disk
  space, high sustained load and stale agent data — each with a
  configurable threshold, evaluation window, hysteresis and cooldown.
  Alerts are recorded locally and are never sent anywhere.
- A read-only HTTP API: `/api/health`, `/api/system`,
  `/api/metrics/current`, `/api/metrics/history`, `/api/processes`,
  `/api/alerts`, `/api/config` and a Server-Sent Events stream at
  `/api/stream`, with validated inputs and bounded responses.
- A dashboard of eight views — overview, CPU, memory, disk, network,
  processes, alerts and system — built as plain ES modules with hand-drawn
  SVG charts, live updates over the event stream, automatic reconnection,
  a visible connection status and configurable refresh intervals.
- Loopback-only defaults, `Host` and `Origin` validation against DNS
  rebinding, a strict content security policy, and an optional bearer
  token that becomes mandatory when the server is bound off loopback.
- Configuration from a JSON file, `SABLE_MONITOR_*` environment variables
  and command-line flags, validated as a whole with every problem reported
  at once, and a `check` subcommand that validates and exits.
- Graceful shutdown on `SIGINT` and `SIGTERM`: buffered samples are
  written, active alerts are resolved and the write-ahead log is folded
  back into the database.
- A benchmark, `npm run bench`, that measures collection latency, CPU
  cost, resident memory and stored size on the machine it is run on.

[1.0.0]: https://github.com/sablectl/sable-monitor/releases/tag/v1.0.0
