# Tree-structured navigation over multiple schedules

**Status:** implemented — see "Multiple calendars (folder-tree mode)" in
README.md, and `server/main.py`, `server/catalog_db.py`,
`server/catalog_routes.py`, `nav/`.

Answers to the open questions this used to list:

- **Tree storage:** a separate catalog database (`server/catalog.db` by
  default), independent of any calendar's own schedule.db, tracking
  folder names/nesting/which calendar id maps to which `.db` filename.
- **URL scheme:** the nav UI itself is a client-side hash router
  (`/#<node_id>`, see `nav/nav.js`) talking to `/api/tree/...`; an opened
  calendar lives at `/cal/<calendar_id>/`, which is linkable and
  bookmarkable on its own.
- **Permissions:** not implemented — folders are purely organizational,
  same open-by-default posture as the rest of the app pre-SAML.
- **Cross-folder features:** each calendar is fully isolated (its own
  users/locations/work types/required approvers), not shared across
  folders. If you want shared rosters across calendars later, that's a
  bigger change (a "shared roster" concept referenced by multiple
  calendar dbs) — not attempted here.
- **Migrations:** `migrations_runner.py` now takes a `migrations_dir`
  argument and is reused for both the per-calendar schema
  (`server/migrations/`) and the catalog's own schema
  (`server/catalog_migrations/`). Each calendar's `.db` gets migrated
  independently, the first time it's opened.
