"""Pre-publication checks for Git snapshots, working files and an optional Pages artifact."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

AUDIO = {".m4a", ".wav", ".mp3", ".ogg", ".webm", ".aac", ".flac", ".caf", ".bin"}   # .bin: a raw recorder take
PACK = re.compile(r"voices/([a-z0-9][a-z0-9._-]*)/([a-z0-9][a-z0-9._-]{0,63})\.m4a")
NOREPLY = re.compile(rb"[^@\s]+@users\.noreply\.github\.com", re.I)
# Check the whole domain, including any further labels after an apparent public suffix.
LABEL = r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
PUBLIC_DOMAIN = rf"(?:users\.noreply\.github\.com|example\.(?:com|org|net)|(?:{LABEL}\.)+example)"
# One public address, only in its commit-trailer form "Co-Authored-By: Claude <noreply@anthropic.com>":
# right after "<", exact case, closed by ">". The lookbehind makes a match start where the address
# starts, so the exception can't be dodged by starting later (a leftmost match always starts there).
PUBLIC_ADDRESS = r"(?<=<)(?-i:noreply@anthropic\.com>)"
EMAIL = (rf"(?<![a-z0-9_.%+'-])(?!{PUBLIC_ADDRESS})[a-z0-9_.%+'-]+@(?!{PUBLIC_DOMAIN}(?![a-z0-9-]|\.[a-z0-9-]))"
         rf"(?:{LABEL}\.)+[a-z]{{2,}}\b")
CREDENTIALS = [
    r"AKIA[0-9A-Z]{16}", r"-----BEGIN [A-Z ]*PRIVATE KEY", r"gh[pousr]_[a-z0-9]{30,}",
    r"sk-[a-z0-9]{20,}", r"AZURE_SPEECH_KEY\s*[=:]\s*\S{16,}",
    r"""(?:key|token|secret|password)["']?\s*[=:]\s*["']?[a-z0-9+/=_-]{24,}""", EMAIL,
]


class CheckError(Exception):
    """A diagnostic safe to display without revealing scanned data."""


def git(*args):
    return subprocess.check_output(["git", "--no-replace-objects", *args], stderr=subprocess.DEVNULL)


@dataclass(frozen=True)
class Entry:
    link: bool
    blob: str | None = None   # None reads the work tree or built file directly


def git_entries(commit=None):
    raw = git("ls-tree", "-rz", commit) if commit else git("ls-files", "--stage", "-z")
    entries = {}
    for row in raw.split(b"\0")[:-1]:
        meta, name = row.split(b"\t", 1)
        mode, middle, last = meta.split()
        if mode not in (b"100644", b"100755", b"120000") or (not commit and last != b"0"):
            raise ValueError("Unsupported Git entry or unresolved index")
        entries[Path(os.fsdecode(name))] = Entry(mode == b"120000", (last if commit else middle).decode())
    return entries


def disk_entries(root, paths):
    entries = {}
    for path in paths:
        full = root / path
        if any((root / part).is_symlink() for part in path.parents):
            raise ValueError("Symlink ancestor in publish set")
        try:
            mode = full.lstat().st_mode
        except FileNotFoundError:
            continue  # a tracked file deleted on disk still gets scanned in the index
        if stat.S_ISDIR(mode):
            continue
        if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
            raise ValueError("Unexpected file type")
        entries[path] = Entry(stat.S_ISLNK(mode))
    return entries


def site_paths(root) -> Iterator[Path]:
    def raise_error(error):
        raise error

    for base, dirs, files in os.walk(root, onerror=raise_error):
        for name in [*dirs, *files]:
            yield (Path(base) / name).relative_to(root)


def contents(root, path, entry):
    if entry.blob:
        return git("cat-file", "blob", entry.blob)
    full = root / path
    return os.fsencode(os.readlink(full)) if entry.link else full.read_bytes()


def forbidden(path):
    name = path.name.lower()
    return ("data" in (part.lower() for part in path.parts[:-1])
            or "recordings" in path.as_posix().lower()
            or name in {"private.md", ".privacy-patterns", ".env"}
            or name.endswith((".db", "-wal", ".env")) or ".sqlite" in name or name.startswith(".env."))


def scan_files(directory, patterns):
    # -a includes binary blobs. Omit rg diagnostics: malformed private regexes can appear in them.
    flags = ["rg", "--no-config", "-uu", "-a", "-i", "-n", "-H", "--no-heading", "--color=never",
             "--only-matching", "--replace", ""]
    hits = set()
    credential_args = ["--pcre2"]
    for pattern in CREDENTIALS:
        credential_args.extend(("-e", pattern))
    for args in (["-f", str(patterns)], credential_args):
        scan = subprocess.run([*flags, *args, "."], cwd=directory, capture_output=True)
        if scan.returncode == 1:
            continue
        if scan.returncode != 0:
            raise CheckError("ripgrep could not complete the scan")
        if not scan.stdout:
            raise ValueError("Match without a reportable location")
        for hit in scan.stdout.splitlines():
            file, line, _ = hit.rsplit(b":", 2)
            hits.add((Path(os.fsdecode(file)).name, int(line)))
    return hits


def audio_tags(data: bytes, work: Path) -> bytes | None:
    """An approved clip's metadata as plain text (container, stream and chapter tags), or None unless
    it is a readable MP4/M4A holding audio streams only (a subtitle or data stream could carry text)."""
    with TemporaryDirectory(dir=work) as directory:   # beside the scanned stage, never inside it
        clip = Path(directory) / "clip"
        clip.write_bytes(data)
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries",
                 "format=format_name:format_tags:stream=codec_type:stream_tags:chapter_tags", "-of", "json", str(clip)],
                capture_output=True)
        except FileNotFoundError:
            raise CheckError("ffprobe (from ffmpeg) is needed to check approved audio") from None
    if probe.returncode != 0:
        return None
    try:
        info = json.loads(probe.stdout)
    except ValueError:
        return None
    fmt, streams = info.get("format") or {}, info.get("streams") or []
    if ("mp4" not in str(fmt.get("format_name", "")).split(",")
            or not streams or any(stream.get("codec_type") != "audio" for stream in streams)):
        return None
    # Decoded values: in ffprobe's JSON, escaped quotes would hide credential patterns.
    lines = [f"{key}={value}" for part in [fmt, *streams, *(info.get("chapters") or [])]
             for key, value in (part.get("tags") or {}).items()]
    return ("\n".join(lines) + "\n").encode()


def approved_audio(path, digest, entries, manifests, built_site):
    if built_site:
        if path.parts[0] != "audio":
            return False
        path = Path("voices", *path.parts[1:])
    match = PACK.fullmatch(path.as_posix())
    if not match:
        return False
    # Approved AND made on the paid tier: free-tier files may be heard, never published.
    for name in ("approved.json", "source.json"):
        manifest = path.with_name(name)
        if manifest not in manifests:
            record = entries.get(manifest)
            if not record or record.link:
                return False
            manifests[manifest] = json.loads(contents(Path("."), manifest, record))
    source = manifests[path.with_name("source.json")].get(match[2])
    return (manifests[path.with_name("approved.json")].get(match[2]) == digest
            and isinstance(source, dict) and source.get("tier") == "S0" and source.get("sha256") == digest)


def scan_snapshot(work, patterns, scope, entries, *, root=Path("."), metadata=None,
                  approvals_from=None, scanned=None):
    # Numbered regular files keep Git paths and symlinks inert. Symlink blob contents are targets.
    labels = {}
    manifests = {}
    hits = set()
    path_lines = []
    sources = entries if approvals_from is None else approvals_from
    with TemporaryDirectory(dir=work) as directory:
        stage = Path(directory)
        with (stage / "paths").open("wb") as listing:
            for index, (path, entry) in enumerate(entries.items()):
                number = str(index)
                encoded = os.fsencode(path)
                listing.write(encoded + b"\n")
                path_lines.extend([number] * (encoded.count(b"\n") + 1))
                labels[number] = str(path).encode("unicode_escape").decode("ascii")
                audio = path.suffix.lower() in AUDIO
                # scanned: blob -> (digest, what was text-scanned: 0 nothing, 1 its tags, 2 its raw bytes,
                # its tags as text if it was probed as a clip, or False if it isn't a readable audio clip)
                digest, level, tags = (scanned.get(entry.blob, (None, 0, None)) if scanned is not None
                                       else (None, 0, None))
                data = None
                if digest is None:
                    data = contents(root, path, entry)
                    digest = hashlib.sha256(data).hexdigest()
                cleared = audio and not entry.link and approved_audio(
                    path, digest, sources, manifests, approvals_from is not None)
                # Approved paid-tier audio is speech a person heard, pinned by hash. Its compressed frames
                # aren't text, and short private patterns turn up in them by chance (2 of 336 clips,
                # 2026-11-23), so only its metadata tags, which listening can't reveal, are scanned. A clip
                # that isn't readable audio-only MP4 counts as unapproved.
                if cleared and tags is None:
                    if data is None:
                        data = contents(root, path, entry)
                    tags = audio_tags(data, work) or False
                if cleared and tags is False:
                    cleared = False
                if level < (1 if cleared else 2):
                    if cleared:
                        (stage / number).write_bytes(tags)
                        level = 1
                    else:
                        if data is None:
                            data = contents(root, path, entry)
                        (stage / number).write_bytes(data)
                        level = 2
                if scanned is not None:
                    scanned[entry.blob] = (digest, level, tags)
                if forbidden(path) or (audio and not cleared):
                    hits.add((number, 1))
        if metadata is not None:
            (stage / "metadata").write_bytes(metadata)
        hits.update(scan_files(stage, patterns))

    # A filename can itself contain a credential. In that case report its location in the path list.
    sensitive_paths = {path_lines[line - 1] for file, line in hits if file == "paths"}
    labels.update(paths="published-paths", metadata="commit-metadata")
    for file, line in sorted(hits):
        if file not in sensitive_paths:
            print(f"{scope}/{labels[file]}:{line}")
    return not hits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision", nargs="?")
    parser.add_argument("site", nargs="?", type=Path)
    args = parser.parse_args()
    clean = True
    with TemporaryDirectory() as work:   # mode 0700, pattern file outside every scanned directory
        patterns = Path(work) / "patterns"
        lines = [line for line in Path(".privacy-patterns").read_bytes().splitlines()
                 if line.strip() and not line.lstrip().startswith(b"#")]
        if not lines:
            raise CheckError("private pattern list is empty")
        patterns.write_bytes(b"\n".join(lines) + b"\n")
        if args.revision:
            tip = git("rev-parse", "--verify", "--end-of-options", args.revision + "^{commit}").strip().decode()
            if git("rev-parse", "--is-shallow-repository").strip() == b"true":
                raise CheckError("complete history is required for a revision check")
            scanned = {}
            for oid in git("rev-list", tip).decode().splitlines():
                meta = git("show", "-s", "--no-show-signature", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", oid)
                author, email, committer, cemail, message = meta.split(b"\0", 4)
                if not all(NOREPLY.fullmatch(value) for value in (email, cemail)):
                    print(f"{oid}/commit-identities:1")
                    clean = False
                entries = git_entries(oid)
                if oid == tip:
                    approvals = entries
                clean &= scan_snapshot(work, patterns, oid, entries, scanned=scanned,
                                       metadata=b"\n".join((author, email, committer, cemail, message)))
        else:
            clean &= scan_snapshot(work, patterns, "index", git_entries())
            paths = git("ls-files", "-co", "--exclude-standard", "-z").split(b"\0")[:-1]
            approvals = disk_entries(Path("."), (Path(os.fsdecode(p)) for p in paths))
            clean &= scan_snapshot(work, patterns, "worktree", approvals)
        if args.site:
            if not args.site.is_dir() or args.site.is_symlink():
                raise ValueError("Expected a built site directory")
            clean &= scan_snapshot(work, patterns, "site", disk_entries(args.site, site_paths(args.site)),
                                   root=args.site, approvals_from=approvals)
    return clean


if __name__ == "__main__":
    try:
        ok = main()
    except CheckError as exc:
        sys.exit(f"privacy check FAILED ({exc})")
    except (ValueError, OSError, AttributeError, subprocess.SubprocessError):
        # Parsing and tool errors can include private inputs. Fail closed without echoing them.
        sys.exit("privacy check FAILED (missing input, invalid configuration or scan error)")
    print("privacy check passed" if ok else "privacy check FAILED")
    sys.exit(0 if ok else 1)
