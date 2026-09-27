# Potato Server Agent in containers

The container-external backend installs the Server Agent runtime and stable
launcher, then leaves process startup and restart policy to the container
orchestrator. It does not write systemd, supervisord, or `/etc` configuration
and does not daemonize the runtime.

The runtime command is:

```text
<absolute stable launcher> run
```

Send `SIGTERM` for shutdown and allow 15 seconds before forced termination.
Configure the container platform to restart the process (`always` or
`on-failure`, as appropriate for the deployment).

Persist the Server Agent roots across container restarts:

- `~/.config/toknow-agent` for configuration.
- `~/.local/share/toknow-agent` for credentials and runtime data.
- `~/.local/state/toknow-agent` for worker state, notification state, and
  local history.

Potato cannot guarantee that a newly created Pod or container starts the
agent. That guarantee belongs to the external startup command and lifecycle
policy, such as a Docker restart policy, Kubernetes Deployment, or managed
cloud-container startup configuration. Persistence across container recreation
also depends on the volumes configured by that orchestrator.
