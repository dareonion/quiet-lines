import os
import shutil
import subprocess
from pathlib import Path

from toddler_ipad import db

ROOT = Path(__file__).resolve().parents[1]


def test_snapshots_and_rollback(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    for name in ("scripts", "src"):
        shutil.copytree(ROOT / name, repo / name)
    shutil.copy(ROOT / ".gitignore", repo)
    app = repo / "app"
    (app / "content").mkdir(parents=True)
    (app / "content/catalog.json").write_text('{"clips":{}}')
    (repo / "PRIVATE.md").write_text("private")
    db.initialize(repo / "data")
    (repo / "data/keep").touch()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    systemctl = bin_dir / "systemctl"
    systemctl.write_text("""#!/bin/sh
set -eu
test "$*" = "--user restart toddler-ipad"
cd live/current
PYTHONPATH=src python3 -c '
import json
from pathlib import Path
from toddler_ipad.release import build_release
print(json.dumps(build_release(Path("app"), {})))
' > ../../data/served-release.json
""")
    curl = bin_dir / "curl"
    curl.write_text('#!/bin/sh\ncat data/served-release.json\n')
    systemctl.chmod(0o755)
    curl.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "SYSTEMCTL": str(systemctl),
           "TODDLER_DATA_DIR": str(repo / "data")}

    def run(script, *args, check=True):
        return subprocess.run([f"scripts/{script}.sh", *args], cwd=repo, env=env,
                              check=check, capture_output=True, text=True)

    current = repo / "live/current"
    previous = repo / "live/previous"
    snapshots = []
    for version in ("one", "two", "three"):
        (app / "index.html").write_text(version)
        run("deploy", "--no-test")
        snapshots.append(current.resolve())
        assert (current / "app/index.html").read_text() == version
        assert (current / "src/toddler_ipad/sw_template.js").is_file()
        assert all(not (current / key).exists() for key in ("data", "live", "PRIVATE.md", ".git"))
    # Roll back the whole tree. The previous link allows the other direction as well.
    run("rollback")
    assert current.resolve() == snapshots[1] and previous.resolve() == snapshots[2]
    run("rollback")
    assert current.resolve() == snapshots[2] and previous.resolve() == snapshots[1]
    (app / "index.html").write_text("four")
    run("deploy", "--no-test")
    assert previous.resolve() == snapshots[2]
    assert not snapshots[0].exists() and all(p.is_dir() for p in snapshots[1:])
    # A repeatedly selected baseline can age out of the newest three and still be needed.
    for version in ("five", "six"):
        run("rollback")
        assert current.resolve() == snapshots[2]
        (app / "index.html").write_text(version)
        run("deploy", "--no-test")
    assert previous.resolve() == snapshots[2] and previous.is_dir()
    assert len([p for p in current.parent.iterdir() if p.is_dir() and not p.is_symlink()]) == 4
    assert (repo / "data/keep").exists()
    # A syntactically valid stale release from the wrong process fails the health check.
    curl.write_text('#!/bin/sh\necho \'{"id":"0000000000000000"}\'\n')
    result = run("rollback", check=False)
    assert result.returncode and "Wrong release from service" in result.stderr
