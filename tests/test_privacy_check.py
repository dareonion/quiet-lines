import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
MARKER = "synthetic-marker"
PUBLIC = "tester@users.noreply.github.com"


def git(repo, *args, **env):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                   env={**os.environ, **env})


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "Tester")
    git(tmp_path, "config", "user.email", PUBLIC)
    git(tmp_path, "config", "commit.gpgsign", "false")
    # Run only the checker inside this independent fixture; it has its own private regexes.
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    for name in ("privacy_check.sh", "privacy_check.py"):
        shutil.copy(SCRIPTS / name, scripts / name)
    (tmp_path / ".gitignore").write_text("/.privacy-patterns\n/scripts/\n/site/\n")
    (tmp_path / ".privacy-patterns").write_text(MARKER + "\n")
    return tmp_path


def check(repo, *args, ok):
    result = subprocess.run(["scripts/privacy_check.sh", *args], cwd=repo, capture_output=True, text=True)
    assert (result.returncode == 0) == ok, result
    return result.stdout + result.stderr


def test_hidden_files_staged_blobs_and_deleted_history(repo):
    path = repo / ".hidden"
    path.write_text("unrelated text\n" + MARKER)
    output = check(repo, ok=False)
    assert ".hidden:2" in output and MARKER not in output and "unrelated text" not in output
    git(repo, "add", ".")
    path.write_text("clean on disk")
    assert "index/.hidden:2" in check(repo, ok=False)
    git(repo, "commit", "-qm", "first")
    path.unlink()
    git(repo, "add", "-u")
    git(repo, "commit", "-qm", "remove")
    check(repo, ok=True)
    assert ".hidden:2" in check(repo, "HEAD", ok=False)


@pytest.mark.parametrize("name,value", [
    (MARKER + ".txt", "clean"), ("link", MARKER), ("data/item", "test"), ("sub/old-recordings.txt", "test"),
    ("notes/.env", "test"), ("audio/clip.mp3", "test"), ("clip.CAF", "test"),
    ("secret", "AZURE_SPEECH_KEY" + "=" + "1" * 16), ("secret", 'password: "' + "a1b2" * 8 + '"'),
    ("mail", "tester@" + "inbox.invalid"), ("mail", PUBLIC + ".invalid"),
])
def test_publish_paths_link_targets_and_secrets(repo, name, value):
    path = repo / name
    path.parent.mkdir(exist_ok=True)
    if name == "link":
        path.symlink_to(value)
    else:
        path.write_text(value)
    output = check(repo, ok=False)
    assert value not in output
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "fixture")
    check(repo, "HEAD", ok=False)


def test_public_email_exceptions_and_invalid_patterns(repo):
    (repo / "contacts").write_text("\n".join([PUBLIC, "a@example.org", "c@example.com",
                                             "b@example.net", "name@project.example"]))
    check(repo, ok=True)
    for invalid in ("", "# comment\n  \n", "[bad regex"):
        (repo / ".privacy-patterns").write_text(invalid)
        output = check(repo, ok=False)
        assert "bad regex" not in output


@pytest.mark.parametrize("message,env", [
    (MARKER, {}), ("message", {"GIT_AUTHOR_NAME": MARKER}), ("message", {"GIT_COMMITTER_NAME": MARKER}),
    ("message", {"GIT_AUTHOR_EMAIL": "person@example.com"}), ("message", {"GIT_COMMITTER_EMAIL": "person@example.org"}),
])
def test_history_checks_commit_metadata(repo, message, env):
    git(repo, "add", ".")
    git(repo, "commit", "-qm", message, **env)
    git(repo, "commit", "--allow-empty", "-qm", "clean tip")
    output = check(repo, "HEAD", ok=False)
    assert MARKER not in output and "person@" not in output


def test_approved_audio_uses_manifest_from_each_snapshot(repo):
    pack = repo / "voices" / "test"
    pack.mkdir(parents=True)
    path = pack / "word.en.m4a"
    _m4a(path)                     # a real clip: approved audio has its tags read
    approved = pack / "approved.json"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    approved.write_text(json.dumps({"word.en": digest}))
    source = pack / "source.json"
    source.write_text(json.dumps({"word.en": {"tier": "F0", "sha256": digest}}))
    check(repo, ok=False)          # approved but made on the free tier: never publishable
    source.write_text(json.dumps({"word.en": {"tier": "S0", "sha256": digest}}))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "approved")
    site = repo / "site"
    (site / "audio/test").mkdir(parents=True)
    shipped = site / "audio/test" / path.name
    shutil.copyfile(path, shipped)
    check(repo, "HEAD", "site", ok=True)
    approved.write_text("{}")
    check(repo, ok=False)
    check(repo, "HEAD", "site", ok=True)
    shipped.write_bytes(b"changed")
    check(repo, "HEAD", "site", ok=False)
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "withdrawn")
    check(repo, "HEAD", ok=False)



def _m4a(path, *metadata):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
                    *metadata, "-c:a", "aac", str(path)], check=True)


def _with_free_box(path, payload: bytes):
    """Bytes inside the file that are no metadata tag, as a chance match in the audio would be."""
    path.write_bytes(path.read_bytes() + (8 + len(payload)).to_bytes(4, "big") + b"free" + payload)


def _approve(pack, path):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    clip = path.name.removesuffix(".m4a")
    (pack / "source.json").write_text(json.dumps({clip: {"tier": "S0", "sha256": digest}}))
    (pack / "approved.json").write_text(json.dumps({clip: digest}))


def test_approved_audio_scans_its_tags_not_its_raw_bytes(repo):
    pack = repo / "voices" / "test"
    pack.mkdir(parents=True)
    path = pack / "word.en.m4a"
    _m4a(path)
    _with_free_box(path, b"\n" + MARKER.encode())
    data = path.read_bytes()
    line = data[:data.index(MARKER.encode())].count(b"\n") + 1
    assert line > 1
    out = check(repo, ok=False)                       # unapproved: fails as audio AND as a pattern match
    assert "word.en.m4a:1" in out and f"word.en.m4a:{line}" in out
    _approve(pack, path)
    check(repo, ok=True)                              # approved: the raw bytes aren't text-scanned
    _m4a(path, "-metadata", f"comment={MARKER}")
    _approve(pack, path)
    check(repo, ok=False)                             # ...but its tags are


def test_history_scans_text_whose_bytes_also_appear_as_an_approved_clip(repo):
    pack = repo / "voices" / "test"
    pack.mkdir(parents=True)
    path = pack / "word.en.m4a"
    _m4a(path)
    _with_free_box(path, b"\n" + MARKER.encode())
    notes = repo / "notes.txt"
    notes.write_bytes(path.read_bytes())
    path.unlink()
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "notes")
    notes.rename(path)
    _approve(pack, path)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "clip")
    check(repo, ok=True)                              # the worktree holds only the approved clip
    check(repo, "HEAD", ok=False)                     # history still has the same bytes as text


def test_approved_audio_tags_are_scanned_decoded(repo):
    pack = repo / "voices" / "test"
    pack.mkdir(parents=True)
    path = pack / "word.en.m4a"
    _m4a(path, "-metadata", 'comment=password="' + "a1" * 16 + '"')
    _approve(pack, path)
    check(repo, ok=False)


def test_an_approved_m4a_with_a_subtitle_stream_is_not_audio(repo, tmp_path):
    pack = repo / "voices" / "test"
    pack.mkdir(parents=True)
    subs = tmp_path / "subs.srt"
    subs.write_text(f"1\n00:00:00,000 --> 00:00:00,200\n{MARKER}\n")
    path = pack / "word.en.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
                    "-i", str(subs), "-c:a", "aac", "-c:s", "mov_text", "-f", "mp4", str(path)], check=True)
    _approve(pack, path)
    out = check(repo, ok=False)
    assert "word.en.m4a:1" in out


def test_history_validates_a_clip_whose_bytes_were_scanned_as_text(repo):
    pack = repo / "voices" / "test"
    pack.mkdir(parents=True)
    path = pack / "word.en.m4a"
    path.write_bytes(b"plain words, no audio\n")
    _approve(pack, path)
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "not a clip")
    path.rename(repo / "notes.txt")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "now text")
    check(repo, ok=True)
    check(repo, "HEAD", ok=False)
