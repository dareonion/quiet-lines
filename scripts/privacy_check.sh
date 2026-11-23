#!/usr/bin/env bash
# No arguments checks the index and working tree. REV checks every reachable commit.
# An optional second argument adds a built site, including its published voice-pack audio.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/privacy_check.py "$@"
