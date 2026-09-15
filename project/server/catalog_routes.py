"""
Tree REST API — folders and calendars, metadata only.

Mounted at /api/tree by main.py. Every route here talks to the catalog
database (catalog_db.py) exclusively; none of them ever open a calendar's
own schedule.db — creating a calendar node here does NOT create its
SQLite file (see create_calendar below and main.py's lazy-create step).
"""

from flask import Blueprint, current_app, jsonify, request

from calendar_app import new_id
from catalog_db import get_catalog_db

catalog_bp = Blueprint("catalog", __name__)


def _db():
    return get_catalog_db(current_app.config["CATALOG_DB_PATH"])


def _node_json(node):
    return {
        "id": node["id"],
        "parentId": node["parent_id"],
        "name": node["name"],
        "slug": node["slug"],
        "kind": node["kind"],
        "hasFile": bool(node["db_filename"]) and _calendar_file_exists(node),
    } if node["kind"] == "calendar" else {
        "id": node["id"],
        "parentId": node["parent_id"],
        "name": node["name"],
        "slug": node["slug"],
        "kind": node["kind"],
    }


def _calendar_file_exists(node):
    from pathlib import Path
    if not node.get("db_filename"):
        return False
    return (Path(current_app.config["CALENDARS_DIR"]) / node["db_filename"]).exists()


@catalog_bp.get("/<node_id>")
def get_node(node_id):
    db = _db()
    node = db.get_node(node_id)
    if node is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "node": _node_json(node),
        "breadcrumb": [_node_json(n) for n in db.breadcrumb(node_id)],
    })


@catalog_bp.get("/<node_id>/children")
def list_children(node_id):
    db = _db()
    if db.get_node(node_id) is None:
        return jsonify({"error": "not found"}), 404
    return jsonify([_node_json(n) for n in db.list_children(node_id)])


@catalog_bp.post("/<node_id>/folders")
def create_folder(node_id):
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = _db()
    parent = db.get_node(node_id)
    if parent is None or parent["kind"] != "folder":
        return jsonify({"error": "parent must be an existing folder"}), 400
    node = db.create_folder(node_id, name, new_id("f"))
    return jsonify(_node_json(node)), 201


@catalog_bp.post("/<node_id>/calendars")
def create_calendar(node_id):
    """Registers a calendar in the tree. Deliberately does NOT create the
    SQLite file — that happens the first time someone actually opens this
    calendar (GET /cal/<id>/, handled in main.py), the same way clicking a
    shortcut is what launches the program, not pinning it to a menu. This
    keeps "create 10 calendars while planning out a folder structure, only
    ever open 3 of them" from littering the calendars/ directory with 7
    empty .db files nobody asked for."""
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = _db()
    parent = db.get_node(node_id)
    if parent is None or parent["kind"] != "folder":
        return jsonify({"error": "parent must be an existing folder"}), 400
    cal_id = new_id("cal")
    node = db.create_calendar(node_id, name, cal_id, db_filename=f"{cal_id}.db")
    return jsonify(_node_json(node)), 201


@catalog_bp.patch("/nodes/<node_id>")
def update_node(node_id):
    body = request.get_json(force=True, silent=True) or {}
    db = _db()
    node = db.get_node(node_id)
    if node is None:
        return jsonify({"error": "not found"}), 404
    if node_id == "root":
        return jsonify({"error": "cannot modify the root folder"}), 400

    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name cannot be empty"}), 400
        node = db.rename_node(node_id, name)

    if "parentId" in body:
        node = db.move_node(node_id, body["parentId"])
        if node is None:
            return jsonify({"error": "invalid move (bad target, or would create a cycle)"}), 400

    return jsonify(_node_json(node))


@catalog_bp.delete("/nodes/<node_id>")
def delete_node(node_id):
    if node_id == "root":
        return jsonify({"error": "cannot delete the root folder"}), 400
    db = _db()
    if db.get_node(node_id) is None:
        return jsonify({"error": "not found"}), 404
    removed_calendars = db.delete_node(node_id)

    # Clean up the underlying .db files for any calendars that were
    # removed (the node itself, or anything under it if it was a folder).
    # Catalog rows are already committed at this point — if a file unlink
    # below fails partway through, the tree is still in a consistent
    # state (those calendars are just gone from the catalog, matching
    # what the user asked for; an orphaned file on disk is a much safer
    # failure mode than an orphaned catalog row pointing at nothing).
    import os
    from pathlib import Path
    calendars_dir = Path(current_app.config["CALENDARS_DIR"])
    for cal in removed_calendars:
        if not cal["db_filename"]:
            continue
        path = calendars_dir / cal["db_filename"]
        for suffix in ("", "-wal", "-shm"):  # WAL mode leaves sidecar files
            candidate = Path(str(path) + suffix)
            if candidate.exists():
                os.remove(candidate)

    return "", 204
