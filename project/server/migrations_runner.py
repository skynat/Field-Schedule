"""
Versioned SQLite migrations.

Each file in migrations/ is a numbered, one-way SQL script (0001_*.sql,
0002_*.sql, ...). Applied migrations are recorded by filename (minus the
extension) in a schema_migrations table, so re-running is always safe —
anything already applied is skipped.

Once a migration has shipped (i.e. it might already be applied on someone's
database), don't edit it — add a new migration instead. Editing an already-
applied file silently does nothing on databases that already ran it, which
is a much worse bug than it sounds like.

CLI usage (see migrate.py for the actual entry point):
    python migrate.py            # apply anything pending
    python migrate.py --check    # exit 1 if anything is pending, apply nothing
"""

import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def _ensure_tracking_table(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


def _migration_files():
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def applied_versions(db_path):
    with sqlite3.connect(db_path) as db:
        _ensure_tracking_table(db)
        return {row[0] for row in db.execute("SELECT version FROM schema_migrations")}


def pending_migrations(db_path):
    applied = applied_versions(db_path)
    return [f.stem for f in _migration_files() if f.stem not in applied]


def run_migrations(db_path):
    """Applies any migration files not yet recorded as applied. Returns the
    list of versions that were newly applied (empty if already up to date)."""
    newly_applied = []
    with sqlite3.connect(db_path) as db:
        _ensure_tracking_table(db)
        applied = {row[0] for row in db.execute("SELECT version FROM schema_migrations")}
        for f in _migration_files():
            version = f.stem
            if version in applied:
                continue
            db.executescript(f.read_text())
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            newly_applied.append(version)
    return newly_applied
