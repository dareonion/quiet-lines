"""Generate a voice pack for the hosted app with Azure AI Speech (prebuilt neural voices).

    uv run python scripts/generate_voices.py voices/default --tier S0 --env-file ~/.config/azure-speech.env
    uv run python scripts/generate_voices.py /tmp/sample --tier F0 --only letter.a.en,char.yu2.zh

Set AZURE_SPEECH_KEY, AZURE_SPEECH_REGION and AZURE_SPEECH_TIER together in the environment
or in an explicit --env-file. They are never printed. Each clip is requested once (unless its SSML or voice
changed, or --force), run through the same ffmpeg pipeline as the recorder (trim, about -16 LUFS,
96 kbps AAC), and written to OUT/<clip>.m4a. OUT/source.json records the voice, SSML, date and
sha256 of every clip, so a listener's approval can name exact bytes.

Per-clip recipes, in OUT/recipes.json (optional), fix a voice's weak words (see voices/zh-yunjhe):
  {"carrier": "三個"}  say the word first in a two-syllable carrier, then keep only its first
                       syllable (a lone syllable gets sentence-final intonation; inside a word it
                       keeps its tone). Pick a second syllable that starts with a stop (b p d t g k),
                       so there is a silent closure to cut in, and avoid tone sandhi (一, 不, 3+3).
                       "cut": "min" (default) cuts at the quietest point of that closure with a 20 ms
                       fade; "late" cuts at its end with a 60 ms fade, which can catch the next
                       consonant (a listener heard it on 三個, 七個 and 山頂, 2026-11-23).
  {"contour": "(0%,-8%) (40%,-6%) (100%,+30%)"}  force the pitch shape with SSML prosody.
  {"skip": true}        don't make this clip: the app plays the language's default voice instead.
Carrier cuts need the `voices` dependency group: uv run --group voices python scripts/...

Release terms (checked 2026-11-22): Microsoft grants use of prebuilt-voice output to customers of
the *paid* tier only, so generate the files that ship from an S0 resource; a free (F0) resource is
for listening samples. The credential source supplies the recorded tier and --tier can verify it. The hosted
release refuses clips not made on the paid tier. The voices must be disclosed as computer-generated.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from toddler_ipad.audio import AudioError, process  # noqa: E402

VOICES = {"en": ("en-US", "en-US-JennyNeural"), "zh": ("zh-TW", "zh-TW-HsiaoChenNeural")}
RATE = "-10%"          # a little slower than default, for small listeners
OUTPUT_FORMAT = "riff-48khz-16bit-mono-pcm"
MIN_INTERVAL = 3.1     # the free tier allows 20 requests a minute

# Per-clip text overrides, for a word the voice misreads. Azure refuses <phoneme> for zh-TW, so a
# Mandarin fix swaps in a character with only the intended reading (the chineselearning approach).
RESPELL: dict[str, str] = {}


def credentials(env_file: Path | None, expected_tier: str | None = None) -> tuple[str, str, str]:
    values = os.environ
    if env_file is not None:
        values = {}
        for line in env_file.expanduser().read_text(encoding="utf-8").splitlines():
            name, sep, value = line.strip().partition("=")
            if sep:
                values[name.strip()] = value.strip().strip("'\"")
    key, region, tier = (values.get("AZURE_SPEECH_" + field) for field in ("KEY", "REGION", "TIER"))
    if not key or not region or tier not in ("S0", "F0"):
        raise SystemExit("Set AZURE_SPEECH_KEY, AZURE_SPEECH_REGION and AZURE_SPEECH_TIER (S0 or F0) "
                         "together in the credential source.")
    if expected_tier and tier != expected_tier:
        raise SystemExit("--tier conflicts with the credential source's AZURE_SPEECH_TIER")
    return key, region, tier


NS = "xmlns='http://www.w3.org/2001/10/synthesis'"


def ssml_for(clip_id: str, clip: dict, voices: dict = VOICES, recipe: dict | None = None) -> tuple[str, str]:
    lang, voice = voices[clip["lang"]]
    recipe = recipe or {}
    text = escape(recipe.get("carrier") or RESPELL.get(clip_id, clip["text"]))
    if clip_id.startswith("letter."):
        # A lone "A" can be read as the article; spell it as a letter name.
        text = f"<say-as interpret-as='characters'>{text}</say-as>"
    contour = f" contour='{recipe['contour']}'" if recipe.get("contour") else ""
    body = f"<prosody rate='{RATE}'{contour}>{text}</prosody>"
    if not voice.startswith(lang + "-"):
        # A multilingual voice from another locale (e.g. zh-CN-Yunfan:DragonHDLatestNeural speaking
        # Taiwan Mandarin) is told the language explicitly.
        return voice, (f"<speak version='1.0' {NS} xml:lang='{lang}'><voice name='{voice}'>"
                       f"<lang xml:lang='{lang}'>{body}</lang></voice></speak>")
    return voice, f"<speak version='1.0' xml:lang='{lang}'><voice name='{voice}'>{body}</voice></speak>"


def cut_first_syllable(raw: Path, out: Path, mode: str = "min") -> dict:
    """Keep the first syllable of a two-syllable carrier, cutting in the silent closure before the
    second syllable's consonant, after the first syllable's voicing has ended. "min": at the
    closure's quietest point, 20 ms linear fade. "late": at the closure's end (the last point within
    10 dB of its quietest), 60 ms fade."""
    import numpy as np
    import parselmouth
    import soundfile as sf

    x, sr = sf.read(raw)
    snd = parselmouth.Sound(x, sampling_frequency=sr)
    pitch = snd.to_pitch_ac(time_step=0.005, pitch_floor=60, pitch_ceiling=400)
    f0, t = pitch.selected_array["frequency"], pitch.xs()
    runs, start = [], None
    for i, voiced in enumerate(f0 > 0):
        if voiced and start is None:
            start = i
        if (not voiced or i == len(f0) - 1) and start is not None:
            end = i if not voiced else i + 1
            if t[end - 1] - t[start] >= 0.03:           # ignore voicing blips
                runs.append((t[start], t[end - 1]))
            start = None
    if len(runs) < 2:
        raise ValueError(f"expected two voiced syllables in the carrier, found {len(runs)}")
    first_end, second_start = runs[0][1], runs[1][0]
    intensity = snd.to_intensity(time_step=0.002, minimum_pitch=100)
    ts, db = intensity.xs(), intensity.values[0]
    gap = (ts > first_end) & (ts < second_start)
    if not gap.any():
        raise ValueError("no gap between the carrier's syllables to cut in")
    if mode == "late":
        cut, fade, shape = float(ts[gap][db[gap] <= db[gap].min() + 10].max()), 0.06, 2
    elif mode == "min":
        cut, fade, shape = float(ts[gap][np.argmin(db[gap])]), 0.02, 1
    else:
        raise ValueError(f"unknown cut mode {mode!r}")
    n = int(cut * sr)
    y = x[:n].copy()
    k = min(int(fade * sr), n)
    y[-k:] *= np.linspace(1, 0, k) ** shape
    sf.write(out, y, sr)
    return {"mode": mode, "voicing_end": round(first_end, 3), "next_syllable": round(second_start, 3),
            "cut": round(cut, 3)}


_last_call = 0.0


def synthesize(ssml: str, creds: tuple[str, str], dest: Path, min_interval: float) -> None:
    global _last_call
    key, region = creds
    request = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"), method="POST",
        headers={"Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
                 "X-Microsoft-OutputFormat": OUTPUT_FORMAT, "User-Agent": "quiet-lines-voices"})
    for attempt in range(4):
        wait = min_interval - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                dest.write_bytes(response.read())
            return
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 3:
                time.sleep(10 * (attempt + 1))
                continue
            detail = exc.read()[:200].decode(errors="replace")
            hint = {401: " (wrong key, or the region isn't the resource's own)",
                    403: " (the free tier's monthly characters may be used up)"}.get(exc.code, "")
            raise SystemExit(f"Azure answered {exc.code}{hint}: {detail}") from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("--only", help="comma-separated clip ids (default: every clip in the catalog)")
    parser.add_argument("--lang", choices=sorted(VOICES), help="only this language's clips (one voice per pack)")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--tier", choices=["F0", "S0"],
                        help="the Azure Speech resource's pricing tier (only S0 output may be published)")
    parser.add_argument("--force", action="store_true", help="regenerate clips whose SSML is unchanged")
    parser.add_argument("--min-interval", type=float, default=MIN_INTERVAL)
    parser.add_argument("--voice", action="append", default=[], metavar="LANG=NAME",
                        help="override a language's voice, e.g. en=en-US-GuyNeural (repeatable)")
    args = parser.parse_args()

    clips = json.loads((ROOT / "app/content/catalog.json").read_text(encoding="utf-8"))["clips"]
    wanted = args.only.split(",") if args.only else list(clips)
    unknown = [c for c in wanted if c not in clips]
    if unknown:
        raise SystemExit(f"Not in the catalog: {', '.join(unknown)}")
    voices = dict(VOICES)
    pack_path = args.out / "pack.json"
    pack = None
    if pack_path.exists():
        from toddler_ipad.site import pack_metadata

        pack = pack_metadata(args.out)
        if args.lang and args.lang != pack["lang"]:
            parser.error("--lang conflicts with pack.json")
        args.lang = pack["lang"]
        voices[args.lang] = (voices[args.lang][0], pack["voice"])
    if args.lang:
        wanted = [c for c in wanted if clips[c]["lang"] == args.lang]
    for override in args.voice:
        lang, _, name = override.partition("=")
        if lang not in voices or not name:
            raise SystemExit(f"--voice takes LANG=NAME with LANG in {sorted(voices)}: {override}")
        if pack and (lang != pack["lang"] or name != pack["voice"]):
            parser.error("--voice conflicts with pack.json")
        voices[lang] = (voices[lang][0], name)
    key, region, tier = credentials(args.env_file, args.tier)
    args.out.mkdir(parents=True, exist_ok=True)
    source_path = args.out / "source.json"
    source = json.loads(source_path.read_text(encoding="utf-8")) if source_path.exists() else {}
    recipes_path = args.out / "recipes.json"
    recipes = json.loads(recipes_path.read_text(encoding="utf-8")) if recipes_path.exists() else {}
    unknown = sorted(set(recipes) - set(clips))
    if unknown:
        raise SystemExit(f"recipes.json names clips not in the catalog: {', '.join(unknown)}")

    made = skipped = 0
    for clip_id in wanted:
        recipe = recipes.get(clip_id, {})
        out = args.out / f"{clip_id}.m4a"
        if recipe.get("skip") is True:
            out.unlink(missing_ok=True)          # the app falls back to the default voice
            if source.pop(clip_id, None) is not None:
                source_path.write_text(json.dumps(source, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                                       encoding="utf-8")
            print(f"{clip_id}: skipped (recipe)")
            continue
        voice, ssml = ssml_for(clip_id, clips[clip_id], voices, recipe)
        old = source.get(clip_id, {})
        if (not args.force and out.exists() and old.get("ssml") == ssml and old.get("tier") == tier
                and old.get("voice") == voice
                and old.get("recipe", {}) == recipe
                and old.get("sha256") == hashlib.sha256(out.read_bytes()).hexdigest()):
            skipped += 1
            continue
        cut = None
        with TemporaryDirectory() as work:
            raw = Path(work) / "raw.wav"
            synthesize(ssml, (key, region), raw, args.min_interval)
            if recipe.get("carrier"):
                trimmed = Path(work) / "first-syllable.wav"
                try:
                    cut = cut_first_syllable(raw, trimmed, recipe.get("cut", "min"))
                except ValueError as exc:
                    raise SystemExit(f"{clip_id}: carrier {recipe['carrier']}: {exc}") from None
                raw = trimmed
            try:
                duration = process(raw, out)
            except AudioError as exc:
                raise SystemExit(f"{clip_id}: {exc.message}") from None
        source[clip_id] = {
            "text": clips[clip_id]["text"], "voice": voice, "ssml": ssml, "tier": tier,
            **({"recipe": recipe} if recipe else {}), **({"cut": cut} if cut else {}),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "duration": round(duration, 3), "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        }
        source_path.write_text(json.dumps(source, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                               encoding="utf-8")
        made += 1
        print(f"{clip_id}: {duration:.2f} s")
    print(f"{made} generated, {skipped} unchanged, in {args.out}")


if __name__ == "__main__":
    main()
