import json
import math
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory


class AudioError(ValueError):
    def __init__(self, message: str, diagnostic: str = ""):
        self.message = message
        super().__init__(message + ("\n" + diagnostic.strip()[-1000:] if diagnostic else ""))


def _run(command: list) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, errors="replace", timeout=30, check=False)
    except subprocess.TimeoutExpired as exc:
        detail = (exc.stderr or b"").decode(errors="replace")
        raise AudioError("Processing took too long. Please record a shorter take.", detail) from exc
    except OSError as exc:
        raise AudioError("The audio tools are unavailable. Please check the recorder server.", str(exc)) from exc
    if result.returncode:
        raise AudioError("This recording could not be read. Please record it again.", result.stderr)
    return result


FFMPEG = ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-y"]
PCM = ["-f", "f32le", "-ar", "48000", "-ac", "1"]


def _levels(input_args: list, duration: float) -> tuple[float, float]:
    # R128 needs a 400 ms block. Repeat a very short word for the meter only.
    repeat = "aloop=loop=2:size=24000," if duration < 0.4 else ""
    result = _run([*FFMPEG, *input_args, "-af", repeat + "loudnorm=print_format=json",
                   "-f", "null", "-"])
    try:
        stats, _ = json.JSONDecoder().raw_decode(result.stderr[result.stderr.rindex("{"):])
        return float(stats["input_i"]), float(stats["input_tp"])
    except (ValueError, KeyError) as exc:
        raise AudioError("The recording could not be measured. Please try again.", result.stderr) from exc


def process(raw: Path, out: Path) -> float:
    out.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=out.parent) as work:
        pcm = Path(work) / "trimmed.f32"
        encoded = Path(work) / "preview.m4a"
        # Apply the same leading-edge trim from each end. Interior pauses survive.
        edge = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1:detection=peak"
        trim = f"aformat=sample_rates=48000:channel_layouts=mono,{edge},areverse,{edge},areverse"
        _run([*FFMPEG, "-loglevel", "error", "-xerror", "-protocol_whitelist", "file",
              "-format_whitelist", "mov,matroska,webm,ogg,wav,mp3,aac,flac", "-i", raw,
              "-map", "0:a:0", "-af", trim, "-t", "6.01", *PCM, pcm])
        duration = pcm.stat().st_size / (48000 * 4)
        if duration < 0.2:
            raise AudioError("The recording was silent or too short. Please say the word again.")
        if duration > 6:
            raise AudioError("The recording was too long. Please keep the word under six seconds.")

        source = [*PCM, "-i", pcm]
        loudness, peak = _levels(source, duration)
        if not math.isfinite(loudness) or not math.isfinite(peak):
            raise AudioError("The recording was too quiet. Please move closer and try again.")
        gain = min(-16 - loudness, -1.8 - peak)
        for _ in range(3):
            _run([*FFMPEG, "-loglevel", "error", *source, "-af", f"volume={gain:.4f}dB",
                  "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "96k",
                  "-movflags", "+faststart", encoded])
            # Lossy encoding can introduce new peaks. Verify the actual preview bytes.
            _, encoded_peak = _levels(["-i", encoded], duration)
            if math.isfinite(encoded_peak) and encoded_peak <= -1.5:
                break
            gain -= max(0.5, encoded_peak + 1.8)
        else:
            raise AudioError("This recording peaked too loudly. Please record it again.")

        probe = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "default=nw=1:nk=1", encoded])
        try:
            duration = float(probe.stdout)
        except ValueError as exc:
            raise AudioError("The recording length could not be verified. Please try again.",
                             probe.stderr) from exc
        if not 0.2 <= duration <= 6:
            raise AudioError("Please record a take between 0.2 and 6 seconds long.")
        encoded.replace(out)
        return duration
