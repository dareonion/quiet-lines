import hashlib
import json
import re
import sqlite3
import subprocess
from contextlib import closing
from datetime import datetime

import pytest


def upload(client, origin, clip, content, mime="audio/webm", speaker=" Robin "):
    return client.post(f"/api/clips/{clip}/takes", headers=origin,
                       files={"audio": ("ignored.filename", content, mime)},
                       data={"speaker": speaker})


def keep(client, origin, clip, take):
    return client.post(f"/api/clips/{clip}/active", headers=origin, json={"take_id": take})


def rows(data_dir, sql):
    with closing(sqlite3.connect(data_dir / "recordings.db")) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(sql).fetchall()


@pytest.fixture
def clip(client):
    return client.get("/api/clips").json()["clips"][0]["id"]


@pytest.mark.parametrize("bad", ["unknown", ".bad", "BAD", "x" * 65, "%2e%2e%2findex.html", "a%2Fb"])
def test_invalid_clip(client, origin, bad):
    assert upload(client, origin, bad, b"audio").status_code == 404
    assert keep(client, origin, bad, "unknown").status_code == 404
    assert client.get(f"/audio/{bad}.m4a").status_code == 404


@pytest.mark.parametrize("headers", [{}, {"Origin": "https://foreign.example"}])
def test_origin_before_body(client, data_dir, clip, headers):
    assert client.post(f"/api/clips/{clip}/takes", headers=headers).status_code == 403
    assert client.post(f"/api/clips/{clip}/active", headers=headers).status_code == 403
    assert not rows(data_dir, "SELECT * FROM takes")
    assert not (data_dir / "recordings").exists()


def test_oversize_stream(client, data_dir, origin, clip):
    def chunks():
        yield b'--abc\r\nContent-Disposition: form-data; name="audio"; filename="a"\r\n\r\n'
        for _ in range(16):
            yield b"a" * 65536
        yield b"a\r\n--abc--\r\n"

    response = client.post(f"/api/clips/{clip}/takes", content=chunks(),
                           headers={**origin, "Content-Type": "multipart/form-data; boundary=abc"})
    assert response.status_code == 413
    assert not rows(data_dir, "SELECT * FROM takes")
    assert not (data_dir / "recordings").exists()


@pytest.mark.parametrize("speaker", ["   ", "x" * 41])
def test_invalid_speaker(client, data_dir, origin, clip, speaker):
    assert upload(client, origin, clip, b"audio", speaker=speaker).status_code == 422
    assert not rows(data_dir, "SELECT * FROM takes")


def manifest(client):
    response = client.get("/release.json")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-cache"
    release = response.json()
    worker = client.get("/sw.js")
    assert worker.headers["Cache-Control"] == "no-cache"
    assert worker.headers["Content-Type"].split(";")[0] == "text/javascript"
    assert "__RELEASE__" not in worker.text
    stamp = re.search(r"^const RELEASE = (.*);$", worker.text, re.MULTILINE)
    assert json.loads(stamp[1]) == {k: release[k] for k in ("files", "hashes", "id")}
    return release, worker.content


def test_static_and_release(client, app_dir):
    initial, _ = manifest(client)
    assert initial["files"] == ["", "content/catalog.json", "js/main.js", "release.json"]
    assert initial["recorder"] is True
    assert client.get("/recorder/").text == "recorder/index.html"
    assert initial["clips"] == {}
    assert re.fullmatch("[0-9a-f]{16}", initial["id"])
    assert client.get("/").text == "index.html"
    assert client.get("/record").text == "recorder/index.html"
    assert client.get("/js/main.js").text == "js/main.js"
    catalog = json.loads((app_dir / "content/catalog.json").read_bytes())["clips"]
    listed = client.get("/api/clips").json()["clips"]
    assert listed == [{"id": k, **v, "takes": 0, "active": None, "unkept": None} for k, v in catalog.items()]
    (app_dir / "debug/x.html").write_text("ignored")
    assert manifest(client)[0] == initial
    for name in ("index.html", "js/main.js"):
        target = app_dir / name
        original = target.read_bytes()
        target.write_bytes(original[::-1])
        assert manifest(client)[0]["id"] != initial["id"]
        target.write_bytes(original)


@pytest.mark.parametrize(("fmt", "mime", "ext"), [
    ("webm", "audio/webm;codecs=opus", "webm"), ("mp4", "audio/mp4", "m4a"),
    ("ogg", "audio/ogg", "ogg"), ("wav", "audio/wav", "wav"),
])
def test_record_preview_keep(client, origin, clip, data_dir, recording, fmt, mime, ext):
    before = manifest(client)
    raw = recording(fmt)
    result = upload(client, origin, clip, raw, mime)
    assert result.status_code == 201, result.text
    take = result.json()
    ident = take["take_id"]
    assert take["clip_id"] == clip
    assert take["preview_url"] == f"/api/takes/{ident}.m4a"
    assert take["duration"] == pytest.approx(0.8, abs=0.25)
    preview = client.get(take["preview_url"])
    assert preview.status_code == 200
    assert preview.headers["Content-Type"] == "audio/mp4"
    assert client.get(f"/audio/{clip}.m4a").status_code == 404
    assert manifest(client) == before
    listed = client.get("/api/clips").json()["clips"][0]
    assert listed["takes"] == 1 and listed["active"] is None
    row, = rows(data_dir, "SELECT * FROM takes")
    assert row["raw_path"] == f"recordings/raw/{clip}/{ident}.{ext}"
    assert (data_dir / row["raw_path"]).read_bytes() == raw
    assert row["raw_sha256"] == hashlib.sha256(raw).hexdigest()
    processed_sha = hashlib.sha256(preview.content).hexdigest()
    assert row["processed_path"] == f"recordings/processed/{clip}/{ident}.m4a"
    assert row["processed_sha256"] == processed_sha
    assert datetime.fromisoformat(row["recorded_at"]).utcoffset() is not None

    kept = keep(client, origin, clip, ident)
    assert kept.status_code == 200
    assert kept.json() == {"clip_id": clip, "take_id": ident}
    published = client.get(f"/audio/{clip}.m4a")
    assert published.headers["Cache-Control"] == "no-cache"
    assert published.content == preview.content
    after, worker = manifest(client)
    assert after["id"] != before[0]["id"] and worker != before[1]
    assert after["files"] == sorted([*before[0]["files"], f"audio/{clip}.m4a"])
    assert after["clips"] == {clip: {"take_id": ident, "sha256": processed_sha}}
    assert client.get("/api/clips").json()["clips"][0]["active"] == {
        "take_id": ident, "speaker": "Robin", "recorded_at": row["recorded_at"], "duration": take["duration"]}

    info = subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json",
                                    data_dir / row["processed_path"]], timeout=30)
    stream, = json.loads(info)["streams"]
    assert (stream["codec_name"], stream["profile"], stream["sample_rate"], stream["channels"]) == (
        "aac", "LC", "48000", 1)


def test_keeps_and_failures(client, data_dir, origin, clip, recording):
    other = client.get("/api/clips").json()["clips"][1]["id"]
    a, b = [upload(client, origin, clip, recording(db=level)).json() for level in (-15, -12)]
    assert a["take_id"] != b["take_id"]
    for take in (a, b):
        assert keep(client, origin, clip, take["take_id"]).status_code == 200
    assert keep(client, origin, other, b["take_id"]).status_code == 409
    stable = manifest(client)
    for bad in (recording(silent=True), b"garbage", recording(tone=6.2), recording(tone=0.1, pad=0)):
        response = upload(client, origin, clip, bad, "application/octet-stream")
        assert response.status_code == 422
        assert isinstance(response.json()["detail"], str)
        row = rows(data_dir, "SELECT * FROM takes ORDER BY rowid DESC LIMIT 1")[0]
        assert row["ok"] == 0 and row["error"]
        assert row["processed_path"] is None and row["processed_sha256"] is None
        assert row["raw_path"].endswith(".bin") and (data_dir / row["raw_path"]).read_bytes() == bad
        assert client.get(f"/api/takes/{row['take_id']}.m4a").status_code == 404
        assert keep(client, origin, clip, row["take_id"]).status_code == 409
        assert manifest(client) == stable
    assert [tuple(row) for row in rows(data_dir, "SELECT clip_id, take_id FROM active")] == [(clip, b["take_id"])]
    assert client.get("/api/clips").json()["clips"][0]["takes"] == 2
    assert client.get(a["preview_url"]).status_code == 200


def test_identical_takes_and_catalog_removal(client, app_dir, data_dir, origin, clip, recording):
    content = recording("mp4")
    first, second = [upload(client, origin, clip, content, "audio/mp4").json() for _ in range(2)]
    assert first["take_id"] < second["take_id"]
    assert keep(client, origin, clip, first["take_id"]).status_code == 200
    before, worker = manifest(client)
    assert keep(client, origin, clip, second["take_id"]).status_code == 200
    after, new_worker = manifest(client)
    assert after["clips"][clip]["take_id"] == second["take_id"]
    assert after["id"] == before["id"] and new_worker == worker

    path = app_dir / "content/catalog.json"
    catalog = json.loads(path.read_bytes())
    del catalog["clips"][clip]
    path.write_text(json.dumps(catalog))
    assert client.get(second["preview_url"]).status_code == 404
    assert client.get(f"/audio/{clip}.m4a").status_code == 404
    assert clip not in manifest(client)[0]["clips"]
    assert len(rows(data_dir, "SELECT * FROM takes")) == 2


@pytest.mark.parametrize(("tone", "padding"), [(0.6, 0.5), (0.3, 0)])
def test_normalized_levels(client, origin, clip, recording, tone, padding):
    levels = []
    for db in (-12, -24):
        response = upload(client, origin, clip, recording("wav", db, tone, padding), "audio/wav")
        assert response.status_code == 201, response.text
        take = response.json()
        preview = client.get(take["preview_url"]).content
        filters = "ebur128=peak=true"
        if tone < 0.4:
            # Integrated loudness has a 400 ms gate. Meter repetitions of the decoded word.
            filters = "aloop=loop=3:size=20000," + filters
        result = subprocess.run(["ffmpeg", "-hide_banner", "-i", "pipe:0", "-af", filters,
                                 "-f", "null", "-"], input=preview, capture_output=True,
                                check=True, timeout=30)
        summary = result.stderr.decode().rsplit("Summary:", 1)[1]
        levels.append(float(re.search(r"I:\s+([-\d.]+) LUFS", summary)[1]))
        assert float(re.search(r"Peak:\s+([-\d.]+) dBFS", summary)[1]) <= -1.5
    assert levels[0] == pytest.approx(levels[1], abs=2)
    assert all(abs(level + 16) < 2 for level in levels)


def test_unkept_take_is_offered_until_kept(client, origin, recording):
    """A take uploaded but not kept (a lost response, a reload) comes back in /api/clips."""
    clips = client.get("/api/clips").json()["clips"]
    clip = clips[0]["id"]
    assert clips[0]["unkept"] is None
    take = upload(client, origin, clip, recording("webm")).json()["take_id"]
    entry = next(c for c in client.get("/api/clips").json()["clips"] if c["id"] == clip)
    assert entry["unkept"]["take_id"] == take
    assert client.get(entry["unkept"]["preview_url"]).status_code == 200
    assert keep(client, origin, clip, take).status_code == 200
    entry = next(c for c in client.get("/api/clips").json()["clips"] if c["id"] == clip)
    assert entry["unkept"] is None and entry["active"]["take_id"] == take
