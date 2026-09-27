# Potato Server Agent service backends

The Server Agent runtime remains independent of systemd, supervisord, Docker,
and Kubernetes. `toknow-agent run` owns profile workers and their recovery. A
service backend owns only the top-level runtime process.

## Linux support matrix

| Backend | Support |
| --- | --- |
| `systemd-user` | SUPPORTED |
| `supervisord` | SUPPORTED |
| `container-external` | SUPPORTED |
| Foreground (`none`) | SUPPORTED_MANUAL_ONLY |
| Bash launcher shim | SUPPORTED_ON_DEMAND |
| systemd-system | NOT_YET_FORMAL |
| openrc | NOT_YET_FORMAL |
| runit | NOT_YET_FORMAL |

## Read-only detection

Run:

```sh
~/.local/bin/toknow-agent service detect
```

The command emits safe JSON with separate environment and process-manager
evidence, systemd user-manager reachability, supervisord binary/version/config
discovery and control-channel status, container signals, a recommendation,
and a runtime contract. Detection does not write service files, enable or
start a service, change linger, or edit manager configuration. It does not
print credentials, owner IDs, CID values, `CODEX_HOME`, the full environment,
or the process command line.

`systemd-user` is available only when `systemctl --user` can reach a user
manager. A `systemctl` executable by itself is not evidence that the manager
is online. The detected PID 1 name is supporting evidence, not the authority.

`supervisord` is a manageable backend only when `supervisorctl` connects to
the running manager and a safe, writable include directory can be identified.
The detector checks `SUPERVISOR_CONFIG`, the PID 1 `supervisord -c` argument,
and common configuration locations. An unavailable control socket is reported
as unavailable; the presence of `supervisord` alone does not enable managed
installation.

Container recognition uses multiple read-only signals, including
`/.dockerenv`, `/proc/1/cgroup`, and `KUBERNETES_SERVICE_HOST`. The JSON may
identify a Kubernetes container and a separate in-container process manager.
Unknown lifecycle or persistence capabilities remain `unknown`.

## Install the runtime

A plain install installs only the versioned runtime and stable launcher. It
does not choose a service backend:

```sh
./install.sh
```

The launcher remains `~/.local/bin/toknow-agent`, so manager configuration
does not need to change on version upgrades. A custom `--prefix` uses
`<prefix>/bin/toknow-agent` as its stable launcher.

## systemd user service

Install explicitly with either the new name or the backward-compatible alias:

```sh
./install.sh --service-manager systemd-user
./install.sh --user-service
```

This copies the packaged unit to
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/toknow-agent.service`, runs
`systemctl --user daemon-reload`, and runs
`systemctl --user enable --now toknow-agent.service`. The systemd user backend
does not write `/etc/systemd/system`, invoke `sudo`, or enable linger.

Useful lifecycle commands:

```sh
systemctl --user status toknow-agent.service
systemctl --user start toknow-agent.service
systemctl --user stop toknow-agent.service
systemctl --user restart toknow-agent.service
journalctl --user -u toknow-agent.service
```

For rollback, run `systemd/remove-user-service.sh` from the extracted package.
It removes only the marked Potato unit after disabling that unit.

Enabling the user service makes it start when the user manager starts. To keep
it running after SSH logout and start it after reboot before the first login,
the operator must separately enable linger for the user. The installer does
not change this host-session policy.

## supervisord

Install explicitly, pointing at the active primary config when auto-discovery
is ambiguous or the manager uses a nonstandard location:

```sh
./install.sh --service-manager supervisord \
  --supervisor-config /path/to/supervisord.conf
```

The installer reads the primary config and writes only
`toknow-agent.conf` into one existing, unambiguous, writable include
directory. It never edits the primary config. It refuses symlinked or
unwritable include directories, an unknown existing `toknow-agent` program,
and an unmarked file at the destination. Generated configuration is marked
`Managed by Potato Server Agent installer` and points to the stable launcher.

After writing the program file, the installer runs the equivalent of:

```sh
supervisorctl -c /path/to/supervisord.conf reread
supervisorctl -c /path/to/supervisord.conf update toknow-agent
supervisorctl -c /path/to/supervisord.conf status toknow-agent
```

The update is scoped to `toknow-agent`; the installer does not signal PID 1,
restart all programs, or stop platform programs. For rollback, run
`supervisord/remove-service.sh` from the extracted package, with
`--supervisor-config PATH` when needed. Removal requires the managed marker,
stops only `toknow-agent`, removes only its generated file, then rereads and
updates that program.

## container-external

Select the backend explicitly:

```sh
./install.sh --service-manager container-external
```

The installer installs the runtime and stable launcher and prints a runtime
contract. Use `<stable-launcher> run`, send `SIGTERM`, and allow 15 seconds for
shutdown. Configure an external restart policy such as `always` or
`on-failure`. Persist these roots across container restarts:

- `~/.config/toknow-agent` for configuration.
- `~/.local/share/toknow-agent` for credentials and runtime data.
- `~/.local/state/toknow-agent` for worker state, notification state, and
  local history.

Potato does not guarantee that a newly created container or Pod starts the
agent. That guarantee belongs to the external startup command and lifecycle
policy, such as a Docker restart policy, Kubernetes Deployment, or managed
cloud-container configuration. Persistence across container recreation also
depends on the volumes configured by that orchestrator. See the packaged
`container/README.md` for the deployment contract.

## Foreground mode

When no manager backend is available, run the stable launcher manually:

```sh
~/.local/bin/toknow-agent run
```

This is foreground operation only: `AUTO_RESTART: NO` and
`PRODUCTION_DAEMON: NOT_CONFIGURED`. `tmux`, `screen`, and `nohup` are not
formal service backends.

## On-demand Codex bootstrap (bash)

The always-on choices above are `systemd-user`, `supervisord`, or an external
orchestrator. The shell shim is a separate on-demand adapter. It starts the
Agent when a registered Codex launcher is first used; it does not start an
Agent immediately after a new Pod/container appears before a launcher runs.
`service detect` can still recommend `container-external` when the shim is
enabled; the shim is not an always-on external orchestrator.

Register only real launcher names, from a shell whose PATH already finds the
original executables:

```sh
~/.local/bin/toknow-agent shell install \
  --command codex --command codex-srj --command codex-plus
exec bash
~/.local/bin/toknow-agent shell status
```

The installer creates managed shims under
`~/.local/share/toknow-agent/shims`, a bootstrap file under
`~/.config/toknow-agent/shell`, and one marked block in `~/.bashrc`.
The new shell prepends the shim directory once. Each shim calls
`toknow-agent ensure --quiet`, removes its own directory from PATH, then
`exec`s the first original executable with its arguments and terminal streams.
An Agent error prints one short warning and still starts Codex. No shim
changes `CODEX_HOME`, profile mapping, or the Stop Hook command. The original
launcher remains untouched and follows its normal version upgrades.

To add a launcher later, use `shell add --command NAME`. Remove a launcher
with `shell remove --command NAME`; each remove targets one explicit shim file.
When the last command is removed, the managed `.bashrc` block and bootstrap
files are removed too. `shell uninstall` is a shorthand when exactly one
registered launcher remains; with multiple registrations, remove each name
explicitly. A damaged marker or modified managed shim fails closed.

`toknow-agent ensure` also works without notification credentials. A running
usage-only Agent is ready without a notification bridge. When notification is
configured, readiness requires the local authenticated `/health` response.
Multiple terminals share one top-level Agent per state root. The detached
Agent continues after the launching terminal or Codex exits. A later Codex
invocation recovers it after a container restart or Agent crash; this adapter
does not add a watchdog.

Service logs and detection output must remain privacy-safe. Do not include
credentials, `Authorization`, `ownerId`, CID values, `CODEX_HOME`, prompts, or
replies.
