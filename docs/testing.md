# Testing

The suite is Vitest, split into two projects: unit tests that read
captured kernel files from the repository, and integration tests that
run a real agent and a real server against the machine running them.

## Running the tests

```sh
npm test                   # the unit project
npm run test:integration   # the integration project
npm run verify             # everything below
npm run test:watch         # the unit project, in watch mode
```

At the time of writing the unit project is 170 tests across 11 files
and the integration project is 36 tests across 2 files.

`npm run verify` runs the type check, the linter, the format check, both
test projects and both builds, in that order. It is what to run before
opening a pull request.

Both projects run against the TypeScript sources through Vitest, so no
build is needed first. The build is still part of `verify`, because a
tree that type-checks can still fail to emit.

## The two projects

**unit** covers everything that can be made deterministic: the `/proc`
and `/sys` parsers, the rate and utilisation arithmetic, memory
accounting, mount and `diskstats` filtering, process parsing, sorting
and filtering, configuration loading, merging and validation, the alert
engine's thresholds, hysteresis, duration and cooldown, the store's
schema, history thinning and retention, the request admission checks,
and the query-string parsers. Nothing is read from the running host, so
results are identical on any machine and the files run in parallel.

**integration** covers the agent and the server end to end against the
real kernel: starting and stopping the agent, taking samples, writing
them, the live buffer, health reporting, and each HTTP endpoint with its
parameters, its error cases, its headers and its event stream.

| Project       | Files                            | Reads the host | Parallel |
| ------------- | -------------------------------- | -------------- | -------- |
| `unit`        | `tests/unit/**/*.test.ts`        | No             | Yes      |
| `integration` | `tests/integration/**/*.test.ts` | Yes            | No       |

The integration project runs in a single forked process, so two servers
cannot compete for the same port, with a 30-second timeout for both
tests and hooks.

## Fixtures

The unit tests point a `Procfs` at a directory of captured kernel files
instead of at `/proc`, which is what lets them assert exact numbers.

```text
tests/fixtures/
  proc-a/     a reading: stat, meminfo, cpuinfo, loadavg, uptime,
              diskstats, net/dev, self/mounts, 123/stat, 456/stat
  proc-b/     the same machine one second later: stat, loadavg,
              diskstats, net/dev
  sys/        class/net/eth0/operstate
```

`proc-a` and `proc-b` are two readings one second apart, which is
exactly what a rate calculation needs: the tests feed the first as the
baseline and the second as the current reading, and check the resulting
utilisation, throughput and per-process CPU against values worked out by
hand.

`tests/helpers/fixtures.ts` provides `fixtureProcfs('proc-a')`,
`fixturePath` and `readFixture`.

Adding a fixture means capturing the real file, not writing a plausible
one: the point of the directory is that it contains output the kernel
actually produced.

## What the integration tests do to the machine

Nothing that persists. Each run creates a temporary directory, puts a
SQLite database in it, binds an HTTP server to a loopback port chosen by
the operating system — port 0, so the suite cannot collide with an agent
the developer happens to be running — and removes the directory
afterwards.

They do read the real `/proc` and `/sys`, so they exercise the
collectors against whatever the machine is doing at the time. The
assertions are therefore about shape, bounds and invariants rather than
about particular values: that a percentage is between 0 and 100, that a
rate is either `null` or non-negative, that a first sample has no rates,
that history is ordered. A test that asserted a specific CPU figure
would fail for the wrong reason.

## Writing a test

Put anything that can be driven from a fixture in the unit project. It
is faster, it is parallel, and it fails for exactly one reason.

Reserve the integration project for behaviour that needs a real kernel
or a real socket: the admission checks against real headers, the event
stream, the static file handling, the agent's lifecycle.

Two habits matter in this codebase:

- Assert that an unmeasurable value is `null`, not `0`. Several tests
  exist only to pin that distinction down, because it is the easiest
  thing to lose in a refactor.
- Assert the error message, not just the failure. A validation error
  that names the wrong setting is as unhelpful as no error at all.

## The other checks

```sh
npm run check         # tsc --noEmit over the whole tree
npm run lint          # eslint
npm run format:check  # prettier --check
npm run format        # prettier --write
```

The type check covers the sources and the tests. Prettier is configured
with an 80-column print width and runs over Markdown as well as code, so
documentation changes are formatted too.

## The benchmark is not a test

`npm run bench` measures cost; it asserts nothing and is not part of
`verify`. It needs a build first, because it imports from `dist/`. See
[performance.md](performance.md).
