# HTTP API

The agent serves a read-only JSON API on the address it is bound to,
`http://127.0.0.1:7878` by default. There are seven JSON endpoints and
one event stream. Nothing in the API changes anything: there is no
endpoint that writes, acknowledges, terminates or executes.

## Conventions

Only `GET` and `HEAD` are accepted. Any other method is `405` before
routing. A request target longer than 2048 characters is `414`. Requests
are also subject to the `Host`, `Origin` and bearer-token checks
described in [security-model.md](security-model.md).

Responses are `application/json; charset=utf-8` with
`Cache-Control: no-store` and the security headers listed in the
security model. An unknown path under `/api/` is `404`; anything else is
served from the dashboard's static files.

Timestamps are integer milliseconds since the Unix epoch. Sizes are
bytes, rates are bytes per second, and percentages are 0 to 100.

A value that could not be measured is `null`, never `0`. The first
sample after startup has `null` for every rate, because a rate is a
difference between two readings. Consumers must treat `null` as "not
measured" and render it as such.

An error is always the same shape:

```json
{
  "error": {
    "status": 400,
    "message": "range must be one of 15m, 1h, 6h, 24h, 7d"
  }
}
```

| Status | Raised by                                              |
| ------ | ------------------------------------------------------ |
| `400`  | A query parameter is present and invalid               |
| `401`  | A token is configured and the request did not match it |
| `403`  | `Host` or `Origin` not allowed, or a path outside root |
| `404`  | No such endpoint or static file                        |
| `405`  | A method other than `GET` or `HEAD`                    |
| `414`  | Request target longer than 2048 characters             |
| `503`  | No sample yet, or the stream client limit is reached   |
| `500`  | An unhandled failure while serving the request         |

A parameter that is absent takes its documented default. A parameter
that is present and wrong is an error naming it, never a silent
substitution.

```sh
curl -s http://127.0.0.1:7878/api/health
curl -s -H 'Authorization: Bearer <token>' http://127.0.0.1:7878/api/system
```

## `GET /api/health`

Liveness and self-reported state of the agent.

```json
{
  "status": "ok",
  "agentRunning": true,
  "uptimeSeconds": 3600,
  "samplesCollected": 1800,
  "collectionErrors": 0,
  "lastSampleAt": 1731600000000,
  "lastSampleAgeMs": 412,
  "degraded": [],
  "storedPoints": 1799,
  "databaseBytes": 331776,
  "activeAlerts": 0,
  "streamClients": 1,
  "version": "1.0.0"
}
```

| Field              | Type                            | Meaning                                     |
| ------------------ | ------------------------------- | ------------------------------------------- |
| `status`           | `"ok"`, `"degraded"`, `"stale"` | Derived; see below                          |
| `agentRunning`     | boolean                         | Whether the sampling loop is active         |
| `uptimeSeconds`    | number                          | Since the agent started, not since boot     |
| `samplesCollected` | number                          | Successful samples this run                 |
| `collectionErrors` | number                          | Collector failures this run                 |
| `lastSampleAt`     | timestamp or `null`             | When the last sample succeeded              |
| `lastSampleAgeMs`  | number or `null`                | Age of that sample                          |
| `degraded`         | string[]                        | Collectors that failed in the last sample   |
| `storedPoints`     | number                          | Rows in the `metrics` table                 |
| `databaseBytes`    | number or `null`                | File size; `null` for an in-memory database |
| `activeAlerts`     | number                          | Alerts currently active                     |
| `streamClients`    | number                          | Open event-stream subscribers               |
| `version`          | string                          | Agent version                               |

`status` is `stale` when the last sample is older than five sampling
intervals, `degraded` when the last sample listed a failed collector,
and `ok` otherwise.

## `GET /api/system`

Static and slow-moving facts about the host.

```json
{
  "hostname": "workstation",
  "os": "Debian GNU/Linux 13 (trixie)",
  "kernel": "6.12.0-amd64",
  "architecture": "x64",
  "uptimeSeconds": 254100,
  "bootTime": 1731345900000,
  "logicalCpus": 12,
  "cpuModel": "Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz",
  "totalMemoryBytes": 33363492864,
  "agentVersion": "1.0.0",
  "nodeVersion": "24.0.0",
  "privileged": false
}
```

`os` is `PRETTY_NAME` from `/etc/os-release` or `/usr/lib/os-release`,
falling back to `Linux`. `cpuModel` is `null` on an architecture whose
`/proc/cpuinfo` does not carry `model name`. `privileged` is true when
the agent runs as uid 0.

Machine identifiers, serial numbers, MAC and IP addresses and the kernel
command line are not collected and not served.

## `GET /api/metrics/current`

The most recent sample. `503` with
`no sample has been collected yet` before the first one succeeds.

```json
{
  "timestamp": 1731600000000,
  "intervalMs": 2000,
  "cpu": {
    "usage": 7.42,
    "cores": [{ "index": 0, "usage": 11.2 }],
    "loadAverage": { "one": 0.84, "five": 0.73, "fifteen": 0.6 },
    "logicalCount": 12,
    "model": "Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz",
    "frequencyMhz": 2712,
    "iowait": 0.25,
    "steal": 0
  },
  "memory": {
    "totalBytes": 33363492864,
    "availableBytes": 24180989952,
    "usedBytes": 9182502912,
    "freeBytes": 12894912512,
    "buffersBytes": 331350016,
    "cachedBytes": 9804800000,
    "usage": 27.52,
    "swapTotalBytes": 8589934592,
    "swapUsedBytes": 0,
    "swapUsage": 0
  },
  "disk": {
    "filesystems": [],
    "devices": [],
    "totalBytes": 998611877888,
    "usedBytes": 412316860416,
    "availableBytes": 586295017472,
    "usage": 41.29,
    "readBytesPerSecond": 0,
    "writeBytesPerSecond": 131072
  },
  "network": {
    "interfaces": [],
    "receiveBytesPerSecond": 4096,
    "transmitBytesPerSecond": 1024,
    "receivedBytes": 8123456789,
    "transmittedBytes": 912345678
  },
  "degraded": []
}
```

`filesystems`, `devices` and `interfaces` are shown empty above only to
keep the example short. Their contents are described below.

### `cpu`

| Field          | Type             | Meaning                                              |
| -------------- | ---------------- | ---------------------------------------------------- |
| `usage`        | number or `null` | Busy time over the interval, all logical CPUs        |
| `cores`        | array            | `{ index, usage }` per logical CPU; empty first time |
| `loadAverage`  | object           | `one`, `five`, `fifteen` from `/proc/loadavg`        |
| `logicalCount` | number           | Logical CPUs the kernel reports                      |
| `model`        | string or `null` | From `/proc/cpuinfo`                                 |
| `frequencyMhz` | number or `null` | Mean current frequency over the CPUs that report one |
| `iowait`       | number or `null` | Share of the interval blocked on I/O                 |
| `steal`        | number or `null` | Share of the interval taken by a hypervisor          |

`guest` and `guest_nice` ticks are excluded from the denominator,
because the kernel already counts them inside `user` and `nice`.

### `memory`

Used memory is `MemTotal - MemAvailable`, so reclaimable page cache is
not counted as used. On a kernel too old to publish `MemAvailable`, the
collector falls back to `MemFree + Buffers + Cached`.

| Field                             | Type             |
| --------------------------------- | ---------------- |
| `totalBytes`, `availableBytes`    | number           |
| `usedBytes`, `freeBytes`          | number           |
| `buffersBytes`, `cachedBytes`     | number           |
| `usage`                           | number           |
| `swapTotalBytes`, `swapUsedBytes` | number           |
| `swapUsage`                       | number or `null` |

`cachedBytes` includes `SReclaimable`. `swapUsage` is `null` when the
host has no swap configured.

### `disk`

`filesystems` is one entry per real mounted filesystem:

| Field            | Type    | Meaning                                       |
| ---------------- | ------- | --------------------------------------------- |
| `device`         | string  | As it appears in `/proc/self/mounts`          |
| `mountPoint`     | string  | Mount point                                   |
| `fsType`         | string  | Filesystem type                               |
| `totalBytes`     | number  | Size from `statfs`                            |
| `usedBytes`      | number  | Total minus free                              |
| `availableBytes` | number  | Space an unprivileged user may use            |
| `usage`          | number  | Used as a percentage of what the user can use |
| `readOnly`       | boolean | Mounted with `ro`                             |

Pseudo filesystems — `proc`, `sysfs`, `tmpfs`, `overlay`, cgroups and the
rest — are excluded entirely. Reserved blocks count as neither used nor
available, so `usage` reflects what the user can actually reach.

`devices` is one entry per whole block device, from `/proc/diskstats`:

| Field                 | Type             | Meaning                                  |
| --------------------- | ---------------- | ---------------------------------------- |
| `device`              | string           | Kernel device name                       |
| `readBytesPerSecond`  | number or `null` | 512-byte sectors scaled to bytes         |
| `writeBytesPerSecond` | number or `null` |                                          |
| `readsPerSecond`      | number or `null` | Completed operations                     |
| `writesPerSecond`     | number or `null` |                                          |
| `utilisation`         | number or `null` | Share of the interval with I/O in flight |

Partitions and `loop`, `ram`, `zram` and `fd` devices are excluded.
`devices` is empty on the first sample, because throughput needs two
readings.

The top-level `totalBytes`, `usedBytes`, `availableBytes` and `usage`
are totals over the distinct filesystems; a filesystem mounted more than
once is counted once. `readBytesPerSecond` and `writeBytesPerSecond` are
totals over the devices, and are `null` when no device produced a rate.
Capacity and throughput describe different things and cannot be
combined; see [known-limitations.md](known-limitations.md).

### `network`

`interfaces` is one entry per interface in `/proc/net/dev`:

| Field                                   | Type             |
| --------------------------------------- | ---------------- |
| `name`                                  | string           |
| `receivedBytes`, `transmittedBytes`     | number           |
| `receivedPackets`, `transmittedPackets` | number           |
| `receiveErrors`, `transmitErrors`       | number           |
| `receiveBytesPerSecond`                 | number or `null` |
| `transmitBytesPerSecond`                | number or `null` |
| `state`                                 | string           |
| `loopback`                              | boolean          |

`state` is whatever `/sys/class/net/<name>/operstate` reports — `up`,
`down`, `unknown` — or `unknown` when the file cannot be read.

The top-level totals cover non-loopback interfaces only, so local socket
traffic is not reported as network throughput. Latency and packet loss
are not measured anywhere.

### `degraded`

The names of the collectors — `cpu`, `memory`, `disk`, `network` — that
threw while this sample was taken. The rest of the sample is still
valid. A sample in which `cpu` or `memory` failed is discarded and never
served.

## `GET /api/metrics/history`

Stored history for a window.

| Parameter | Default | Accepted                       |
| --------- | ------- | ------------------------------ |
| `range`   | `1h`    | `15m`, `1h`, `6h`, `24h`, `7d` |
| `from`    | `0`     | Milliseconds since the epoch   |
| `to`      | now     | Milliseconds since the epoch   |
| `limit`   | `600`   | 1 to 5000                      |

`range` cannot be combined with `from` or `to`; doing so is a `400`, as
is a `from` later than `to`.

```json
{
  "from": 1731596400000,
  "to": 1731600000000,
  "count": 360,
  "retainedFrom": 1731000000000,
  "points": [
    {
      "timestamp": 1731596400000,
      "cpu": 7.42,
      "memory": 27.52,
      "swap": 0,
      "disk": 41.29,
      "diskReadBps": 0,
      "diskWriteBps": 131072,
      "netRxBps": 4096,
      "netTxBps": 1024,
      "load1": 0.84
    }
  ]
}
```

`retainedFrom` is the timestamp of the oldest row in the database, or
`null` when there are none, so a client can show where history begins
rather than implying it goes back for ever.

A history point carries only the nine aggregate values stored per
sample. Per-core, per-filesystem, per-device and per-interface detail is
available live but is not kept.

When the window holds more rows than `limit`, every nth stored row is
returned, with n chosen so the result fits. The rows are real stored
samples: nothing is interpolated or averaged, so a period when the agent
was not running is a gap in the series rather than a flat line.

```sh
curl -s 'http://127.0.0.1:7878/api/metrics/history?range=24h&limit=1000'
curl -s 'http://127.0.0.1:7878/api/metrics/history?from=1731000000000&to=1731003600000'
```

## `GET /api/processes`

A fresh reading of the process table, taken when the request arrives.

| Parameter   | Default | Accepted                                 |
| ----------- | ------- | ---------------------------------------- |
| `search`    | empty   | Up to 64 characters                      |
| `sort`      | `cpu`   | `cpu`, `memory`, `pid`, `name`, `uptime` |
| `direction` | `desc`  | `asc`, `desc`                            |
| `limit`     | `100`   | 1 to `collection.processRows`            |

`search` matches a case-insensitive substring of the process name, or an
exact process identifier. The default and maximum for `limit` both come
from `collection.processRows`.

```json
{
  "timestamp": 1731600000000,
  "total": 467,
  "returned": 100,
  "processes": [
    {
      "pid": 2841,
      "ppid": 1,
      "name": "node",
      "state": "S",
      "cpu": 3.5,
      "memoryBytes": 184549376,
      "memory": 0.55,
      "threads": 11,
      "uptimeSeconds": 8123
    }
  ]
}
```

`total` is the number of processes read, before filtering; `returned` is
how many are in the array.

`name` is the executable name from `/proc/<pid>/stat` and is the only
identifying string served. Command-line arguments, the environment, the
working directory, open file descriptors and memory maps are never read.

`cpu` is a share of **one** logical CPU, so a busy multi-threaded
process can exceed 100%. It is `null` on the first reading of a process,
and `null` again if the identifier was reused since the previous
reading, which is detected by comparing process start times.

`state` is the single-letter state from the kernel: `R`, `S`, `D`, `Z`,
`T` and the rest. Processes hidden by `hidepid`, and processes that exit
between the directory listing and the read, are skipped silently.

```sh
curl -s 'http://127.0.0.1:7878/api/processes?search=node&sort=memory&limit=20'
```

## `GET /api/alerts`

| Parameter | Default | Accepted             |
| --------- | ------- | -------------------- |
| `state`   | both    | `active`, `resolved` |
| `limit`   | `100`   | 1 to 1000            |

```json
{
  "active": [
    {
      "id": 42,
      "rule": "disk-low",
      "severity": "critical",
      "state": "active",
      "scope": "/home",
      "message": "Filesystem /home is 92.4% full, above the 90.0% threshold",
      "value": 92.4,
      "threshold": 90,
      "startedAt": 1731599000000,
      "resolvedAt": null
    }
  ],
  "alerts": []
}
```

`active` is always every currently active alert, newest first, whatever
`state` and `limit` say. `alerts` is the filtered, limited history, also
newest first. `scope` names the subject of the alert — a mount point for
`disk-low` — and is `null` for rules that apply to the host as a whole.

Alerts are local. Nothing is sent anywhere: there is no email, SMS or
webhook delivery in Sable Monitor. See [agent.md](agent.md).

## `GET /api/config`

The configuration the dashboard is allowed to see.

```json
{
  "version": "1.0.0",
  "apiVersion": 1,
  "collection": { "intervalMs": 2000, "bufferSize": 900, "processRows": 100 },
  "storage": { "retentionDays": 7, "writeIntervalMs": 10000 },
  "alerts": {
    "enabled": true,
    "rules": [
      {
        "id": "cpu-high",
        "enabled": true,
        "threshold": 90,
        "clearThreshold": 80,
        "forSeconds": 120,
        "cooldownSeconds": 600,
        "severity": "warning"
      }
    ]
  },
  "security": {
    "host": "127.0.0.1",
    "port": 7878,
    "tokenRequired": false,
    "remoteAccess": false
  }
}
```

The token is not included under any name, and neither is the database
path. `tokenRequired` says whether a token is configured, not what it
is.

## `GET /api/stream`

Server-Sent Events. `Content-Type: text/event-stream; charset=utf-8`,
with `X-Accel-Buffering: no` so that an intermediary does not buffer a
stream whose purpose is to arrive promptly.

The stream opens with a `retry: 2000` directive, then the current sample
if one exists. A `: keep-alive` comment is sent every 20 seconds.

Two event types are emitted:

```text
event: metrics
data: {"timestamp":1731600000000,"intervalMs":2000,...}

event: alert
data: {"kind":"raised","alert":{"id":42,"rule":"disk-low",...}}
```

`metrics` carries the same object as `/api/metrics/current`, once per
successful sample. `alert` carries `{ kind, alert }`, where `kind` is
`raised` or `resolved`.

A subscriber whose socket has not drained has events dropped rather than
queued: the payload is the current state of the machine, and the next
one supersedes it. When `server.maxStreamClients` subscribers are
already connected, a further request is `503`
`too many stream clients`.

```sh
curl -N http://127.0.0.1:7878/api/stream
```

```js
const source = new EventSource('/api/stream');
source.addEventListener('metrics', (event) => {
  const sample = JSON.parse(event.data);
  console.log(sample.cpu.usage);
});
```

## Versioning

`/api/config` reports `apiVersion`, currently `1`. The field exists so a
client can refuse to interpret a response shape it does not know.
