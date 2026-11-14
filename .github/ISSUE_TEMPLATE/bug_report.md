---
name: Bug report
about: A metric that is wrong, or something Sable Monitor does that it should not
labels: bug
---

## What happened

A short description of the behaviour. If a number looks wrong, say what
Sable Monitor reported and what you believe the correct value is, and how
you obtained it — `top`, `free -m`, `df -h`, `iostat` or a direct read of
the relevant `/proc` file.

## What you expected

## How to reproduce

The command you ran, with any token removed:

```sh
sable-monitor start ...
```

Where a `/proc` or `/sys` file is involved, its contents are more useful
than a description. Remove any hostname or path you would rather not
publish.

```text

```

## Output

The API response or the startup output, with anything sensitive removed.

```text

```

## Versions

- Sable Monitor: `sable-monitor --version`
- Node.js: `node --version`
- Kernel: `uname -r`
- Distribution and architecture:
- Anything unusual about the host: a container, a virtual machine,
  `hidepid`, a kernel with non-standard page size or clock rate
