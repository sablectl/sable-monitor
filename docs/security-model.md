# Security model

Sable Monitor publishes the state of a machine. That is useful to its
operator and useful to an attacker, so the defaults assume the data is
sensitive and every setting that widens exposure has to be chosen
deliberately.

This document describes what the program does and what it does not do.
It is not a claim that the program is free of defects.

## What is protected

The metrics themselves: utilisation, capacity, throughput, the list of
running processes, the host's name, kernel and operating system, and the
alert history. Taken together these describe when a machine is in use,
what runs on it and when it is idle.

## Threats considered

| Threat                                      | Measure                                       |
| ------------------------------------------- | --------------------------------------------- |
| Another host on the network reading metrics | Loopback binding by default                   |
| A web page reading the API from the browser | `Host` allow-listing, `Origin` checking, CSP  |
| DNS rebinding to `127.0.0.1`                | `Host` allow-listing                          |
| An unauthorised local or remote client      | Optional bearer token, mandatory off loopback |
| Guessing a token by timing                  | Constant-time comparison                      |
| Reading files outside the dashboard         | Path containment and an extension allow-list  |
| Credentials leaking through process data    | Command lines and environments are never read |
| Unbounded work from one request             | Every query parameter is bounded              |
| A slow client exhausting memory             | Backpressure, dropped events, client limit    |

## Threats not considered

A user who can already read `/proc` on the machine can read everything
the agent reads, without the agent. A user who can read the database
file can read the history. Root can do anything. None of these are
boundaries Sable Monitor can defend, and it does not pretend to.

## Binding and remote access

The server binds `127.0.0.1:7878` by default, so nothing off the machine
can reach it and no token is needed.

Binding to an address other hosts can reach turns a local diagnostic
tool into a network service that publishes the state of the machine.
That requires **both** of the following, or startup fails with a
validation error:

- `server.allowRemote: true`, confirming the exposure is intended;
- `server.token`, at least 16 characters.

Even then there is no transport encryption: the server speaks plain
HTTP, so a token sent over an untrusted network is sent in clear.

The recommended way to reach the dashboard from elsewhere is not to bind
off loopback at all. Forward the port over SSH:

```sh
ssh -N -L 7878:127.0.0.1:7878 user@host
```

Then open `http://127.0.0.1:7878` on the local machine. Authentication,
encryption and access control are SSH's, which are better than anything
this program could add. A private network such as Tailscale, or a
reverse proxy that terminates TLS and authenticates, are the other
reasonable options.

## Request admission

Every request passes the same checks before it reaches a route.

**Method.** Only `GET` and `HEAD` exist. Everything else is `405`. There
is no state-changing request to authorise, forge or protect, which is
the strongest form that protection can take.

**Request target.** Longer than 2048 characters is `414`.

**`Host`.** The header must name a host this server answers to: a
loopback name or address, the configured `host`, or an entry in
`server.allowedHosts`. A `Host` naming a different port is refused.

This is what defeats DNS rebinding. A page on a hostile site can make
its name resolve to `127.0.0.1` and then issue requests to this server,
but the browser sends that hostile name in the `Host` header, and the
request is refused before it reaches a route.

**`Origin`.** A browser always sets this on a cross-origin request and a
page cannot forge it. A request with no `Origin`, or the opaque origin
`null` — from a terminal, a script, or the dashboard's own same-origin
navigation — is allowed. Any other `Origin` must be in
`server.allowedOrigins`, or be a loopback origin or the configured host
on the configured port.

**Authorisation.** When `server.token` is set, the request must carry
`Authorization: Bearer <token>`, or it is `401`. The comparison is
length-checked and then `timingSafeEqual`, so the token cannot be
recovered by measuring response times.

There is no `--token` flag, because a command line is readable by every
user on the machine through `/proc`. The token comes from the
configuration file or from `SABLE_MONITOR_TOKEN`.

## Response headers

Every response, including the event stream and static files, carries
the following. The policy is sent on one line; it is wrapped here for
readability.

```text
Content-Security-Policy: default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self' data:; connect-src 'self';
  font-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
Cache-Control: no-store
```

The policy allows this origin's own script and style and nothing else:
no inline script, no remote font, no image from anywhere. The dashboard
is built to live inside it. `frame-ancestors 'none'` prevents framing,
`form-action 'none'` means a form cannot submit anywhere, and
`no-store` applies because metrics are current by definition and a
cached copy is a wrong copy.

## What is never collected

The process collector reads `/proc/<pid>/stat` and nothing else. It does
**not** read:

- `/proc/<pid>/cmdline`, which routinely carries passwords, tokens and
  connection strings passed as arguments;
- `/proc/<pid>/environ`, which carries the whole environment;
- `/proc/<pid>/cwd`, `fd`, `maps` or any other per-process state.

Command-line arguments and environment variables are therefore never
collected, never stored and never served, and no configuration setting
turns that on.

The system collector reads the hostname, the kernel release, the
architecture, uptime and `PRETTY_NAME`. Machine identifiers, serial
numbers, MAC addresses, IP addresses and the kernel command line are not
collected.

`/api/config` returns the collection, storage, alert and binding
settings. It never includes the token, under any name, and never
includes the database path: the dashboard has no use for it and it names
a location on the operator's disk.

## What the program cannot do

- There is no process termination, no signal sending and no command
  execution. The agent reads, and that is all it can do.
- There is no write endpoint of any kind. Alerts cannot be acknowledged
  or silenced over HTTP; thresholds change in the configuration file.
- There is no telemetry, no update check, no crash reporting and no
  outbound connection. Nothing leaves the machine.
- Nothing installs a service, writes to a system directory or modifies
  anything outside its own database.

## Privileges

Root is neither required nor recommended. Everything the agent reads is
world readable on a stock kernel, and running as uid 0 grants access it
does not use. When the process does run as root, the startup banner says
so and `/api/system` reports `privileged: true`.

Processes hidden by `hidepid` are skipped rather than failing the
sample, so the agent degrades sensibly on a hardened host.

## Storage

The database directory is created with mode 0700 and the database file
and its write-ahead log sidecars with mode 0600: what the machine was
doing and when is the operator's business. The default location is under
`$XDG_STATE_HOME` or `~/.local/state`, inside the user's own tree.

The database holds aggregate metrics and alerts. It does not hold
process names, command lines or anything identifying beyond what the
alert messages contain, which is a rule identifier, a mount point and a
value.

## Static file serving

A request for a static file is resolved and then checked to be inside
the dashboard directory, and its extension must be one of `.html`,
`.css`, `.js`, `.svg` or `.ico`. Anything else is refused, whatever the
request does with `..`, encoded separators or a symbolic link.

## Resource bounds

Every query parameter is validated and bounded, so no request can ask
the server for an unbounded amount of work: history is capped at 5000
points, processes at `collection.processRows`, alerts at 1000, and the
search term at 64 characters.

Header and request timeouts are set on the server, the maximum header
count is 64, and the event stream accepts at most
`server.maxStreamClients` subscribers. A subscriber whose socket has
stopped draining has its events dropped rather than buffered, so a
laptop that was closed mid-stream cannot grow the process heap.

The request head is bounded by `server.maxRequestBytes`, 16 KiB by
default. Since no endpoint accepts a body, the head is the whole of what
a client can send, and a request exceeding it is answered with 431 and
the connection closed.

## Reporting a vulnerability

Use the reporting process described in the repository's `SECURITY.md` at
<https://github.com/sablectl/sable-monitor>.
