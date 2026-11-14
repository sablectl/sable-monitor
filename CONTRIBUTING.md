# Contributing

## Scope

Sable Monitor reads one Linux machine and shows what it is doing. It does
not act on that machine, and no change that gives it the ability to will be
accepted, however convenient: no process termination, no command execution,
no writing to `/proc` or `/sys`, no installing or enabling services.

Useful contributions are new metrics the kernel already publishes, better
accuracy, support for kernels and hardware that report things differently,
dashboard and accessibility improvements, and documentation that corrects
something wrong.

## Getting set up

```sh
git clone https://github.com/sablectl/sable-monitor.git
cd sable-monitor
npm ci
npm run build
node dist/bin/sable-monitor.js start
```

Node.js 24 or later and a Linux host are required. There are no runtime
dependencies and nothing is compiled from C, so a clone and `npm ci` is the
whole of the setup.

## Before opening a pull request

```sh
npm run verify
```

That runs, in order: type check, lint, formatting check, unit tests,
integration tests and both builds. All of it must pass.

New behaviour needs a test that fails without the change. A bug fix needs a
test that reproduces the bug first. Tests must assert what the code actually
does; if a test and the implementation disagree, work out which one is wrong
rather than adjusting the assertion until it passes.

Unit tests read captured kernel files from `tests/fixtures`, so they assert
exact numbers and give the same result on any machine. Integration tests run
a real agent and a real server against the host running the suite, and so
assert ranges and consistency rather than particular values. See
[docs/testing.md](docs/testing.md).

## House rules

- **No runtime dependency.** There are none, and that is a feature:
  everything comes from the Node standard library. A change that adds one
  needs an argument in the pull request that explains why the standard
  library will not do.
- **Say what is not known.** A value that could not be measured is `null`,
  and the dashboard draws an em dash for it. Substituting a zero, the last
  known value or an interpolated point is a bug, not a nicety — a chart
  that invents a reading is worse than a chart with a gap in it.
- **A rate is a difference between two readings.** Never report an
  instantaneous counter as though it described the present moment, and
  never report a negative delta as a huge positive rate.
- **Nothing sensitive leaves `/proc`.** Command lines, environments,
  working directories, open file descriptors and memory maps are not read.
  A change that reads one of them will not be accepted.
- **Kernel text is untrusted input.** Parse it defensively, field by field,
  and handle a missing file, a truncated line and an unexpected unit
  without throwing. A collector that fails degrades its own metric for one
  sample; it does not stop the agent.
- **Everything is bounded.** Buffers, queues, query results, process lists
  and stream clients all have a limit. A change that removes one needs to
  explain what stops it growing.
- **British English in prose**, including "licence" as a noun. Identifiers
  keep their own spelling: `MemAvailable`, `iowait`, `operstate`.
- Comments explain why, not what. The code already says what it does.

## Code style

Prettier and ESLint decide formatting and lint; `npm run format` applies
them. Strict TypeScript, no `any`, ESM with `.js` extensions on relative
imports.

The dependency direction is `bin` → `server` → `agent` → `collect` and
`store`. The collectors know nothing about HTTP, the store knows nothing
about collection, and the agent knows nothing about the dashboard, so each
can be tested on its own.

Browser code lives in `src/web` and is compiled separately by
`tsconfig.web.json`. It has no bundler and no framework; relative imports
there must carry the `.js` extension because the browser resolves them
literally.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).
