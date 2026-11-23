"""Build the static, scope-relative edition from reviewed voice files."""

import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import sys
from html import escape
from pathlib import Path
from tempfile import TemporaryDirectory

from .release import TEMPLATE, build_release, catalog_clips, public_files, render_worker

APP = Path(__file__).resolve().parents[2] / "app"


def _read_object(path):
    try:
        data = json.loads(path.read_bytes())
    except (FileNotFoundError, ValueError) as exc:
        raise ValueError(f"Cannot read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return data


def pack_metadata(pack):
    metadata = _read_object(pack / "pack.json")
    if (metadata.get("lang") not in ("en", "zh")
            or not isinstance(metadata.get("default"), bool)
            or not all(isinstance(metadata.get(k), str) and metadata[k].strip()
                       for k in ("voice", "label"))):
        raise ValueError(f"Invalid {pack}/pack.json: expected lang, label, voice and boolean default")
    return metadata


def collect_voice_packs(voices, catalog, *, audio=None, preview=False):
    """Validate the release packs, optionally staging the exact bytes checked for publication."""
    packs, shipped, clips = {}, {}, {}
    for pack in sorted(voices.iterdir()):
        if not pack.is_dir():
            if pack.suffix == ".m4a":
                raise ValueError(f"Expected a clip inside a voice pack: {pack}")
            continue
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", pack.name):
            raise ValueError(f"Invalid voice pack id: {pack.name}")
        metadata = pack_metadata(pack)
        packs[pack.name] = {k: metadata[k] for k in ("lang", "label", "default")}
        language = {k for k, v in catalog.items() if v["lang"] == metadata["lang"]}
        paths = sorted(pack.rglob("*.m4a"))
        present = {path.stem for path in paths}
        approvals = pack / "approved.json"
        approved = {} if preview and not approvals.exists() else _read_object(approvals)
        unknown = (approved.keys() | present) - language
        if unknown:
            raise ValueError(f"{pack.name}/{min(unknown)} is unknown or has the wrong language")

        if not preview and not metadata["default"] and not approved and not present:
            # An optional voice nobody has approved yet (e.g. one still being made) isn't released.
            print(f"Omitting voice pack with no approved clips: {pack.name}", file=sys.stderr)
            continue
        if not preview:
            recipes_path = pack / "recipes.json"
            recipes = _read_object(recipes_path) if recipes_path.exists() else {}
            if not all(isinstance(recipe, dict) for recipe in recipes.values()):
                raise ValueError(f"Invalid recipe in {recipes_path}")
            skipped = {k for k, recipe in recipes.items() if recipe.get("skip") is True}
            if skipped - language or (skipped and metadata["default"]):
                raise ValueError(f"Invalid skipped clips in {recipes_path}")
            required = language - skipped
            for what, keys in (("audio", present), ("approvals", approved.keys())):
                if keys != required:
                    differences = ", ".join(f"{pack.name}/{k}" for k in sorted(keys ^ required))
                    raise ValueError(f"Incorrect {what} coverage: {differences}")
            source = _read_object(pack / "source.json")

        for path in paths:
            if path.parent != pack:
                raise ValueError(f"Expected a clip directly inside {pack}: {path}")
            content = path.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            if not preview:
                record = source.get(path.stem)
                if approved.get(path.stem) != digest:
                    raise ValueError(f"Unapproved voice file or SHA-256 mismatch: {path}")
                if (not isinstance(record, dict) or record.get("sha256") != digest
                        or record.get("tier") != "S0" or record.get("voice") != metadata["voice"]):
                    raise ValueError(f"Missing or mismatched S0 source record: {path}")
            if audio is not None:
                dest = audio / pack.name / path.name
                dest.parent.mkdir(exist_ok=True)
                dest.write_bytes(content)
            clips[f"{pack.name}/{path.stem}"] = {"take_id": digest, "sha256": digest}
        if paths:
            shipped[pack.name] = packs[pack.name]
        else:
            print(f"Omitting empty voice pack: {pack.name}", file=sys.stderr)

    # Complete default coverage above guarantees a fallback for every explicit skip.
    for lang in {v["lang"] for v in catalog.values()}:
        defaults = sum(p["default"] for p in shipped.values() if p["lang"] == lang)
        if defaults > 1 or (not preview and defaults != 1):
            raise ValueError(f"Expected exactly one shipped default voice pack for {lang}")
    return packs, shipped, clips


def _review_page(catalog, clips, packs):
    sections = []
    for pack_id, pack in packs.items():
        rows = []
        for key, info in catalog.items():
            if info["lang"] != pack["lang"]:
                continue
            clip = clips.get(f"{pack_id}/{key}")
            if clip:
                player = (f'<audio controls preload="none" aria-label="Play {key}" '
                          f'src="audio/{pack_id}/{key}.m4a"></audio>')
            else:
                player = '<button disabled>Play</button>'
            rows.append(f'<tr><th scope="row">{key}</th><td>{escape(info["text"])}</td>'
                        f'<td>{player}</td><td><code>{clip["sha256"] if clip else "Missing"}</code></td></tr>')
        sections.append(f'<section><h2>{escape(pack["label"])} ({pack_id})</h2><table><thead>'
                        '<tr><th>Clip</th><th>Text</th><th>Listen</th><th>SHA-256</th></tr>'
                        '</thead><tbody>' + "\n".join(rows) + '</tbody></table></section>')
    return """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Voice review</title>
<style>body{background:#f6f1e7;color:#39362f;font:1rem system-ui;margin:2rem}
th,td{text-align:left;padding:.5rem}code{overflow-wrap:anywhere}audio{width:14rem}</style>
<h1>Voice review</h1>""" + "\n".join(sections) + "</html>\n"


def _publish(stage: Path, out: Path):
    if out.is_symlink() or (out.exists() and not out.is_dir()):
        raise ValueError(f"Output must be a directory: {out}")
    if not out.exists():
        stage.rename(out)
        return
    # Ordinary rename cannot replace a populated directory. Exchange both names in one
    # operation so concurrent readers always have an OUT, even if this process is killed.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        result = libc.renamex_np(os.fsencode(stage), os.fsencode(out), 2)  # RENAME_SWAP
    elif hasattr(libc, "renameat2"):
        result = libc.renameat2(-100, os.fsencode(stage), -100, os.fsencode(out), 2)  # RENAME_EXCHANGE
    else:
        raise OSError("Replacing an existing site requires atomic directory exchange on this platform")
    if result:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), out)


def build_site(out: Path, voices: Path, *, preview=False, app_dir: Path = APP):
    # In particular, a mistyped OUT of "." must never replace the project or either input.
    for source in (app_dir.resolve(), voices.resolve()):
        if source.is_relative_to(out.resolve()) or out.resolve().is_relative_to(source):
            raise ValueError(f"Output overlaps build inputs: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    shared = _read_object(voices / "voices.json")
    if (not isinstance(shared.get("disclosure"), str) or not shared["disclosure"].strip()
            or shared.get("credits") != "CREDITS.md"):
        raise ValueError("Invalid voices.json: expected a disclosure and CREDITS.md")
    with TemporaryDirectory(dir=out.parent, prefix=f".{out.name}-") as work:
        stage = Path(work) / "site"
        stage.mkdir()
        for _, path in public_files(app_dir):
            dest = stage / path.relative_to(app_dir)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)

        catalog = catalog_clips(stage)
        # Keep audio beside the staged app until the allowlisted app files have been hashed.
        audio = Path(work) / "audio"
        audio.mkdir()
        packs, shipped, clips = collect_voice_packs(voices, catalog, audio=audio, preview=preview)

        # The MIT notice travels with the code, into the offline copy too (so it is in the manifest).
        shutil.copyfile(APP.parent / "LICENSE", stage / "LICENSE.txt")
        template = TEMPLATE.read_bytes()
        release = build_release(stage, clips, template)
        release["voices"] = {"disclosure": shared["disclosure"], "packs": shipped}
        # A disclosure edit alone must also bring existing installations a new manifest.
        identity = json.dumps([release["id"], release["voices"]], sort_keys=True).encode()
        release["id"] = hashlib.sha256(identity).hexdigest()[:16]
        shutil.copyfile(voices / "CREDITS.md", audio / "CREDITS.md")
        audio.rename(stage / "audio")
        (stage / "release.json").write_text(json.dumps(release, ensure_ascii=False) + "\n", encoding="utf-8")
        (stage / "sw.js").write_text(render_worker(release, template), encoding="utf-8")
        (stage / ".nojekyll").touch()
        if preview:
            (stage / "voices.html").write_text(_review_page(catalog, clips, packs), encoding="utf-8")
        _publish(stage, out)
    return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    parser.add_argument("--voices", type=Path, required=True)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    try:
        release = build_site(args.out, args.voices, preview=args.preview)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"Build failed: {exc}\n")
    print(f"Built {args.out} (release {release['id']}, {len(release['clips'])} clips)")
