"""Carry listening approvals from the files people heard to freshly generated release files.

    uv run --group voices python scripts/carry_approvals.py voices/en-jenny [--heard voices-heard/en-jenny]

Why: approvals name exact bytes, but Azure's standard voices don't repeat byte for byte. Regenerating
the same SSML gives audio of the same length with waveform correlation 0.9998 to 1.0000 (measured
2026-11-22), which is rounding noise, not a different take. The paid-tier release run therefore
replaces each heard file with an equivalent one. A clip's approval carries over only when its new
file matches the approved heard file (same approved hash in the heard folder, same length within
5 ms, correlation at least 0.999 and RMS level within 0.5 dB). Anything else is listed for re-listening
and loses its approval.
HD voices (e.g. Dragon HD) give a different take every time, so their files never carry; approve
those as generated.

The pack's approved.json is rewritten with the new hashes, and source.json gets an
"approval" note per clip saying which heard file it matched.

    ... carry_approvals.py voices/zh-yunjhe --direct num.3.zh,num.7.zh

--direct records that a person listened to the current (S0) files of those clips and approved them
(e.g. a re-listened clip, or an HD take). Direct approvals survive later carry-over runs as long as the
file is unchanged.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MIN_CORR = 0.999
MAX_LEN_DIFF = 0.005


def pcm(path: Path) -> np.ndarray:
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, np.float32)


def write_manifest(path, data):
    tmp = tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False)
    temporary = Path(tmp.name)
    try:
        with tmp:
            json.dump(data, tmp, ensure_ascii=False, indent=1, sort_keys=True)
            tmp.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pack", type=Path)
    parser.add_argument("--heard", type=Path, help="default: voices-heard/<pack name>")
    parser.add_argument("--direct", default="", help="comma-separated clips a person approved as they are now")
    args = parser.parse_args()
    heard = args.heard or ROOT / "voices-heard" / args.pack.name
    voice = json.loads((args.pack / "pack.json").read_bytes())["voice"]
    direct = [c for c in args.direct.split(",") if c]
    if "DragonHD" in voice and not direct:
        parser.exit(2, "DragonHD release takes require direct listening approval (--direct).\n")
    heard_manifest = heard / "approved.json"
    output = args.pack / "approved.json"
    if output.resolve() == heard_manifest.resolve():
        parser.error("heard and release manifests must be separate")
    hd = "DragonHD" in voice
    approved = {} if hd else json.loads(heard_manifest.read_bytes())
    source_path = args.pack / "source.json"
    source = json.loads(source_path.read_text(encoding="utf-8"))

    def current_s0(clip):
        """The digest of the clip's current file if its source record is S0 and this voice."""
        path, record = args.pack / f"{clip}.m4a", source.get(clip, {})
        if not path.exists():
            return None
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        ok = record.get("tier") == "S0" and record.get("voice") == voice and record.get("sha256") == digest
        return digest if ok else None

    from datetime import date
    kept = {}
    for clip in direct:
        digest = current_s0(clip)
        if not digest:
            parser.error(f"{clip}: no current S0 file with a matching source record to approve")
        source[clip]["approval"] = f"direct listening {date.today().isoformat()}"
        kept[clip] = digest
    previous = json.loads(output.read_bytes()) if output.exists() else {}
    for clip, digest in previous.items():
        if (clip not in kept and str(source.get(clip, {}).get("approval", "")).startswith("direct")
                and current_s0(clip) == digest):
            kept[clip] = digest

    for record in source.values():
        if str(record.get("approval", "")).startswith("carried from the heard file"):
            del record["approval"]

    carried, relisten = {}, []
    for clip, digest in sorted(approved.items()):
        new, old = args.pack / f"{clip}.m4a", heard / f"{clip}.m4a"
        if not new.exists():
            relisten.append(f"{clip}: not generated")
            continue
        if not old.exists() or hashlib.sha256(old.read_bytes()).hexdigest() != digest:
            relisten.append(f"{clip}: the heard file is missing or isn't the approved one")
            continue
        new_digest = hashlib.sha256(new.read_bytes()).hexdigest()
        record = source.get(clip, {})
        if record.get("tier") != "S0" or record.get("voice") != voice or record.get("sha256") != new_digest:
            relisten.append(f"{clip}: missing or mismatched S0 source record")
            continue
        try:
            a, b = pcm(new), pcm(old)
        except subprocess.CalledProcessError:
            relisten.append(f"{clip}: could not decode audio")
            continue
        length_diff = abs(len(a) - len(b)) / 16000
        n = min(len(a), len(b))
        if n < 2 or not a[:n].std() or not b[:n].std():
            relisten.append(f"{clip}: insufficient waveform to compare")
            continue
        corr = float(np.corrcoef(a[:n], b[:n])[0, 1])
        level_db = 10 * np.log10(np.mean(a ** 2) / np.mean(b ** 2))
        if length_diff <= MAX_LEN_DIFF and corr >= MIN_CORR and abs(level_db) <= 0.5:
            carried[clip] = new_digest
            record["approval"] = (
                f"carried from the heard file {digest[:12]} (length diff {length_diff * 1000:.1f} ms, corr {corr:.4f})")
        else:
            relisten.append(f"{clip}: differs from what was heard (length diff {length_diff * 1000:.0f} ms, "
                            f"corr {corr:.3f}, level diff {level_db:.2f} dB)")

    relisten = [line for line in relisten if line.split(":")[0] not in kept]
    write_manifest(source_path, source)
    write_manifest(output, {**carried, **kept})
    print(f"{args.pack.name}: {len(carried)} approvals carried, {len(kept)} direct, {len(relisten)} to re-listen")
    for line in relisten:
        print("  " + line)
    return 1 if relisten else 0


if __name__ == "__main__":
    sys.exit(main())
