#!/usr/bin/env python3
"""
Apply (or check for) pending database migrations.

    python migrate.py            apply any pending migrations
    python migrate.py --check    exit 1 if migrations are pending; applies nothing

Run this as an explicit deploy step in production — see README.md
("Database migrations") for why app.py doesn't auto-apply migrations when
run under gunicorn.
"""
import os
import sys
from pathlib import Path

from migrations_runner import run_migrations, pending_migrations

DB_PATH = os.environ.get("SCHEDULE_DB_PATH", str(Path(__file__).resolve().parent / "schedule.db"))

if __name__ == "__main__":
    if "--check" in sys.argv:
        pending = pending_migrations(DB_PATH)
        if pending:
            print(f"{len(pending)} pending migration(s): {', '.join(pending)}")
            sys.exit(1)
        print("Database is up to date.")
        sys.exit(0)

    applied = run_migrations(DB_PATH)
    if applied:
        print(f"Applied {len(applied)} migration(s): {', '.join(applied)}")
    else:
        print("No pending migrations — database already up to date.")
