import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path


def timestamp() -> str:
    return datetime.now().astimezone().isoformat()


@contextmanager
def connect(data_dir: Path):
    conn = sqlite3.connect(data_dir / "recordings.db", timeout=10)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        with conn:
            yield conn
    finally:
        conn.close()


def initialize(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    with connect(data_dir) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS takes (
                take_id TEXT PRIMARY KEY, clip_id TEXT NOT NULL, speaker TEXT NOT NULL,
                recorded_at TEXT NOT NULL, raw_path TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
                mime TEXT, ok INTEGER NOT NULL, error TEXT, duration REAL,
                processed_path TEXT, processed_sha256 TEXT, discarded INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS active (
                clip_id TEXT PRIMARY KEY, take_id TEXT NOT NULL REFERENCES takes(take_id),
                set_at TEXT NOT NULL
            );
        """)
        # Two server processes can open the same older database at startup.
        conn.execute("BEGIN IMMEDIATE")
        if "discarded" not in {row["name"] for row in conn.execute("PRAGMA table_info(takes)")}:
            conn.execute("ALTER TABLE takes ADD COLUMN discarded INTEGER NOT NULL DEFAULT 0")


def add_raw_take(data_dir: Path, take: dict) -> None:
    with connect(data_dir) as conn:
        conn.execute("""
            INSERT INTO takes (take_id, clip_id, speaker, recorded_at, raw_path, raw_sha256,
                               mime, ok, error)
            VALUES (:take_id, :clip_id, :speaker, :recorded_at, :raw_path, :raw_sha256, :mime,
                    0, 'Processing has not finished.')
        """, take)


def keep(data_dir: Path, clip_id: str, take_id: str) -> bool:
    with connect(data_dir) as conn:
        result = conn.execute("""
            INSERT INTO active (clip_id, take_id, set_at)
            SELECT clip_id, take_id, ? FROM takes WHERE clip_id=? AND take_id=? AND ok=1 AND discarded=0
            ON CONFLICT(clip_id) DO UPDATE SET take_id=excluded.take_id, set_at=excluded.set_at
        """, (timestamp(), clip_id, take_id))
        return result.rowcount == 1


def active_takes(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT t.* FROM active a JOIN takes t ON t.take_id=a.take_id")
    return {row["clip_id"]: row for row in rows}
