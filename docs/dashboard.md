# Dashboard

The dashboard is served by the agent at the address it is bound to,
`http://127.0.0.1:7878` by default. It is a small TypeScript program
with no framework, no bundler and no chart library: the charts are SVG
drawn by `src/web/chart.ts`, and the styling is a grayscale terminal
theme in one stylesheet.

It is a client of the HTTP API like any other. It has no privileged
access, and it can do nothing that [api.md](api.md) does not describe.

## Views

Navigation is by URL fragment, so a view can be bookmarked and the back
button works.

| Fragment      | View      | Shows                                                 |
| ------------- | --------- | ----------------------------------------------------- |
| `#/overview`  | Overview  | Overall state, health, active alerts, four live stats |
| `#/cpu`       | CPU       | Total and per-core utilisation, load, processor facts |
| `#/memory`    | Memory    | Usage, breakdown, swap                                |
| `#/disk`      | Disk      | Filesystems, device throughput                        |
| `#/network`   | Network   | Throughput and per-interface counters                 |
| `#/processes` | Processes | The process table, searchable and sortable            |
| `#/alerts`    | Alerts    | Active alerts and recent history                      |
| `#/system`    | System    | Host facts and the agent's public configuration       |

An unknown fragment falls back to Overview.

### Overview

A single derived word — `OK`, `WARNING`, `CRITICAL`, `DEGRADED` or
`STALE` — over the health panel, followed by the agent's own state, the
list of active alerts, system uptime and hostname, and four live stats
with compact charts for CPU, memory, disk and network.

### CPU

Total utilisation with a live chart, the one-, five- and fifteen-minute
load averages shown both absolutely and per logical CPU, processor model
and logical CPU count, current frequency, I/O wait and steal, and a bar
per logical CPU. Below the live panels are history charts for
utilisation and for the one-minute load average.

### Memory

Usage as a percentage with a bar and a live chart that also carries
swap, a breakdown of total, used, available, free, cached and buffers,
and a swap panel. When the host has no swap, the panel says so rather
than drawing a zero.

### Disk

A table of filesystems and a table of per-device throughput — read,
write, reads per second, writes per second and busy share — with a live
throughput chart and history charts for usage and throughput.

Capacity comes from filesystems and throughput from whole block devices.
They are shown in separate tables because they measure different things
and cannot be added together.

### Network

Receive and transmit throughput with a live chart, and a table of
interfaces showing link state, current rates, cumulative bytes and
error counts. Loopback is labelled and excluded from the totals.
Latency and packet loss are not measured and are not shown.

### Processes

The process table, refreshed on its own interval — off, 2 s, 5 s or
10 s, defaulting to 5 s. A search box filters by name or exact process
identifier with a 250 ms debounce. Column headings sort: clicking a new
column sorts by it, clicking the current column reverses the direction.
Sorting and filtering are done by the agent, not in the browser.

The view states plainly that CPU is a share of one logical CPU, so a
busy multi-threaded process can exceed 100%, and that it is not measured
on the first read of a process.

Only the executable name is shown. Command-line arguments and
environment variables are never collected, so they cannot be displayed;
see [security-model.md](security-model.md). There is no way to signal or
stop a process from the dashboard.

### Alerts

Active alerts, then up to 100 recent alerts from the history. Each entry
carries its rule, severity, scope, message, the value that triggered it,
the threshold, and when it started and resolved.

### System

Two panels: host facts from `/api/system`, and the agent's public
configuration from `/api/config`. The two are fetched independently, so
one can show an error while the other still renders.

## Live updates

The dashboard opens `/api/stream` as soon as it loads and keeps it open.
Each sample the agent takes arrives as a `metrics` event and is pushed
into a client-side buffer capped at 900 samples, which is what the live
charts draw. Alerts arrive as `alert` events and cause the alert-aware
views to refresh at once.

Because the stream only carries samples as they are taken, the first
chart would otherwise sit empty for a whole interval, so the dashboard
also fetches `/api/metrics/current` on load. A `503` there before the
first sample is expected and ignored; the stream follows.

The connection indicator in the top bar shows `Connecting`, `Live` or
`Reconnecting`. The browser retries a dropped event stream by itself
after the `retry: 2000` the server sends, but it gives up permanently on
some failures, so a closed source is reopened by the page with a delay
that doubles from 1 second to a maximum of 30 and resets on success.
Restarting the agent therefore does not require reloading the page.

## Refresh intervals

Everything that is not pushed — health, history, processes, alerts,
system and configuration — is polled. The selector in the top bar sets
that interval to off, 5 s, 15 s, 30 s or 60 s, defaulting to 15 s, and
takes effect immediately on the current view. The process view has its
own selector, because a process listing is the most expensive request.

Each poller waits for its response before scheduling the next run, so a
slow response never overlaps the next request, and an in-flight request
is aborted when its view is left or its parameters change.

## Reading the display

A measurement that is not available is shown as an em dash, never as
zero. On a history chart, a period when the agent was not running is a
gap in the line; nothing is interpolated to bridge it. Each history
panel states how many points it is showing, over what period, and where
the stored history begins.

A chart panel has its own range selector — 15m, 1h, 6h, 24h, 7d — and a
refresh button.

## Markup and keyboard use

The page is semantic HTML: a skip link, a navigation landmark with the
current page marked, a main region, headings in order, real tables with
header cells, and labelled form controls. Changing view moves focus to
the new heading. The connection indicator is a live region, as is the
process view's result count.

Everything is reachable with the keyboard, including the sortable column
headings. The dashboard has not been tested with a screen reader; see
[known-limitations.md](known-limitations.md).

The page needs JavaScript and says so in a `noscript` element. It loads
one module and one stylesheet, both from its own origin: the content
security policy forbids inline script, remote fonts and images from
anywhere else, and the dashboard is built to live inside it.
