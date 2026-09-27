#!/bin/sh
set -eu

SCRIPT_PATH=$0
case "$SCRIPT_PATH" in
  /*) ;;
  *) SCRIPT_PATH="$(pwd -P)/$SCRIPT_PATH" ;;
esac
PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)
UNIT_SOURCE="$PACKAGE_ROOT/toknow-agent.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/toknow-agent.service"

if [ ! -e "$UNIT_PATH" ]; then
  printf '%s\n' 'Potato Server Agent user service is not installed.'
  exit 0
fi

if [ -L "$UNIT_PATH" ]; then
  printf '%s\n' 'remove-user-service.sh: refusing to remove a symlinked unit' >&2
  exit 1
fi

if ! cmp -s "$UNIT_SOURCE" "$UNIT_PATH" && ! grep -Fqx '# Managed by To Know Server Agent installer.' "$UNIT_PATH"; then
  printf '%s\n' 'remove-user-service.sh: refusing to remove an unknown user unit' >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  printf '%s\n' 'remove-user-service.sh: systemctl is required' >&2
  exit 1
fi

if ! systemctl --user disable --now toknow-agent.service; then
  printf '%s\n' 'remove-user-service.sh: systemctl --user could not disable the service' >&2
  exit 1
fi
rm -f "$UNIT_PATH"
if ! systemctl --user daemon-reload; then
  printf '%s\n' 'remove-user-service.sh: systemctl --user daemon-reload failed' >&2
  exit 1
fi
printf '%s\n' 'Removed Potato Server Agent user service.'
