"""Check a Mandarin voice pack's single-syllable clips against their expected tones, by pitch.

    uv run --group voices python scripts/check_tones.py voices/zh-hsiaochen
    uv run --group voices python scripts/check_tones.py voices/zh-yunjhe --male

The expected tone comes from the pinyin in the catalog prompt (e.g. "請說：三（sān）"); clips whose
pinyin has more than one syllable are listed but not judged. Each clip's pitch is split into thirds and
compared with the pack's average pitch: tone 1 high and level, 2 rising, 3 low (falling or dipping),
4 falling from high. This is a screen for a listener, not a verdict: it flags clips to hear first.
It found that zh-TW-YunJheNeural says lone first tones falling and second tones flat (2026-11-22).
Exit status 1 when any judged clip doesn't match.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

import numpy as np
import parselmouth

ROOT = Path(__file__).resolve().parents[1]
MARKS = {"̄": 1, "́": 2, "̌": 3, "̀": 4}
VOWELS = "aeiouü"


def expected_tone(prompt: str) -> tuple[int | None, str]:
    """(tone, pinyin) for a one-syllable pinyin in the prompt's brackets, else (None, pinyin)."""
    pinyin = prompt[prompt.find("（") + 1:prompt.find("）")] if "（" in prompt else ""
    decomposed = unicodedata.normalize("NFD", pinyin)
    tones = [MARKS[c] for c in decomposed if c in MARKS]
    base = "".join(c for c in decomposed if c not in MARKS and unicodedata.category(c) != "Mn")
    vowel_groups = sum(1 for i, c in enumerate(base) if c in VOWELS and (i == 0 or base[i - 1] not in VOWELS))
    if len(tones) != 1 or vowel_groups != 1:
        return None, pinyin
    return tones[0], pinyin


def contour(path: Path, male: bool) -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-ac", "1", "-ar", "24000", wav.name],
                       check=True)
        sound = parselmouth.Sound(wav.name)
    floor, ceiling = (60, 300) if male else (120, 500)
    f0 = sound.to_pitch_ac(time_step=0.01, pitch_floor=floor, pitch_ceiling=ceiling).selected_array["frequency"]
    f0 = f0[f0 > 0]
    return 12 * np.log2(f0 / (110.0 if male else 200.0))


def judge(a: float, b: float, c: float) -> int:
    """Thirds of the contour, in semitones relative to the pack's average."""
    level, rise = (a + b + c) / 3, c - a
    if rise > 1.5:
        return 2
    if rise < -3 and a > 1:
        return 4
    if level < -0.5:
        return 3
    if level > 1 and abs(rise) < 2.5:
        return 1
    return 0


def measure(directory, clips, male):
    if not directory.is_dir():
        raise ValueError(f"Missing clip directory: {directory}")
    thirds, unjudged = {}, []
    for path in sorted(directory.glob("*.m4a")):
        info = clips.get(path.stem)
        if not info or info["lang"] != "zh":
            continue
        tone, pinyin = expected_tone(info.get("prompt", ""))
        if tone is None:
            unjudged.append(f"{path.stem} {info['text']} ({pinyin})")
            continue
        st = contour(path, male)
        if len(st) < 6:
            thirds[path.stem] = (tone, pinyin, None)
            continue
        n = len(st)
        thirds[path.stem] = (tone, pinyin, (st[: n // 3].mean(), st[n // 3: 2 * n // 3].mean(), st[2 * n // 3:].mean()))
    if not thirds:
        raise ValueError(f"No eligible single-syllable Mandarin clips in {directory}")
    return thirds, unjudged


def voice_names(directory, keys):
    names = set()
    metadata = directory / "pack.json"
    if metadata.exists():
        names.add(json.loads(metadata.read_bytes())["voice"])
    source = directory / "source.json"
    if source.exists():
        records = json.loads(source.read_bytes())
        names.update(records[k]["voice"] for k in keys if k in records)
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pack", type=Path)
    parser.add_argument("--male", action="store_true", help="pitch range for a man's voice")
    parser.add_argument("--reference", type=Path, help="use the average pitch of this same-voice set")
    args = parser.parse_args()
    clips = json.loads((ROOT / "app/content/catalog.json").read_text(encoding="utf-8"))["clips"]
    try:
        thirds, unjudged = measure(args.pack, clips, args.male)
        baseline = thirds
        if args.reference:
            baseline, _ = measure(args.reference, clips, args.male)
            if len(voice_names(args.pack, thirds) | voice_names(args.reference, baseline)) > 1:
                parser.error("target and reference must use the same voice")
        measured = [np.mean(v[2]) for v in baseline.values() if v[2] is not None]
        if not measured:
            parser.error("too little voicing to establish a reference level")
        if len(measured) == 1 and (not args.reference or args.reference.resolve() == args.pack.resolve()):
            parser.error("a single measured clip needs --reference DIR from the same voice")
        reference = float(np.mean(measured))
    except ValueError as exc:
        parser.error(str(exc))
    bad = 0
    for clip, (tone, pinyin, parts) in sorted(thirds.items(), key=lambda kv: (kv[1][0], kv[0])):
        if parts is None:
            print(f"{clip:18} {pinyin:6} tone {tone}  too little voicing to measure: LISTEN")
            bad += 1
            continue
        a, b, c = (x - reference for x in parts)
        got = judge(a, b, c)
        ok = got == tone
        bad += not ok
        print(f"{clip:18} {pinyin:6} tone {tone}  {'ok   ' if ok else 'CHECK'}  "
              f"start/mid/end {a:+.1f} {b:+.1f} {c:+.1f} st")
    if unjudged:
        print("not judged (several syllables): " + ", ".join(unjudged))
    print(f"{len(thirds)} single syllables, {bad} to check by ear")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
