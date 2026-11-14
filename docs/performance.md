# Performance

Every figure below was measured, on one machine, with the benchmark in
this repository. They are measurements, not guarantees: a different
processor, a different kernel, a different number of processes or a
busy disk will give different numbers. Reproduce them yourself before
relying on them.

```sh
npm run build && npm run bench
```

## The benchmark

`scripts/bench.js` builds a real agent with a real SQLite database in a
temporary directory, takes a fixed number of samples back to back, and
reports what they cost: elapsed time per sample, CPU time actually
consumed, resident memory actually used and bytes actually written.

It takes two optional arguments — the number of samples and the interval
used to express the duty cycle:

```sh
node scripts/bench.js 200 1000
```

The sampling and write timers are set to five minutes during the run, so
nothing fires in the background and the loop is driven directly. A
process listing is timed separately rather than being hidden in the
average, because it is the most expensive thing the agent does and it
happens only when `/api/processes` is requested. The temporary directory
is removed afterwards.

## Measured results

Measured on one laptop: Node v26.3.1, linux-x64, Intel Core i7-8750H,
12 logical CPUs, 467 processes running.

### Collection

| Measure         | Value   |
| --------------- | ------- |
| Mean            | 5.05 ms |
| Median          | 5.00 ms |
| 95th percentile | 5.82 ms |
| Slowest         | 7.89 ms |

One sample is four collectors: `/proc/stat`, `/proc/loadavg`,
`/proc/cpuinfo`, `/proc/meminfo`, `/proc/self/mounts`, a `statfs` per
mounted filesystem, `/proc/diskstats`, `/proc/net/dev` and one `/sys`
read per interface. The spread between the median and the slowest
sample is small because none of those reads touches a real device.

### Cost

| Measure                          | Value     |
| -------------------------------- | --------- |
| CPU time per sample              | 5.11 ms   |
| Duty cycle at a 1000 ms interval | 0.51%     |
| Resident memory                  | 87.92 MiB |
| Heap used                        | 13.83 MiB |

The duty cycle is CPU time per sample divided by the interval, so at the
default 2000 ms interval it is about half of the figure above. Resident
memory is dominated by the Node runtime itself rather than by the
agent's own data; the heap figure is the part that belongs to the
program.

### Storage

| Measure                                 | Value         |
| --------------------------------------- | ------------- |
| Per stored sample                       | 184.3 bytes   |
| Projected, 7 days at a 1000 ms interval | about 106 MiB |

At the default 2000 ms interval that projection halves, to roughly
53 MiB for the default seven-day retention. The projection is linear in
the sample rate and the retention window, so it is easy to scale: a
5000 ms interval over 30 days is of the same order as the one-second
seven-day figure.

Only nine aggregate values are stored per sample. Per-core,
per-filesystem, per-device and per-interface detail is served live and
never written, which is what keeps the row so small.

### Process listing

A listing of 467 processes took **70.64 ms**.

That is an order of magnitude more than a metrics sample, because it
opens and parses one file per process. It is why the process table is
read on request rather than on the sampling timer, and why the
dashboard's process view has its own refresh selector, defaulting to
five seconds, separate from the rest of the page.

## Tuning

| Change                           | Effect                                       |
| -------------------------------- | -------------------------------------------- |
| Longer `collection.intervalMs`   | Lower duty cycle and slower database growth  |
| Shorter `collection.intervalMs`  | Finer resolution at proportionally more cost |
| Longer `storage.writeIntervalMs` | Fewer, larger transactions                   |
| Lower `storage.retentionDays`    | Smaller database                             |
| Lower `collection.bufferSize`    | Less memory, shorter live charts             |
| Lower `collection.processRows`   | Cheaper process responses                    |

The sampling interval is the main control. Everything the agent costs —
CPU, disk writes, database growth — scales with it.

Reading history is bounded independently: a request is capped at 5000
points, and a window holding more rows than the limit is thinned by
taking every nth stored row, so a seven-day chart costs about the same
as a fifteen-minute one.

## What is not measured

There is no published benchmark of the HTTP layer, of concurrent stream
subscribers, or of behaviour on a machine with thousands of processes or
hundreds of mounted filesystems. Those would all be worth measuring and
have not been.
