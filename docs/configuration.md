# Configuration

Configuration is read once at startup and never reloaded from a request.
It comes from four places, each overriding the one before it:

```text
defaults  <  configuration file  <  environment  <  command line
```

Every default is the safe one. The server binds to the loopback address,
no token is set because none is needed to reach a loopback-only service,
and the database is written under the user's own state directory with
owner-only permissions.

To see the effective configuration without starting anything:

```sh
sable-monitor check
```

It prints the file it read, or `defaults, no file`, followed by the
merged configuration as JSON. A configured token is printed as `***`.

## The configuration file

The default path is `$XDG_CONFIG_HOME/sable-monitor/config.json`, or
`~/.config/sable-monitor/config.json` when `XDG_CONFIG_HOME` is unset or
not absolute.

A missing file at the default path is not an error: the defaults are a
working configuration. A missing file at a path named with `--config`
**is** an error, because silently ignoring what was asked for is worse
than refusing to start.

The file is JSON with four optional sections. An unknown section, an
unknown alert rule, a value of the wrong type and a value out of range
are all errors. Every problem is reported, not just the first:

```text
invalid configuration:
  - server.port must be between 1 and 65535
  - collection.intervalMs must be an integer
```

A complete file, showing every setting at its default:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7878,
    "allowRemote": false,
    "allowedHosts": [],
    "allowedOrigins": [],
    "token": null,
    "maxRequestBytes": 16384,
    "maxStreamClients": 16
  },
  "collection": {
    "intervalMs": 2000,
    "bufferSize": 900,
    "processRows": 100
  },
  "storage": {
    "path": "~/.local/state/sable-monitor/metrics.db",
    "retentionDays": 7,
    "writeIntervalMs": 10000,
    "cleanupIntervalMs": 3600000
  },
  "alerts": {
    "enabled": true,
    "historyLimit": 1000,
    "rules": {}
  }
}
```

`storage.path` is shown expanded for readability; the real default is
derived at startup, and a path given in the file is resolved against the
working directory. A tilde is not expanded — write an absolute path.

## `server`

| Setting            | Default     | Range        | Meaning                             |
| ------------------ | ----------- | ------------ | ----------------------------------- |
| `host`             | `127.0.0.1` | any address  | Address to bind                     |
| `port`             | `7878`      | 1–65535      | Port to bind                        |
| `allowRemote`      | `false`     | boolean      | Confirms binding off loopback       |
| `allowedHosts`     | `[]`        | strings      | Extra accepted `Host` header values |
| `allowedOrigins`   | `[]`        | strings      | Exact origins allowed cross-origin  |
| `token`            | `null`      | ≥ 16 chars   | Required in `Authorization: Bearer` |
| `maxRequestBytes`  | `16384`     | 1024–1048576 | Largest accepted request head       |
| `maxStreamClients` | `16`        | 1–256        | Concurrent event-stream subscribers |

Two validation rules apply to the first three together. A non-loopback
`host` without `allowRemote: true` is refused, and a non-loopback `host`
with `allowRemote: true` but no `token` is refused as well. A token
shorter than 16 characters is always refused. The reasoning is in
[security-model.md](security-model.md), which also explains why an SSH
tunnel is the recommended alternative to binding off loopback.

`maxRequestBytes` bounds the request head — the request line and all of
the headers together — because no endpoint accepts a body, so the head is
everything a client can send. A request larger than this is answered with
431 and the connection is closed, which caps what one client can make the
server buffer. Two narrower limits apply as well: a request target may
not exceed 2048 characters, and no request may carry more than 64
headers.

`allowedHosts` and `allowedOrigins` are only needed when the dashboard is
reached through a name or a proxy that the server would otherwise refuse.
Loopback names, the configured `host` and the configured port are already
accepted without any entry.

## `collection`

| Setting       | Default | Range      | Meaning                                  |
| ------------- | ------- | ---------- | ---------------------------------------- |
| `intervalMs`  | `2000`  | 500–300000 | Milliseconds between samples             |
| `bufferSize`  | `900`   | 10–10000   | Samples held in memory for the live view |
| `processRows` | `100`   | 1–500      | Default and maximum process rows         |

`bufferSize` sets how far back the live charts reach: 900 samples at the
default interval is 30 minutes. Anything older comes from the history
API instead.

`processRows` is both the default for `/api/processes?limit=` and the
hard cap on it; a request asking for more is clamped rather than refused.

Lowering `intervalMs` raises the cost of collection proportionally — see
[performance.md](performance.md) — and raises the rate at which the
database grows.

## `storage`

| Setting             | Default         | Range          | Meaning                     |
| ------------------- | --------------- | -------------- | --------------------------- |
| `path`              | state directory | absolute path  | The SQLite file             |
| `retentionDays`     | `7`             | 1–365          | Days of history kept        |
| `writeIntervalMs`   | `10000`         | 1000–600000    | Milliseconds between writes |
| `cleanupIntervalMs` | `3600000`       | 60000–86400000 | Milliseconds between sweeps |

The default path is `$XDG_STATE_HOME/sable-monitor/metrics.db`, or
`~/.local/state/sable-monitor/metrics.db` when `XDG_STATE_HOME` is unset
or not absolute. The directory is created with mode 0700 and the
database file and its write-ahead log sidecars with mode 0600.

`writeIntervalMs` must not be shorter than `collection.intervalMs`;
configuring it that way is a validation error. Samples accumulate in
memory between writes, so a longer interval means fewer, larger
transactions and more samples lost if the process is killed with
`SIGKILL`.

The retention sweep deletes metric rows older than `retentionDays` and
trims resolved alerts beyond `alerts.historyLimit`. An active alert is
never deleted, however old it is. Deleted space is not returned to the
filesystem automatically; the store exposes a `VACUUM`, but the agent
does not run it on a timer.

Set `path` to `:memory:` to run without touching the disk at all. History
then lasts only as long as the process.

## `alerts`

| Setting        | Default | Range     | Meaning                  |
| -------------- | ------- | --------- | ------------------------ |
| `enabled`      | `true`  | boolean   | Evaluate rules at all    |
| `historyLimit` | `1000`  | 10–100000 | Resolved alert rows kept |
| `rules`        | `{}`    | object    | Per-rule overrides       |

`rules` is an object keyed by rule identifier; any key that is not one of
the five known rules is an error. Each entry may override `enabled`,
`threshold`, `clearThreshold`, `forSeconds`, `cooldownSeconds` and
`severity`, and anything omitted keeps its default. `clearThreshold` must
not be greater than `threshold`; equal values are allowed and simply
disable hysteresis.

```json
{
  "alerts": {
    "rules": {
      "cpu-high": { "threshold": 95, "clearThreshold": 85 },
      "load-high": { "severity": "critical" },
      "agent-stale": { "enabled": false }
    }
  }
}
```

The rules, their units and their defaults are documented in
[agent.md](agent.md).

## Environment variables

Environment variables override the file and are overridden by the
command line. Only a subset of the settings has one.

| Variable                       | Setting                 |
| ------------------------------ | ----------------------- |
| `SABLE_MONITOR_HOST`           | `server.host`           |
| `SABLE_MONITOR_PORT`           | `server.port`           |
| `SABLE_MONITOR_TOKEN`          | `server.token`          |
| `SABLE_MONITOR_ALLOW_REMOTE`   | `server.allowRemote`    |
| `SABLE_MONITOR_INTERVAL_MS`    | `collection.intervalMs` |
| `SABLE_MONITOR_DB`             | `storage.path`          |
| `SABLE_MONITOR_RETENTION_DAYS` | `storage.retentionDays` |

`SABLE_MONITOR_ALLOW_REMOTE` is true only for the exact string `true`;
anything else is false. The numeric variables are not coerced quietly: a
value that is not a number produces the same validation error a bad file
would, rather than falling back to the default.

A token in the environment is visible in `/proc/<pid>/environ` to the
user who owns the process and to root, and may be recorded in a shell
history file. Sable Monitor itself never reads any process's environment
— see [security-model.md](security-model.md) — but other tools on the
machine can.

## Command-line flags

Flags override everything else. Unknown flags are an error, not a
warning.

| Flag                   | Setting                 |
| ---------------------- | ----------------------- |
| `--config <path>`      | configuration file path |
| `--host <address>`     | `server.host`           |
| `--port <number>`      | `server.port`           |
| `--interval <ms>`      | `collection.intervalMs` |
| `--db <path>`          | `storage.path`          |
| `--retention-days <n>` | `storage.retentionDays` |

There is no `--token` flag. A command line is visible to every user on
the machine through `/proc`, so the token is accepted from the
configuration file and the environment only.

```sh
sable-monitor --config ./monitor.json --interval 5000 --retention-days 30
sable-monitor check --config ./monitor.json
```

`--version`, `-V`, `--help` and `-h` print and exit 0. A usage error
exits 2, as does an invalid configuration.

## Worked example

Sampling every five seconds, thirty days of history in a chosen
location, a quieter CPU rule and the staleness rule left alone:

```json
{
  "collection": { "intervalMs": 5000, "bufferSize": 720 },
  "storage": {
    "path": "/srv/monitoring/metrics.db",
    "retentionDays": 30,
    "writeIntervalMs": 30000
  },
  "alerts": {
    "rules": {
      "cpu-high": {
        "threshold": 95,
        "clearThreshold": 85,
        "forSeconds": 300
      }
    }
  }
}
```

Validate it before relying on it:

```sh
sable-monitor check --config /srv/monitoring/config.json
```
