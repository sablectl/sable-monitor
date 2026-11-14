## What this changes

## Why

## Checks

- [ ] `npm run verify` passes.
- [ ] New behaviour has a test that fails without the change.
- [ ] No new runtime dependency, or a reason for one in the description.
- [ ] A value that cannot be measured is still reported as `null`, not as a
      zero or an interpolated point.
- [ ] No new read of a process command line, environment, working
      directory, open file descriptor or memory map.
- [ ] Documentation updated if a command, setting, endpoint or metric
      changed.
- [ ] No token, hostname or other detail of a real machine in the diff.
