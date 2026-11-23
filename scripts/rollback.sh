#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/snapshots.sh
[[ -L live/previous ]] || { echo 'No previous snapshot to roll back to.' >&2; exit 1; }
switch_snapshot "$(readlink live/previous)"
