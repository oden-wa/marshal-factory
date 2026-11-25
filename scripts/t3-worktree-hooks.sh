#!/bin/sh
# T3 starts here in the new worktree. Start Bun in the factory checkout.
set -eu
case "$0" in /*) ;; *) echo "Use the absolute factory script path" >&2; exit 2 ;; esac
case "$1" in /*) ;; *) echo "Use the absolute Bun path" >&2; exit 2 ;; esac
cd -P "${0%/*}/.."
bun_path=$1
shift
exec "$bun_path" scripts/t3-worktree-hooks.ts "$@"
