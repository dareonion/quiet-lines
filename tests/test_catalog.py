import hashlib
import json
import re
import string
import subprocess
from pathlib import Path
from urllib.parse import quote

import pytest

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "app/content"
CATALOG = CONTENT / "catalog.json"
LATIN = CONTENT / "glyphs/latin.json"
ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
SHAPES = "vline hline diagonal circle cross zigzag wave square triangle heart star balloon ice-cream".split()
HANZI = "一二三四五六七八九十人口大小山水火日月木手目魚鳥馬牛羊耳雨上下"
# What each ten-frame picture is called in the counting phrases ("five turtles", 五隻烏龜).
COUNTED = {"🍎": ("apple", "顆蘋果"), "🐟": ("fish", "條魚"), "🦆": ("ducks", "隻鴨子"), "🍐": ("pears", "顆梨子"),
           "🐢": ("turtles", "隻烏龜"), "🥕": ("carrots", "根紅蘿蔔"), "🍋": ("lemons", "顆檸檬"),
           "🐰": ("rabbits", "隻兔子"), "🍊": ("oranges", "顆橘子"), "🍌": ("bananas", "根香蕉")}


@pytest.fixture
def catalog():
    return json.loads(CATALOG.read_bytes())


def test_catalog_ids_and_recordings(catalog):
    clips = catalog["clips"]
    items = catalog["items"]
    assert all(ID.fullmatch(key) for key in clips)
    assert all(ID.fullmatch(item["id"]) for item in items)
    assert len({item["id"] for item in items}) == len(items)
    used = set()
    for item in items:
        for role, key in [*item["clips"].items(), *item.get("count_clips", {}).items()]:
            assert key in clips, (item["id"], key)
            assert clips[key]["lang"] == ("en" if role == "word" else role)
            used.add(key)
    assert used == clips.keys()
    for key, clip in clips.items():
        lang, text, prompt = clip["lang"], clip["text"], clip["prompt"]
        assert text and key.endswith("." + lang)
        if lang == "en":
            assert prompt == ("Say the letter: " if key.startswith("letter.") else "Say: ") + text
        else:
            assert lang == "zh" and re.fullmatch(r"請說：" + re.escape(text) + r"（[^（）]+）", prompt)


def test_pilot_recording_compatibility(catalog):
    items = {item["id"]: item for item in catalog["items"]}
    for item_id, glyph, lang, key, text in (
        ("shape.vline", "latin:vline", "en", "shape.line.en", "line"),
        ("shape.vline", "latin:vline", "zh", "shape.line.zh", "線"),
        ("letter.b", "latin:B", "en", "letter.b.en", "B"),
        ("char.yu2", "hanzi:魚", "zh", "char.yu2.zh", "魚"),
    ):
        assert items[item_id]["glyph"] == glyph
        assert items[item_id]["clips"][lang] == key
        assert catalog["clips"][key]["text"] == text


def test_v1_sequence_and_glyph_references(catalog):
    expected = [("shape", "latin:" + name) for name in SHAPES]
    expected += [("number", f"latin:{n}") for n in range(11)]
    expected += [("letter", "latin:" + letter) for letter in string.ascii_uppercase]
    expected += [("hanzi", "hanzi:" + char) for char in HANZI]
    assert [(item["kind"], item["glyph"]) for item in catalog["items"]] == expected
    glyphs = json.loads(LATIN.read_bytes())["glyphs"]
    for kind, glyph in expected:
        if kind != "hanzi":
            assert glyph.removeprefix("latin:") in glyphs


def test_counting_and_picture_words(catalog):
    for item in catalog["items"]:
        kind, glyph = item["kind"], item["glyph"].split(":")[1]
        if kind == "number":
            if glyph == "0":
                assert item.get("count_emoji") is None and "count_clips" not in item
            else:
                assert item["count_emoji"]
                # After the last object it says what was counted: "five turtles", 五隻烏龜.
                assert item["count_clips"] == {lang: f"count.{glyph}.{lang}" for lang in ("en", "zh")}
                en = catalog["clips"][f"count.{glyph}.en"]["text"]
                zh = catalog["clips"][f"count.{glyph}.zh"]["text"]
                en_noun, zh_noun = COUNTED[item["count_emoji"]]
                assert en == catalog["clips"][f"num.{glyph}.en"]["text"] + " " + en_noun
                assert zh == ("兩" if glyph == "2" else catalog["clips"][f"num.{glyph}.zh"]["text"]) + zh_noun
            assert item["clips"] == {lang: f"num.{glyph}.{lang}" for lang in ("en", "zh")}
        if kind == "letter":
            assert item["emoji"]
            word = item["word"]
            assert item["clips"] == {"en": f"letter.{glyph.lower()}.en", "word": f"word.{word.replace(' ', '-')}.en"}
            assert catalog["clips"][item["clips"]["word"]]["text"] == word
            if glyph == "X":
                assert (word, item["emoji"], item["word_note"]) == ("box", "📦", "ends with x")
            else:
                assert word.startswith(glyph.lower())
        if kind == "hanzi":
            assert type(item["strokes"]) is int and item["strokes"] > 0
            assert item["trace"] is True   # all 31; 魚 鳥 馬 雨 (8 to 11 strokes) were look-and-listen until 2026-11-23
            if glyph in HANZI[:10]:
                assert item["clips"] == {"zh": f"num.{HANZI.index(glyph) + 1}.zh"}
            if glyph in HANZI[:10] + "上下":
                assert item["emoji"] is None
            else:
                assert item["emoji"]
        else:
            assert item["trace"] is True


def test_latin_paths():
    # Use the same parser and curve sampler as the canvas. Reject unsupported
    # tokens separately because the app tokenizer silently skips unknown letters.
    script = """
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import {samplePath, polylineLength} from './app/js/trace/path.js';
        const {box, glyphs} = JSON.parse(fs.readFileSync(process.argv[1]));
        assert.equal(box, 100);
        for (const [name, glyph] of Object.entries(glyphs)) {
          assert.ok(glyph.strokes.length, name);
          for (const d of glyph.strokes) {
            const label = name + ': ' + d;
            assert.match(d, /^M[MLHVCQZ0-9., +\\s-]+$/, label);
            assert.equal(d.match(/M/g).length, 1, label);
            const pts = samplePath(d, 0.1);
            assert.ok(pts.every(p => p.every(n => n >= 0 && n <= box)), label);
            assert.ok(polylineLength(pts) >= 12, label);
          }
        }
    """
    subprocess.run(["node", "--input-type=module", "-e", script, str(LATIN)], cwd=ROOT, check=True)


def test_vendored_hanzi(catalog):
    directory = CONTENT / "glyphs/hanzi"
    if not directory.exists() or not any(directory.iterdir()):
        pytest.skip("Hanzi directory is empty. Claude runs uv run scripts/vendor_hanzi.py to populate it.")
    for item in catalog["items"]:
        if item["kind"] == "hanzi":
            char = item["glyph"].removeprefix("hanzi:")
            path = directory / f"{ord(char):x}.json"
            assert path.is_file(), f"Missing {char} at {path.name}"
            data = json.loads(path.read_bytes())
            assert next(iter(data)) == "notice" and data["notice"].startswith("Modified ")
            assert data["char"] == char
            assert len(data["strokes"]) == len(data["medians"]) == item["strokes"]
    # Arphic Public License: the licence travels unaltered, beside our notice of the changes.
    assert hashlib.sha256((directory / "ARPHICPL.TXT").read_bytes()).hexdigest() == (
        "5590533436c70f10f2f524ee61456238c290175c6662fbe1c700b5f038a6d328")
    assert "## Changes" in (directory / "NOTICE.md").read_text()
    assert not (directory / "LICENSE.md").exists()
    assert "Taiwan's stroke order" in json.loads((directory / "99ac.json").read_bytes())["notice"]


def test_vendor_round_trip_and_failures(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import vendor_hanzi as vendor

    catalog_path = tmp_path / "catalog.json"
    chars = {"一": 1, "二": 2, "山": 3}
    catalog_path.write_text(json.dumps({"items": [
        {"glyph": "hanzi:" + char, "strokes": count} for char, count in chars.items()
    ]}))
    output = tmp_path / "out"
    source = tmp_path / "source"
    source.mkdir()
    (source / "ARPHICPL.TXT").write_bytes((CONTENT / "glyphs/hanzi/ARPHICPL.TXT").read_bytes())
    for char, count in chars.items():
        raw = {"strokes": ["M1 3 Q2 4 5 6 Z"] * count, "medians": [[[1, 3], [5, 6]]] * count}
        (source / (char + ".json")).write_text(json.dumps(raw))

    # Stand in for jsDelivr and check that actual urllib requests use encoded filenames.
    urls = {vendor.BASE + quote(path.name): path for path in source.iterdir()}
    monkeypatch.setattr(vendor, "urlopen", lambda url, timeout: urls[url].open("rb"))
    vendor.vendor(catalog_path, output, False)
    mtimes = {p: p.stat().st_mtime_ns for p in output.iterdir()}
    vendor.vendor(catalog_path, output, False)
    assert mtimes == {p: p.stat().st_mtime_ns for p in output.iterdir()}
    for char in chars:
        raw = json.loads((source / (char + ".json")).read_bytes())
        assert json.loads((output / f"{ord(char):x}.json").read_bytes()) == {
            "notice": vendor.notice_for(char), "char": char, "source": "hanzi-writer-data@2.0.1",
            "box": 1024, "y_flip": 900, **raw,
        }
    assert (output / "ARPHICPL.TXT").read_bytes() == (source / "ARPHICPL.TXT").read_bytes()

    (source / "一.json").unlink()
    bad = json.loads((source / "山.json").read_bytes())
    bad["strokes"].pop()
    (source / "山.json").write_text(json.dumps(bad))
    with pytest.raises(SystemExit) as failed:
        vendor.vendor(catalog_path, output, False)
    assert "一 (4e00.json)" in str(failed.value)
    assert "山 (5c71.json): 2 strokes, catalog expects 3" in str(failed.value)

    (source / "ARPHICPL.TXT").unlink()
    fresh = tmp_path / "fresh"
    with pytest.raises(SystemExit) as failed:
        vendor.vendor(catalog_path, fresh, False)
    assert all(name in str(failed.value) for name in ("ARPHICPL.TXT", "一 (4e00.json)", "山 (5c71.json)"))
    assert not list(fresh.iterdir())

    def offline(*args, **kwargs):
        pytest.fail("Offline check attempted a download")

    monkeypatch.setattr(vendor, "urlopen", offline)
    vendor.vendor(catalog_path, output, True)
    (output / "ARPHICPL.TXT").write_text("ARPHIC PUBLIC LICENSE\n")
    (output / "4e00.json").unlink()
    path = output / "5c71.json"
    data = json.loads(path.read_bytes())
    data["medians"].pop()
    path.write_text(json.dumps(data))
    with pytest.raises(SystemExit) as failed:
        vendor.vendor(catalog_path, output, True)
    assert "Arphic Public License SHA-256 mismatch" in str(failed.value)
    assert "一 (4e00.json)" in str(failed.value)
    assert "山 (5c71.json): 2 medians, catalog expects 3" in str(failed.value)
