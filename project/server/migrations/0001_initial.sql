-- Migration 0001: initial schema
-- Applied automatically, tracked in schema_migrations. Do not edit after release.

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    login       TEXT NOT NULL UNIQUE,
    alias       TEXT NOT NULL,
    is_worker   INTEGER NOT NULL DEFAULT 1,   -- 0/1
    is_approver INTEGER NOT NULL DEFAULT 0    -- 0/1
);

CREATE TABLE IF NOT EXISTS locations (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS work_types (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- Single-row table holding the list of approver names required for a block
-- to count as "fully approved". Stored as a JSON array in `names`.
CREATE TABLE IF NOT EXISTS required_approvers (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    names TEXT NOT NULL DEFAULT '[]'
);
INSERT OR IGNORE INTO required_approvers (id, names) VALUES (1, '[]');

CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    date          TEXT NOT NULL,     -- "YYYY-MM-DD", the block's home day
    start_minutes INTEGER NOT NULL,  -- minutes after that day's midnight
    duration      INTEGER NOT NULL,  -- minutes
    locations     TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    types         TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    workers       TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    approved_by   TEXT NOT NULL DEFAULT '[]'   -- JSON array of strings (names)
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
