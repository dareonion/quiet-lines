"""Verify listening approvals in the repository and complete S0 packs for Pages releases."""
import hashlib
import json
import os
import re
from pathlib import Path

import pytest

from toddler_ipad.site import collect_voice_packs, pack_metadata

ROOT = Path(__file__).resolve().parents[1]
VOICES = ROOT / "voices"
PACKS = sorted(p for p in VOICES.iterdir() if p.is_dir())
CLIPS = json.loads((ROOT / "app/content/catalog.json").read_bytes())["clips"]


def test_shared_metadata_and_defaults():
    shared = json.loads((VOICES / "voices.json").read_bytes())
    assert shared["disclosure"] == "The voices are computer-generated with Microsoft Azure Speech."
    assert shared["credits"] == "CREDITS.md" and (VOICES / shared["credits"]).is_file()
    approved_packs = [pack_metadata(p) for p in PACKS if json.loads((p / "approved.json").read_bytes())]
    for lang in {pack["lang"] for pack in approved_packs}:
        assert sum(p["default"] for p in approved_packs if p["lang"] == lang) == 1, lang


@pytest.mark.parametrize("pack", PACKS, ids=lambda p: p.name)
def test_pack_files_match_approvals(pack):
    lang = pack_metadata(pack)["lang"]
    approved = json.loads((pack / "approved.json").read_bytes())
    assert isinstance(approved, dict)
    for key, digest in approved.items():
        assert key in CLIPS and CLIPS[key]["lang"] == lang, key
        assert re.fullmatch("[0-9a-f]{64}", digest), key
    for path in pack.rglob("*.m4a"):
        assert path.parent == pack and approved.get(path.stem) == hashlib.sha256(path.read_bytes()).hexdigest(), path


@pytest.mark.skipif(os.environ.get("TODDLER_RELEASE") != "1", reason="release gate: set TODDLER_RELEASE=1")
def test_packs_are_complete_and_from_the_paid_tier():
    collect_voice_packs(VOICES, CLIPS)
