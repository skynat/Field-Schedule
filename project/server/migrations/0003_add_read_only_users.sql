-- Migration 0003: read-only users
-- Applied automatically, tracked in schema_migrations. Do not edit after release.

ALTER TABLE users ADD COLUMN is_read_only INTEGER NOT NULL DEFAULT 0;  -- 0/1
