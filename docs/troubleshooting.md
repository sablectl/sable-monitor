# Troubleshooting

Each entry quotes what is printed or returned, then explains what it
means and what to do.

Exit codes: 0 on success, 1 when startup fails, 2 for a usage error or
an invalid configuration, 130 when a second signal arrives during
shutdown.

## Startup

### The configuration is rejected

```text
invalid configuration:
  - server.port must be between 1 and 65535
  - alerts.rules.cpu-high.clearThreshold must not be greater than alerts.rules.cpu-high.threshold
```

Every problem is reported at once, each naming the setting by its full
path. Fix them all and run `sable-monitor check` to confirm before
starting. Exit code 2.

### The named configuration file does not exist

```text
invalid configuration:
  - configuration file not found: /etc/sable-monitor.json
```

A missing file at the default location is fine; a missing file at a path
given with `--config` is an error, because ignoring what was asked for
silently is worse than refusing to start. Check the path. Exit code 2.

### The configuration file is not valid JSON

```text
invalid configuration:
  - /home/user/.config/sable-monitor/config.json is not valid JSON: ...
```

The message carries the parser's own complaint, including the position.
A trailing comma and an unquoted key are the usual causes; JSON permits
neither, and there are no comments.

### Binding off loopback is refused

```text
invalid configuration:
  - server.host 0.0.0.0 is reachable from other machines; set
    server.allowRemote to true to confirm that is intended, and set
    server.token as well
```

or

```text
invalid configuration:
  - server.token is required when the server binds off loopback
```

Both are deliberate. Binding to an address other hosts can reach turns a
local diagnostic tool into a network service, so it needs
`server.allowRemote: true` **and** a token of at least 16 characters.
Prefer an SSH tunnel instead:

```sh
ssh -N -L 7878:127.0.0.1:7878 user@host
```

See [security-model.md](security-model.md).

### The port is in use

```text
failed to start: listen EADDRINUSE: address already in use 127.0.0.1:7878
```

Another process holds the port — often an earlier instance that has not
exited. Find it, or choose another port:

```sh
ss -ltnp 'sport = :7878'
sable-monitor --port 7879
```

Exit code 1.

### The database cannot be opened

The store is created before the agent starts, so a failure here is
reported as an uncaught error with a stack trace rather than through
the `failed to start:` path.

The message comes from SQLite or from the filesystem. Check that the
directory exists and is writable, that the filesystem is not full or
read-only, and that the path is not on a network filesystem where
locking is unreliable. `--db /tmp/metrics.db` isolates the problem
quickly.

### The database is from a newer version

```text
database at /home/user/.local/state/sable-monitor/metrics.db has schema
version 2, which is newer than this build understands (1)
```

An older build has been pointed at a database written by a newer one.
Run the newer build, or move the file aside and let a new one be
created. The file is never downgraded in place.

### An unknown argument

```text
unknown argument: --verbose
Run sable-monitor --help for usage.
```

Unknown flags are errors, not warnings. Exit code 2.

## While running

### `no sample has been collected yet`

```json
{ "error": { "status": 503, "message": "no sample has been collected yet" } }
```

`/api/metrics/current` returns this until the first sample succeeds. The
dashboard expects it on load and ignores it; the stream delivers the
first sample when it arrives. If it persists, the CPU or memory
collector is failing — check `/api/health` and the agent's output.

### The dashboard says `Reconnecting`

The event stream has dropped. The page reopens it with a delay that
doubles from 1 second to a maximum of 30, so a restarted agent is picked
up without reloading. If it stays in that state, confirm the agent is
running and that the stream is reachable:

```sh
curl -N http://127.0.0.1:7878/api/stream
```

### `too many stream clients`

```json
{ "error": { "status": 503, "message": "too many stream clients" } }
```

`server.maxStreamClients` subscribers — 16 by default — are already
connected. Close some dashboard tabs, or raise the setting.

### Health reports `stale`

The last sample is older than five sampling intervals. The process is
alive but the loop is not producing. Look at `collectionErrors` and
`degraded` in `/api/health`, and at the agent's standard error, which
carries one line per failed collector:

```text
[sable-monitor] disk: ENOENT: no such file or directory, open '/proc/self/mounts'
```

The `agent-stale` alert covers the same situation on its own schedule:
it fires once the last sample is more than 60 seconds old, whatever the
sampling interval is.

### Health reports `degraded`

One or more collectors threw while taking the last sample; their names
are in `degraded`. The rest of the sample is still accurate, and the
sample is still stored and served.

Files the collectors treat as optional — `/proc/cpuinfo`,
`/proc/diskstats`, `/sys/class/net/<name>/operstate` — do not degrade a
sample when they are missing; the values they would have supplied are
reported as `null` instead. A collector is only marked degraded when a
file it requires cannot be read.

### A metric shows an em dash

That is not a fault. An em dash means the value could not be measured,
as distinct from being zero. The first sample has no rates, a device or
interface seen for the first time has none for one interval, and a
counter that went backwards yields none for that interval. CPU
frequency, `iowait` and `steal` are permanently absent on some kernels
and hypervisors. See [agent.md](agent.md).

### A chart has gaps

The agent was not running during that period. History is never
interpolated: a gap is the honest representation of no measurement. The
panel also states where stored history begins, so a window reaching
further back than the retention period shows nothing before that point.

### History is empty for a recent range

Samples are written every `storage.writeIntervalMs`, 10 seconds by
default, and the very first sample of a run is never written because it
has no rates. Immediately after startup there is therefore nothing to
chart. The live charts, which read from memory, fill first.

### Processes show no CPU

The first request after startup establishes the baseline, so every
process reports `null`. The second request reports usage over the time
between the two. If a particular process keeps showing an em dash, its
identifier is being reused, or it is new since the previous reading.

### Fewer processes than expected

Processes hidden by the kernel's `hidepid` mount option are skipped
silently, as are processes that exit between the directory listing and
the read. `total` in the response is what the agent could read, not what
the kernel has.

### Disk usage does not match `df`

Three differences are deliberate. Reserved blocks count as neither used
nor available, so the percentage is measured against what an
unprivileged user can actually reach. Pseudo filesystems, including
`tmpfs`, are excluded. A filesystem mounted more than once counts once
towards the totals. See [known-limitations.md](known-limitations.md).

### Memory usage looks low compared to another tool

Used memory is `MemTotal - MemAvailable`, so reclaimable page cache and
buffers are not counted as used. A tool that counts them reports a
machine with plenty of headroom as nearly full.

## Requests

### `403 host not allowed`

The `Host` header does not name a host this server answers to. This is
the DNS rebinding defence. Reaching the dashboard through a name other
than a loopback name or the configured host requires that name in
`server.allowedHosts`. A `Host` naming a different port is also
refused.

### `403 origin not allowed`

A browser sent a cross-origin request from an origin that is not
allowed. Add the exact origin to `server.allowedOrigins` if it is
genuinely yours.

### `401 a bearer token is required`

A token is configured and the request did not present a matching one:

```sh
curl -H 'Authorization: Bearer <token>' http://127.0.0.1:7878/api/health
```

### `405 only GET and HEAD are supported`

The API is read-only. There is no endpoint that accepts `POST`, `PUT`,
`PATCH` or `DELETE`.

### `400` on a query parameter

```json
{
  "error": {
    "status": 400,
    "message": "range cannot be combined with from or to"
  }
}
```

The message names the parameter and what was expected. Parameters are
never silently corrected: a chart that quietly shows the last hour when
the last week was asked for would be a lie about the machine.

## The dashboard will not load

If the page is blank or the browser reports a missing script, the web
build has not run. `npm run build:server` alone does not produce
`dist/web`:

```sh
npm run build
```

A `404` for `/main.js` or `/styles.css` has the same cause.

## Diagnosing from the command line

```sh
sable-monitor check                                  # validate configuration
curl -s http://127.0.0.1:7878/api/health             # agent state
curl -s http://127.0.0.1:7878/api/config             # effective public settings
curl -sN http://127.0.0.1:7878/api/stream            # watch samples arrive
ls -l ~/.local/state/sable-monitor/                  # database and permissions
```

`/api/health` is the first thing to read: it reports whether the loop is
running, the age of the last sample, the collectors currently degraded,
the number of stored rows and the size of the database.
