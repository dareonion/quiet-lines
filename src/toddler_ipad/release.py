import hashlib
import json
import re
from pathlib import Path
from urllib.parse import quote

from . import db

TEMPLATE = Path(__file__).resolve().with_name("sw_template.js")


def catalog_clips(app_dir: Path) -> dict:
    catalog = json.loads((app_dir / "content/catalog.json").read_bytes())
    return {key: value for key, value in catalog["clips"].items()
            if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", key)}


def recorded_clips(app_dir: Path, data_dir: Path) -> dict:
    with db.connect(data_dir) as conn:
        active = db.active_takes(conn)
    return {key: {"take_id": active[key]["take_id"], "sha256": active[key]["processed_sha256"]}
            for key in catalog_clips(app_dir) if key in active}


def public_files(app_dir: Path):
    """Yield scope-relative URL keys and their source paths. Unexpected files stop publication."""
    for path in app_dir.rglob("*"):
        rel = path.relative_to(app_dir)
        top = rel.parts[0]
        if top != "content" and any(part.startswith(".") for part in rel.parts):
            continue
        if top in {"recorder", "debug"} and (len(rel.parts) > 1 or path.is_dir()):
            continue
        if path.is_symlink():
            raise ValueError(f"Unexpected symlink under app/: {rel}")
        if path.is_dir():
            if top == "content" and rel.as_posix() not in {"content", "content/glyphs", "content/glyphs/hanzi"}:
                raise ValueError(f"Unexpected directory under app/: {rel}")
            continue
        if top == "js" and path.name.endswith(".test.js"):
            continue
        if not (rel.as_posix() in {"index.html", "app.css", "manifest.webmanifest", "LICENSE.txt"}
                or (top == "icons" and len(rel.parts) == 2 and path.suffix == ".png")
                or (top == "js" and path.suffix == ".js")
                or rel.as_posix() in {"content/catalog.json", "content/glyphs/latin.json",
                                      "content/glyphs/hanzi/ARPHICPL.TXT", "content/glyphs/hanzi/NOTICE.md"}
                or re.fullmatch(r"content/glyphs/hanzi/[0-9a-f]+\.json", rel.as_posix())):
            raise ValueError(f"Unexpected file under app/: {rel}")
        yield "" if rel.as_posix() == "index.html" else quote(rel.as_posix()), path


def build_release(app_dir: Path, clips: dict, template: bytes | None = None) -> dict:
    hashes = {key: hashlib.sha256(path.read_bytes()).hexdigest()
              for key, path in public_files(app_dir)}
    if "" not in hashes:
        raise ValueError("Missing app/index.html")
    hashes.update({f"audio/{key}.m4a": clip["sha256"] for key, clip in clips.items()})
    if template is None:
        template = TEMPLATE.read_bytes()
    identity = {**hashes, "sw_template": hashlib.sha256(template).hexdigest()}
    pairs = json.dumps(sorted(identity.items()), separators=(",", ":")).encode()
    return {"id": hashlib.sha256(pairs).hexdigest()[:16],
            "files": sorted([*hashes, "release.json"]), "hashes": dict(sorted(hashes.items())),
            "clips": clips}


def render_worker(release: dict, template: bytes) -> str:
    stamp = json.dumps({key: release[key] for key in ("id", "files", "hashes")})
    return template.decode().replace("__RELEASE__", stamp)
