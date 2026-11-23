import hashlib
import json
import shutil
from urllib.parse import unquote

import pytest

from toddler_ipad.site import APP, build_site


def files(directory):
    return {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}


def test_release_tree_and_rebuild(tmp_path, voice_pack, capsys):
    out = tmp_path / "site"
    release = build_site(out, voice_pack)
    public = {"index.html", "app.css", "manifest.webmanifest"}
    for pattern in ("icons/*.png", "js/**/*.js", "content/**/*"):
        public.update(p.relative_to(APP).as_posix() for p in APP.glob(pattern)
                      if p.is_file() and not p.name.endswith(".test.js"))

    expected_clips = {}
    for path in voice_pack.glob("*/*.m4a"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        expected_clips[f"{path.parent.name}/{path.stem}"] = {"take_id": digest, "sha256": digest}
    audio = {f"audio/{key}.m4a" for key in expected_clips}
    assert files(out) == public | audio | {"release.json", "sw.js", ".nojekyll", "LICENSE.txt", "audio/CREDITS.md"}
    assert release == json.loads((out / "release.json").read_bytes())
    assert release["clips"] == expected_clips
    packs = {
        "en-jenny": {"lang": "en", "label": "Jenny", "default": True},
        "en-guy": {"lang": "en", "label": "Guy", "default": False},
        "zh-hsiaochen": {"lang": "zh", "label": "HsiaoChen", "default": True},
        "zh-yunjhe": {"lang": "zh", "label": "YunJhe", "default": False},
    }
    assert release["voices"] == {"packs": packs, "disclosure": "Computer-generated test tones."}
    assert "recorder" not in release
    assert set(release["files"]) == (public - {"index.html"}) | audio | {"", "release.json", "LICENSE.txt"}
    assert release["hashes"].keys() == set(release["files"]) - {"release.json"}
    for url, expected in release["hashes"].items():
        assert hashlib.sha256((out / (unquote(url) or "index.html")).read_bytes()).hexdigest() == expected
    assert (out / "audio/CREDITS.md").read_bytes() == (voice_pack / "CREDITS.md").read_bytes()

    assert (out / "LICENSE.txt").read_bytes() == (APP.parent / "LICENSE").read_bytes()

    for path in (voice_pack / "en-guy").glob("*.m4a"):
        path.unlink()
    with pytest.raises(ValueError, match="audio coverage"):
        build_site(out, voice_pack)
    assert release == json.loads((out / "release.json").read_bytes())
    removed = build_site(out, voice_pack, preview=True)
    assert "Omitting empty voice pack: en-guy" in capsys.readouterr().err
    assert removed["id"] != release["id"]
    del packs["en-guy"]
    assert removed["voices"]["packs"] == packs
    assert removed["clips"] == {k: v for k, v in expected_clips.items() if not k.startswith("en-guy/")}
    assert not (out / "audio/en-guy").exists()


def test_metadata_changes_release_id(tmp_path, voice_pack):
    out = tmp_path / "site"
    before = build_site(out, voice_pack)
    path = voice_pack / "en-jenny/pack.json"
    path.write_text(json.dumps({**json.loads(path.read_bytes()), "label": "New label"}))
    after = build_site(out, voice_pack)
    assert after["id"] != before["id"] and after["clips"] == before["clips"]


def test_unexpected_file_keeps_previous_output(tmp_path, app_dir, voice_pack):
    out = tmp_path / "site"
    build_site(out, voice_pack, app_dir=app_dir)
    original = (out / "sw.js").read_bytes()
    (app_dir / "private.txt").touch()
    with pytest.raises(ValueError, match="private.txt"):
        build_site(out, voice_pack, app_dir=app_dir)
    assert (out / "sw.js").read_bytes() == original


@pytest.mark.parametrize("metadata", [None, "{", "[]", "{}",
    '{"lang":"fr","label":"Guy","voice":"v","default":false}',
    '{"lang":"en","label":"","voice":"v","default":false}',
    '{"lang":"en","label":"Guy","voice":null,"default":false}',
    '{"lang":"en","label":"Guy","voice":"v","default":"false"}'])
def test_missing_or_invalid_metadata_even_for_empty_pack(tmp_path, voice_pack, metadata):
    pack = voice_pack / "empty"
    pack.mkdir()
    (pack / "approved.json").write_text("{}")
    if metadata is not None:
        (pack / "pack.json").write_text(metadata)
    with pytest.raises(ValueError, match="empty/pack.json"):
        build_site(tmp_path / "site", voice_pack)


@pytest.mark.parametrize("key", ["num.1.zh", "not.in.catalog"])
@pytest.mark.parametrize("preview", [True, False])
def test_wrong_language_or_unknown_clip_fails(tmp_path, voice_pack, key, preview):
    (voice_pack / "en-jenny" / f"{key}.m4a").touch()
    with pytest.raises(ValueError, match=key):
        build_site(tmp_path / "site", voice_pack, preview=preview)


@pytest.mark.parametrize("pack,default", [("en-jenny", False), ("en-guy", True)])
def test_exactly_one_shipped_default(tmp_path, voice_pack, pack, default):
    if default:
        # Make the second default complete, so the only error is the duplicate default.
        shutil.copytree(voice_pack / "en-jenny", voice_pack / pack, dirs_exist_ok=True)
    path = voice_pack / pack / "pack.json"
    path.write_text(json.dumps({**json.loads(path.read_bytes()), "default": default}))
    with pytest.raises(ValueError, match="one shipped default.*en"):
        build_site(tmp_path / "site", voice_pack)


def test_default_with_no_audio_does_not_count(tmp_path, voice_pack):
    for path in (voice_pack / "en-jenny").glob("*.m4a"):
        path.unlink()
    with pytest.raises(ValueError, match="audio coverage"):
        build_site(tmp_path / "site", voice_pack)
    (voice_pack / "en-guy/approved.json").unlink()
    release = build_site(tmp_path / "site", voice_pack, preview=True)
    assert set(release["voices"]["packs"]) == {"en-guy", "zh-hsiaochen", "zh-yunjhe"}


@pytest.mark.parametrize("clear", [True, False])
def test_unapproved_audio_and_preview(tmp_path, voice_pack, clear):
    out = tmp_path / "site"
    path = voice_pack / "en-guy/approved.json"
    approved = json.loads(path.read_bytes())
    approved["num.1.en"] = "0" * 64
    path.write_text(json.dumps({} if clear else approved))
    with pytest.raises(ValueError, match="en-guy/num.1.en"):
        build_site(out, voice_pack)
    assert not out.exists()
    # The review includes even an empty pack, but lists only that pack's language.
    (voice_pack / "zh-yunjhe/num.2.zh.m4a").unlink()
    release = build_site(out, voice_pack, preview=True)
    html = (out / "voices.html").read_text()
    assert html.count("<section>") == 4
    for section in html.split("<section>")[1:]:
        header, table = section.split("</h2>")
        lang = "en" if "(en-" in header else "zh"
        catalog = json.loads((APP / "content/catalog.json").read_bytes())["clips"]
        assert {k for k in catalog if f'<th scope="row">{k}</th>' in table} == {
            k for k, v in catalog.items() if v["lang"] == lang}
    assert "audio/en-guy/num.1.en.m4a" in html
    assert release["clips"]["en-guy/num.1.en"]["sha256"] in html
    assert "Missing" in html and "voices.html" not in release["files"]
    assert "zh-yunjhe" not in release["voices"]["packs"]


@pytest.mark.parametrize("field", ["tier", "voice", "sha256", "absent"])
def test_build_requires_matching_source(tmp_path, voice_pack, field):
    path = voice_pack / "en-guy/source.json"
    if field == "absent":
        path.unlink()
    else:
        source = json.loads(path.read_bytes())
        source["num.1.en"][field] = "other"
        path.write_text(json.dumps(source))
    with pytest.raises(ValueError, match="source"):
        build_site(tmp_path / "site", voice_pack)


@pytest.mark.parametrize("name", ["extra.m4a", ".draft", "glyphs/hanzi/other.json"])
def test_content_allowlist(tmp_path, app_dir, voice_pack, name):
    path = app_dir / "content" / name
    path.parent.mkdir(exist_ok=True, parents=True)
    path.touch()
    with pytest.raises(ValueError, match="Unexpected file"):
        build_site(tmp_path / "site", voice_pack, app_dir=app_dir)


def test_unapproved_optional_pack_is_left_out(tmp_path, voice_pack, capsys):
    """A non-default voice still being made (no audio, no approvals) doesn't block a release."""
    pending = voice_pack / "zh-pending"
    pending.mkdir()
    (pending / "pack.json").write_text(json.dumps({"lang": "zh", "label": "Pending", "voice": "PendingTest",
                                                   "default": False}))
    (pending / "approved.json").write_text("{}")
    release = build_site(tmp_path / "site", voice_pack)
    assert "zh-pending" not in release["voices"]["packs"]
    assert "Omitting voice pack with no approved clips: zh-pending" in capsys.readouterr().err
