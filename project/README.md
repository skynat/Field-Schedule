# Field Schedule

A calendar-based work scheduling tool: week-view calendar, config-managed
users/locations/work types, drag-and-drop scheduling blocks, an approval
workflow, CSV/JSON/Excel export, and JSON bulk import.

```
project/
├── index.html          the app's HTML shell — open this
├── app.jsx             React source (edit this)
├── app.js              compiled from app.jsx — do not edit by hand
├── build.js            rebuilds app.js from app.jsx
├── vendor/              self-hosted JS dependencies (see below)
│   ├── react.production.min.js
│   ├── react-dom.production.min.js
│   └── xlsx.full.min.js
└── server/              optional Flask + SQLite backend
    ├── app.py
    ├── schema.sql
    └── requirements.txt
```

## Dependencies

Everything the frontend needs is already vendored in `vendor/` — nothing is
fetched from a CDN at runtime. Exact versions:

| Library  | Version | File                              | Source |
|----------|---------|------------------------------------|--------|
| React    | 18.2.0  | `vendor/react.production.min.js`     | `npm view react@18.2.0` / [npmjs.com/package/react](https://www.npmjs.com/package/react) |
| ReactDOM | 18.2.0  | `vendor/react-dom.production.min.js` | [npmjs.com/package/react-dom](https://www.npmjs.com/package/react-dom) |
| xlsx (SheetJS) | 0.18.5 | `vendor/xlsx.full.min.js`       | [npmjs.com/package/xlsx](https://www.npmjs.com/package/xlsx) |

`app.js` is **pre-compiled** from `app.jsx` — the browser doesn't run Babel
at runtime, so there's no Babel dependency to host in production. You only
need Babel as a *dev-time* tool, for rebuilding `app.js` after you edit
`app.jsx`:

```
npm install --no-save @babel/core @babel/preset-react
node build.js
```

Backend dependencies (only needed if you're running `server/app.py`) are in
`server/requirements.txt`: Flask, and gunicorn for production. SAML support
is commented out there — see below.

## Third-party licenses

| Dependency | Version | License | What it requires |
|---|---|---|---|
| React | 18.2.0 | MIT | Keep the copyright/license notice with the code. Permissive — no obligation to open-source your own code, no patent clause. |
| ReactDOM | 18.2.0 | MIT | Same as above. |
| xlsx (SheetJS) | 0.18.5 | Apache-2.0 | Keep the copyright notice; include a copy of the license with any redistribution; if you modify the file, note that you changed it. Also grants you an explicit patent license (MIT doesn't). |
| Flask | 3.0.x | BSD-3-Clause | Keep the copyright notice; don't use the Pallets/Flask name to endorse derived products without permission. |
| gunicorn | latest | MIT | Same as React/ReactDOM. |
| Babel (`@babel/core`, `@babel/preset-react`) | — | MIT | Dev-only — used by `build.js` to compile `app.jsx`, never shipped to the browser, so there's nothing to distribute here at all. |

All of these are permissive licenses: none of them require you to open-source
your own application code (that's copyleft licenses like GPL, which none of
these are), and none of them restrict commercial use.

The practical difference that matters here is **Apache-2.0 (xlsx) vs. MIT**:
Apache-2.0 additionally wants you to preserve any "NOTICE" file from the
original project (SheetJS doesn't ship one) and to flag it if you've
modified their source — we haven't, `vendor/xlsx.full.min.js` is used
as-is. Because these libraries are *vendored* (their actual files are copied
into this repo and shipped to end users' browsers), their full license texts
are included in `vendor/licenses/` so that copy requirement is satisfied
regardless of where you deploy this from. React's own minified file already
carries its MIT notice in a header comment; the `vendor/licenses/` copies
make it unambiguous for all three.

Flask and gunicorn are different: they're *server-side* dependencies,
installed via `pip install -r requirements.txt` rather than vendored into
this repo, so the people who install them get the license directly from
PyPI/the package itself — you don't need to bundle copies of their license
text here the way you do for the browser-side vendor files.

If your organization has a policy requiring a consolidated
THIRD_PARTY_NOTICES file, everything in `vendor/licenses/` plus this table
is what that file would draw from.

## Running it

### Just the static frontend (no persistence)

```
cd project
python -m http.server 8000
```

Open `http://localhost:8000`. This works with **zero** setup, but there's
no backend behind it — every change (new blocks, config edits, approvals)
lives only in that browser tab's memory and is gone on refresh. This mode
is for quickly trying out the UI or demoing the calendar interactions.

### With persistence (SQLite via Flask)

```
cd project/server
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000` — Flask serves both the frontend and the
`/api/*` routes from the same origin, and everything is written to
`server/schedule.db` (created automatically on first run, pre-populated
with the same starter users/locations/work types the demo used to ship
with). A small badge next to the "Field Schedule" title tells you whether
the frontend actually found a backend: **● Synced** (green) means changes
are being saved; **○ Local only** (grey) means it fell back to in-memory
mode, e.g. because you opened `index.html` directly or the server isn't
running.

If you ever want to run the frontend and backend on two different ports
during development (e.g. frontend on `:8000` via http.server, API on
`:5000` via Flask), set `SCHEDULE_DEV_CORS=1` when starting `app.py` so the
browser's cross-origin fetches are allowed. Leave it unset for the normal
single-origin setup above — you don't want open CORS in production.

## Rebuilding after editing app.jsx

`app.jsx` is the real source; `app.js` is a build artifact. After changing
`app.jsx`:

```
node build.js
```

This uses the classic JSX runtime (`React.createElement(...)` calls) on
purpose — Babel's newer "automatic" runtime emits an ES module `import`
statement, which throws `Cannot use import statement outside a module`
the instant it hits a plain `<script>` tag. `build.js` already pins this
via `runtime: "classic"`; don't remove that option.

## Data model / API reference

The backend exposes a small REST API over SQLite:

| Resource | Endpoints |
|---|---|
| Users | `GET/POST /api/users`, `PUT/DELETE /api/users/<id>`, `POST /api/users/bulk` |
| Locations | `GET/POST /api/locations`, `DELETE /api/locations/<id>`, `POST /api/locations/bulk` |
| Work types | `GET/POST /api/work_types`, `DELETE /api/work_types/<id>`, `POST /api/work_types/bulk` |
| Required approvers | `GET /api/required_approvers`, `PUT /api/required_approvers` (body: `{"names": [...]}`) |
| Events (blocks) | `GET/POST /api/events` (`GET` takes optional `?from=YYYY-MM-DD&to=YYYY-MM-DD`), `PUT/DELETE /api/events/<id>`, `POST /api/events/bulk` |

The bulk-events JSON shape (same one the "Bulk add work blocks" button in
the UI uses) is:

```json
[
  {
    "date": "2026-09-10",
    "start": "08:00",
    "duration": 90,
    "locations": ["North Yard"],
    "types": ["Install"],
    "workers": ["J. Martinez", "A. Smith"],
    "approvedBy": []
  }
]
```

`locations`/`types`/`workers`/`approvedBy` are optional and default to `[]`.
The endpoint returns `{"added": [...created event objects], "errors": [...per-row messages]}`
— rows that fail validation are skipped, not fatal to the whole batch.

### How the frontend talks to the backend

On load, the app fetches all five resources; if any request fails (no
network, no server running), it silently falls back to its built-in demo
data and works entirely in memory — that's the "○ Local only" state. All
later edits (adding a user, dragging a block, approving something) go
through the same pattern: update the UI immediately, then fire the matching
API call in the background. Dragging/resizing a block updates the UI on
every mouse-move for responsiveness but only sends **one** API call when
you release the mouse, not one per pixel moved.

## Production hosting

A few things change between "works on my laptop" and "safe to point real
users at":

**Don't use `app.run(debug=True)` or the Flask dev server in production.**
Put a real WSGI server in front of it:

```
pip install gunicorn
gunicorn --workers 4 --bind 127.0.0.1:5000 app:app
```

...and put gunicorn behind a reverse proxy (nginx or Caddy) that terminates
TLS and serves the static `vendor/*.js` files directly rather than routing
every request through Python. A minimal nginx sketch:

```nginx
server {
    listen 443 ssl;
    server_name schedule.example.com;

    location /vendor/ { alias /path/to/project/vendor/; }
    location /api/    { proxy_pass http://127.0.0.1:5000; }
    location /        { proxy_pass http://127.0.0.1:5000; }
}
```

Run gunicorn under systemd (or your platform's equivalent) so it restarts
on crash/reboot rather than as a background shell job.

**SQLite is fine at small-to-medium scale** — a single scheduling tool for
one team, low write concurrency — but it has real limits: it locks the
whole database file on writes, so it won't hold up well with many
simultaneous editors or across multiple app server processes/machines. If
you outgrow it (frequent "database is locked" errors, need for multiple
app servers, need for replication/backups beyond "copy the file"), move to
Postgres. The SQL in `schema.sql` is plain enough to port directly; the
main code change is swapping `sqlite3` calls in `app.py` for a Postgres
driver (`psycopg`) — the query shapes stay almost the same.

**Back up `schedule.db` regularly** if you stick with SQLite — it's a
single file, so this can be as simple as a cron job copying it somewhere
durable (or better, using SQLite's [online backup
API](https://sqlite.org/backup.html) so you don't copy it mid-write).

**Lock down CORS** — don't ship with `SCHEDULE_DEV_CORS=1` set. The normal
production setup (frontend and API on the same origin, per the nginx sketch
above) doesn't need CORS headers at all.

## Login: SAML 2.0

The app doesn't have any authentication built in yet — `server/app.py` has
a comment marking where SSO would plug in, but no working SAML flow, since
that genuinely needs a real Identity Provider's metadata to test against
(there's no way to build and verify this without one).

Here's the shape it would take:

- **SAML is a backend concern, not a frontend one.** The browser gets
  redirected to your IdP, POSTs a signed assertion back to a fixed
  "Assertion Consumer Service" URL, and the *server* verifies that
  signature and establishes a session (cookie). None of that can happen in
  client-side JS alone — the frontend just ends up behind a login wall the
  same way it would be behind any server-rendered app.
- **Recommended library:** [`python3-saml`](https://github.com/SAML-Toolkits/python3-saml)
  (OneLogin's toolkit — mature, still maintained). It has a native
  dependency on `xmlsec`, which needs `libxml2-dev`/`libxmlsec1-dev` (or
  your distro's equivalent) installed before `pip install python3-saml`
  will build.
- **Routes you'd add to `app.py`:**
  - `GET /saml/metadata` — serves your Service Provider metadata XML, which
    you hand to whoever manages the IdP (Okta, Azure AD, OneLogin, etc.) to
    register the integration.
  - `GET /saml/login` — redirects the browser to the IdP's SSO URL.
  - `POST /saml/acs` — the Assertion Consumer Service; validates the signed
    response, pulls the user's identity out of it, sets a session cookie.
  - Every `/api/*` route then checks that session cookie (a `before_request`
    hook is the natural place) instead of trusting an open API.
- **Mapping IdP identities to the `users` table:** decide whether the IdP's
  NameID/email should auto-create a row in `users` on first login (with
  `is_worker`/`is_approver` defaulted, then adjusted by an admin in Config),
  or whether accounts must be pre-provisioned. Auto-provisioning is less
  admin overhead; pre-provisioning is safer if `is_approver` should never be
  assigned by accident.
- **Alternative if you'd rather not run SAML yourself:** put an identity
  gateway in front of the app instead of implementing SAML directly —
  something like Keycloak, Authentik, or a hosted product (Okta, Auth0)
  configured to speak SAML to your corporate IdP and OIDC (simpler to
  implement) to this app. That shifts the SAML complexity to a piece of
  infrastructure built specifically for it, and `app.py` only needs to
  handle the much simpler OIDC side.

I'd suggest starting there — get a plain-cookie session working locally
first (even a hardcoded "you're logged in as X" for dev), then swap in
whichever SSO path fits your organization once you have real IdP metadata
to test against.
