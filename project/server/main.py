"""
Field Schedule — multi-calendar entry point.

This is the new "main index.html" for a deployment that wants many
independent calendars organized in a folder tree, instead of app.py's one
schedule. Run it the same way you'd run app.py:

    pip install -r requirements.txt
    python main.py
    # -> serves the folder-tree nav UI at http://localhost:5000/

Environment variables:
    CATALOG_DB_PATH        where the tree itself lives (default:
                            server/catalog.db). One small SQLite file
                            unless CATALOG_DATABASE_URL is set — see
                            catalog_db.py.
    SCHEDULE_CALENDARS_DIR  directory holding one .db file per calendar
                            (default: server/calendars/). Created on
                            first run if missing.
    SCHEDULE_DEV_CORS       same meaning as in app.py, applied to every
                            per-calendar sub-app.

How a click on a calendar becomes a SQLite file
------------------------------------------------
Creating a calendar (POST /api/tree/<folder>/calendars) only ever writes
a row to the catalog — name, id, and the filename it WILL use. The
SQLite file itself is created lazily, the first time anyone actually
navigates to /cal/<calendar_id>/ (see _get_calendar_app below), by
calling calendar_app.init_db() — the exact same migrations + starter-data
seeding app.py already uses for the single-schedule case. That keeps
"planning out a folder structure" (which can involve creating and
deleting calendar entries speculatively) from littering disk with empty
database files, while still guaranteeing that by the time the calendar
app's own frontend makes its first /api/users call, the file, schema, and
seed data are all already in place — there's no separate "is it ready
yet?" round trip for the frontend to make.

Why per-calendar locks never interact
--------------------------------------
Each calendar_id gets its own calendar_app.create_app() instance — a
fully independent Flask app closed over that one calendar's db_path, with
its own get_db()/g the same as if it were the only schedule.py running.
There is no shared connection, connection pool, or global lock between
calendars: a write to Calendar A's SQLite file cannot block a read or
write against Calendar B's file, because nothing here ever opens a
connection to A that any request for B could see or wait on. WAL mode
(set inside calendar_app.py's get_db()) further reduces blocking *within*
one busy calendar.
"""

import os
from collections import OrderedDict
from pathlib import Path

from flask import Flask, abort, request, send_from_directory
from werkzeug.wrappers import Response as WerkzeugResponse

from calendar_app import create_app as create_calendar_app, init_db as init_calendar_db
from catalog_db import get_catalog_db
from catalog_routes import catalog_bp

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
NAV_DIR = PROJECT_DIR / "nav"

CATALOG_DB_PATH = os.environ.get("CATALOG_DB_PATH", str(BASE_DIR / "catalog.db"))
CALENDARS_DIR = Path(os.environ.get("SCHEDULE_CALENDARS_DIR", str(BASE_DIR / "calendars")))
CALENDARS_DIR.mkdir(parents=True, exist_ok=True)
DEV_CORS = os.environ.get("SCHEDULE_DEV_CORS") == "1"

app = Flask(__name__)
app.config["CATALOG_DB_PATH"] = CATALOG_DB_PATH
app.config["CALENDARS_DIR"] = str(CALENDARS_DIR)
app.register_blueprint(catalog_bp, url_prefix="/api/tree")

# Warm the catalog database (applies its migrations, creates the root
# folder row) at import time, the same way app.py brings schedule.db up
# to date — so `python main.py` works from a totally clean checkout with
# no separate setup step.
get_catalog_db(CATALOG_DB_PATH).close()


# ---------------------------------------------------------- nav frontend --
# The folder-tree navigator. Deliberately plain HTML/JS (no build step,
# no vendored React needed just to render a tree of folders) — see
# nav/index.html. It's the new site root, replacing the calendar app's
# index.html in that role; the calendar app's own index.html/app.js/vendor
# are untouched and still get served, just from /cal/<id>/ instead of /.
@app.route("/")
@app.route("/t/<path:subpath>")
def nav_index(subpath=None):
    return send_from_directory(NAV_DIR, "index.html")


@app.route("/nav.js")
def nav_js():
    return send_from_directory(NAV_DIR, "nav.js")


# ------------------------------------------------- per-calendar dispatch --
# A small bounded cache of already-built calendar sub-apps, keyed by
# calendar_id. Each entry is a full Flask app instance (see module
# docstring for why that's what gives us per-calendar lock isolation).
# Bounded with a simple LRU so a deployment with thousands of calendars
# doesn't accumulate an unbounded number of open Flask apps / SQLite file
# handles in memory over the server's lifetime — least-recently-used
# calendars are evicted; closing a calendar_app doesn't affect its
# on-disk SQLite file, only this process's cached handle to it, so
# eviction is entirely transparent to the user (the next visit just pays
# one extra "open the file" cost, same as a cold start).
_MAX_CACHED_CALENDAR_APPS = 128
_calendar_apps: "OrderedDict[str, object]" = OrderedDict()


def _get_calendar_app(calendar_id):
    if calendar_id in _calendar_apps:
        _calendar_apps.move_to_end(calendar_id)
        return _calendar_apps[calendar_id]

    db = get_catalog_db(app.config["CATALOG_DB_PATH"])
    try:
        node = db.get_node(calendar_id)
    finally:
        db.close()
    if node is None or node["kind"] != "calendar":
        return None

    db_path = CALENDARS_DIR / node["db_filename"]
    if not db_path.exists():
        # First open of this calendar — create + migrate + seed now,
        # exactly like a fresh `python app.py` would for a single schedule.
        init_calendar_db(str(db_path))

    cal_app = create_calendar_app(str(db_path), static_folder=PROJECT_DIR, static_url_path="", dev_cors=DEV_CORS)
    _calendar_apps[calendar_id] = cal_app
    if len(_calendar_apps) > _MAX_CACHED_CALENDAR_APPS:
        _calendar_apps.popitem(last=False)  # evict least-recently-used
    return cal_app


@app.route("/cal/<calendar_id>/", defaults={"subpath": ""})
@app.route("/cal/<calendar_id>/<path:subpath>", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def dispatch_calendar(calendar_id, subpath):
    cal_app = _get_calendar_app(calendar_id)
    if cal_app is None:
        abort(404)

    # Re-root the incoming request onto the sub-app's own routing: same
    # trick werkzeug's DispatcherMiddleware uses, done per-request instead
    # of at startup, since which calendar_ids exist isn't known ahead of
    # time. The calendar app's frontend never has to know any of this —
    # it derives its own API base URL from wherever its <script> tag
    # actually loaded from (see app.jsx's APP_BASE), so mounting the exact
    # same, unmodified static files at /cal/<id>/ instead of / is
    # sufficient on its own for every relative fetch() call to land here.
    environ = request.environ.copy()
    environ["SCRIPT_NAME"] = environ.get("SCRIPT_NAME", "") + f"/cal/{calendar_id}"
    environ["PATH_INFO"] = "/" + subpath
    return WerkzeugResponse.from_app(cal_app, environ)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
