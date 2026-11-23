"""End-to-end: Chromium at an iPad viewport, against FastAPI and a static project site.

Covers the pilot's risks that Linux can check: the app renders, scripted traces complete
(including across a rotation), the parent gate needs the full hold, the recorder UI records and
keeps a take (Chromium's fake microphone), the service worker survives an offline cold relaunch,
and an update waits for Home (an open lesson keeps its release and progress, even offline) and
then serves the new clip's exact bytes. Real fingers, audible playback, Safari's Home Screen mode
and Guided Access stay on the device checklist.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import socket
import subprocess
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import uvicorn
from playwright.sync_api import expect

from toddler_ipad.server import create_app
from toddler_ipad.site import build_site

REPO = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.usefixtures("audio_tools")
both_hosts = pytest.mark.parametrize("server", ["fastapi", "static"], indirect=True)
static_host = pytest.mark.parametrize("server", ["static"], indirect=True)
LANDSCAPE = {"width": 1180, "height": 820}   # iPad Air, CSS px
PORTRAIT = {"width": 820, "height": 1180}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def server(tmp_path, voice_pack, request):
    app_dir = tmp_path / "app"
    shutil.copytree(REPO / "app", app_dir)
    if getattr(request, "param", "fastapi") == "static":
        root = tmp_path / "www"
        out = root / "sub"
        build_site(out, voice_pack, app_dir=app_dir)

        allow_audio = threading.Event()
        allow_audio.set()

        class StaticHandler(SimpleHTTPRequestHandler):
            def do_GET(self):
                if self.path.endswith(".m4a") and not allow_audio.wait(20):
                    self.send_error(503)
                    return
                # The fixture can rebuild twice within HTTP-date's one-second resolution.
                if "If-Modified-Since" in self.headers:
                    del self.headers["If-Modified-Since"]
                super().do_GET()

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), partial(StaticHandler, directory=root)) as http:
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://localhost:{http.server_port}/sub"
                yield {"base": base, "app_dir": app_dir, "tmp": tmp_path, "out": out, "pack": voice_pack,
                       "allow_audio": allow_audio}
            finally:
                http.shutdown()
                thread.join()
        return
    data_dir = tmp_path / "data"
    port = _free_port()
    base = f"http://localhost:{port}"
    app = create_app(app_dir, data_dir, {base})
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield {"base": base, "app_dir": app_dir, "data_dir": data_dir, "tmp": tmp_path}
    srv.should_exit = True
    th.join(timeout=5)


@pytest.fixture()
def browser_ctx(server):
    """A persistent profile (so an offline cold relaunch is real) with a fake microphone."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(server["tmp"] / "profile"),
            viewport=LANDSCAPE,
            device_scale_factor=2,
            has_touch=True,
            args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        )
        yield ctx
        ctx.close()


@pytest.fixture()
def page(browser_ctx):
    pg = browser_ctx.pages[0] if browser_ctx.pages else browser_ctx.new_page()
    pg.on("pageerror", lambda e: pytest.fail(f"page error: {e}"))
    return pg


def _tone(path: Path, seconds: float = 0.6, freq: int = 440) -> Path:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.3",
         "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=48000:duration={seconds}",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.3",
         "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1,volume=0.5", "-c:a", "aac", str(path)],
        check=True,
    )
    return path


def _record_and_keep(page, base: str, clip: str, audio: Path) -> str:
    """Upload a take and keep it through the HTTP API (the recorder UI has its own test)."""
    api = page.context.request
    r = api.post(
        f"{base}/api/clips/{clip}/takes",
        multipart={"speaker": "Test", "audio": {"name": "take.m4a", "mimeType": "audio/mp4", "buffer": audio.read_bytes()}},
        headers={"Origin": base},
    )
    assert r.status == 201, r.text()
    take = r.json()["take_id"]
    r = api.post(f"{base}/api/clips/{clip}/active", data={"take_id": take}, headers={"Origin": base})
    assert r.ok, r.text()
    return take


def _publish_clip(page, server, audio):
    key = "shape.line.en"
    if "out" in server:
        pack = server["pack"] / "en-jenny"
        digest = hashlib.sha256(audio.read_bytes()).hexdigest()
        shutil.copyfile(audio, pack / f"{key}.m4a")
        approvals = pack / "approved.json"
        approvals.write_text(json.dumps({**json.loads(approvals.read_bytes()), key: digest}))
        source_path = pack / "source.json"
        source = json.loads(source_path.read_bytes())
        source[key]["sha256"] = digest
        source_path.write_text(json.dumps(source))
        build_site(server["out"], server["pack"], app_dir=server["app_dir"])
        return digest
    take = _record_and_keep(page, server["base"], key, audio)
    processed = server["data_dir"] / f"recordings/processed/{key}/{take}.m4a"
    return hashlib.sha256(processed.read_bytes()).hexdigest()


def _ready(page):
    page.wait_for_function("document.documentElement.dataset.ready === '1'")


def _controlled(page, timeout: float = 20):
    """The worker controls the page AND the page was loaded from it. A first install that finishes
    while the app is on Home reloads it onto the worker (main.js), so poll across that reload."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if page.evaluate("""window.pageController?.scriptURL === new URL("sw.js", location.href).href
                                && window.pageController === navigator.serviceWorker.controller
                                && document.documentElement.dataset.ready === '1'"""):
                return
        except Exception:
            pass   # mid-reload: the old document is gone
        time.sleep(0.1)
    raise AssertionError("the page never came under its service worker")


def _wait_for_waiting_worker(page, seconds: float = 15) -> bool:
    # (wait_for_function treats a returned Promise as truthy, so poll inside the page instead.)
    return page.evaluate(
        """async (ms) => {
            const r = await navigator.serviceWorker.getRegistration();
            for (const end = Date.now() + ms; Date.now() < end; ) {
                if (r.waiting) return true;
                await new Promise((s) => setTimeout(s, 100));
            }
            return false;
        }""",
        int(seconds * 1000),
    )


def _fetch_in_page(page, url: str) -> dict:
    """Status and sha256 of a fetch made by the page (so it goes through the service worker)."""
    return page.evaluate(
        """async (url) => {
            const r = await fetch(url);
            const buf = await r.arrayBuffer();
            const d = await crypto.subtle.digest('SHA-256', buf);
            return {status: r.status, sha: Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')};
        }""",
        url,
    )


def _trace(page, start: float = 0.0, end: float = 1.0, reverse: bool = False):
    """Drag the mouse along each stroke of the open trace screen, from fraction start to end."""
    strokes = page.evaluate("window.__trace.strokePts")
    box = page.locator(".trace-stage canvas").bounding_box()
    for pts in strokes:
        pts = pts[::-1] if reverse else pts
        pts = pts[int(start * (len(pts) - 1)): int(end * (len(pts) - 1)) + 1]
        page.mouse.move(box["x"] + pts[0][0], box["y"] + pts[0][1])
        page.mouse.down()
        for x, y in pts[:: max(1, len(pts) // 40)] + [pts[-1]]:
            page.mouse.move(box["x"] + x, box["y"] + y, steps=2)
        page.mouse.up()


def _covered_fraction(page) -> float:
    return page.evaluate(
        """(() => { const t = window.__trace; const cov = t.tracer.coverage()[0];
                    const n = t.strokePts[0].length;
                    return cov.ranges.reduce((m, [lo, hi]) => Math.max(m, (hi - lo + 1) / n), 0); })()"""
    )


def _open_trace(page, item: str = "shape.vline"):
    """From Home: Shapes, the vertical line's card, then its trace button."""
    page.locator('.tile[data-area="shapes"]').click()
    page.locator(f'.tile[data-item="{item}"]').click()
    page.locator('[data-act="trace"]').click()
    page.wait_for_function("window.__trace && window.__trace.strokePts")


def _offline_ready(page):
    """Controlled by a worker with nothing left installing (what the ✓ means in the Home Screen app)."""
    _controlled(page)
    page.wait_for_function("navigator.serviceWorker.getRegistration().then(r => !r.installing)")
    assert page.evaluate("navigator.serviceWorker.getRegistration().then(r => !r.installing && !!r.active)")


@both_hosts
def test_home_renders_and_line_traces(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    assert page.locator(".tile[data-area]").count() == 5
    _open_trace(page)
    _trace(page)
    assert page.evaluate("window.__trace.tracer.complete")
    page.locator('[data-act="restart"]').click()
    assert not page.evaluate("window.__trace.tracer.complete")
    _trace(page, reverse=True)  # easy mode: from the other end
    assert page.evaluate("window.__trace.tracer.complete")


def test_rotation_keeps_progress(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    _open_trace(page)
    _trace(page, 0.0, 0.5)
    before = _covered_fraction(page)
    assert 0.4 < before < 0.6
    page.set_viewport_size(PORTRAIT)
    page.wait_for_timeout(200)
    assert abs(_covered_fraction(page) - before) < 0.05
    _trace(page, 0.45, 1.0)
    assert page.evaluate("window.__trace.tracer.complete")
    page.set_viewport_size(LANDSCAPE)
    page.wait_for_timeout(200)
    assert page.evaluate("window.__trace.tracer.complete")


@both_hosts
def test_parent_gate_needs_the_full_hold(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    gear = page.locator(".parent-corner")
    gear.click()                                    # a tap does nothing
    page.wait_for_timeout(300)
    assert page.locator(".parent").count() == 0
    box = gear.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.wait_for_timeout(1500)
    page.mouse.up()                                 # let go early: still nothing
    page.wait_for_timeout(2000)
    assert page.locator(".parent").count() == 0
    page.mouse.down()
    page.wait_for_timeout(3300)
    page.mouse.up()
    page.wait_for_selector(".parent")
    parent = page.locator(".parent").inner_text()
    assert ("/record" in parent) == ("out" not in server)
    assert ("Computer-generated test tones." in parent) == ("out" in server)
    page.locator('.seg[data-setting="lang"] button[data-value="zh"]').click()
    assert page.evaluate("JSON.parse(localStorage.getItem('toddler.settings.v1')).lang") == "zh"
    page.locator('[data-act="done"]').click()
    page.wait_for_selector(".home")


def test_recorder_ui_records_and_keeps(server, page):
    page.goto(server["base"] + "/recorder/")
    page.wait_for_selector(".clip")
    page.goto(server["base"] + "/record")
    page.wait_for_selector(".clip")
    page.locator("#speakers input").fill("Robin")
    row = page.locator('.clip[data-clip="letter.b.en"]')
    row.locator("button.rec").click()
    row.locator("button.rec.on", has_text="Stop").wait_for()
    page.wait_for_timeout(1500)                     # the fake mic plays a beep
    row.locator("button.rec.on").click()
    row.locator("button.keep").wait_for(timeout=20000)
    row.locator("button.listen").click()            # the processed take plays back
    row.locator("button.keep").click()
    row.locator(".status.kept").wait_for(timeout=10000)
    assert "Robin" in row.locator(".status").inner_text()
    clips = page.context.request.get(server["base"] + "/api/clips").json()["clips"]
    active = next(c for c in clips if c["id"] == "letter.b.en")["active"]
    assert active and active["speaker"] == "Robin"


@both_hosts
def test_offline_cold_relaunch(server):
    """Install, quit the whole browser, relaunch the same profile offline: the app still opens."""
    from playwright.sync_api import sync_playwright

    profile = str(server["tmp"] / "cold-profile")
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(profile, viewport=LANDSCAPE, has_touch=True)
        page = ctx.pages[0]
        digest = _publish_clip(page, server, _tone(server["tmp"] / "cold.m4a"))
        page.goto(server["base"] + "/")
        _ready(page)
        _offline_ready(page)
        assert "(browser tab)" in page.locator(".release-tag").inner_text()   # not the Home Screen app
        ctx.close()
        ctx = p.chromium.launch_persistent_context(profile, viewport=LANDSCAPE, has_touch=True, offline=True)
        page = ctx.pages[0]
        page.goto(server["base"] + "/")
        _ready(page)
        assert page.locator(".tile[data-area]").count() == 5
        page.goto(server["base"] + "/#/card/char.shan1")
        _ready(page)
        assert page.locator(".card-glyph svg path").count() == 3   # 山, drawn from cached stroke data
        page.goto(server["base"] + "/#/card/shape.vline")
        page.evaluate("window.__plays = []")
        key = "en-jenny/shape.line.en" if "out" in server else "shape.line.en"
        with page.expect_response(lambda r: r.url.endswith(f"/audio/{key}.m4a")) as fetched:
            page.locator('.card-shape [data-act="say"]').click()
        assert fetched.value.from_service_worker
        assert _fetch_in_page(page, f"audio/{key}.m4a") == {"status": 200, "sha": digest}
        assert key in page.evaluate("window.__plays[0]")
        ctx.close()


def _open_parent(page):
    gear = page.locator(".parent-corner")
    gear.hover()
    page.mouse.down()
    try:
        page.wait_for_selector(".parent", timeout=10000)
    finally:
        page.mouse.up()


@static_host
def test_voice_selection_and_fallback_on_offline_cold_relaunch(server):
    from playwright.sync_api import sync_playwright

    base = server["base"] + "/"
    profile = str(server["tmp"] / "voices-profile")
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(profile, viewport=LANDSCAPE, has_touch=True)
        page = ctx.pages[0]
        page.goto(base)
        _offline_ready(page)
        page.goto(base + "#/card/num.3")
        page.evaluate("window.__plays = []")
        page.locator('[data-act="say"]').click()
        assert page.evaluate("window.__plays") == [["en-jenny/num.3.en", "zh-hsiaochen/num.3.zh"]]
        page.locator('[data-act="home"]').click()
        _open_parent(page)
        en = page.get_by_role("group", name="English voice")
        zh = page.get_by_role("group", name="中文 voice")
        assert en.get_by_role("button", name="Jenny").get_attribute("aria-pressed") == "true"
        assert zh.get_by_role("button", name="HsiaoChen").get_attribute("aria-pressed") == "true"
        zh.get_by_role("button", name="YunJhe").click()
        # This pack lacks the usual sample. The parent hears one of its own clips.
        assert page.evaluate("window.__plays.at(-1)") == ["zh-yunjhe/num.2.zh"]
        en.get_by_role("button", name="Guy").click()
        assert page.evaluate("window.__plays.at(-1)") == ["en-guy/num.1.en"]
        assert zh.get_by_role("button", name="YunJhe").get_attribute("aria-pressed") == "true"
        page.locator('[data-act="done"]').click()
        page.wait_for_selector(".home")
        page.locator('.tile[data-area="numbers"]').click()
        page.locator('.tile[data-item="num.3"]').click()
        page.locator('[data-act="say"]').click()
        assert page.evaluate("window.__plays.at(-1)") == ["en-guy/num.3.en", "zh-hsiaochen/num.3.zh"]
        ctx.close()

        ctx = p.chromium.launch_persistent_context(profile, viewport=LANDSCAPE, has_touch=True, offline=True)
        page = ctx.pages[0]
        page.goto(base)
        _ready(page)
        page.evaluate("window.__plays = []")
        for n, en_pack, zh_pack in [(3, "en-guy", "zh-hsiaochen"), (2, "en-jenny", "zh-yunjhe")]:
            page.goto(base + f"#/card/num.{n}")
            page.wait_for_function("n => document.querySelectorAll('.count-obj').length === n", arg=n)
            en_key, zh_key = f"{en_pack}/num.{n}.en", f"{zh_pack}/num.{n}.zh"
            with page.expect_response(lambda r: r.url.endswith(f"/audio/{en_key}.m4a")) as fetched:
                page.locator('[data-act="say"]').click()
            assert fetched.value.ok and fetched.value.from_service_worker
            expected = hashlib.sha256((server["pack"] / f"{en_key}.m4a").read_bytes()).hexdigest()
            assert _fetch_in_page(page, f"audio/{en_key}.m4a") == {"status": 200, "sha": expected}
            assert page.evaluate("window.__plays.at(-1)") == [en_key, zh_key]
        ctx.close()


@static_host
def test_language_with_only_one_pack_hides_its_voice_row(server, page):
    shutil.rmtree(server["pack"] / "en-guy")
    build_site(server["out"], server["pack"], app_dir=server["app_dir"])
    page.goto(server["base"] + "/")
    _offline_ready(page)
    _open_parent(page)
    assert page.get_by_text("English voice", exact=True).count() == 0
    assert page.get_by_role("group", name="中文 voice").get_by_role("button").count() == 2


@pytest.mark.parametrize("code_change", [False, True], ids=["audio-only", "audio-and-code"])
@both_hosts
def test_update_waits_for_home_then_serves_new_clip(server, page, code_change):
    base = server["base"]
    _publish_clip(page, server, _tone(server["tmp"] / "a.m4a", 0.6, 440))

    page.goto(base + "/")
    _ready(page)
    _controlled(page)
    page.reload()
    _ready(page)
    old_release = _release_id(page)
    page.evaluate("caches.open('release-legacy').then(() => true)")

    # Open a lesson and trace half of it; then a new take and a code change land on the server.
    _open_trace(page)
    _trace(page, 0.0, 0.5)
    half = _covered_fraction(page)
    assert 0.4 < half < 0.6
    if code_change:
        css = server["app_dir"] / "app.css"
        css.write_text(css.read_text() + "\n/* release bump */\n")
    new_sha = _publish_clip(page, server, _tone(server["tmp"] / "b.m4a", 0.9, 330))
    page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
    assert _wait_for_waiting_worker(page), "the new release never finished installing"

    # Still on the old release, progress intact, even offline; the lesson can be finished.
    page.context.set_offline(True)
    assert _release_id(page) == old_release
    assert abs(_covered_fraction(page) - half) < 0.02
    _trace(page, 0.45, 1.0)
    assert page.evaluate("window.__trace.tracer.complete")

    # Home: the waiting worker takes over and the page reloads onto the new release, offline.
    page.evaluate("window.__oldDocument = true")
    page.locator('[data-act="home"]').click()
    page.wait_for_function(
        "!window.__oldDocument && document.documentElement.dataset.ready === '1'", timeout=15000
    )
    release = page.evaluate("fetch('release.json').then(r => r.json())")
    assert release["id"] != old_release
    key = "en-jenny/shape.line.en" if "out" in server else "shape.line.en"
    got = _fetch_in_page(page, f"audio/{key}.m4a")
    assert got["status"] == 200
    assert got["sha"] == release["clips"][key]["sha256"]
    assert got["sha"] == new_sha
    assert page.evaluate("caches.has('release-legacy')") == ("out" in server)


def test_representative_glyphs_trace_in_the_browser(server, page):
    """The surface + glyph layout in a real page (every glyph's data is covered fast by
    app/js/trace/glyphs.test.js): one of each kind, plus the shared-end and sharp-corner cases."""
    page.goto(server["base"] + "/")
    _ready(page)
    failed = []
    for item in [{"id": i} for i in ("shape.star", "shape.heart", "num.10", "letter.b", "letter.d", "char.kou3", "char.shui3")]:
        page.evaluate(f"location.hash = '#/trace/{item['id']}'")
        page.wait_for_function(f"window.__trace && document.querySelector('#app').dataset.screen === 'trace'")
        _trace(page)
        if not page.evaluate("window.__trace.tracer.complete"):
            failed.append(item["id"])
    assert not failed, f"could not complete: {failed}"


@both_hosts
def test_pickers_page_and_cards_open(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    page.locator('.tile[data-area="letters"]').click()
    expect(page.locator(".item-tile")).to_have_count(6)      # retries: the page renders after the tap
    expect(page.locator('[data-act="prev"]')).to_be_hidden()
    for _ in range(4):
        page.locator('[data-act="next"]').click()
    expect(page.locator(".item-tile")).to_have_count(2)      # Y, Z
    expect(page.locator('[data-act="next"]')).to_be_hidden()
    page.locator('.tile[data-item="letter.z"]').click()
    page.wait_for_selector(".card-letter .card-emoji")
    page.locator('[data-act="back"]').click()
    page.wait_for_selector('.tile[data-item="letter.z"]')     # back to the same page


@pytest.mark.parametrize(
    "lang,expected",
    [
        ("en", [["num.1.en"], ["num.2.en"], ["num.3.en", "num.3.en"]]),
        ("zh", [["num.1.zh"], ["num.2.zh"], ["num.3.zh", "num.3.zh"]]),
        ("both", [["num.1.en", "num.1.zh"], ["num.2.en", "num.2.zh"], ["num.3.en", "num.3.zh", "num.3.en", "num.3.zh"]]),
    ],
)
@both_hosts
def test_counting_counts_each_object_once(server, page, lang, expected):
    page.goto(server["base"] + "/")
    _ready(page)
    page.evaluate(f"localStorage.setItem('toddler.settings.v1', JSON.stringify({{lang: '{lang}'}}))")
    page.goto(server["base"] + "/#/card/num.3")
    _ready(page)
    page.evaluate("window.__plays = []")
    objs = page.locator(".count-obj")
    assert objs.count() == 3
    objs.nth(1).click()
    objs.nth(1).click()                                       # a second tap doesn't count again
    assert page.locator(".count-obj.counted").count() == 1
    objs.nth(0).click()
    objs.nth(2).click()
    assert page.locator(".count-obj.counted").count() == 3
    if "out" in server:
        default = {"en": "en-jenny", "zh": "zh-hsiaochen"}
        expected = [[f"{default[key.rsplit('.', 1)[1]]}/{key}" for key in count] for count in expected]
    assert page.evaluate("window.__plays") == expected        # running count, then the number again
    page.locator('[data-act="recount"]').click()              # count again: a fresh frame
    assert page.locator(".count-obj.counted").count() == 0
    page.goto(server["base"] + "/#/card/num.0")
    page.wait_for_selector(".card-number .ten-frame")
    assert page.locator(".count-obj").count() == 0


@both_hosts
def test_draw_leaves_ink_and_new_page_clears(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    page.locator('.tile[data-area="draw"]').click()
    c = page.locator(".draw-stage canvas").bounding_box()
    page.mouse.move(c["x"] + 100, c["y"] + 100)
    page.mouse.down()
    for i in range(20):
        page.mouse.move(c["x"] + 100 + i * 10, c["y"] + 100 + i * 5)
    page.mouse.up()
    assert page.evaluate("window.__draw.strokes.length") == 1
    page.locator('[data-act="new"]').click()
    assert page.evaluate("window.__draw.strokes.length") == 0


VIEWPORTS = [{"width": 820, "height": 1180}, {"width": 768, "height": 1024},
             {"width": 1180, "height": 820}, {"width": 1024, "height": 768}]
CHILD_TARGETS = ".round, .tile, .crayon, .count-obj, .card-glyph, .card-emoji"


@pytest.mark.parametrize("vp", VIEWPORTS, ids=lambda v: f"{v['width']}x{v['height']}")
def test_child_targets_are_at_least_88pt_and_fit(server, page, vp):
    page.set_viewport_size(vp)
    page.goto(server["base"] + "/")
    _ready(page)
    for h in ["#/", "#/area/letters/0", "#/card/num.7", "#/card/letter.a", "#/card/char.shan1",
              "#/trace/char.shan1", "#/draw"]:
        page.evaluate(f"location.hash = '{h}'")
        page.wait_for_timeout(150)
        boxes = page.evaluate(
            """(sel) => [...document.querySelectorAll(sel)]
                 .filter(e => !e.hidden && e.offsetParent !== null)
                 .map(e => { const r = e.getBoundingClientRect();
                             return {c: e.className, w: r.width, h: r.height, r: r.right, b: r.bottom}; })""",
            CHILD_TARGETS,
        )
        small = [b for b in boxes if b["w"] < 87.5 or b["h"] < 87.5]
        assert not small, f"{h}: under 88 pt: {small}"
        off = [b for b in boxes if b["r"] > vp["width"] + 0.5 or b["b"] > vp["height"] + 0.5]
        assert not off, f"{h}: off screen: {off}"


def _pixel(page, x: float, y: float) -> list[int]:
    """RGBA of the trace/draw canvas at CSS px (x, y) relative to the canvas."""
    return page.evaluate(
        """([x, y]) => { const c = document.querySelector('#app canvas');
                         const dpr = c.width / c.getBoundingClientRect().width;
                         return Array.from(c.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data); }""",
        [x, y],
    )


def _close(rgb, hex_color, tol=30):
    want = [int(hex_color[i:i + 2], 16) for i in (1, 3, 5)]
    return all(abs(a - b) <= tol for a, b in zip(rgb[:3], want))


@pytest.mark.parametrize("clipped", [True, False], ids=["clipped", "clip-removed"])
def test_hanzi_progress_paints_inside_the_stroke_only(server, page, clipped):
    """Progress paint (a brush 2.2x the line width) is clipped to the stroke's outline. The outside
    probe sits within the unclipped brush, so removing the clip must make it fail (second case)."""
    page.goto(server["base"] + "/#/trace/char.shan1")
    _ready(page)
    page.wait_for_function("window.__trace && window.__trace.strokePts")
    if not clipped:
        page.evaluate("() => { window.__trace.layout.clipTo = (ctx) => ctx.save(); }")   # simulate the regression
    _trace(page, 0.0, 0.6)                                   # stroke 1 (the centre 丨), partly
    pts = page.evaluate("window.__trace.strokePts[0]")
    lw = page.evaluate("window.__trace.lineWidth")
    x, y = pts[len(pts) // 4]
    assert _close(_pixel(page, x, y), "#6f8fad"), "progress isn't painted on the stroke"
    outside = _close(_pixel(page, x + lw * 0.9, y), "#6f8fad")   # outside 山's 丨, inside the brush
    assert outside is (not clipped)


def test_draw_paints_to_the_lift_point(server, page):
    page.goto(server["base"] + "/#/draw")
    _ready(page)
    c = page.locator(".draw-stage canvas").bounding_box()
    pts = [(100 + i * 12, 100 + (i % 2) * 6) for i in range(20)]
    page.mouse.move(c["x"] + pts[0][0], c["y"] + pts[0][1])
    page.mouse.down()
    for x, y in pts[1:]:
        page.mouse.move(c["x"] + x, c["y"] + y)
    page.mouse.up()
    end = pts[-1]
    assert _pixel(page, end[0] - 1, end[1])[3] > 0, "the end of the stroke wasn't drawn"


class _Hand:
    """Real browser input through CDP: Apple Pencil-like pen events and finger/palm touches."""

    def __init__(self, page):
        self.cdp = page.context.new_cdp_session(page)

    def pen(self, kind, x, y):
        down = kind != "mouseReleased"
        self.cdp.send("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": "left", "buttons": 1 if down else 0,
            "clickCount": 1, "pointerType": "pen", "force": 0.5})

    def hover(self, x, y):
        self.cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0, "pointerType": "pen"})

    def pen_stroke(self, pts):
        self.pen("mousePressed", *pts[0])
        for x, y in pts[1:]:
            self.pen("mouseMoved", x, y)
        self.pen("mouseReleased", *pts[-1])

    def touch(self, kind, x=0, y=0):
        points = [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 1}]
        self.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

    def tap(self, x, y):
        self.touch("touchStart", x, y)
        self.touch("touchEnd")


def _centre(page, selector):
    b = page.locator(selector).bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def test_draw_ignores_a_resting_hand_while_the_pencil_is_used(server, page):
    page.goto(server["base"] + "/#/draw")
    _ready(page)
    c = page.locator(".draw-stage canvas").bounding_box()
    hand = _Hand(page)
    count = lambda: page.evaluate("window.__draw.strokes.length")   # noqa: E731
    # The hand lands first: until the Pencil shows up it is just a finger, so it draws.
    hand.touch("touchStart", c["x"] + 400, c["y"] + 500)
    hand.touch("touchMove", c["x"] + 410, c["y"] + 505)
    assert count() == 1
    # The Pencil lands: the hand's mark goes, and its further movement draws nothing.
    assert _pixel(page, 405, 502)[3] > 0
    hand.pen("mousePressed", c["x"] + 100, c["y"] + 100)
    assert count() == 1 and page.evaluate("window.__draw.strokes[0].pts[0][0]") == pytest.approx(100, abs=1)
    assert _pixel(page, 405, 502)[3] == 0, "the hand's ink is still on the page"
    hand.touch("touchMove", c["x"] + 430, c["y"] + 520)
    for i in range(1, 15):
        hand.pen("mouseMoved", c["x"] + 100 + i * 10, c["y"] + 100)
    hand.pen("mouseReleased", c["x"] + 240, c["y"] + 100)
    hand.touch("touchEnd")
    assert count() == 1 and page.evaluate("window.__draw.strokes[0].pts.length") > 10
    # Between Pencil strokes a new touch is still the hand: no mark, and its tap on "new page" does nothing.
    hand.tap(c["x"] + 300, c["y"] + 400)
    hand.tap(*_centre(page, '[data-act="new"]'))
    page.wait_for_timeout(400)
    assert count() == 1
    # Once the Pencil has been put down, a finger draws and taps again.
    page.wait_for_timeout(1300)
    hand.tap(c["x"] + 300, c["y"] + 400)
    assert count() == 2
    hand.tap(*_centre(page, '[data-act="new"]'))
    page.wait_for_timeout(400)
    assert count() == 0


def test_pencil_tapping_a_crayon_also_lifts_the_hands_ink(server, page):
    page.goto(server["base"] + "/#/draw")
    _ready(page)
    c = page.locator(".draw-stage canvas").bounding_box()
    hand = _Hand(page)
    hand.touch("touchStart", c["x"] + 400, c["y"] + 500)
    hand.touch("touchMove", c["x"] + 410, c["y"] + 505)
    crayon = _centre(page, ".crayon:nth-child(3)")
    hand.pen("mousePressed", *crayon)
    hand.pen("mouseReleased", *crayon)
    assert page.locator(".crayon:nth-child(3)").get_attribute("aria-pressed") == "true"
    hand.touch("touchMove", c["x"] + 440, c["y"] + 530)
    hand.touch("touchEnd")
    assert page.evaluate("window.__draw.strokes.length") == 0
    assert _pixel(page, 405, 502)[3] == 0 and _pixel(page, 440, 530)[3] == 0


def test_a_resting_hand_does_not_open_the_parent_area(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    hand = _Hand(page)
    gear = _centre(page, ".parent-corner")
    hand.hover(gear[0] - 300, gear[1] - 300)            # the Pencil hovering nearby (on screen)
    hand.touch("touchStart", *gear)
    page.wait_for_timeout(3400)
    assert page.locator(".parent").count() == 0
    hand.touch("touchEnd")
    page.wait_for_timeout(1600)                          # the Pencil was put down: a finger hold works
    hand.touch("touchStart", *gear)
    try:
        page.wait_for_selector(".parent", timeout=6000)
    finally:
        hand.touch("touchEnd")


def test_trace_follows_the_pencil_not_a_hand_on_the_line(server, page):
    page.goto(server["base"] + "/")
    _ready(page)
    _open_trace(page)
    pts = page.evaluate("window.__trace.strokePts[0]")
    box = page.locator(".trace-stage canvas").bounding_box()
    at = lambda p: (box["x"] + p[0], box["y"] + p[1])                  # noqa: E731
    hand = _Hand(page)
    hand.touch("touchStart", *at(pts[len(pts) // 2]))                  # the hand rests on the line first
    assert page.evaluate("window.__trace.tracer.activePointer") is not None
    hand.pen("mousePressed", *at(pts[0]))
    assert page.evaluate("window.__trace.ink.size") == 1, "the hand's ink should be fading, not live"
    for p in pts[:: max(1, len(pts) // 40)] + [pts[-1]]:
        hand.pen("mouseMoved", *at(p))
        hand.touch("touchMove", *at(pts[len(pts) // 2]))
    hand.pen("mouseReleased", *at(pts[-1]))
    hand.touch("touchEnd")
    assert page.evaluate("window.__trace.tracer.coverage()[0].done"), "the Pencil's trace didn't complete"


@both_hosts
def test_every_item_opens_a_card_drawn_from_stroke_data(server, page):
    catalog = json.loads((REPO / "app/content/catalog.json").read_text())
    page.goto(server["base"] + "/")
    _ready(page)
    bad = []
    for item in catalog["items"]:
        page.evaluate(f"location.hash = '#/card/{item['id']}'")
        page.wait_for_function(f"document.querySelector('#app').dataset.screen === 'card'")
        ok = page.evaluate(
            "() => !!document.querySelector('.card-glyph svg.glyph-svg path') && "
            "!document.querySelector('.card-glyph .glyph-text')"
        )
        if not ok or (item.get("trace") and page.locator('[data-act="trace"]').count() != 1):
            bad.append(item["id"])
    assert not bad, f"cards missing their glyph or trace button: {bad}"


def _release_id(page):
    return page.evaluate("fetch('release.json').then(r => r.json()).then(j => j.id)")


def _mixed_css(server):
    """Publish the new worker and manifest, then simulate an edge still serving the old CSS."""
    source = server["app_dir"] / "app.css"
    old = source.read_bytes()
    source.write_bytes(old + b"\n/* next version */\n")
    release = build_site(server["out"], server["pack"], app_dir=server["app_dir"])
    (server["out"] / "app.css").write_bytes(old)
    return release["id"]


@static_host
def test_mixed_update_retains_old_release_then_switches_at_home(server, page):
    base = server["base"] + "/"
    page.goto(base)
    _ready(page)
    _controlled(page)
    page.goto(base + "index.html#/draw")
    _ready(page)
    old = _release_id(page)
    new = _mixed_css(server)
    # Subscribe before asking for the update so a quick failed install cannot be missed.
    page.evaluate("""async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker.addEventListener('statechange', () => { window.installState = worker.state; });
        }, {once: true});
        await reg.update();
    }""")
    page.wait_for_function("window.installState === 'redundant'")
    assert not page.evaluate("id => caches.has('toddler:/sub/:release-' + id)", new)
    page.context.set_offline(True)
    page.reload()
    _ready(page)
    assert _release_id(page) == old and page.locator(".draw-stage canvas").count() == 1

    shutil.copyfile(server["app_dir"] / "app.css", server["out"] / "app.css")
    page.context.set_offline(False)
    page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
    assert _wait_for_waiting_worker(page)
    assert _release_id(page) == old
    page.context.set_offline(True)
    page.locator('[data-act="home"]').click()
    page.wait_for_function("id => document.querySelector('.release-tag')?.textContent.startsWith(id)",
                           arg=new[:6])
    assert _release_id(page) == new


@static_host
def test_fresh_mixed_install_marks_only_verified_page(server, page):
    new = _mixed_css(server)
    page.add_init_script("""window.startedControlled = !!navigator.serviceWorker.controller;
        Object.defineProperty(navigator, 'standalone', {value: true});""")
    page.goto(server["base"] + "/")
    _ready(page)
    page.wait_for_function("""async () => (await import('./js/main.js')).swStatus().lastCheck === 'failed'""")
    assert not page.evaluate("!!navigator.serviceWorker.controller")
    assert "✓" not in page.locator(".release-tag").inner_text()
    # The complete release installs while the app is on Home: the page that wasn't loaded from the
    # worker reloads onto it at once (a parent waiting for the ✓ sees it), and only then shows ✓.
    page.evaluate("window.firstPage = true")
    shutil.copyfile(server["app_dir"] / "app.css", server["out"] / "app.css")
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    _controlled(page)
    page.wait_for_function("document.querySelector('.release-tag')?.textContent.includes('✓')")
    assert page.evaluate("!window.firstPage && window.startedControlled")
    assert _release_id(page) == new


@static_host
def test_home_reloads_when_claim_precedes_main(server, page):
    index = server["app_dir"] / "index.html"
    # Preserve the inline controller snapshot, then delay main's listener until after the claim.
    index.write_text(index.read_text().replace('<script type="module" src="js/main.js"></script>', """
        <script type="module">
          if (!window.pageController) {
            const sw = navigator.serviceWorker;
            const claim = new Promise(resolve => sw.addEventListener('controllerchange', resolve, {once: true}));
            await sw.register('sw.js');
            await claim;
            sessionStorage.setItem('claimedBeforeMain', 'yes');
          }
          await import('./js/main.js');
        </script>"""))
    build_site(server["out"], server["pack"], app_dir=server["app_dir"])
    page.add_init_script("Object.defineProperty(navigator, 'standalone', {value: true});")
    page.goto(server["base"] + "/")
    _controlled(page)
    assert page.evaluate("sessionStorage.getItem('claimedBeforeMain') === 'yes'")
    page.wait_for_function("document.querySelector('.release-tag')?.textContent.includes('✓')")


@static_host
def test_first_install_away_from_home_waits_for_home(server, page):
    """A first install that finishes during a lesson doesn't reload it; Home does, then shows ✓."""
    page.add_init_script("Object.defineProperty(navigator, 'standalone', {value: true});")
    server["allow_audio"].clear()
    try:
        page.goto(server["base"] + "/#/draw")
        _ready(page)
        assert page.evaluate("!navigator.serviceWorker.controller && !window.pageController")
        page.evaluate("""() => {
            window.firstPage = document;
            document.querySelector('[data-act="home"]').addEventListener('click', () => {
                sessionStorage.setItem('leftOriginalDrawing', 'yes');
            }, {capture: true, once: true});
        }""")
    finally:
        server["allow_audio"].set()
    page.wait_for_function("!!navigator.serviceWorker.controller", timeout=15000)
    page.wait_for_function("import('./js/main.js').then(m => m.swStatus().switching)")
    assert page.evaluate("window.firstPage === document")          # the drawing wasn't interrupted
    page.locator('[data-act="home"]').click()
    _controlled(page)
    assert page.evaluate("!window.firstPage && sessionStorage.getItem('leftOriginalDrawing') === 'yes'")
    page.wait_for_function("document.querySelector('.release-tag')?.textContent.includes('✓')")


@static_host
def test_sibling_scopes_survive_update_and_cold_relaunch(server):
    from playwright.sync_api import sync_playwright

    root = server["out"].parent
    origin = server["base"].rsplit("/", 1)[0]
    app, pack = server["app_dir"], server["pack"]
    old = build_site(root / "a", pack, app_dir=app)["id"]
    assert build_site(root / "b", pack, app_dir=app)["id"] == old
    profile = str(server["tmp"] / "siblings")
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(profile, viewport=LANDSCAPE)
        page = ctx.pages[0]
        for scope in ("a", "b"):
            page.goto(f"{origin}/{scope}/")
            _ready(page)
            _controlled(page)
        page.evaluate("caches.open('release-another-project').then(() => true)")
        page.goto(origin + "/a/#/draw")
        _ready(page)
        css = app / "app.css"
        css.write_bytes(css.read_bytes() + b"\n/* changed only in a */\n")
        new = build_site(root / "a", pack, app_dir=app)["id"]
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        assert _wait_for_waiting_worker(page)
        page.locator('[data-act="home"]').click()
        page.wait_for_function("id => document.querySelector('.release-tag')?.textContent.startsWith(id)",
                               arg=new[:6])
        names = page.evaluate("caches.keys()")
        assert set(names) == {f"toddler:/a/:release-{new}", f"toddler:/b/:release-{old}", "release-another-project"}
        ctx.close()

        ctx = p.chromium.launch_persistent_context(profile, viewport=LANDSCAPE, offline=True)
        page = ctx.pages[0]
        for scope, expected in (("a", new), ("b", old)):
            page.goto(f"{origin}/{scope}/index.html")
            _ready(page)
            assert _release_id(page) == expected
            assert page.locator(".home .tile").count() == 5
        ctx.close()
