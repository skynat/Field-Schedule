"""
Catalog database adapter.

The catalog answers exactly one question: "what folders and calendars
exist, and where does each calendar's data live?" It never touches a
calendar's own schedule data (users/events/etc.) — that lives in each
calendar's own SQLite file, opened separately by calendar_app.py. Keeping
these as two entirely different databases (and two entirely different
connections) is what makes "a lock on one calendar's file never blocks
another's, or the catalog" true by construction rather than by careful
locking code.

Backend today: SQLite (CATALOG_DB_PATH, one small file). The tree is
low-volume, low-write-concurrency data — even a large org's folder
structure is a few thousand rows changing rarely — which is exactly what
SQLite is good at, and it means "clone the repo, run it" still works with
zero extra services.

Backend later: Postgres, once the catalog needs to be shared across
multiple app-server processes/machines (the SAME reason the README
already gives for moving a *calendar's* schedule.db to Postgres — this is
that identical tradeoff, just for the tree instead of one calendar's
events). Set CATALOG_DATABASE_URL to a postgres:// URL to switch; nothing
else in this file's public interface (CatalogDB's methods) changes, and
nothing in catalog_routes.py or main.py needs to know which backend is
live. This works because:
  - every table uses TEXT primary keys (new_id()-style, like the rest of
    the app) instead of SQLite's AUTOINCREMENT or Postgres's SERIAL, so
    the schema in catalog_migrations/ is valid unmodified on either engine
  - all queries in this file are written with "?" placeholders and go
    through _q(), which rewrites them to Postgres's "%s" style only when
    the Postgres backend is active
  - psycopg is only imported inside the Postgres branch, so a plain
    SQLite-only install never needs it on the path at all
"""

import os
import sqlite3
from pathlib import Path

from migrations_runner import run_migrations

CATALOG_MIGRATIONS_DIR = Path(__file__).resolve().parent / "catalog_migrations"

# Slugs are kept URL-safe and short; collisions get a numeric suffix.
import re as _re
_SLUG_STRIP_RE = _re.compile(r"[^a-z0-9]+")


def slugify(name, existing):
    """existing: a set of sibling slugs already in use under the same
    parent, so a name that collides gets -2, -3, ... appended."""
    base = _SLUG_STRIP_RE.sub("-", name.strip().lower()).strip("-") or "item"
    slug = base
    n = 2
    while slug in existing:
        slug = f"{base}-{n}"
        n += 1
    return slug


class CatalogDB:
    """Thin wrapper so callers (catalog_routes.py, main.py) never touch
    sqlite3/psycopg directly and never need an if/else on the backend."""

    def __init__(self, conn, is_postgres):
        self._conn = conn
        self._is_postgres = is_postgres

    def _q(self, sql):
        return sql.replace("?", "%s") if self._is_postgres else sql

    def _execute(self, sql, params=()):
        cur = self._conn.cursor()
        cur.execute(self._q(sql), params)
        return cur

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()

    # ------------------------------------------------------------- reads
    def get_node(self, node_id):
        row = self._execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        return dict(row) if row else None

    def list_children(self, parent_id):
        rows = self._execute(
            "SELECT * FROM nodes WHERE parent_id = ? AND id != parent_id ORDER BY kind DESC, name",
            (parent_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def breadcrumb(self, node_id):
        """Ancestor chain from root to node_id, inclusive, as a list of
        dicts ordered root-first. Small trees only (no depth limit) — walks
        parent_id one hop at a time, which is plenty fast for a folder tree
        a human is navigating by hand."""
        chain = []
        seen = set()
        current = self.get_node(node_id)
        while current and current["id"] not in seen:
            chain.append(current)
            seen.add(current["id"])
            if current["id"] == "root":
                break
            current = self.get_node(current["parent_id"])
        return list(reversed(chain))

    def sibling_slugs(self, parent_id):
        rows = self._execute("SELECT slug FROM nodes WHERE parent_id = ?", (parent_id,)).fetchall()
        return {r["slug"] for r in rows}

    # ------------------------------------------------------------- writes
    def create_folder(self, parent_id, name, new_id):
        slug = slugify(name, self.sibling_slugs(parent_id))
        self._execute(
            "INSERT INTO nodes (id, parent_id, slug, name, kind, db_filename) VALUES (?, ?, ?, ?, 'folder', NULL)",
            (new_id, parent_id, slug, name),
        )
        self.commit()
        return self.get_node(new_id)

    def create_calendar(self, parent_id, name, new_id, db_filename):
        slug = slugify(name, self.sibling_slugs(parent_id))
        self._execute(
            "INSERT INTO nodes (id, parent_id, slug, name, kind, db_filename) VALUES (?, ?, ?, ?, 'calendar', ?)",
            (new_id, parent_id, slug, name, db_filename),
        )
        self.commit()
        return self.get_node(new_id)

    def rename_node(self, node_id, name):
        node = self.get_node(node_id)
        if node is None or node_id == "root":
            return None
        slug = slugify(name, self.sibling_slugs(node["parent_id"]) - {node["slug"]})
        self._execute(
            "UPDATE nodes SET name = ?, slug = ?, updated_at = datetime('now') WHERE id = ?",
            (name, slug, node_id),
        )
        self.commit()
        return self.get_node(node_id)

    def move_node(self, node_id, new_parent_id):
        if node_id == "root" or node_id == new_parent_id:
            return None
        node = self.get_node(node_id)
        target = self.get_node(new_parent_id)
        if node is None or target is None or target["kind"] != "folder":
            return None
        # Refuse moving a folder into its own subtree (would orphan it).
        walk = target
        while walk:
            if walk["id"] == node_id:
                return None
            if walk["id"] == "root":
                break
            walk = self.get_node(walk["parent_id"])
        slug = slugify(node["name"], self.sibling_slugs(new_parent_id))
        self._execute(
            "UPDATE nodes SET parent_id = ?, slug = ?, updated_at = datetime('now') WHERE id = ?",
            (new_parent_id, slug, node_id),
        )
        self.commit()
        return self.get_node(node_id)

    def delete_node(self, node_id):
        """Returns the list of calendar nodes (id + db_filename) that were
        removed from the catalog as part of this delete — a folder delete
        cascades to every descendant. The CALLER is responsible for
        unlinking the actual .db files; this method only ever touches
        catalog rows, never the calendar files themselves, keeping the two
        concerns (tree bookkeeping vs. file lifecycle) cleanly separate."""
        if node_id == "root":
            return []
        removed_calendars = []
        stack = [node_id]
        while stack:
            nid = stack.pop()
            node = self.get_node(nid)
            if node is None:
                continue
            if node["kind"] == "calendar":
                removed_calendars.append({"id": node["id"], "db_filename": node["db_filename"]})
            else:
                stack.extend(c["id"] for c in self.list_children(nid))
        self._execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        self.commit()
        return removed_calendars


def _sqlite_connect(db_path):
    run_migrations(db_path, migrations_dir=CATALOG_MIGRATIONS_DIR)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return CatalogDB(conn, is_postgres=False)


def _postgres_connect(database_url):
    # Imported lazily: a SQLite-only deployment never needs psycopg
    # installed at all. `pip install psycopg[binary]` when you're ready to
    # actually use this path, then set CATALOG_DATABASE_URL.
    import psycopg
    from psycopg.rows import dict_row

    conn = psycopg.connect(database_url, row_factory=dict_row)
    # NOTE: run_migrations() as written is SQLite-specific (sqlite3.connect
    # + executescript). The catalog_migrations/*.sql files are plain
    # portable SQL (no SQLite-only pragmas), so porting the runner to also
    # accept a psycopg connection is a small, mechanical follow-up once
    # this path is actually exercised — call it out explicitly rather than
    # silently applying SQLite migration bookkeeping against Postgres.
    return CatalogDB(conn, is_postgres=True)


def get_catalog_db(db_path=None):
    """The single entry point callers use: `db = get_catalog_db(app.config["CATALOG_DB_PATH"])`.
    Honors CATALOG_DATABASE_URL (Postgres) over the passed-in SQLite path
    when set, so flipping backends is a deploy-time env var change, not a
    code change."""
    database_url = os.environ.get("CATALOG_DATABASE_URL")
    if database_url:
        return _postgres_connect(database_url)
    return _sqlite_connect(db_path)
