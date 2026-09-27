#!/bin/sh
set -eu

SCRIPT_PATH=$0
case "$SCRIPT_PATH" in
  /*) ;;
  *) SCRIPT_PATH="$(pwd -P)/$SCRIPT_PATH" ;;
esac
PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)

VERSION=$(tr -d '\r\n' < "$PACKAGE_ROOT/VERSION")
if [ -z "$VERSION" ]; then
  printf '%s\n' 'install.sh: VERSION is empty' >&2
  exit 1
fi

PREFIX=
USER_SERVICE=0
SERVICE_MANAGER=none
SERVICE_MANAGER_SET=0
SUPERVISOR_CONFIG=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix=*) PREFIX=${1#*=}; shift ;;
    --prefix)
      if [ "$#" -lt 2 ]; then
        printf '%s\n' 'install.sh: --prefix requires a path' >&2
        exit 2
      fi
      PREFIX=$2
      shift 2
      ;;
    --service-manager=*)
      REQUESTED_SERVICE_MANAGER=${1#*=}
      if [ "$SERVICE_MANAGER_SET" -eq 1 ] && [ "$SERVICE_MANAGER" != "$REQUESTED_SERVICE_MANAGER" ]; then
        printf '%s\n' 'install.sh: conflicting --service-manager values' >&2
        exit 2
      fi
      SERVICE_MANAGER=$REQUESTED_SERVICE_MANAGER
      SERVICE_MANAGER_SET=1
      shift
      ;;
    --service-manager)
      if [ "$#" -lt 2 ]; then
        printf '%s\n' 'install.sh: --service-manager requires a value' >&2
        exit 2
      fi
      REQUESTED_SERVICE_MANAGER=$2
      if [ "$SERVICE_MANAGER_SET" -eq 1 ] && [ "$SERVICE_MANAGER" != "$REQUESTED_SERVICE_MANAGER" ]; then
        printf '%s\n' 'install.sh: conflicting --service-manager values' >&2
        exit 2
      fi
      SERVICE_MANAGER=$REQUESTED_SERVICE_MANAGER
      SERVICE_MANAGER_SET=1
      shift 2
      ;;
    --supervisor-config=*)
      SUPERVISOR_CONFIG=${1#*=}
      shift
      ;;
    --supervisor-config)
      if [ "$#" -lt 2 ]; then
        printf '%s\n' 'install.sh: --supervisor-config requires a path' >&2
        exit 2
      fi
      SUPERVISOR_CONFIG=$2
      shift 2
      ;;
    --user-service)
      if [ "$SERVICE_MANAGER_SET" -eq 1 ] && [ "$SERVICE_MANAGER" != systemd-user ]; then
        printf '%s\n' 'install.sh: --user-service conflicts with --service-manager' >&2
        exit 2
      fi
      USER_SERVICE=1
      SERVICE_MANAGER=systemd-user
      SERVICE_MANAGER_SET=1
      shift
      ;;
    --help|-h)
      printf '%s\n' 'Usage: install.sh [--prefix PATH]' \
        '       install.sh --service-manager systemd-user' \
        '       install.sh --service-manager supervisord [--supervisor-config PATH]' \
        '       install.sh --service-manager container-external|none' \
        '       install.sh --user-service (alias for systemd-user)' \
        'Default: ~/.local/share/toknow-agent/<VERSION> with ~/.local/bin/toknow-agent' \
        'Override: TO_KNOW_INSTALL_ROOT or --prefix PATH' \
        'No service manager is selected by a plain install.'
      exit 0
      ;;
    *)
      printf 'install.sh: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [ "$USER_SERVICE" -eq 1 ] && [ "$SERVICE_MANAGER" != systemd-user ]; then
  printf '%s\n' 'install.sh: --user-service conflicts with --service-manager' >&2
  exit 2
fi

case "$SERVICE_MANAGER" in
  systemd-user|supervisord|container-external|none) ;;
  *)
    printf 'install.sh: unsupported service manager: %s\n' "$SERVICE_MANAGER" >&2
    exit 2
    ;;
esac

if [ -n "$SUPERVISOR_CONFIG" ] && [ "$SERVICE_MANAGER" != supervisord ]; then
  printf '%s\n' 'install.sh: --supervisor-config requires --service-manager supervisord' >&2
  exit 2
fi

if [ -n "${TO_KNOW_INSTALL_ROOT:-}" ]; then
  if [ -n "$PREFIX" ] && [ "$PREFIX" != "$TO_KNOW_INSTALL_ROOT" ]; then
    printf '%s\n' 'install.sh: --prefix and TO_KNOW_INSTALL_ROOT disagree' >&2
    exit 2
  fi
  PREFIX=$TO_KNOW_INSTALL_ROOT
fi

if [ -z "$PREFIX" ]; then
  PREFIX="$HOME/.local/share/toknow-agent"
  STABLE_BIN="$HOME/.local/bin/toknow-agent"
else
  STABLE_BIN="$PREFIX/bin/toknow-agent"
fi

if [ "$SERVICE_MANAGER" = supervisord ]; then
  SERVICE_HELPER="$PACKAGE_ROOT/app/src/server-agent/serviceInstaller.js"
  TEMPLATE="$PACKAGE_ROOT/supervisord/toknow-agent.conf.template"
  BUNDLED_NODE="$PACKAGE_ROOT/runtime/node/bin/node"
  if [ ! -f "$SERVICE_HELPER" ] || [ ! -f "$TEMPLATE" ] || [ ! -x "$BUNDLED_NODE" ]; then
    printf '%s\n' 'install.sh: packaged supervisord backend assets are incomplete' >&2
    exit 1
  fi
  set -- validate --service-manager supervisord --launcher "$STABLE_BIN" --template "$TEMPLATE"
  if [ -n "$SUPERVISOR_CONFIG" ]; then
    set -- "$@" --supervisor-config "$SUPERVISOR_CONFIG"
  fi
  "$BUNDLED_NODE" "$SERVICE_HELPER" "$@"
fi

if [ "$SERVICE_MANAGER" = systemd-user ]; then
  USER_SERVICE=1
  DEFAULT_PREFIX="$HOME/.local/share/toknow-agent"
  if [ "$PREFIX" != "$DEFAULT_PREFIX" ]; then
    printf '%s\n' 'install.sh: --user-service requires the default install root ~/.local/share/toknow-agent' >&2
    exit 2
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    printf '%s\n' 'install.sh: --user-service requires systemctl' >&2
    exit 1
  fi
  UNIT_SOURCE="$PACKAGE_ROOT/systemd/toknow-agent.service"
  if [ ! -f "$UNIT_SOURCE" ]; then
    printf '%s\n' 'install.sh: packaged systemd user unit is missing' >&2
    exit 1
  fi
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  UNIT_PATH="$UNIT_DIR/toknow-agent.service"
  if [ -L "$UNIT_PATH" ]; then
    printf '%s\n' 'install.sh: refusing to overwrite a symlinked user unit' >&2
    exit 1
  fi
  if [ -e "$UNIT_PATH" ] \
    && ! cmp -s "$UNIT_SOURCE" "$UNIT_PATH" \
    && ! grep -Fqx '# Managed by To Know Server Agent installer.' "$UNIT_PATH"; then
    printf '%s\n' 'install.sh: existing user unit is not managed by Potato' >&2
    exit 1
  fi
fi

VERSION_ROOT="$PREFIX/$VERSION"
mkdir -p "$VERSION_ROOT"
cp -a "$PACKAGE_ROOT/." "$VERSION_ROOT/"
mkdir -p "$(dirname -- "$STABLE_BIN")"
ln -sfn "$VERSION_ROOT/bin/toknow-agent" "$STABLE_BIN"

printf 'Installed Potato Server Agent %s\n' "$VERSION"
printf 'Stable launcher: %s\n' "$STABLE_BIN"

if [ "$USER_SERVICE" -eq 1 ]; then
  mkdir -p "$UNIT_DIR"
  cp "$UNIT_SOURCE" "$UNIT_PATH"
  chmod 0644 "$UNIT_PATH"
  if ! systemctl --user daemon-reload; then
    printf '%s\n' 'install.sh: systemctl --user daemon-reload failed; user manager may be unavailable' >&2
    exit 1
  fi
  if ! systemctl --user enable --now toknow-agent.service; then
    printf '%s\n' 'install.sh: systemctl --user enable --now failed' >&2
    exit 1
  fi
  printf 'User service enabled: %s\n' "$UNIT_PATH"
elif [ "$SERVICE_MANAGER" = supervisord ]; then
  SERVICE_HELPER="$VERSION_ROOT/app/src/server-agent/serviceInstaller.js"
  TEMPLATE="$PACKAGE_ROOT/supervisord/toknow-agent.conf.template"
  BUNDLED_NODE="$VERSION_ROOT/runtime/node/bin/node"
  if [ ! -f "$SERVICE_HELPER" ] || [ ! -f "$TEMPLATE" ] || [ ! -x "$BUNDLED_NODE" ]; then
    printf '%s\n' 'install.sh: packaged supervisord backend assets are incomplete' >&2
    exit 1
  fi
  set -- install --service-manager supervisord --launcher "$STABLE_BIN" --template "$TEMPLATE"
  if [ -n "$SUPERVISOR_CONFIG" ]; then
    set -- "$@" --supervisor-config "$SUPERVISOR_CONFIG"
  fi
  "$BUNDLED_NODE" "$SERVICE_HELPER" "$@"
elif [ "$SERVICE_MANAGER" = container-external ]; then
  printf '%s\n' 'Service backend: container-external' \
    "Command: $STABLE_BIN run" \
    'Stop signal: SIGTERM' \
    'Stop timeout: 15s' \
    'Restart policy: always or on-failure (configure in the external orchestrator)' \
    "Persistent config: ${XDG_CONFIG_HOME:-$HOME/.config}/toknow-agent" \
    "Persistent runtime data: ${XDG_DATA_HOME:-$HOME/.local/share}/toknow-agent" \
    "Persistent state: ${XDG_STATE_HOME:-$HOME/.local/state}/toknow-agent"
fi
