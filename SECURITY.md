# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |

## Reporting a vulnerability

Report privately through a
[GitHub security advisory](https://github.com/sablectl/sable-monitor/security/advisories/new).
Do not open a public issue.

Please include what you did, what happened, what you expected, and the
smallest reproduction you can manage. A `curl` command and the response it
produced is worth more than a description. Remove any token, hostname or
other detail of your own machine that you would rather not publish.

You will get an acknowledgement within seven days. A fix, or an explanation
of why the behaviour is intended, follows as quickly as the problem
warrants.

## What is in scope

- Reading a file outside the configured database and the kernel interfaces
  the collectors are documented to read, including through a crafted
  request path, a device name or an interface name.
- Any request that changes state on the host. There is no such endpoint by
  design, so finding one is a defect.
- Reaching the API from a web page the user merely visited: a `Host` or
  `Origin` check that can be bypassed, a DNS rebinding path that works, or
  any response that can be read cross-origin.
- Bypassing the bearer token, including through a timing difference, a
  parsing difference or an endpoint that does not check it.
- The token, the database path, a process command line, an environment
  variable or any other value documented as not served appearing in a
  response, in a log line or in the dashboard.
- A database or configuration file created with permissions that let
  another local user read it.
- Unbounded memory or disk use that the documented limits — the live
  buffer, the write queue, retention, the response limits, the stream
  client cap — should have prevented.
- Binding off the loopback address without both `server.allowRemote` and a
  token, or any other way to start a network-reachable instance that the
  configuration should have refused.
- A dependency vulnerability reachable from Sable Monitor's own code paths.
  There are no runtime dependencies, so this means the toolchain.

## What is not in scope

- **What a privileged user can already see.** Sable Monitor reports what
  the user running it may read. Run as root, it can read more, which is
  why it does not need root, says so at startup, and is documented as
  something to run unprivileged.
- **Information the kernel exposes to every local user.** Process names,
  states and memory sizes are world readable in `/proc`. Restricting that
  is `hidepid`'s job, and Sable Monitor respects it when it is set.
- **An instance the operator deliberately exposed.** Binding off loopback
  requires two explicit settings and a token. If that instance is then put
  on the public internet without TLS in front of it, the exposure is the
  deployment's, not a defect here. The documented methods are an SSH
  tunnel and a private network.
- **Denial of service against your own machine** by configuring a
  half-second sampling interval and a year of retention. The limits are
  configurable on purpose; the defaults are the conservative ones.
- A token chosen badly, or one passed on a command line where another
  local user can read it from the process table. `SABLE_MONITOR_TOKEN` and
  the configuration file exist so that it need not be.
- Behaviour on a platform that is not Linux. The collectors read `/proc`,
  and nothing else is supported or claimed.

## Design notes

The guarantees Sable Monitor does and does not make — why localhost binding
is not treated as a security model on its own, what the `Host` and `Origin`
checks are for, which parts of `/proc` are deliberately never read, and how
remote access should be arranged — are set out in
[docs/security-model.md](docs/security-model.md). Read it before reporting:
several behaviours that look like weaknesses are deliberate, documented
limits.
