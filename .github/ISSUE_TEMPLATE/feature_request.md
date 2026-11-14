---
name: Feature request
about: Something Sable Monitor could usefully show
labels: enhancement
---

## What you are trying to find out

Describe the question about a machine that Sable Monitor cannot currently
answer.

## Where the kernel publishes it

If the metric exists in `/proc`, `/sys` or another interface the standard
library can read, naming the file makes the request far easier to act on.

## What you do instead today

`top`, `iostat`, `journalctl`, a script of your own, another tool.

## Scope

Sable Monitor reads one Linux machine and displays what it finds. It will
not gain the ability to act on that machine — no process termination, no
command execution, no configuration changes — so a request along those
lines will be declined however useful it would be elsewhere. Nor will it
gain a runtime dependency without a reason that the standard library cannot
meet, or send anything off the host.
