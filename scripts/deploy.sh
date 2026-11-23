#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/snapshots.sh

case "${1:-}" in
  --no-test) ;;
  '') node --test 'app/js/**/*.test.js'
      TODDLER_REQUIRE_ALL=1 uv run --frozen pytest ;;
  *) echo 'Usage: scripts/deploy.sh [--no-test]' >&2; exit 2 ;;
esac

stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
stage=$(mktemp -d live/.stage.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
# Keep modes, symlinks and unusual filenames. A tracked file deleted in the working tree
# has no bytes to publish. Always exclude personal data and the snapshot directory itself.
git ls-files -coz --exclude-standard --deduplicate -- . ':!data' ':!live' ':!PRIVATE.md' ':!.privacy-patterns' |
  while IFS= read -r -d '' path; do
    if [[ -f "$path" || -L "$path" ]]; then printf '%s\0' "$path"; fi
  done | tar --null -T - -cf - | tar -C "$stage" -xf -
mv -T -- "$stage" "live/$stamp"
switch_snapshot "$stamp"

# Names sort by UTC time. Only remove timestamped directories created by this deployer.
shopt -s nullglob
snapshots=(live/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9]*Z)
count=0
for ((i=${#snapshots[@]}-1; i>=0; i--)); do
  snap=${snapshots[i]}
  [[ ${snap##*/} =~ ^[0-9]{8}T[0-9]{15}Z$ && -d "$snap" && ! -L "$snap" ]] || continue
  ((++count <= 3)) && continue
  [[ "$snap" -ef live/current || "$snap" -ef live/previous ]] || rm -rf -- "$snap"
done
