#!/usr/bin/env bash
# setup.sh — kept so existing docs and muscle memory keep working.
#
# The installer is now install.sh, which does everything this did plus a
# no-clone path. Flags are unchanged, so this just forwards.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '\033[2m(setup.sh now forwards to install.sh)\033[0m\n'
exec "$DIR/install.sh" "$@"
