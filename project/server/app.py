"""
Field Schedule — backend API.

A small Flask + SQLite service that persists what the React frontend
currently keeps in memory: users, locations, work types, required
approvers, and the schedule blocks ("events") themselves.

Run for local testing:
    pip install -r requirements.txt
    python app.py
    # -> serves the frontend AND the API on http://localhost:5000

This is NOT the same as `python -m http.server` in the project root.
http.server only serves static files (index.html/app.js/vendor) — fine for
trying out the UI, but nothing you do will be saved. This app.py is the
one that actually writes to SQLite.

See ../README.md for production hosting notes (gunicorn, nginx, SAML, etc).
"""

import json
import os
import re
import sqlite3
import uuid
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DB_PATH = os.environ.get("SCHEDULE_DB_PATH", str(BASE_DIR / "schedule.db"))
SCHEMA_PATH = BASE_DIR / "schema.sql"

app = Flask(__name__, static_folder=str(PROJECT_DIR), static_url_path="")

# Dev convenience only: if you run the frontend from a *different* origin
# than this API (e.g. `python -m http.server` on :8000 while this runs on
# :5000), the browser needs CORS headers to allow the fetch() calls through.
# Turn this on with SCHEDULE_DEV_CORS=1. Leave it off (the default) whenever
# the frontend is served by this same Flask app (the normal/production
# setup) — you don't need or want open CORS then.
if os.environ.get("SCHEDULE_DEV_CORS") == "1":
    @app.after_request
    def add_dev_cors_headers(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp


# ---------------------------------------------------------------- database --
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.row_factory = sqlite3.Row
        db.executescript(SCHEMA_PATH.read_text())
        db.commit()
        seed_if_empty(db)


def seed_if_empty(db):
    """First-run only: give a fresh database the same starter data the
    frontend used to ship with as in-memory seeds, so a clean checkout
    doesn't open to an empty, user-less calendar. Safe to call repeatedly —
    each table is only seeded if it's still empty."""
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        seed_users = [
            ("jmartinez", "J. Martinez", 1, 0),
            ("asmith", "A. Smith", 1, 0),
            ("rt.chen", "R. Chen", 1, 1),
            ("dford", "D. Ford", 0, 1),
            ("kpatel", "K. Patel", 1, 0),
        ]
        for login, alias, is_worker, is_approver in seed_users:
            db.execute("INSERT INTO users (id, login, alias, is_worker, is_approver) VALUES (?, ?, ?, ?, ?)",
                       (new_id("u"), login, alias, is_worker, is_approver))

    if db.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == 0:
        for name in ["North Yard", "Warehouse 3", "Site B - Riverside", "HQ Loading Dock"]:
            db.execute("INSERT INTO locations (id, name) VALUES (?, ?)", (new_id("l"), name))

    if db.execute("SELECT COUNT(*) FROM work_types").fetchone()[0] == 0:
        for name in ["Install", "Maintenance", "Inspection", "Cleanup"]:
            db.execute("INSERT INTO work_types (id, name) VALUES (?, ?)", (new_id("t"), name))

    row = db.execute("SELECT names FROM required_approvers WHERE id = 1").fetchone()
    if row and json.loads(row["names"]) == []:
        db.execute("UPDATE required_approvers SET names = ? WHERE id = 1", (json.dumps(["R. Chen", "D. Ford"]),))

    db.commit()


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


# -------------------------------------------------------------- validation --
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def bad_request(msg):
    return jsonify({"error": msg}), 400


# ------------------------------------------------------------------ static --
@app.route("/")
def index():
    return send_from_directory(PROJECT_DIR, "index.html")


# ------------------------------------------------------------------- users --
@app.get("/api/users")
def list_users():
    rows = get_db().execute("SELECT * FROM users ORDER BY alias").fetchall()
    return jsonify([
        {
            "id": r["id"], "login": r["login"], "alias": r["alias"],
            "isWorker": bool(r["is_worker"]), "isApprover": bool(r["is_approver"]),
        }
        for r in rows
    ])


@app.post("/api/users")
def create_user():
    body = request.get_json(force=True, silent=True) or {}
    login = (body.get("login") or "").strip()
    alias = (body.get("alias") or login).strip()
    if not login:
        return bad_request("login is required")
    uid = new_id("u")
    db = get_db()
    try:
        db.execute(
            "INSERT INTO users (id, login, alias, is_worker, is_approver) VALUES (?, ?, ?, ?, ?)",
            (uid, login, alias, int(bool(body.get("isWorker", True))), int(bool(body.get("isApprover", False)))),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return bad_request(f'login "{login}" already exists')
    return jsonify({"id": uid, "login": login, "alias": alias,
                     "isWorker": bool(body.get("isWorker", True)),
                     "isApprover": bool(body.get("isApprover", False))}), 201


@app.put("/api/users/<uid>")
def update_user(uid):
    body = request.get_json(force=True, silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    alias = body.get("alias", row["alias"])
    is_worker = int(bool(body.get("isWorker", row["is_worker"])))
    is_approver = int(bool(body.get("isApprover", row["is_approver"])))
    db.execute("UPDATE users SET alias=?, is_worker=?, is_approver=? WHERE id=?",
               (alias, is_worker, is_approver, uid))
    db.commit()
    return jsonify({"id": uid, "login": row["login"], "alias": alias,
                     "isWorker": bool(is_worker), "isApprover": bool(is_approver)})


@app.delete("/api/users/<uid>")
def delete_user(uid):
    db = get_db()
    db.execute("DELETE FROM users WHERE id = ?", (uid,))
    db.commit()
    return "", 204


@app.post("/api/users/bulk")
def bulk_users():
    """Body: {"names": ["J. Doe", "A. Smith", ...]} — mirrors the UI's bulk-add box.
    Login is auto-generated from the name (lowercased, non-alphanumerics -> '.')."""
    body = request.get_json(force=True, silent=True) or {}
    names = body.get("names") or []
    db = get_db()
    created = []
    for name in names:
        name = str(name).strip()
        if not name:
            continue
        login = re.sub(r"[^a-z0-9]+", ".", name.lower()).strip(".") or new_id("user")
        uid = new_id("u")
        try:
            db.execute(
                "INSERT INTO users (id, login, alias, is_worker, is_approver) VALUES (?, ?, ?, 1, 0)",
                (uid, login, name),
            )
            created.append({"id": uid, "login": login, "alias": name, "isWorker": True, "isApprover": False})
        except sqlite3.IntegrityError:
            pass  # login collision — skip quietly
    db.commit()
    return jsonify(created), 201


# -------------------------------------------------------------- locations --
@app.get("/api/locations")
def list_locations():
    rows = get_db().execute("SELECT * FROM locations ORDER BY name").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/locations")
def create_location():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return bad_request("name is required")
    lid = new_id("l")
    db = get_db()
    try:
        db.execute("INSERT INTO locations (id, name) VALUES (?, ?)", (lid, name))
        db.commit()
    except sqlite3.IntegrityError:
        return bad_request(f'location "{name}" already exists')
    return jsonify({"id": lid, "name": name}), 201


@app.post("/api/locations/bulk")
def bulk_locations():
    """Body: {"names": ["North Yard", "Warehouse 3", ...]}"""
    body = request.get_json(force=True, silent=True) or {}
    names = body.get("names") or []
    db = get_db()
    created = []
    for name in names:
        name = str(name).strip()
        if not name:
            continue
        lid = new_id("l")
        try:
            db.execute("INSERT INTO locations (id, name) VALUES (?, ?)", (lid, name))
            created.append({"id": lid, "name": name})
        except sqlite3.IntegrityError:
            pass  # already exists — skip quietly, same behavior as the UI's bulk-add
    db.commit()
    return jsonify(created), 201


@app.delete("/api/locations/<lid>")
def delete_location(lid):
    db = get_db()
    db.execute("DELETE FROM locations WHERE id = ?", (lid,))
    db.commit()
    return "", 204


# -------------------------------------------------------------- work types --
@app.get("/api/work_types")
def list_work_types():
    rows = get_db().execute("SELECT * FROM work_types ORDER BY name").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/work_types")
def create_work_type():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return bad_request("name is required")
    tid = new_id("t")
    db = get_db()
    try:
        db.execute("INSERT INTO work_types (id, name) VALUES (?, ?)", (tid, name))
        db.commit()
    except sqlite3.IntegrityError:
        return bad_request(f'work type "{name}" already exists')
    return jsonify({"id": tid, "name": name}), 201


@app.post("/api/work_types/bulk")
def bulk_work_types():
    body = request.get_json(force=True, silent=True) or {}
    names = body.get("names") or []
    db = get_db()
    created = []
    for name in names:
        name = str(name).strip()
        if not name:
            continue
        tid = new_id("t")
        try:
            db.execute("INSERT INTO work_types (id, name) VALUES (?, ?)", (tid, name))
            created.append({"id": tid, "name": name})
        except sqlite3.IntegrityError:
            pass
    db.commit()
    return jsonify(created), 201


@app.delete("/api/work_types/<tid>")
def delete_work_type(tid):
    db = get_db()
    db.execute("DELETE FROM work_types WHERE id = ?", (tid,))
    db.commit()
    return "", 204


# --------------------------------------------------------- required approvers --
@app.get("/api/required_approvers")
def get_required_approvers():
    row = get_db().execute("SELECT names FROM required_approvers WHERE id = 1").fetchone()
    return jsonify(json.loads(row["names"]) if row else [])


@app.put("/api/required_approvers")
def set_required_approvers():
    body = request.get_json(force=True, silent=True) or {}
    names = body.get("names")
    if not isinstance(names, list):
        return bad_request('body must be {"names": ["...", ...]}')
    names = [str(n).strip() for n in names if str(n).strip()]
    db = get_db()
    db.execute("UPDATE required_approvers SET names = ? WHERE id = 1", (json.dumps(names),))
    db.commit()
    return jsonify(names)


# ------------------------------------------------------------------ events --
def event_row_to_json(r):
    return {
        "id": r["id"], "date": r["date"], "startMinutes": r["start_minutes"], "duration": r["duration"],
        "locations": json.loads(r["locations"]), "types": json.loads(r["types"]),
        "workers": json.loads(r["workers"]), "approvedBy": json.loads(r["approved_by"]),
    }


def validate_event_body(body):
    problems = []
    if not isinstance(body.get("date"), str) or not DATE_RE.match(body["date"]):
        problems.append('"date" must be "YYYY-MM-DD"')
    if not isinstance(body.get("startMinutes"), int) or not (0 <= body["startMinutes"] < 1440):
        problems.append('"startMinutes" must be an integer between 0 and 1439')
    if not isinstance(body.get("duration"), (int, float)) or body["duration"] <= 0:
        problems.append('"duration" must be a positive number of minutes')
    return problems


@app.get("/api/events")
def list_events():
    """Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD range filter."""
    date_from = request.args.get("from")
    date_to = request.args.get("to")
    db = get_db()
    query = "SELECT * FROM events"
    params = []
    if date_from and date_to:
        query += " WHERE date BETWEEN ? AND ?"
        params = [date_from, date_to]
    query += " ORDER BY date, start_minutes"
    rows = db.execute(query, params).fetchall()
    return jsonify([event_row_to_json(r) for r in rows])


@app.post("/api/events")
def create_event():
    body = request.get_json(force=True, silent=True) or {}
    problems = validate_event_body(body)
    if problems:
        return bad_request("; ".join(problems))
    eid = new_id("ev")
    db = get_db()
    db.execute(
        "INSERT INTO events (id, date, start_minutes, duration, locations, types, workers, approved_by) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (eid, body["date"], body["startMinutes"], body["duration"],
         json.dumps(body.get("locations", [])), json.dumps(body.get("types", [])),
         json.dumps(body.get("workers", [])), json.dumps(body.get("approvedBy", []))),
    )
    db.commit()
    row = db.execute("SELECT * FROM events WHERE id = ?", (eid,)).fetchone()
    return jsonify(event_row_to_json(row)), 201


@app.put("/api/events/<eid>")
def update_event(eid):
    body = request.get_json(force=True, silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM events WHERE id = ?", (eid,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    merged = {
        "date": body.get("date", row["date"]),
        "startMinutes": body.get("startMinutes", row["start_minutes"]),
        "duration": body.get("duration", row["duration"]),
        "locations": body.get("locations", json.loads(row["locations"])),
        "types": body.get("types", json.loads(row["types"])),
        "workers": body.get("workers", json.loads(row["workers"])),
        "approvedBy": body.get("approvedBy", json.loads(row["approved_by"])),
    }
    db.execute(
        "UPDATE events SET date=?, start_minutes=?, duration=?, locations=?, types=?, workers=?, approved_by=? WHERE id=?",
        (merged["date"], merged["startMinutes"], merged["duration"],
         json.dumps(merged["locations"]), json.dumps(merged["types"]),
         json.dumps(merged["workers"]), json.dumps(merged["approvedBy"]), eid),
    )
    db.commit()
    merged["id"] = eid
    return jsonify(merged)


@app.delete("/api/events/<eid>")
def delete_event(eid):
    db = get_db()
    db.execute("DELETE FROM events WHERE id = ?", (eid,))
    db.commit()
    return "", 204


@app.post("/api/events/bulk")
def bulk_events():
    """
    Same JSON shape as the frontend's bulk-import box:
    [ { "date": "YYYY-MM-DD", "start": "HH:MM", "duration": 90,
        "locations": [...], "types": [...], "workers": [...], "approvedBy": [...] } ]
    """
    rows = request.get_json(force=True, silent=True)
    if not isinstance(rows, list):
        return bad_request("body must be a JSON array")

    db = get_db()
    added, errors = [], []
    for i, row in enumerate(rows):
        problems = []
        if not isinstance(row, dict):
            errors.append(f"Row {i + 1}: not an object")
            continue
        if not isinstance(row.get("date"), str) or not DATE_RE.match(row["date"]):
            problems.append('"date" must be "YYYY-MM-DD"')
        start_minutes = None
        start = row.get("start")
        if not isinstance(start, str) or not re.match(r"^\d{1,2}:\d{2}$", start):
            problems.append('"start" must be "HH:MM" (24-hour)')
        else:
            h, m = (int(x) for x in start.split(":"))
            if h > 23 or m > 59:
                problems.append('"start" time is out of range')
            else:
                start_minutes = h * 60 + m
        duration = row.get("duration")
        if not isinstance(duration, (int, float)) or duration <= 0:
            problems.append('"duration" must be a positive number of minutes')
        if problems:
            errors.append(f"Row {i + 1}: " + "; ".join(problems))
            continue

        eid = new_id("ev")
        db.execute(
            "INSERT INTO events (id, date, start_minutes, duration, locations, types, workers, approved_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (eid, row["date"], start_minutes, duration,
             json.dumps([str(x) for x in row.get("locations", [])]),
             json.dumps([str(x) for x in row.get("types", [])]),
             json.dumps([str(x) for x in row.get("workers", [])]),
             json.dumps([str(x) for x in row.get("approvedBy", [])])),
        )
        added.append({
            "id": eid, "date": row["date"], "startMinutes": start_minutes, "duration": duration,
            "locations": [str(x) for x in row.get("locations", [])],
            "types": [str(x) for x in row.get("types", [])],
            "workers": [str(x) for x in row.get("workers", [])],
            "approvedBy": [str(x) for x in row.get("approvedBy", [])],
        })
    db.commit()
    return jsonify({"added": added, "errors": errors})


# --------------------------------------------------------------------- SSO --
# SAML 2.0 goes here once you have real Identity Provider metadata. This is
# deliberately left as a stub — see README.md ("Login: SAML 2.0") for the
# recommended approach (python3-saml) and what routes to add
# (/saml/login, /saml/acs, /saml/metadata) plus session handling.


if __name__ == "__main__":
    if not Path(DB_PATH).exists():
        init_db()
        print(f"Initialized new database at {DB_PATH}")
    else:
        # make sure any new tables added since the DB was created still get made
        init_db()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
