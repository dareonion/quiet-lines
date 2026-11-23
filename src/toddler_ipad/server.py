import hashlib
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from . import audio, db
from .release import TEMPLATE, build_release, catalog_clips, recorded_clips, render_worker

LIMIT = 1_048_576
NO_CACHE = {"Cache-Control": "no-cache"}
EXTENSIONS = {"audio/mp4": "m4a", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav"}


class RecordingForm(MultiPartParser):
    """Count each part as it arrives, before the multipart parser spools it."""

    def on_part_begin(self):
        super().on_part_begin()
        self.part_bytes = 0

    def on_part_data(self, data: bytes, start: int, end: int):
        self.part_bytes += end - start
        if self.part_bytes > LIMIT:
            raise HTTPException(413, "The recording is too large. Please try a shorter take.")
        super().on_part_data(data, start, end)


def _record(data_dir: Path, clip_id: str, speaker: str, mime: str | None, content: bytes) -> dict:
    take_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f") + "-" + uuid.uuid4().hex
    ext = EXTENSIONS.get((mime or "").partition(";")[0].strip().lower(), "bin")
    raw = Path("recordings/raw") / clip_id / f"{take_id}.{ext}"
    processed = Path("recordings/processed") / clip_id / f"{take_id}.m4a"
    take = {
        "take_id": take_id, "clip_id": clip_id, "speaker": speaker, "mime": mime,
        "recorded_at": db.timestamp(), "raw_sha256": hashlib.sha256(content).hexdigest(),
        "raw_path": str(raw),
    }
    raw_file = data_dir / raw
    out = data_dir / processed
    raw_file.parent.mkdir(parents=True, exist_ok=True)
    stream = raw_file.open("xb")
    try:
        with stream:
            stream.write(content)
        db.add_raw_take(data_dir, take)
    except Exception:
        raw_file.unlink()
        raise
    try:
        duration = audio.process(raw_file, out)
    except audio.AudioError as exc:
        with db.connect(data_dir) as conn:
            conn.execute("UPDATE takes SET error=? WHERE take_id=?", (str(exc), take_id))
        raise HTTPException(422, exc.message) from exc
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    with db.connect(data_dir) as conn:
        conn.execute("""
            UPDATE takes SET ok=1, error=NULL, duration=?, processed_path=?, processed_sha256=?
            WHERE take_id=?
        """, (duration, str(processed), digest, take_id))
    return {"take_id": take_id, "clip_id": clip_id, "duration": duration,
            "preview_url": f"/api/takes/{take_id}.m4a"}


def create_app(app_dir: Path, data_dir: Path, origins: set[str]) -> FastAPI:
    db.initialize(data_dir)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def check_origin(request: Request, call_next):
        if request.method == "POST":
            values = request.headers.getlist("origin")
            if len(values) != 1 or values[0] not in origins:
                return JSONResponse({"detail": "Please use the recorder on this server."}, status_code=403)
        return await call_next(request)

    def check_clip(clip_id: str):
        if clip_id not in catalog_clips(app_dir):
            raise HTTPException(404, "Unknown clip.")

    @app.get("/sw.js")
    def worker():
        # One read of the template: the bytes served are the bytes the release id covers.
        template = TEMPLATE.read_bytes()
        release = build_release(app_dir, recorded_clips(app_dir, data_dir), template)
        return Response(render_worker(release, template),
                        headers={**NO_CACHE, "Content-Type": "text/javascript"})

    @app.get("/release.json")
    def release_manifest():
        # "recorder": this copy is self-hosted with a /record page (the hosted static site has none).
        release = build_release(app_dir, recorded_clips(app_dir, data_dir))
        return JSONResponse({**release, "recorder": True}, headers=NO_CACHE)

    @app.get("/audio/{clip_id:path}.m4a")
    def active_audio(clip_id: str):
        check_clip(clip_id)
        with db.connect(data_dir) as conn:
            take = db.active_takes(conn).get(clip_id)
        if take is None:
            raise HTTPException(404, "No recording has been kept yet.")
        return FileResponse(data_dir / take["processed_path"], media_type="audio/mp4", headers=NO_CACHE)

    @app.get("/record")
    def recorder():
        return FileResponse(app_dir / "recorder/index.html")

    @app.get("/api/clips")
    def list_clips():
        with db.connect(data_dir) as conn:
            conn.execute("BEGIN")
            active = db.active_takes(conn)
            counts = dict(conn.execute("SELECT clip_id, COUNT(*) FROM takes WHERE ok=1 GROUP BY clip_id"))
            # The newest ok take per clip: if it isn't the active one, it's waiting for Keep (the
            # recorder offers it again after a reload or a lost response, so nobody re-records).
            newest = {row["clip_id"]: row for row in conn.execute("""
                SELECT t.* FROM takes t
                JOIN (SELECT clip_id, MAX(take_id) AS take_id FROM takes WHERE ok=1 GROUP BY clip_id) m
                  ON m.take_id = t.take_id""")}
        clips = []
        for clip_id, info in catalog_clips(app_dir).items():
            take = active.get(clip_id)
            summary = {k: take[k] for k in ("take_id", "speaker", "recorded_at", "duration")} if take else None
            latest = newest.get(clip_id)
            unkept = None
            if latest is not None and (take is None or latest["take_id"] != take["take_id"]):
                unkept = {k: latest[k] for k in ("take_id", "speaker", "recorded_at", "duration")}
                unkept["preview_url"] = f"/api/takes/{latest['take_id']}.m4a"
            clips.append({"id": clip_id, **info, "takes": counts.get(clip_id, 0), "active": summary,
                          "unkept": unkept})
        return {"clips": clips}

    @app.post("/api/clips/{clip_id:path}/takes", status_code=201)
    async def upload(clip_id: str, request: Request):
        check_clip(clip_id)
        if request.headers.get("content-type", "").partition(";")[0].lower() != "multipart/form-data":
            raise HTTPException(422, "Please send an audio file and a speaker name.")
        parser = RecordingForm(request.headers, request.stream(), max_files=1, max_fields=1)
        try:
            form = await parser.parse()
        except MultiPartException as exc:
            raise HTTPException(422, "Please send one audio file and one speaker name.") from exc
        try:
            file = form.get("audio")
            speaker = form.get("speaker")
            if not isinstance(file, UploadFile):
                raise HTTPException(422, "Please record some audio first.")
            if not isinstance(speaker, str) or not 1 <= len(speaker.strip()) <= 40:
                raise HTTPException(422, "Please enter a speaker name between 1 and 40 characters.")
            return await run_in_threadpool(_record, data_dir, clip_id, speaker.strip(),
                                           file.content_type, await file.read())
        finally:
            await form.close()

    @app.get("/api/takes/{take_id}.m4a")
    def preview(take_id: str):
        with db.connect(data_dir) as conn:
            row = conn.execute("SELECT clip_id, processed_path FROM takes WHERE take_id=? AND ok=1",
                               (take_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Recording unavailable.")
        check_clip(row["clip_id"])
        return FileResponse(data_dir / row["processed_path"], media_type="audio/mp4")

    @app.post("/api/clips/{clip_id:path}/active")
    async def keep(clip_id: str, request: Request):
        check_clip(clip_id)
        try:
            body = await request.json()
        except ValueError as exc:
            raise HTTPException(422, "Please choose a recording to keep.") from exc
        if not isinstance(body, dict) or not isinstance(body.get("take_id"), str):
            raise HTTPException(422, "Please choose a recording to keep.")
        take_id = body["take_id"]
        if not await run_in_threadpool(db.keep, data_dir, clip_id, take_id):
            raise HTTPException(409, "Choose a successful recording of this word.")
        return {"clip_id": clip_id, "take_id": take_id}

    app.mount("/", StaticFiles(directory=app_dir, html=True))
    return app


def main():
    repo = Path(__file__).resolve().parents[2]
    port = int(os.getenv("PORT", "8019"))
    origins = {s.strip() for s in os.getenv("TODDLER_ORIGINS", "").split(",") if s.strip()}
    origins.update({f"http://127.0.0.1:{port}", f"http://localhost:{port}"})
    app = create_app(Path(os.getenv("TODDLER_APP_DIR", repo / "app")),
                     Path(os.getenv("TODDLER_DATA_DIR", repo / "data")), origins)
    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=port)
