# Known limitations

Everything on this page is real and current. It is here so that nobody
has to discover it from a wrong number on a chart.

## Kernel constants are assumed

Two values that vary between kernel builds are compiled in as constants,
because there is no portable way to ask libc for either of them from
Node.

- **USER_HZ is assumed to be 100.** The CPU times in
  `/proc/<pid>/stat` are counted in clock ticks. On a kernel built with
  a different clock rate, per-process CPU and process uptime are wrong
  by the ratio of the two rates.
- **The page size is assumed to be 4096 bytes.** The resident set in
  `/proc/<pid>/stat` is counted in pages. On a kernel built with 16K or
  64K pages, per-process resident memory is reported proportionally low.

Both constants are correct on x86-64 and on arm64 kernels in general
distribution. System-wide CPU and memory are unaffected: those come from
`/proc/stat` and `/proc/meminfo`, which do not depend on either value.

## Per-process CPU

It is a share of **one** logical CPU, so a busy multi-threaded process
can report more than 100%. This matches what other process tools report,
but it is not a share of the machine.

It is `null` on the first reading of a process, because a rate needs two
readings, and `null` again when a process identifier has been reused
since the previous reading, which is detected by comparing start times.
The dashboard shows both cases as an em dash.

## Disk capacity and disk throughput cannot be added

They measure different things from different sources. Capacity comes
from `statfs` on a mounted filesystem; throughput comes from the
counters of a whole block device in `/proc/diskstats`. One filesystem
can span several devices and one device can carry several filesystems,
so no arithmetic relates the two. They are reported, and displayed,
separately.

Partitions and `loop`, `ram`, `zram` and `fd` devices are excluded from
device throughput, so activity attributed to those is not counted
anywhere.

A filesystem mounted at more than one place — a bind mount, a Btrfs
subvolume — reports the same blocks each time. It appears once per mount
point in the per-filesystem list, but only its first mount point counts
towards the totals.

Pseudo filesystems are excluded entirely, which includes `tmpfs`. A
machine using `tmpfs` heavily will not see that reflected in disk usage.

## Network

Latency and packet loss are not measured. Nothing in the agent sends a
packet; it reads counters. There are no IPv6-specific metrics: the byte
and packet counters in `/proc/net/dev` are totals across address
families.

Throughput totals cover non-loopback interfaces only.

## No container awareness

Metrics are host-wide. There is no cgroup-aware accounting, no view of
an individual container and no awareness of a container's own limits.
Running the agent inside a container reports what that container can
see of the host, which is usually the host.

## Metrics that do not exist

There are no GPU metrics, no temperature, fan or power readings and no
SMART or disk-health data. There is no per-process I/O or per-process
network accounting.

## One host only

There is no aggregation across machines, no central collector, no remote
scrape endpoint in a federated format and no clustering. One agent
watches one host and serves one dashboard.

## History is thinned by sampling, not averaging

When a requested window holds more rows than the limit, every nth stored
row is returned. The points are real stored samples, which keeps them
honest, but a spike that falls between two chosen rows is not visible at
that zoom level. Narrow the range or raise `limit` to see it.

Only nine aggregate values are stored per sample. Per-core,
per-filesystem, per-device and per-interface detail is live only and
cannot be charted historically.

## Storage does not shrink automatically

The retention sweep deletes rows, but SQLite does not return the freed
pages to the filesystem by itself. The store exposes a `VACUUM`, and the
agent does not run it on a timer, so the file stays at its high-water
mark after retention is reduced.

## Platform

Linux only. The collectors read `/proc` and `/sys` directly, so macOS
and Windows are not supported and there is no plan recorded in this
repository to support them.

## Node.js and `node:sqlite`

Node.js 24 or later is required, because `node:sqlite` is unflagged from
that release. It is a relatively new standard-library module, and its
API and behaviour have changed across recent Node versions; an upgrade
of Node is therefore a change worth testing rather than assuming.

## Accessibility

The dashboard is semantic HTML, keyboard navigable and uses live regions
for the connection state and the process count. It has **not** been
tested with a screen reader, and no accessibility audit has been
performed. Treat the markup as a good-faith effort rather than as a
verified result.

## Transport security

The server speaks plain HTTP. There is no TLS, so binding off loopback
sends metrics, and any bearer token, in clear. Use an SSH tunnel, a
private network or a reverse proxy that terminates TLS; see
[security-model.md](security-model.md).
