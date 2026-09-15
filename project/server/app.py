"""
Field Schedule — standalone backend entry point (single schedule).

Run for local testing:
    pip install -r requirements.txt
    python app.py
    # -> serves the frontend AND the API on http://localhost:5000

This is NOT the same as `python -m http.server` in the project root.
http.server only serves static files (index.html/app.js/vendor) — fine for
trying out the UI, but nothing you do will be saved. This app.py is the
one that actually writes to SQLite.

As of the multi-calendar feature, the actual Flask app/routes live in
calendar_app.py as create_app(db_path) — a reusable factory. This file is
now just: build one app instance from SCHEDULE_DB_PATH, the same way it
always has, for people who just want one schedule with no folder tree.
If you want multiple independent calendars organized in a folder-style
tree instead, run server/main.py — see ../README.md ("Multiple
calendars").

See ../README.md for production hosting notes (gunicorn, nginx, SAML, etc).
"""

import os
import sqlite3
from pathlib import Path

from calendar_app import create_app, init_db, seed_if_empty
from migrations_runner import run_migrations

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DB_PATH = os.environ.get("SCHEDULE_DB_PATH", str(BASE_DIR / "schedule.db"))

app = create_app(
    DB_PATH,
    static_folder=PROJECT_DIR,
    static_url_path="",
    dev_cors=os.environ.get("SCHEDULE_DEV_CORS") == "1",
)


if __name__ == "__main__":
    # Dev convenience: `python app.py` always brings the database fully up
    # to date (creating it from nothing if needed) before serving. This
    # block does NOT run when gunicorn imports this file as `app:app` —
    # that's intentional. See README.md ("Database migrations") for why
    # production deploys should run `python migrate.py` explicitly instead
    # of relying on migrations firing implicitly on every worker boot.
    applied = run_migrations(DB_PATH)
    if applied:
        print(f"Applied {len(applied)} migration(s): {', '.join(applied)}")
    with sqlite3.connect(DB_PATH) as db:
        db.row_factory = sqlite3.Row
        seed_if_empty(db)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
