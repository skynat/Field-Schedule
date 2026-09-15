-- The folder/calendar tree. This table tracks STRUCTURE ONLY — never the
-- schedule data itself (users/events/etc.), which stays in each
-- calendar's own SQLite file under server/calendars/. Keeping the tree in
-- one small, low-write-volume catalog rather than doing real filesystem
-- walks (readdir/stat) means listing a folder's contents, renaming, and
-- moving nodes around are all just indexed SQL queries.
--
-- id/parent_id are app-generated text ids (same "prefix_hexhex..." style
-- used everywhere else in this app — see new_id() in calendar_app.py),
-- not autoincrementing integers. That's deliberate: TEXT primary keys
-- behave identically on SQLite and Postgres, so this schema needs zero
-- changes if the catalog is later pointed at Postgres (see catalog_db.py)
-- — no SERIAL/AUTOINCREMENT dialect split to worry about.
CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('folder', 'calendar')),
    -- Only set for kind='calendar': the filename (not full path) of this
    -- calendar's SQLite file under CALENDARS_DIR, e.g. "cal_a1b2c3d4e5.db".
    -- Assigned at creation time but the FILE ITSELF is not created until
    -- the calendar is first opened — see main.py's lazy-create step.
    db_filename TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (parent_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

-- A single, always-present root folder ("Home") that every top-level
-- folder/calendar sits under. Existing as a real row (rather than
-- allowing parent_id to be NULL) means the UNIQUE(parent_id, slug)
-- constraint above actually catches top-level slug collisions too — NULL
-- never equals NULL in a uniqueness check, so NULL parent_ids would let
-- two root-level items silently share a slug.
INSERT OR IGNORE INTO nodes (id, parent_id, slug, name, kind, db_filename)
VALUES ('root', 'root', '', 'Home', 'folder', NULL);
