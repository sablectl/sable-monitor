# Installation

Sable Monitor is distributed as a GitHub release tarball. It is not
published to npm, so `npm install -g sable-monitor` will not find it.

## Requirements

| Requirement | Detail                                           |
| ----------- | ------------------------------------------------ |
| Node.js     | 24 or later; `node:sqlite` is unflagged from 24  |
| Platform    | Linux only; `/proc` and `/sys` are read directly |
| Privileges  | None. Root is neither required nor recommended   |
| Disk        | One SQLite file under the user's state directory |

There are no runtime dependencies to install. macOS and Windows are not
supported; see [known-limitations.md](known-limitations.md).

Check the Node.js version first:

```sh
node --version
```

## Download and verify

Releases are published at
<https://github.com/sablectl/sable-monitor/releases>. Take the asset
names and the version from the release page; the commands below use
`1.0.0` as an example. Download the tarball and its SHA-256 digest, and
verify the digest before extracting anything.

```sh
base=https://github.com/sablectl/sable-monitor/releases/download/v1.0.0
curl -LO "$base/sable-monitor-1.0.0.tar.gz"
curl -LO "$base/sable-monitor-1.0.0.tar.gz.sha256"
sha256sum --check sable-monitor-1.0.0.tar.gz.sha256
```

`sha256sum` prints `OK` when the file matches. If it prints anything
else, stop and do not extract the archive.

Extract it somewhere you control:

```sh
mkdir -p ~/.local/opt/sable-monitor
tar -xzf sable-monitor-1.0.0.tar.gz -C ~/.local/opt/sable-monitor
```

Inspect the archive with `tar -tzf` first if you want to know whether it
expands into a directory of its own. The entry point inside it is
`dist/bin/sable-monitor.js`:

```sh
node ~/.local/opt/sable-monitor/dist/bin/sable-monitor.js --version
```

If you would rather type `sable-monitor`, link it onto your path
yourself:

```sh
ln -s ~/.local/opt/sable-monitor/dist/bin/sable-monitor.js \
  ~/.local/bin/sable-monitor
```

Nothing in the program creates that link, writes to a system directory or
modifies your shell configuration.

## Building from source

```sh
git clone https://github.com/sablectl/sable-monitor.git
cd sable-monitor
npm install
npm run build
node dist/bin/sable-monitor.js --version
```

`npm install` installs development dependencies only — the type checker,
the linter, the formatter and the test runner. The built output has none.

`npm run build` compiles the server to `dist/` and the dashboard to
`dist/web/`. The dashboard will not load if only `build:server` has run.
To check the tree before using it, run `npm run verify`; see
[testing.md](testing.md).

## Running the agent

```sh
sable-monitor
```

`start` is the default subcommand, so `sable-monitor` and
`sable-monitor start` are the same thing. The agent takes its first
sample, binds to `127.0.0.1:7878` and prints a short banner:

```text
sable-monitor 1.0.0
  configuration  defaults (no file)
  dashboard      http://127.0.0.1:7878
  sampling       every 2000 ms
  database       /home/user/.local/state/sable-monitor/metrics.db
  retention      7 days
  alerts         enabled
  authentication none (loopback only)
```

Open the dashboard at the address printed. If the process is running as
uid 0, a further line notes that root is not needed.

To validate a configuration without starting anything:

```sh
sable-monitor check
```

See [configuration.md](configuration.md) for the settings, the file
format and the precedence rules, and [dashboard.md](dashboard.md) for the
views.

## Stopping it

Press Ctrl-C, or send `SIGTERM`:

```sh
kill "$(pgrep -f sable-monitor.js)"
```

Both signals run the same shutdown: the server closes and disconnects its
stream clients, the agent stops its timers and waits for any in-flight
collection to finish, the samples still queued are written to the
database, every active alert is resolved, and the write-ahead log is
folded back into the database file. A second signal during shutdown exits
immediately, so the process can always be stopped.

## Uninstalling

There is nothing registered anywhere to unregister. Remove the files:

```sh
rm -rf ~/.local/opt/sable-monitor
rm -f ~/.local/bin/sable-monitor
rm -rf ~/.local/state/sable-monitor      # the metrics database
rm -rf ~/.config/sable-monitor           # the configuration file, if any
```

Adjust the last two paths if `XDG_STATE_HOME` or `XDG_CONFIG_HOME` is
set, or if `storage.path` was configured elsewhere. The database holds
the whole of the recorded history; deleting it is irreversible.

## Running it as a systemd user service

Sable Monitor never installs, enables or writes a service unit. It has no
subcommand that touches a system directory. If you want it to start with
your session, write the unit yourself.

Create `~/.config/systemd/user/sable-monitor.service`:

```ini
[Unit]
Description=Sable Monitor
Documentation=https://github.com/sablectl/sable-monitor
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.local/opt/sable-monitor/dist/bin/sable-monitor.js start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now sable-monitor.service
systemctl --user status sable-monitor.service
journalctl --user -u sable-monitor.service -f
```

Two points worth knowing. A user service stops when the last session of
the user ends unless lingering is enabled with
`loginctl enable-linger "$USER"`. And a user unit is the right scope
here: the agent needs no privileges, and running it as a system service
under root would give it access it does not use. If you do run it from a
system unit, give it its own unprivileged user and set
`SABLE_MONITOR_DB` to a directory that user owns.
