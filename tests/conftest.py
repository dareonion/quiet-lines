import asyncio
import hashlib
import json
import os
import selectors
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from toddler_ipad.server import create_app


@pytest.fixture
def app_dir(tmp_path):
    app = tmp_path / "app"
    for name in ("index.html", "js/main.js", "js/a.test.js", "debug/x.html",
                 "recorder/index.html", ".hidden/data", "js/.private"):
        path = app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
    (app / "content").mkdir()
    catalog = Path(__file__).resolve().parents[1] / "app/content/catalog.json"
    shutil.copyfile(catalog, app / "content/catalog.json")
    return app


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "data"


@pytest.fixture
def origin():
    return {"Origin": "https://family.example"}


@pytest.fixture
def client(app_dir, data_dir, origin):
    # In a network-isolated Linux sandbox asyncio's socketpair wakeup may be
    # denied. Bound the test thread's sleep so queued calls still get serviced.
    class TestSelector(selectors.DefaultSelector):
        def select(self, timeout=None):
            return super().select(0.01 if timeout is None else min(timeout, 0.01))

    options = {"loop_factory": lambda: asyncio.SelectorEventLoop(TestSelector())}
    app = create_app(app_dir, data_dir, {origin["Origin"]})
    with TestClient(app, backend_options=options) as client:
        yield client


@pytest.fixture(scope="session")
def audio_tools():
    if not all(shutil.which(tool) for tool in ("ffmpeg", "ffprobe")):
        message = "ffmpeg and ffprobe are required for audio tests"
        if os.getenv("TODDLER_REQUIRE_ALL") == "1":
            pytest.fail(message)
        pytest.skip(message)


@pytest.fixture
def voice_pack(tmp_path, recording):
    root = tmp_path / "test-voices"
    root.mkdir()
    (root / "voices.json").write_text(json.dumps({
        "disclosure": "Computer-generated test tones.", "credits": "CREDITS.md",
    }))
    (root / "CREDITS.md").write_text("Synthetic tones for the test suite.\n")
    clips = json.loads((Path(__file__).resolve().parents[1] / "app/content/catalog.json").read_bytes())["clips"]
    for index, (pack, lang, label, default, numbers) in enumerate([
        ("en-jenny", "en", "Jenny", True, [1, 2, 3]),
        ("en-guy", "en", "Guy", False, [1, 3]),
        ("zh-hsiaochen", "zh", "HsiaoChen", True, [1, 2, 3]),
        ("zh-yunjhe", "zh", "YunJhe", False, [2]),
    ]):
        directory = root / pack
        directory.mkdir()
        (directory / "pack.json").write_text(json.dumps({
            "lang": lang, "label": label, "voice": label + "Test", "default": default,
        }))
        audio = recording("mp4", db=-12 - index, tone=0.2, pad=0.05)
        approved = {}
        language = {key for key, clip in clips.items() if clip["lang"] == lang}
        wanted = language if default else {f"num.{n}.{lang}" for n in numbers}
        (directory / "recipes.json").write_text(json.dumps({k: {"skip": True} for k in language - wanted}))
        for key in sorted(wanted):
            (directory / f"{key}.m4a").write_bytes(audio)
            approved[key] = hashlib.sha256(audio).hexdigest()
        (directory / "approved.json").write_text(json.dumps(approved))
        (directory / "source.json").write_text(json.dumps({
            key: {"tier": "S0", "voice": label + "Test", "sha256": digest}
            for key, digest in approved.items()
        }))
    return root


@pytest.fixture(scope="session")
def recording(tmp_path_factory, audio_tools):
    directory = tmp_path_factory.mktemp("audio")

    @lru_cache
    def generate(fmt="webm", db=-12, tone=0.6, pad=0.5, silent=False):
        amplitude = 10 ** (db / 20)
        signal = (f"between(t,{pad},{pad + tone})*{amplitude}"
                  "*(0.7+0.3*sin(2*PI*7*t))*sin(2*PI*700*t)")
        if silent:
            signal = "0"
        path = directory / f"{db}_{tone}_{pad}_{silent}.{fmt}"
        codec = {"webm": "libopus", "mp4": "aac", "wav": "pcm_s16le", "ogg": "libopus"}[fmt]
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                        f"aevalsrc='{signal}':s=48000:d={tone + 2 * pad}",
                        "-c:a", codec, path], check=True, timeout=30)
        return path.read_bytes()

    return generate
