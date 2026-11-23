import hashlib
import json
import math
import sys
import wave
from array import array
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@pytest.fixture(autouse=True)
def script_imports(monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))


def test_credentials_are_one_source(tmp_path, monkeypatch):
    from generate_voices import credentials

    names = ("AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "AZURE_SPEECH_TIER")
    for name, value in zip(names, ("exported", "region-a", "F0")):
        monkeypatch.setenv(name, value)
    assert credentials(None, None) == ("exported", "region-a", "F0")
    config = tmp_path / "config"
    lines = [f"{name}={value}" for name, value in zip(names, ("selected", "region-b", "S0"))]
    config.write_text("\n".join(lines))
    assert credentials(config, None) == ("selected", "region-b", "S0")
    with pytest.raises(SystemExit, match="conflicts"):
        credentials(config, "F0")
    for missing in lines:
        config.write_text("\n".join(line for line in lines if line != missing))
        with pytest.raises(SystemExit, match="credential source"):
            credentials(config, None)


def test_named_pack_generation(tmp_path, monkeypatch):
    import generate_voices as generator

    metadata = {"lang": "en", "voice": "en-US-Test", "label": "Test", "default": False}
    (tmp_path / "pack.json").write_text(json.dumps(metadata))
    args = ["generate", str(tmp_path), "--only", "num.1.en,num.1.zh"]
    monkeypatch.setattr(sys, "argv", args)
    monkeypatch.setattr(generator, "credentials", lambda *_: ("test", "region", "F0"))
    requested = []

    def synthesize(ssml, creds, raw, interval):
        requested.append(ssml)
        raw.write_bytes(b"synthetic")

    def process(raw, out):
        out.write_bytes(raw.read_bytes())
        return 1

    monkeypatch.setattr(generator, "synthesize", synthesize)
    monkeypatch.setattr(generator, "process", process)
    generator.main()
    assert len(requested) == 1 and metadata["voice"] in requested[0]
    records = json.loads((tmp_path / "source.json").read_bytes())
    assert records.keys() == {"num.1.en"}
    assert (records["num.1.en"]["tier"], records["num.1.en"]["voice"]) == ("F0", metadata["voice"])
    for override in (["--lang", "zh"], ["--voice", "en=other"], ["--voice", "zh=other"]):
        monkeypatch.setattr(sys, "argv", [*args, *override])
        with pytest.raises(SystemExit) as exc:
            generator.main()
        assert exc.value.code == 2


def tone_file(path, gain=0.4, frequency=300, samples=3200):
    # Lossless fixture in a WAV container. ffmpeg recognizes it from the header.
    pcm = array("h", (round(32767 * gain * math.sin(i * 2 * math.pi * frequency / 16000))
                      for i in range(samples)))
    if sys.byteorder == "big":
        pcm.byteswap()
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(pcm.tobytes())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_approval_transfer_and_retry(tmp_path, monkeypatch, audio_tools):
    pytest.importorskip("numpy")
    import carry_approvals

    heard, pack = tmp_path / "heard", tmp_path / "pack"
    heard.mkdir()
    pack.mkdir()
    voice = "Standard"
    metadata = pack / "pack.json"
    metadata.write_text(json.dumps({"voice": voice}))
    cases = {
        "same": {"gain": 0.41}, "new": {"gain": 0.41}, "quiet": {"gain": 0.02},
        "different": {"frequency": 320}, "long": {"samples": 3281}, "wrong-tier": {},
        "wrong-voice": {}, "wrong-source-hash": {}, "unheard": {},
    }
    original, source = {}, {}
    for clip, kwargs in cases.items():
        original[clip] = tone_file(heard / f"{clip}.m4a")
        digest = tone_file(pack / f"{clip}.m4a", **kwargs)
        source[clip] = {"tier": "S0", "voice": voice, "sha256": digest}
    source["wrong-tier"]["tier"] = "F0"
    source["wrong-voice"]["voice"] = "Other"
    source["wrong-source-hash"]["sha256"] = "0" * 64
    original["unheard"] = "0" * 64
    (pack / "new.m4a").unlink()
    (pack / "source.json").write_text(json.dumps(source))
    heard_manifest = heard / "approved.json"
    heard_manifest.write_text(json.dumps(original))
    release_manifest = pack / "approved.json"
    release_manifest.write_text('{"stale":"unused"}')
    monkeypatch.setattr(sys, "argv", ["carry", str(pack), "--heard", str(heard)])
    assert carry_approvals.main() == 1
    assert json.loads(release_manifest.read_bytes()) == {"same": source["same"]["sha256"]}
    assert source["same"]["sha256"] != original["same"]
    tone_file(pack / "new.m4a", **cases["new"])
    for _ in range(2):
        assert carry_approvals.main() == 1
        assert json.loads(release_manifest.read_bytes()) == {k: source[k]["sha256"] for k in ("same", "new")}
    assert json.loads(heard_manifest.read_bytes()) == original
    # A clip a person approved directly (after re-listening) survives later carry-over runs.
    monkeypatch.setattr(sys, "argv", ["carry", str(pack), "--heard", str(heard), "--direct", "quiet"])
    carry_approvals.main()
    monkeypatch.setattr(sys, "argv", ["carry", str(pack), "--heard", str(heard)])
    carry_approvals.main()
    assert json.loads(release_manifest.read_bytes())["quiet"] == source["quiet"]["sha256"]
    before = release_manifest.read_bytes()
    metadata.write_text(json.dumps({"voice": "X:DragonHDLatestNeural"}))
    with pytest.raises(SystemExit) as exc:
        carry_approvals.main()
    assert exc.value.code != 0 and release_manifest.read_bytes() == before


def test_tone_reference(tmp_path, monkeypatch, capsys, audio_tools):
    pytest.importorskip("parselmouth")
    import check_tones

    pack, reference = tmp_path / "target", tmp_path / "reference"
    monkeypatch.setattr(sys, "argv", ["check", str(pack)])
    for expected in ("Missing clip directory", "No eligible", "needs --reference"):
        with pytest.raises(SystemExit) as exc:
            check_tones.main()
        assert exc.value.code == 2 and expected in capsys.readouterr().err
        pack.mkdir(exist_ok=True)
        if expected == "No eligible":
            tone_file(pack / "num.3.zh.m4a", frequency=250)
    reference.mkdir()
    tone_file(reference / "num.2.zh.m4a", frequency=190)
    monkeypatch.setattr(sys, "argv", ["check", str(pack), "--reference", str(reference)])
    assert check_tones.main() == 0
    for folder, voice in ((reference, "Other"), (pack, "Target")):
        (folder / "pack.json").write_text(json.dumps({"voice": voice}))
    with pytest.raises(SystemExit) as exc:
        check_tones.main()
    assert exc.value.code == 2 and "same voice" in capsys.readouterr().err
