# Shared by deploy.sh and rollback.sh, from the repository root (Linux/systemd).
export LC_ALL=C
mkdir -p live
exec 9>live/.deploy.lock
flock -x 9

switch_snapshot() {
  local target=$1 old
  [[ -d "live/$target" ]] || { echo "Missing snapshot: $target" >&2; return 1; }
  if [[ -L live/current ]]; then
    old=$(readlink live/current)
    ln -sfnT -- "$old" live/.previous.next
    mv -Tf live/.previous.next live/previous
  fi
  ln -sfnT -- "$target" live/.current.next
  mv -Tf live/.current.next live/current
  "${SYSTEMCTL:-systemctl}" --user restart toddler-ipad

  local manifest expected interpreter=python3
  if [[ -x live/.venv/bin/python ]]; then interpreter=live/.venv/bin/python; fi
  manifest=$(curl --fail --silent --show-error --retry 30 --retry-delay 1 --retry-max-time 45 --retry-connrefused \
    --max-time 5 "http://127.0.0.1:${PORT:-8019}/release.json") || {
    echo "Snapshot $target selected, but the service did not return release.json" >&2
    return 1
  }
  # Compare with the selected code, template, app and the same active recordings.
  # The previous (pre-snapshot) release builder took the data directory directly.
  expected=$(PYTHONPATH="live/$target/src" "$interpreter" - "live/$target/app" "${TODDLER_DATA_DIR:-data}" <<'PY'
import sys
from pathlib import Path
from toddler_ipad import release
app, data = map(Path, sys.argv[1:])
source = release.recorded_clips(app, data) if hasattr(release, "recorded_clips") else data
print(release.build_release(app, source)["id"])
PY
)
  python3 -c '
import json, re, sys
release_id = json.load(sys.stdin)["id"]
if not re.fullmatch("[0-9a-f]{16}", release_id) or release_id != sys.argv[1]:
    sys.exit(f"Wrong release from service: expected {sys.argv[1]}, got {release_id!r}")
' "$expected" <<<"$manifest"
  echo "Serving snapshot $target (release $expected)"
}
