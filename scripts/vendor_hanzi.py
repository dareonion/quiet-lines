#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Vendor catalog glyphs with uv run scripts/vendor_hanzi.py. Use --check offline."""

import argparse
import hashlib
import json
from http.client import HTTPException
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import quote
from urllib.request import urlopen

CONTENT = Path(__file__).resolve().parents[1] / "app/content"
SOURCE = "hanzi-writer-data@2.0.1"
BASE = f"https://cdn.jsdelivr.net/npm/{SOURCE}/"
NOTICE = """# Hanzi stroke data

The outlines and medians in this directory come from `hanzi-writer-data@2.0.1`.
The packager attributes the underlying fonts to Arphic Technology Co., Ltd.
and says “You can redistribute and/or modify this data under the terms of the
Arphic Public License”. [Package README](https://github.com/chanind/hanzi-writer-data/tree/v2.0.1#license)

Make Me a Hanzi puts both outlines and medians in its Arphic-licensed
`graphics.txt`. Its separate `dictionary.txt` uses LGPL-3.0-or-later.
This directory contains only graphical data. [Make Me a Hanzi](https://github.com/skishore/makemeahanzi#format)
and [upstream license split](https://github.com/skishore/makemeahanzi/blob/master/COPYING).
We have not independently audited the original font provenance.

## Changes (Arphic Public License, section 2)

These files are modified versions of the package's per-character JSON. Each file
starts with a `notice` field saying how and when it was changed:
`scripts/vendor_hanzi.py` copied the outline strings and median coordinates and
added the character, source and display coordinates (2026-11-22). For 馬 it also
reordered both the outlines and the medians to Taiwan's stroke order.

The modified data is distributed under the Arphic Public License, whose text is
in `ARPHICPL.TXT` in this directory, unaltered. The rest of this project (code,
catalog, Latin glyphs) is under its own licence, as separate works aggregated
with this data (section 2 of the Arphic Public License).
"""
LICENSE_SHA256 = "5590533436c70f10f2f524ee61456238c290175c6662fbe1c700b5f038a6d328"
# The date these files were changed from the package's, for each file's notice (Arphic PL 2a).
VENDORED_ON = "2026-11-22"


def notice_for(char, order=None):
    text = (f"Modified {VENDORED_ON} from {SOURCE} {char}.json (Arphic Public License, see "
            "ARPHICPL.TXT): added the char, source, box and y_flip fields.")
    if order:
        text += f" Reordered the strokes and medians arrays to Taiwan's stroke order {order}."
    return text

# Taiwan stroke order. The data follows mainland conventions. Codex checked all 31 v1 characters
# against Taiwan's Ministry of Education sources on 2026-11-22 (counts all match; report in the
# session record). Reorders to apply to both `strokes` and `medians` (directions unchanged):
TAIWAN_ORDER = {
    # MoE: left 豎 before the top 橫. https://stroke-order.learningweb.moe.edu.tw/dictView.jsp?ID=39340
    "馬": [1, 0, 2, 3, 4, 5, 6, 7, 8, 9],
}
# Known form differences, kept deliberately (all tiny for a toddler):
# - 四, 日: Taiwan's standard ends stroke 2 with a small hook (橫折鉤); the data has none.
# - 雨 (look-and-listen only): Taiwan's inner strokes are 點, 挑, 撇, 點; the data has four 點.
# - 目, 魚, 鳥: some inner bars stop short of the frame.
# - 耳: MoE sources disagree; the data matches the archived MoE player and CNS 11643, so it stays.


def download(name):
    with urlopen(BASE + quote(name), timeout=30) as response:
        return response.read()


def write_if_changed(path, content):
    if path.exists() and path.read_bytes() == content:
        return
    with NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        temp_path = Path(temp.name)
        try:
            temp.write(content)
            temp.close()
            temp_path.chmod(0o644)
            temp_path.replace(path)
        finally:
            temp_path.unlink(missing_ok=True)


def validate(data, char, count):
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    if next(iter(data), None) != "notice" or data["notice"] != notice_for(char, TAIWAN_ORDER.get(char)):
        raise ValueError("expected the change notice as the first field: re-run without --check")
    for key, expected in (("char", char), ("source", SOURCE), ("box", 1024), ("y_flip", 900)):
        if data.get(key) != expected:
            raise ValueError(f"expected {key}={expected!r}")
    for key in ("strokes", "medians"):
        values = data.get(key)
        if not isinstance(values, list):
            raise ValueError(f"missing or invalid {key}")
        if len(values) != count:
            raise ValueError(f"{len(values)} {key}, catalog expects {count}")
    for i, (outline, median) in enumerate(zip(data["strokes"], data["medians"]), 1):
        if not isinstance(outline, str) or not outline.strip():
            raise ValueError(f"stroke {i} has an empty outline")
        if not isinstance(median, list) or len(median) < 2 or not all(
            isinstance(pt, list) and len(pt) == 2 and all(type(n) is int for n in pt)
            for pt in median
        ):
            raise ValueError(f"stroke {i} has an invalid median")


def vendor(catalog, output, check):
    items = json.loads(catalog.read_bytes())["items"]
    expected = {}
    for item in items:
        glyph = item.get("glyph", "")
        if glyph.startswith("hanzi:"):
            char = glyph.removeprefix("hanzi:")
            count = item.get("strokes")
            if (len(char) != 1 or type(count) is not int or count < 1
                    or expected.setdefault(char, count) != count):
                raise ValueError(f"{glyph}: invalid character or conflicting stroke count {count!r}")

    if not check:
        output.mkdir(parents=True, exist_ok=True)
    errors = []
    license_path, notice_path = output / "ARPHICPL.TXT", output / "NOTICE.md"
    try:
        # The licence must travel unaltered (section 1), so it's saved byte for byte as downloaded.
        license_text = license_path.read_bytes() if check else download("ARPHICPL.TXT")
        if hashlib.sha256(license_text).hexdigest() != LICENSE_SHA256:
            raise ValueError("Arphic Public License SHA-256 mismatch")
        if check and notice_path.read_bytes() != NOTICE.encode():
            raise ValueError("NOTICE.md is out of date: re-run without --check")
        if not check:
            write_if_changed(license_path, license_text)
            write_if_changed(notice_path, NOTICE.encode())
            (output / "LICENSE.md").unlink(missing_ok=True)   # the old combined file
    except (ValueError, OSError, HTTPException) as exc:
        errors.append(f"ARPHICPL.TXT: {exc}")

    license_ready = not errors
    for char, count in expected.items():
        path = output / f"{ord(char):x}.json"
        try:
            if check:
                data = json.loads(path.read_bytes())
            else:
                raw = json.loads(download(char + ".json"))
                order = TAIWAN_ORDER.get(char)
                strokes, medians = raw["strokes"], raw["medians"]
                if order:
                    if sorted(order) != list(range(len(strokes))):
                        raise ValueError(f"TAIWAN_ORDER for {char} doesn't fit {len(strokes)} strokes")
                    strokes = [strokes[i] for i in order]
                    medians = [medians[i] for i in order]
                data = {"notice": notice_for(char, order), "char": char, "source": SOURCE,
                        "box": 1024, "y_flip": 900, "strokes": strokes, "medians": medians}
                if order:
                    data["taiwan_order"] = order
            validate(data, char, count)
            if check and TAIWAN_ORDER.get(char) and data.get("taiwan_order") != TAIWAN_ORDER[char]:
                raise ValueError("Taiwan stroke order not applied: re-run without --check")
            if not check and license_ready:
                content = json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
                write_if_changed(path, content.encode())
        except (ValueError, KeyError, TypeError, OSError, HTTPException) as exc:
            errors.append(f"{char} ({path.name}): {exc}")
    if errors:
        raise SystemExit("Hanzi verification failed:\n" + "\n".join(errors))
    print(f"Verified {len(expected)} glyphs in {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CONTENT / "catalog.json")
    parser.add_argument("--output", type=Path, default=CONTENT / "glyphs/hanzi")
    parser.add_argument("--check", action="store_true", help="verify local files without downloading")
    args = parser.parse_args()
    vendor(args.catalog, args.output, args.check)
