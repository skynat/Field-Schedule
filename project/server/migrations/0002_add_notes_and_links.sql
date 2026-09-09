-- Migration 0002: notes (with format) and links on events
-- Applied automatically, tracked in schema_migrations. Do not edit after release.

ALTER TABLE events ADD COLUMN notes_format  TEXT NOT NULL DEFAULT 'text';
ALTER TABLE events ADD COLUMN notes_content TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN links         TEXT NOT NULL DEFAULT '[]';
