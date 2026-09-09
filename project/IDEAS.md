# Future idea: tree-structured navigation over multiple schedules

**Status:** not started — captured here so it survives between sessions.
Still being worked out on your end; this is a placeholder, not a spec.

## The idea

A navigation layer sits above the calendar itself, letting the user build
a folder-tree — like a filesystem — to organize separate schedules:
projects, teams, whatever grouping makes sense to them. Each folder the
user creates in that tree is *not* just a UI grouping; it corresponds to
its own separate SQLite database file, the same way a folder in a real
filesystem contains its own separate files.

Navigating into a folder in the tree takes you to that folder's calendar
(this app, exactly as it exists today, scoped to that one database). The
whole thing needs to be linkable — a URL like
`/tree/acme-corp/field-ops/september/` (exact scheme TBD) should deep-link
straight to that folder's calendar, so someone can share a URL and the
recipient lands directly on the right schedule without manual navigation.

## Why this matters / what it solves

This directly answers the multi-tenant gap flagged earlier: right now,
running this app for multiple independent teams means standing up
separate instances (separate `SCHEDULE_DB_PATH`, separate nginx
`location` blocks) by hand. A tree-of-databases feature would make that
native to the app instead — creating a new "folder" is how you'd spin up
a new independent schedule, with no server reconfiguration.

## Open questions for when this gets designed for real

- **Tree storage**: the tree structure itself (folder names, nesting,
  which SQLite file each folder points to) needs to live somewhere that
  isn't inside any one schedule's database — probably a small top-level
  "catalog" database, separate from the per-folder schedule databases.
- **URL scheme**: how the tree path maps to a URL — slugs per folder,
  or opaque IDs with folder names as metadata (slugs are nicer URLs but
  need rename/collision handling).
- **Permissions**: does access control (who can see/edit which folder)
  matter here, or is this purely organizational with no auth boundary
  between folders?
- **Cross-folder features**: things like the required-approvers list,
  users, locations, work types — are those global (shared across every
  folder) or per-folder (each schedule has its own roster)? This affects
  whether folders are fully isolated schedules or just calendar views
  into shared underlying data.
- **Migrations**: the existing `server/migrations/` system assumes one
  database. A tree of databases means either running migrations against
  every leaf database, or restructuring so schema changes apply
  uniformly across all of them.

None of this needs answering now — just flagging the shape of the
decisions for whenever this gets picked up.
