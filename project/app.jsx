
const { useState, useRef, useMemo, useCallback, useEffect } = React;

function makeIcon(glyph) {
  return function IconGlyph({ size = 14, color, style, ...rest }) {
    return (
      <span
        {...rest}
        style={{
          fontSize: size, lineHeight: 1, display: "inline-flex",
          alignItems: "center", justifyContent: "center",
          width: size, height: size, color, flexShrink: 0, ...style,
        }}
      >
        {glyph}
      </span>
    );
  };
}
const Settings = makeIcon("\u2699");
const X = makeIcon("\u2715");
const Pencil = makeIcon("\u270E");
const Check = makeIcon("\u2713");
const Download = makeIcon("\u2B07");
const ChevronDown = makeIcon("\u2304");
const Search = makeIcon("\u{1F50D}");
const Plus = makeIcon("+");
const Trash2 = makeIcon("\u{1F5D1}");
const CalendarRange = makeIcon("\u{1F4C5}");
const ShieldCheck = makeIcon("\u{1F6E1}");
const ShieldOff = makeIcon("\u26E8");
const Info = makeIcon("\u24D8");
const LinkIcon = makeIcon("\u{1F517}");
const OfflineIcon = makeIcon("\u{1F4BE}");


// ---------- constants ----------
const HOUR_PX = 52;
const PEEK_HOURS_MIN = 2;
// Day columns never shrink narrower than this — chosen so a block's time
// label + N/L badges + info/edit icons always fit on one line without
// wrapping. On a narrow phone this means the calendar goes wider than the
// screen and scrolls horizontally instead of squeezing blocks unreadable;
// that trade-off is intentional.
const MIN_COL_WIDTH = 148;
// Minimum width a single lane needs — same reasoning, but applied per lane:
// when blocks overlap and split a column into side-by-side lanes, each lane
// needs this much room on its own, so a column with N overlapping blocks
// needs to be at least N * MIN_LANE_WIDTH wide, not just MIN_COL_WIDTH.
const MIN_LANE_WIDTH = 140;
const PEEK_HOURS_MAX = 10;
const DAY_MIN = 1440;
const SNAP = 15;
const MIN_DUR = 30;

const COLORS = {
  bg: "#12161B",
  panel: "#1B2128",
  panel2: "#212832",
  line: "#2A323C",
  lineSoft: "#232A33",
  text: "#E7EBEE",
  muted: "#8B98A5",
  faint: "#5C6773",
  accent: "#4FB6A8",
  accentDim: "#33544E",
  amber: "#E8A94E",
  danger: "#D9705F",
  block: "#2D3844",
  blockBorder: "#3C4956",
};

const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// ---------- backend API client ----------
// Talks to the Flask+SQLite service in server/app.py, if one is reachable.
// Every call fails soft (returns null) so the app keeps working — with
// state held only in memory — when there's no backend at all, e.g. when
// you're just opening index.html via `python -m http.server` for a look.
//
// API_BASE is derived at runtime from wherever THIS script was actually
// loaded from (document.currentScript.src), not hardcoded to "/api". That
// makes the exact same built files work correctly whether the app is
// served at a domain root (https://schedule.example.com/ -> API at /api)
// or mounted under a shared path behind a reverse proxy alongside other
// apps (https://example.com/schedule/ -> API at /schedule/api) — no
// rebuild, no config file, no environment variable. document.currentScript
// only resolves during a classic <script>'s own synchronous top-level
// execution, which is exactly when this runs, so it's safe to capture here
// once at module load and reuse everywhere below.
const APP_BASE = (() => {
  try {
    const src = document.currentScript && document.currentScript.src;
    if (src) return src.slice(0, src.lastIndexOf("/") + 1);
  } catch (e) { /* not in a browser, or a security restriction — fall through */ }
  return ""; // e.g. inlined into a standalone offline snapshot with no <script src>          — harmless, that mode never calls the API anyway
})();
const API_BASE = (APP_BASE || "/") + "api";
// The running app registers a listener here (see the connectivity effect in
// WorkSchedulePlanner) so that EVERY request — not just the initial load —
// updates the "Synced"/"Local only" badge. Without this, the badge only
// reflected whether the very first page load succeeded; if the backend died
// mid-session, later edits would fail silently and the badge would keep
// saying "Synced" even though nothing was actually being saved.
let apiStatusListener = null;
async function apiRequest(method, path, body) {
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { if (apiStatusListener) apiStatusListener(false); return null; }
    if (apiStatusListener) apiStatusListener(true);
    if (res.status === 204) return true;
    return await res.json();
  } catch {
    if (apiStatusListener) apiStatusListener(false);
    return null; // no network / no backend running — caller treats this as "stay local"
  }
}
// Diffs an old vs new array of {id, ...} records and pushes the difference
// to the backend: POST for anything new, PUT for anything changed, DELETE
// for anything removed. Used for the users/locations/work_types lists,
// which the Config modal still edits as plain arrays via setState.
function syncListToApi(resource, toApiBody, prev, next, onServerIdAssigned, requestFn) {
  const request = requestFn || apiRequest;
  const prevMap = new Map(prev.map((x) => [x.id, x]));
  const nextMap = new Map(next.map((x) => [x.id, x]));
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id) && !id.startsWith("__pending_")) request("DELETE", `/${resource}/${id}`);
  }
  for (const [id, item] of nextMap) {
    const before = prevMap.get(id);
    if (!before) {
      request("POST", `/${resource}`, toApiBody(item)).then((created) => {
        if (created && created.id && created.id !== id) onServerIdAssigned(id, created.id);
      });
    } else if (JSON.stringify(before) !== JSON.stringify(item)) {
      request("PUT", `/${resource}/${id}`, toApiBody(item));
    }
  }
}


function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function mondayOf(dateObj) {
  const d = new Date(dateObj);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return isoDate(d);
}
function epochDay(iso) {
  return Math.floor(new Date(iso + "T00:00:00").getTime() / 86400000);
}
function hmLabel(h, m) {
  const ampm = h < 12 ? "AM" : "PM";
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${pad2(m)} ${ampm}`;
}
function minsToLabel(mins) {
  const h = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
  const m = ((mins % 60) + 60) % 60;
  return hmLabel(h, m);
}
// Events are authored in the browser's local timezone. These helpers turn an
// event's (date, startMinutes) into a real absolute Date instant, so exports
// can be re-rendered either in local time or UTC without changing what
// instant they refer to.
function eventStartDate(ev) {
  const d = new Date(ev.date + "T00:00:00");
  d.setMinutes(d.getMinutes() + ev.startMinutes);
  return d;
}
function eventEndDate(ev) {
  const d = eventStartDate(ev);
  d.setMinutes(d.getMinutes() + ev.duration);
  return d;
}
function localTZName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "local time"; }
}
function fmtInTZ(dateObj, useUTC) {
  const y = useUTC ? dateObj.getUTCFullYear() : dateObj.getFullYear();
  const mo = useUTC ? dateObj.getUTCMonth() + 1 : dateObj.getMonth() + 1;
  const da = useUTC ? dateObj.getUTCDate() : dateObj.getDate();
  const h = useUTC ? dateObj.getUTCHours() : dateObj.getHours();
  const m = useUTC ? dateObj.getUTCMinutes() : dateObj.getMinutes();
  return { date: `${y}-${pad2(mo)}-${pad2(da)}`, time: hmLabel(h, m) };
}

// ---------- overlap layout (side-by-side blocks) ----------
// items: [{id, start, end}] in a shared coordinate space (minutes). Returns
// { [id]: { lane, laneCount } } so overlapping items can be given equal
// fractional widths and offset side by side instead of stacking.
function layoutOverlaps(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters = [];
  let current = [], currentEnd = -Infinity;
  for (const it of sorted) {
    if (current.length === 0 || it.start < currentEnd) {
      current.push(it);
      currentEnd = Math.max(currentEnd, it.end);
    } else {
      clusters.push(current);
      current = [it];
      currentEnd = it.end;
    }
  }
  if (current.length) clusters.push(current);

  const layout = {};
  for (const cluster of clusters) {
    const laneEnds = [];
    const laneOf = {};
    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.end); }
      else laneEnds[lane] = it.end;
      laneOf[it.id] = lane;
    }
    const laneCount = laneEnds.length;
    for (const it of cluster) layout[it.id] = { lane: laneOf[it.id], laneCount };
  }
  return layout;
}
function fmtDateShort(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ---------- seed data ----------
const seedUsers = [
  { id: "u1", login: "jmartinez", alias: "J. Martinez", isWorker: true, isApprover: false },
  { id: "u2", login: "asmith", alias: "A. Smith", isWorker: true, isApprover: false },
  { id: "u3", login: "rt.chen", alias: "R. Chen", isWorker: true, isApprover: true },
  { id: "u4", login: "dford", alias: "D. Ford", isWorker: false, isApprover: true },
  { id: "u5", login: "kpatel", alias: "K. Patel", isWorker: true, isApprover: false },
];
const seedLocations = [
  { id: "l1", name: "North Yard" },
  { id: "l2", name: "Warehouse 3" },
  { id: "l3", name: "Site B - Riverside" },
  { id: "l4", name: "HQ Loading Dock" },
];
const seedTypes = [
  { id: "t1", name: "Install" },
  { id: "t2", name: "Maintenance" },
  { id: "t3", name: "Inspection" },
  { id: "t4", name: "Cleanup" },
];

const seedRequiredApprovers = ["R. Chen", "D. Ford"];

function isFullyApproved(ev, requiredApprovers) {
  const by = ev.approvedBy || [];
  if (requiredApprovers.length > 0) return requiredApprovers.every((name) => by.includes(name));
  return by.length > 0;
}
// Which calendar day a block's true end time falls on — used so the resize
// handle (drag-to-adjust) shows up on whichever day actually has the tail
// end of a block that spans past midnight, not just its start day.
function eventEndDay(ev) {
  const endAbs = ev.startMinutes + ev.duration;
  const dayOffset = Math.floor((endAbs - 1) / DAY_MIN);
  return addDays(ev.date, dayOffset);
}

function seedEvents(monday) {
  return [
    { id: uid("ev"), date: monday, startMinutes: 8 * 60, duration: 90, locations: ["North Yard"], types: ["Install"], workers: ["J. Martinez", "A. Smith"], approvedBy: [],
      notes: { format: "text", content: "Bring the extra conduit — customer added a run on the north wall." },
      links: [{ label: "Site plan", url: "https://example.com/site-plan.pdf", description: "Marked-up PDF from the walkthrough" }] },
    { id: uid("ev"), date: addDays(monday, 1), startMinutes: 13 * 60, duration: 60, locations: ["Warehouse 3"], types: ["Maintenance"], workers: ["K. Patel"], approvedBy: ["D. Ford"],
      notes: { format: "text", content: "" }, links: [] },
    { id: uid("ev"), date: addDays(monday, 2), startMinutes: 23 * 60 + 30, duration: 90, locations: ["Site B - Riverside"], types: ["Inspection"], workers: ["R. Chen"], approvedBy: ["D. Ford", "R. Chen"],
      notes: { format: "text", content: "" }, links: [] },
  ];
}

// ---------- filter syntax parser ----------
// syntax: field:[value & value] & field:[! value]
function parseFilterSyntax(str) {
  const clauses = [];
  if (!str || !str.trim()) return clauses;
  const topSplit = splitTopLevel(str, "&");
  for (const raw of topSplit) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const m = chunk.match(/^([a-zA-Z]+)\s*:\s*\[(.*)\]$/s);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const inner = m[2];
    const tokens = splitTopLevel(inner, "&").map((t) => t.trim()).filter(Boolean);
    const include = [];
    const exclude = [];
    for (const t of tokens) {
      if (t.startsWith("!")) exclude.push(t.slice(1).trim().toLowerCase());
      else include.push(t.toLowerCase());
    }
    clauses.push({ field, include, exclude });
  }
  return clauses;
}
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
// ---------- bulk JSON import for calendar blocks ----------
// Expected shape: an array of objects like
// { "date": "YYYY-MM-DD", "start": "HH:MM" (24h), "duration": <minutes>,
//   "locations": [...], "types": [...], "workers": [...], "approvedBy": [...] }
// locations/types/workers/approvedBy are optional and default to [].
const NOTE_FORMATS = ["text", "json", "csv", "markdown"];
function normalizeNotes(notes) {
  const format = notes && NOTE_FORMATS.includes(notes.format) ? notes.format : "text";
  const content = notes && notes.content != null ? String(notes.content) : "";
  return { format, content };
}
function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return links
    .filter((l) => l && String(l.url || "").trim())
    .map((l) => ({ label: String(l.label || l.url).trim(), url: String(l.url).trim(), description: String(l.description || "") }));
}

function parseBulkEventsJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("That isn't valid JSON (" + e.message + ").");
  }
  if (!Array.isArray(data)) throw new Error('The top level must be an array, e.g. "[ { ... }, { ... } ]".');

  const added = [];
  const errors = [];
  data.forEach((row, i) => {
    const problems = [];
    if (!row || typeof row !== "object") { errors.push(`Row ${i + 1}: not an object`); return; }
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) problems.push('"date" must be "YYYY-MM-DD"');
    let startMinutes = null;
    if (typeof row.start !== "string" || !/^\d{1,2}:\d{2}$/.test(row.start)) {
      problems.push('"start" must be "HH:MM" (24-hour)');
    } else {
      const [h, m] = row.start.split(":").map(Number);
      if (h > 23 || m > 59) problems.push('"start" time is out of range');
      else startMinutes = h * 60 + m;
    }
    if (typeof row.duration !== "number" || row.duration <= 0) problems.push('"duration" must be a positive number of minutes');
    if (row.notes && row.notes.format && !NOTE_FORMATS.includes(row.notes.format)) problems.push('"notes.format" must be one of: ' + NOTE_FORMATS.join(", "));
    if (row.links && (!Array.isArray(row.links) || row.links.some((l) => !l || !l.url))) problems.push('"links" must be an array of objects each with a "url"');
    if (problems.length) { errors.push(`Row ${i + 1}: ${problems.join("; ")}`); return; }
    added.push({
      id: uid("ev"),
      date: row.date,
      startMinutes,
      duration: row.duration,
      locations: Array.isArray(row.locations) ? row.locations.map(String) : [],
      types: Array.isArray(row.types) ? row.types.map(String) : [],
      workers: Array.isArray(row.workers) ? row.workers.map(String) : [],
      approvedBy: Array.isArray(row.approvedBy) ? row.approvedBy.map(String) : [],
      notes: normalizeNotes(row.notes),
      links: normalizeLinks(row.links),
    });
  });
  return { added, errors };
}

// Accepts either "[label](url)" (the common Markdown link syntax) or a bare
// URL on its own — in which case the URL doubles as the label.
function parseLinkSyntax(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/^\[(.+?)\]\((\S+?)\)$/);
  if (m) return { label: m[1].trim(), url: m[2].trim() };
  return { label: trimmed, url: trimmed };
}

// Small "i" icon that shows a floating text box on hover (and toggles on
// click/tap, for touch). Used for per-link descriptions.
function InlineInfoHover({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <span style={{ position: "relative", display: "inline-flex", marginLeft: 4 }}>
      <Info
        size={12}
        color={COLORS.faint}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      />
      {open && (
        <div
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 60,
            background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 6,
            padding: "7px 9px", fontSize: 11.5, color: COLORS.text, width: 220,
            boxShadow: "0 8px 22px rgba(0,0,0,0.45)", whiteSpace: "pre-wrap", lineHeight: 1.4,
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

function eventMatchesClauses(ev, clauses) {
  const fieldValues = {
    location: (ev.locations || []).map((s) => s.toLowerCase()),
    locations: (ev.locations || []).map((s) => s.toLowerCase()),
    type: (ev.types || []).map((s) => s.toLowerCase()),
    types: (ev.types || []).map((s) => s.toLowerCase()),
    worker: (ev.workers || []).map((s) => s.toLowerCase()),
    workers: (ev.workers || []).map((s) => s.toLowerCase()),
    approver: (ev.approvedBy || []).map((s) => s.toLowerCase()),
    approvers: (ev.approvedBy || []).map((s) => s.toLowerCase()),
  };
  for (const c of clauses) {
    const vals = fieldValues[c.field];
    if (!vals) continue;
    for (const inc of c.include) if (!vals.some((v) => v.includes(inc))) return false;
    for (const exc of c.exclude) if (vals.some((v) => v.includes(exc))) return false;
  }
  return true;
}

// ---------- small UI atoms ----------
function IconBtn({ onClick, title, children, active }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 32, height: 32, borderRadius: 7, border: `1px solid ${active ? COLORS.accent : COLORS.line}`,
        background: active ? COLORS.accentDim : "transparent", color: active ? COLORS.accent : COLORS.muted,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Chip({ children, onRemove, tone }) {
  const toneColor = tone === "loc" ? "#7FB8E0" : tone === "type" ? COLORS.amber : "#B79AE0";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 6px",
      borderRadius: 5, background: "rgba(255,255,255,0.05)", border: `1px solid ${toneColor}55`,
      color: toneColor, marginRight: 4, marginBottom: 4, whiteSpace: "nowrap",
    }}>
      {children}
      {onRemove && (
        <X size={10} style={{ cursor: "pointer" }} onClick={onRemove} />
      )}
    </span>
  );
}

// ---------- Selector box (location / type / worker) ----------
// A single compact control standing in for what used to be three separate
// Location/Type/Worker boxes side by side. Each is now a narrow "chip" in
// one row — tap a chip to jump straight into that category's filtered list,
// or tap empty space in the box to see all three categories first. This is
// what actually saves the horizontal room those three full-width boxes
// needed, which three individually-narrower-but-still-separate boxes
// wouldn't have fixed on small phone screens.
function CombinedSelectorBox({ categories, selVal, recents, onPick, onDragPick, onTouchDragStart }) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(null); // null = category chooser view
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setActiveKey(null); setQuery(""); }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const active = categories.find((c) => c.key === activeKey);

  const ordered = useMemo(() => {
    if (!active) return [];
    const q = query.trim().toLowerCase();
    const rec = recents[active.key] || [];
    const base = [...active.options];
    base.sort((a, b) => {
      const ra = rec.indexOf(a), rb = rec.indexOf(b);
      return (ra === -1 ? 999 : ra) - (rb === -1 ? 999 : rb);
    });
    return q ? base.filter((o) => o.toLowerCase().includes(q)) : base;
  }, [active, query, recents]);

  function openCategory(key) {
    setActiveKey(key);
    setOpen(true);
    setQuery("");
  }

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 240 }}>
      <div
        onClick={() => { setOpen((o) => !o); setActiveKey(null); }}
        style={{
          display: "flex", alignItems: "stretch", gap: 2, border: `1px solid ${open ? COLORS.accent : COLORS.line}`,
          borderRadius: 8, background: COLORS.panel2, cursor: "pointer", userSelect: "none", overflow: "hidden",
        }}
      >
        {categories.map((c, i) => {
          const val = selVal[c.key];
          return (
            <div
              key={c.key}
              draggable={!!val}
              onDragStart={(e) => {
                if (!val) return;
                e.stopPropagation();
                e.dataTransfer.setData("application/json", JSON.stringify({ kind: c.key, value: val }));
                onDragPick(c.key, val);
              }}
              onTouchStart={(e) => {
                if (!val || !onTouchDragStart) return;
                e.stopPropagation();
                onTouchDragStart(e, c.key, val);
                onDragPick(c.key, val);
              }}
              onClick={(e) => { e.stopPropagation(); openCategory(c.key); }}
              title={val || undefined}
              style={{
                flex: 1, minWidth: 0, cursor: val ? "grab" : "pointer",
                padding: "6px 8px", borderLeft: i > 0 ? `1px solid ${COLORS.line}` : "none",
                background: open && activeKey === c.key ? "rgba(255,255,255,0.05)" : "transparent",
              }}
            >
              <div style={{ fontSize: 9, color: COLORS.faint, letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden" }}>{c.label}</div>
              <div style={{
                fontSize: 12.5, color: val ? c.color : COLORS.muted, marginTop: 1,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {val || "Any"}
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", alignItems: "center", padding: "0 8px", flexShrink: 0 }}>
          <ChevronDown size={14} color={COLORS.faint} />
        </div>
      </div>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 40,
          background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 8,
          boxShadow: "0 12px 28px rgba(0,0,0,0.45)", overflow: "hidden",
        }}>
          {!active ? (
            <div>
              {categories.map((c) => (
                <div
                  key={c.key}
                  onClick={() => openCategory(c.key)}
                  style={{
                    padding: "10px 12px", fontSize: 13, cursor: "pointer", color: COLORS.text,
                    borderBottom: `1px solid ${COLORS.lineSoft}`, display: "flex",
                    justifyContent: "space-between", gap: 8, minWidth: 0,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ flexShrink: 0 }}>{c.label}</span>
                  <span style={{ color: COLORS.faint, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selVal[c.key] || "Any"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: `1px solid ${COLORS.line}` }}>
                <button
                  onClick={() => setActiveKey(null)}
                  title="Back"
                  style={{ background: "transparent", border: "none", color: COLORS.faint, cursor: "pointer", fontSize: 14, padding: "0 2px", flexShrink: 0 }}
                >
                  {"\u2190"}
                </button>
                <Search size={13} color={COLORS.faint} style={{ flexShrink: 0 }} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Filter ${active.label.toLowerCase()}\u2026`}
                  style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: COLORS.text, fontSize: 12 }}
                />
              </div>
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {ordered.length === 0 && <div style={{ padding: 10, fontSize: 12, color: COLORS.faint }}>No matches</div>}
                {ordered.map((o) => (
                  <div
                    key={o}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/json", JSON.stringify({ kind: active.key, value: o }));
                      onDragPick(active.key, o);
                      setOpen(false); setActiveKey(null);
                    }}
                    onTouchStart={(e) => {
                      if (!onTouchDragStart) return;
                      onTouchDragStart(e, active.key, o);
                      onDragPick(active.key, o);
                      setOpen(false); setActiveKey(null);
                    }}
                    onClick={() => { onPick(active.key, o); setOpen(false); setActiveKey(null); setQuery(""); }}
                    style={{
                      padding: "8px 10px", fontSize: 13, cursor: "pointer", color: COLORS.text,
                      borderBottom: `1px solid ${COLORS.lineSoft}`, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    {o}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Event edit modal ----------
function EditEventModal({ ev, allLocations, allTypes, allWorkers, allApprovers, requiredApprovers, onSave, onDelete, onClose }) {
  const [locs, setLocs] = useState(ev.locations);
  const [types, setTypes] = useState(ev.types);
  const [workers, setWorkers] = useState(ev.workers);
  const [start, setStart] = useState(minsToInput(ev.startMinutes));
  const [dur, setDur] = useState(ev.duration);
  const [approvedBy, setApprovedBy] = useState(ev.approvedBy || []);
  const [notesFormat, setNotesFormat] = useState((ev.notes && ev.notes.format) || "text");
  const [notesContent, setNotesContent] = useState((ev.notes && ev.notes.content) || "");
  const [links, setLinks] = useState(ev.links || []);
  const [linkInput, setLinkInput] = useState("");
  const [linkDescInput, setLinkDescInput] = useState("");

  function minsToInput(m) { return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`; }

  const remainingApprovers = allApprovers.filter((a) => !approvedBy.includes(a));
  const fullyApproved = requiredApprovers.length > 0
    ? requiredApprovers.every((name) => approvedBy.includes(name))
    : approvedBy.length > 0;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 420, maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...modalHeaderStyle, flexShrink: 0 }}>
          <span>Edit work block</span>
          <X size={16} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Start time</label>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Duration (min)</label>
              <input type="number" min={15} step={15} value={dur} onChange={(e) => setDur(Number(e.target.value))} style={inputStyle} />
            </div>
          </div>

          <FieldEditor title="Locations" tone="loc" items={locs} all={allLocations}
            onRemove={(v) => setLocs(locs.filter((x) => x !== v))}
            onAdd={(v) => !locs.includes(v) && setLocs([...locs, v])} />
          <FieldEditor title="Types" tone="type" items={types} all={allTypes}
            onRemove={(v) => setTypes(types.filter((x) => x !== v))}
            onAdd={(v) => !types.includes(v) && setTypes([...types, v])} />
          <FieldEditor title="Workers" tone="worker" items={workers} all={allWorkers}
            onRemove={(v) => setWorkers(workers.filter((x) => x !== v))}
            onAdd={(v) => !workers.includes(v) && setWorkers([...workers, v])} />

          <div>
            <label style={labelStyle}>
              Approved by {requiredApprovers.length > 0 && (
                <span style={{ color: fullyApproved ? COLORS.accent : COLORS.faint }}>
                  ({approvedBy.filter((a) => requiredApprovers.includes(a)).length}/{requiredApprovers.length} required)
                </span>
              )}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", marginTop: 4 }}>
              {approvedBy.length === 0 && <span style={{ fontSize: 12, color: COLORS.faint }}>No approvals yet</span>}
              {approvedBy.map((v) => (
                <Chip key={v} tone="worker" onRemove={() => setApprovedBy(approvedBy.filter((x) => x !== v))}>
                  {v}{requiredApprovers.includes(v) ? "" : " (extra)"}
                </Chip>
              ))}
              {remainingApprovers.length > 0 && (
                <select
                  value=""
                  onChange={(e) => e.target.value && setApprovedBy([...approvedBy, e.target.value])}
                  style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 11, marginBottom: 4 }}
                >
                  <option value="">+ add approval…</option>
                  {remainingApprovers.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
            </div>
            {fullyApproved && <div style={{ fontSize: 11, color: COLORS.accent, marginTop: 4 }}>All required approvers have signed off.</div>}
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={labelStyle}>Notes</label>
              <select
                value={notesFormat}
                onChange={(e) => setNotesFormat(e.target.value)}
                style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 11 }}
              >
                <option value="text">Text</option>
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            <textarea
              value={notesContent}
              onChange={(e) => setNotesContent(e.target.value)}
              placeholder="Anything a worker or approver should know about this block…"
              rows={4}
              style={{
                ...inputStyle, marginTop: 4, resize: "vertical",
                fontFamily: notesFormat === "json" || notesFormat === "csv" ? "ui-monospace, monospace" : "inherit",
              }}
            />
          </div>

          <div>
            <label style={labelStyle}>Links</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              {links.map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <LinkIcon size={11} color={COLORS.faint} />
                  <a
                    href={l.url} target="_blank" rel="noopener noreferrer"
                    style={{ color: "#7FB8E0", textDecoration: "underline", wordBreak: "break-all" }}
                  >
                    {l.label}
                  </a>
                  <InlineInfoHover text={l.description} />
                  <X
                    size={11} color={COLORS.faint}
                    style={{ cursor: "pointer", marginLeft: "auto" }}
                    onClick={() => setLinks(links.filter((_, x) => x !== i))}
                  />
                </div>
              ))}
              {links.length === 0 && <span style={{ fontSize: 12, color: COLORS.faint }}>No links yet</span>}
            </div>
            <div style={{ marginTop: 8, padding: 8, background: COLORS.panel2, borderRadius: 6, border: `1px solid ${COLORS.line}` }}>
              <input
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                placeholder="[Site plan](https://example.com/plan.pdf) — or just paste a URL"
                style={{ ...inputStyle, fontSize: 11.5 }}
              />
              <input
                value={linkDescInput}
                onChange={(e) => setLinkDescInput(e.target.value)}
                placeholder="Description (optional) — shown on the info icon"
                style={{ ...inputStyle, fontSize: 11.5, marginTop: 6 }}
              />
              <button
                style={{ ...ghostBtnStyle, marginTop: 6, fontSize: 11, padding: "5px 10px" }}
                onClick={() => {
                  if (!linkInput.trim()) return;
                  const { label, url } = parseLinkSyntax(linkInput);
                  setLinks([...links, { label, url, description: linkDescInput.trim() }]);
                  setLinkInput("");
                  setLinkDescInput("");
                }}
              >
                <Plus size={12} /> Add link
              </button>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderTop: `1px solid ${COLORS.line}`, flexShrink: 0 }}>
          <button onClick={() => onDelete(ev.id)} style={dangerBtnStyle}><Trash2 size={13} /> Delete</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={ghostBtnStyle}>Cancel</button>
            <button
              onClick={() => {
                const [h, m] = start.split(":").map(Number);
                onSave(ev.id, {
                  locations: locs, types, workers, startMinutes: h * 60 + m, duration: Math.max(15, dur), approvedBy,
                  notes: { format: notesFormat, content: notesContent }, links,
                });
              }}
              style={primaryBtnStyle}
            >
              <Check size={13} /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldEditor({ title, tone, items, all, onRemove, onAdd }) {
  const remaining = all.filter((x) => !items.includes(x));
  return (
    <div>
      <label style={labelStyle}>{title}</label>
      <div style={{ display: "flex", flexWrap: "wrap", marginTop: 4 }}>
        {items.map((v) => <Chip key={v} tone={tone} onRemove={() => onRemove(v)}>{v}</Chip>)}
        {remaining.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && onAdd(e.target.value)}
            style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 11, marginBottom: 4 }}
          >
            <option value="">+ add…</option>
            {remaining.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

// ---------- Config modal ----------
function ConfigModal({ users, setUsers, locations, setLocations, workTypes, setWorkTypes, requiredApprovers, setRequiredApprovers, showEventIds, setShowEventIds, onClose }) {
  const [tab, setTab] = useState("users");
  const [newLogin, setNewLogin] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [newLoc, setNewLoc] = useState("");
  const [newType, setNewType] = useState("");
  const [bulkNames, setBulkNames] = useState("");
  const [bulkLocText, setBulkLocText] = useState("");
  const [bulkTypeText, setBulkTypeText] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy list");

  function parseNameList(str) {
    return str.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || uid("user");
  }
  function addBulkUsers() {
    const names = parseNameList(bulkNames);
    if (names.length === 0) return;
    const existingAliases = new Set(users.map((u) => u.alias.toLowerCase()));
    const additions = names
      .filter((n) => !existingAliases.has(n.toLowerCase()))
      .map((n) => ({ id: uid("u"), login: slugify(n), alias: n, isWorker: true, isApprover: false }));
    if (additions.length) setUsers([...users, ...additions]);
    setBulkNames("");
  }
  function copyRequiredApprovers() {
    const text = requiredApprovers.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopyLabel("Copied!");
        setTimeout(() => setCopyLabel("Copy list"), 1400);
      }).catch(() => {});
    }
  }
  const approverEligible = users.filter((u) => u.isApprover);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 620, maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...modalHeaderStyle, flexShrink: 0 }}>
          <span>Configuration</span>
          <X size={16} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div style={{ display: "flex", gap: 4, padding: "10px 16px 0", flexShrink: 0 }}>
          {["users", "locations", "types", "approvals", "view"].map((t) => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                padding: "6px 12px", borderRadius: "6px 6px 0 0", border: "none", cursor: "pointer",
                background: tab === t ? COLORS.panel2 : "transparent",
                color: tab === t ? COLORS.text : COLORS.muted, fontSize: 12, textTransform: "capitalize",
                borderBottom: tab === t ? `2px solid ${COLORS.accent}` : "2px solid transparent",
              }}>{t}</button>
          ))}
        </div>
        <div style={{ padding: 16, overflowY: "auto", minHeight: 0, flex: 1 }}>
          {tab === "users" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input placeholder="Login name" value={newLogin} onChange={(e) => setNewLogin(e.target.value)} style={inputStyle} />
                <input placeholder="Alias (display name)" value={newAlias} onChange={(e) => setNewAlias(e.target.value)} style={inputStyle} />
                <button
                  style={primaryBtnStyle}
                  onClick={() => {
                    if (!newLogin.trim()) return;
                    setUsers([...users, { id: uid("u"), login: newLogin.trim(), alias: newAlias.trim() || newLogin.trim(), isWorker: true, isApprover: false }]);
                    setNewLogin(""); setNewAlias("");
                  }}
                ><Plus size={13} /> Add</button>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: COLORS.faint, textAlign: "left" }}>
                    <th style={thStyle}>Login</th><th style={thStyle}>Alias</th>
                    <th style={thStyle}>Worker</th><th style={thStyle}>Approver</th><th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ borderTop: `1px solid ${COLORS.lineSoft}` }}>
                      <td style={tdStyle}>{u.login}</td>
                      <td style={tdStyle}>
                        <input value={u.alias} onChange={(e) => setUsers(users.map((x) => x.id === u.id ? { ...x, alias: e.target.value } : x))}
                          style={{ ...inputStyle, padding: "3px 6px" }} />
                      </td>
                      <td style={tdStyle}><input type="checkbox" checked={u.isWorker} onChange={(e) => setUsers(users.map((x) => x.id === u.id ? { ...x, isWorker: e.target.checked } : x))} /></td>
                      <td style={tdStyle}><input type="checkbox" checked={u.isApprover} onChange={(e) => setUsers(users.map((x) => x.id === u.id ? { ...x, isApprover: e.target.checked } : x))} /></td>
                      <td style={tdStyle}><Trash2 size={13} style={{ cursor: "pointer", color: COLORS.faint }} onClick={() => setUsers(users.filter((x) => x.id !== u.id))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${COLORS.lineSoft}` }}>
                <label style={labelStyle}>Bulk add — paste a name list (one per line, or comma-separated)</label>
                <textarea
                  value={bulkNames}
                  onChange={(e) => setBulkNames(e.target.value)}
                  placeholder={"Paste names here, e.g. from the Approvals tab's copy button…"}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                />
                <button style={{ ...primaryBtnStyle, marginTop: 6 }} onClick={addBulkUsers}><Plus size={13} /> Add all as users</button>
              </div>
            </div>
          )}
          {tab === "locations" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input placeholder="Location name" value={newLoc} onChange={(e) => setNewLoc(e.target.value)} style={inputStyle} />
                <button style={primaryBtnStyle} onClick={() => { if (!newLoc.trim()) return; setLocations([...locations, { id: uid("l"), name: newLoc.trim() }]); setNewLoc(""); }}><Plus size={13} /> Add</button>
              </div>
              {locations.map((l) => (
                <div key={l.id} style={rowStyle}>
                  <span>{l.name}</span>
                  <Trash2 size={13} style={{ cursor: "pointer", color: COLORS.faint }} onClick={() => setLocations(locations.filter((x) => x.id !== l.id))} />
                </div>
              ))}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${COLORS.lineSoft}` }}>
                <label style={labelStyle}>Bulk add — one per line, or comma-separated</label>
                <textarea
                  value={bulkLocText}
                  onChange={(e) => setBulkLocText(e.target.value)}
                  placeholder={"North Yard, Warehouse 3, Site B - Riverside…"}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                />
                <button
                  style={{ ...primaryBtnStyle, marginTop: 6 }}
                  onClick={() => {
                    const names = parseNameList(bulkLocText);
                    const existing = new Set(locations.map((l) => l.name.toLowerCase()));
                    const additions = names.filter((n) => !existing.has(n.toLowerCase())).map((n) => ({ id: uid("l"), name: n }));
                    if (additions.length) setLocations([...locations, ...additions]);
                    setBulkLocText("");
                  }}
                ><Plus size={13} /> Add all</button>
              </div>
            </div>
          )}
          {tab === "types" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input placeholder="Work type name" value={newType} onChange={(e) => setNewType(e.target.value)} style={inputStyle} />
                <button style={primaryBtnStyle} onClick={() => { if (!newType.trim()) return; setWorkTypes([...workTypes, { id: uid("t"), name: newType.trim() }]); setNewType(""); }}><Plus size={13} /> Add</button>
              </div>
              {workTypes.map((t) => (
                <div key={t.id} style={rowStyle}>
                  <span>{t.name}</span>
                  <Trash2 size={13} style={{ cursor: "pointer", color: COLORS.faint }} onClick={() => setWorkTypes(workTypes.filter((x) => x.id !== t.id))} />
                </div>
              ))}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${COLORS.lineSoft}` }}>
                <label style={labelStyle}>Bulk add — one per line, or comma-separated</label>
                <textarea
                  value={bulkTypeText}
                  onChange={(e) => setBulkTypeText(e.target.value)}
                  placeholder={"Install, Maintenance, Inspection…"}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                />
                <button
                  style={{ ...primaryBtnStyle, marginTop: 6 }}
                  onClick={() => {
                    const names = parseNameList(bulkTypeText);
                    const existing = new Set(workTypes.map((t) => t.name.toLowerCase()));
                    const additions = names.filter((n) => !existing.has(n.toLowerCase())).map((n) => ({ id: uid("t"), name: n }));
                    if (additions.length) setWorkTypes([...workTypes, ...additions]);
                    setBulkTypeText("");
                  }}
                ><Plus size={13} /> Add all</button>
              </div>
            </div>
          )}
          {tab === "approvals" && (
            <div>
              <label style={labelStyle}>
                Required approvers — every name here must approve a work block before it turns green
              </label>
              <textarea
                value={requiredApprovers.join("\n")}
                onChange={(e) => setRequiredApprovers(parseNameList(e.target.value))}
                placeholder={"One name per line, or comma-separated…"}
                rows={5}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button style={ghostBtnStyle} onClick={copyRequiredApprovers}>{copyLabel}</button>
                <span style={{ fontSize: 11, color: COLORS.faint, alignSelf: "center" }}>
                  Select all and copy, then paste into the bulk-add box on the Users tab to reuse this list.
                </span>
              </div>

              {approverEligible.length > 0 && (
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${COLORS.lineSoft}` }}>
                  <label style={labelStyle}>Quick toggle from existing approvers</label>
                  {approverEligible.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "5px 0", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={requiredApprovers.includes(u.alias)}
                        onChange={(e) => {
                          if (e.target.checked) setRequiredApprovers([...requiredApprovers, u.alias]);
                          else setRequiredApprovers(requiredApprovers.filter((n) => n !== u.alias));
                        }}
                      />
                      {u.alias}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === "view" && (
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: COLORS.text, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showEventIds}
                  onChange={(e) => setShowEventIds(e.target.checked)}
                />
                Show event ID on calendar blocks
              </label>
              <div style={{ fontSize: 11, color: COLORS.faint, marginTop: 6, marginLeft: 24 }}>
                Prints each block's underlying database ID (e.g. <code>ev_a1b2c3</code>) in small text
                on the block itself — useful when cross-referencing an export or a support request
                against what's on screen. This is just a display preference (saved in this browser),
                not something exported or synced.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Export modal ----------
function ExportModal({ events, requiredApprovers, onClose }) {
  const [from, setFrom] = useState(addDays(isoDate(new Date()), -7));
  const [to, setTo] = useState(addDays(isoDate(new Date()), 7));
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [tz, setTz] = useState("local"); // "local" | "utc"
  const [includeId, setIncludeId] = useState(false);
  const tzName = localTZName();

  function flattenLinks(links) {
    return (links || []).map((l) => {
      let s = `${l.label} (${l.url})`;
      if (l.description) s += ` \u2014 ${l.description}`;
      return s;
    }).join(" | ");
  }

  function buildRows(structured) {
    const clauses = parseFilterSyntax(filter);
    const fromE = epochDay(from), toE = epochDay(to);
    const useUTC = tz === "utc";
    const rows = events
      .filter((ev) => {
        const ed = epochDay(ev.date);
        return ed >= fromE && ed <= toE;
      })
      .filter((ev) => eventMatchesClauses(ev, clauses))
      .map((ev) => {
        const s = fmtInTZ(eventStartDate(ev), useUTC);
        const e = fmtInTZ(eventEndDate(ev), useUTC);
        const base = {
          ...(includeId ? { id: ev.id } : {}),
          date: s.date,
          start: s.time,
          end: e.time,
          timezone: useUTC ? "UTC" : tzName,
          startSort: eventStartDate(ev).getTime(),
          workers: ev.workers.join("; "),
          locations: ev.locations.join("; "),
          types: ev.types.join("; "),
          approvedBy: (ev.approvedBy || []).join("; "),
          fullyApproved: isFullyApproved(ev, requiredApprovers) ? "Yes" : "No",
        };
        return structured
          ? { ...base, notes: ev.notes || { format: "text", content: "" }, links: ev.links || [] }
          : {
              ...base,
              notesFormat: (ev.notes && ev.notes.format) || "text",
              notes: (ev.notes && ev.notes.content) || "",
              links: flattenLinks(ev.links),
            };
      })
      .sort((a, b) => a.startSort - b.startSort)
      .map(({ startSort, ...r }) => r);
    return rows;
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function doExport(kind) {
    try {
      const rows = buildRows(kind === "json");
      setError("");
      if (rows.length === 0) { setError("No rows match this range and filter."); return; }
      if (kind === "csv") {
        const headers = [...(includeId ? ["id"] : []), "date", "start", "end", "timezone", "workers", "locations", "types", "approvedBy", "fullyApproved", "notesFormat", "notes", "links"];
        const csv = [headers.join(",")].concat(
          rows.map((r) => headers.map((h) => `"${String(r[h]).replace(/"/g, '""')}"`).join(","))
        ).join("\n");
        download("schedule_export.csv", new Blob([csv], { type: "text/csv" }));
      } else if (kind === "json") {
        download("schedule_export.json", new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
      } else if (kind === "xlsx") {
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Schedule");
        const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        download("schedule_export.xlsx", new Blob([arr], { type: "application/octet-stream" }));
      }
    } catch (e) {
      setError("Filter syntax error — check brackets and field names.");
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 480, maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...modalHeaderStyle, flexShrink: 0 }}><span>Export schedule</span><X size={16} style={{ cursor: "pointer" }} onClick={onClose} /></div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={labelStyle}>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} /></div>
            <div style={{ flex: 1 }}><label style={labelStyle}>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} /></div>
          </div>
          <div>
            <label style={labelStyle}>Times shown as</label>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setTz("local")}
                style={tz === "local" ? primaryBtnStyle : ghostBtnStyle}
              >Local ({tzName})</button>
              <button
                onClick={() => setTz("utc")}
                style={tz === "utc" ? primaryBtnStyle : ghostBtnStyle}
              >UTC</button>
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: COLORS.muted, cursor: "pointer" }}>
            <input type="checkbox" checked={includeId} onChange={(e) => setIncludeId(e.target.checked)} />
            Include event ID column
          </label>
          <div>
            <label style={labelStyle}>Filter</label>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder='location:[North Yard] & type:[! Cleanup]'
              style={inputStyle}
            />
            <div style={{ fontSize: 11, color: COLORS.faint, marginTop: 4 }}>
              Fields: location, type, worker. <code>field:[a &amp; b]</code> requires both, <code>field:[! a]</code> excludes a. Join clauses with &amp;.
            </div>
          </div>
          {error && <div style={{ fontSize: 12, color: COLORS.danger }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button style={primaryBtnStyle} onClick={() => doExport("csv")}><Download size={13} /> CSV</button>
            <button style={primaryBtnStyle} onClick={() => doExport("json")}><Download size={13} /> JSON</button>
            <button style={primaryBtnStyle} onClick={() => doExport("xlsx")}><Download size={13} /> Excel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Bulk JSON import modal ----------
function BulkImportModal({ onImport, onClose }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const example = `[
  {
    "date": "2026-09-10",
    "start": "08:00",
    "duration": 90,
    "locations": ["North Yard"],
    "types": ["Install"],
    "workers": ["J. Martinez", "A. Smith"],
    "approvedBy": [],
    "notes": { "format": "text", "content": "Bring extra conduit" },
    "links": [{ "label": "Site plan", "url": "https://example.com/plan.pdf", "description": "Marked-up PDF" }]
  }
]`;

  function runImport() {
    try {
      const { added, errors } = parseBulkEventsJSON(text);
      if (added.length) onImport(added);
      setResult({ addedCount: added.length, errors });
    } catch (e) {
      setResult({ addedCount: 0, errors: [e.message] });
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 540, maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...modalHeaderStyle, flexShrink: 0 }}>
          <span>Bulk add work blocks</span>
          <X size={16} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", minHeight: 0 }}>
          <div style={{ fontSize: 11, color: COLORS.faint }}>
            Paste a JSON array of blocks. Each item needs <code>date</code> ("YYYY-MM-DD"),{" "}
            <code>start</code> ("HH:MM", 24-hour) and <code>duration</code> (minutes).{" "}
            <code>locations</code>, <code>types</code>, <code>workers</code> and <code>approvedBy</code> are
            optional arrays of names — anything not on file yet in Config still gets added to the block as text.{" "}
            <code>notes</code> (<code>{"{format, content}"}</code>, format is text/json/csv/markdown) and{" "}
            <code>links</code> (array of <code>{"{label, url, description}"}</code>) are also optional.
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={example}
            rows={11}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", fontSize: 11.5, resize: "vertical" }}
          />
          {result && (
            <div style={{ fontSize: 12, color: result.errors.length ? COLORS.amber : COLORS.accent }}>
              Added {result.addedCount} block{result.addedCount === 1 ? "" : "s"}.
              {result.errors.length > 0 && (
                <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                  {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px", borderTop: `1px solid ${COLORS.line}`, flexShrink: 0 }}>
          <button onClick={onClose} style={ghostBtnStyle}>Close</button>
          <button onClick={runImport} style={primaryBtnStyle}><Plus size={13} /> Import</button>
        </div>
      </div>
    </div>
  );
}

// ---------- shared style objects ----------
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 };
const modalStyle = { background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 10, color: COLORS.text, fontFamily: "system-ui, sans-serif" };
const modalHeaderStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${COLORS.line}`, fontSize: 14, fontWeight: 600 };
const labelStyle = { fontSize: 11, color: COLORS.faint, display: "block", marginBottom: 3 };
const inputStyle = { width: "100%", background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "7px 9px", color: COLORS.text, fontSize: 12, outline: "none", boxSizing: "border-box" };
const thStyle = { padding: "4px 6px", fontWeight: 500 };
const tdStyle = { padding: "5px 6px" };
const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 4px", borderBottom: `1px solid ${COLORS.lineSoft}`, fontSize: 13 };
const primaryBtnStyle = { display: "flex", alignItems: "center", gap: 6, background: COLORS.accent, color: "#0D1512", border: "none", borderRadius: 7, padding: "7px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const ghostBtnStyle = { background: "transparent", color: COLORS.muted, border: `1px solid ${COLORS.line}`, borderRadius: 7, padding: "7px 12px", fontSize: 12, cursor: "pointer" };
const dangerBtnStyle = { display: "flex", alignItems: "center", gap: 6, background: "transparent", color: COLORS.danger, border: `1px solid ${COLORS.danger}55`, borderRadius: 7, padding: "7px 12px", fontSize: 12, cursor: "pointer" };

// ---------- info popup: full block details on hover ----------
function BlockInfoPopup({ ev, corner, requiredApprovers, onMouseEnter, onMouseLeave }) {
  const approvedBy = ev.approvedBy || [];
  const fullyApproved = isFullyApproved(ev, requiredApprovers);
  const endDay = eventEndDay(ev);
  const endMinutes = (ev.startMinutes + ev.duration) % 1440;
  const timeRange = `${minsToLabel(ev.startMinutes)} \u2013 ${minsToLabel(endMinutes)}`
    + (endDay !== ev.date ? ` (${fmtDateShort(endDay)})` : "");
  const hasNotes = ev.notes && ev.notes.content && ev.notes.content.trim();

  const posStyle = corner === "bottom-right"
    ? { bottom: 16, right: 16 }
    : { bottom: 16, left: 16 };

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed", ...posStyle, zIndex: 80, width: 300, maxHeight: "60vh", overflowY: "auto",
        background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 10,
        boxShadow: "0 16px 36px rgba(0,0,0,0.5)", padding: 14, fontSize: 12.5, color: COLORS.text,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 12, color: COLORS.faint }}>{fmtDateShort(ev.date)}</div>
        <div style={{ fontSize: 9.5, color: COLORS.faint, fontFamily: "ui-monospace, monospace" }}>{ev.id}</div>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{timeRange}</div>

      {ev.locations.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: COLORS.faint }}>LOCATIONS</div>
          <div style={{ marginTop: 3 }}>{ev.locations.map((l) => <Chip key={l} tone="loc">{l}</Chip>)}</div>
        </div>
      )}
      {ev.types.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: COLORS.faint }}>TYPES</div>
          <div style={{ marginTop: 3 }}>{ev.types.map((t) => <Chip key={t} tone="type">{t}</Chip>)}</div>
        </div>
      )}
      {ev.workers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: COLORS.faint }}>WORKERS</div>
          <div style={{ marginTop: 3 }}>{ev.workers.map((w) => <Chip key={w} tone="worker">{w}</Chip>)}</div>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 10, color: COLORS.faint }}>APPROVAL</div>
        <div style={{ marginTop: 3, color: fullyApproved ? COLORS.accent : approvedBy.length ? COLORS.amber : COLORS.faint }}>
          {approvedBy.length === 0 ? "No approvals yet" : `Approved by ${approvedBy.join(", ")}`}
          {fullyApproved && " \u2014 fully approved"}
        </div>
      </div>

      {hasNotes && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: COLORS.faint }}>NOTES ({ev.notes.format})</div>
          <div style={{
            marginTop: 3, whiteSpace: "pre-wrap", fontFamily: ev.notes.format === "json" || ev.notes.format === "csv" ? "ui-monospace, monospace" : "inherit",
            fontSize: 11.5, lineHeight: 1.4, background: COLORS.panel2, borderRadius: 6, padding: "6px 8px",
          }}>
            {ev.notes.content}
          </div>
        </div>
      )}

      {ev.links && ev.links.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: COLORS.faint }}>LINKS</div>
          <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 3 }}>
            {ev.links.map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <LinkIcon size={10} color={COLORS.faint} />
                <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#7FB8E0", textDecoration: "underline", wordBreak: "break-all" }}>
                  {l.label}
                </a>
                <InlineInfoHover text={l.description} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- context create-menu (right click) ----------
function ContextCreateMenu({ x, y, locations, types, workers, onCreate, onClose }) {
  const [loc, setLoc] = useState(null);
  const [type, setType] = useState(null);
  const [worker, setWorker] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div ref={ref} style={{
      position: "fixed", left: x, top: y, zIndex: 90, background: COLORS.panel,
      border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 10, width: 220,
      boxShadow: "0 12px 28px rgba(0,0,0,0.5)", color: COLORS.text, fontSize: 12,
    }}>
      <div style={{ fontSize: 11, color: COLORS.faint, marginBottom: 6 }}>New work block</div>
      {[["Location", locations, loc, setLoc], ["Type", types, type, setType], ["Worker", workers, worker, setWorker]].map(([label, opts, val, setVal]) => (
        <select key={label} value={val || ""} onChange={(e) => setVal(e.target.value || null)} style={{ ...inputStyle, marginBottom: 6 }}>
          <option value="">{label}…</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ))}
      <button style={{ ...primaryBtnStyle, width: "100%", justifyContent: "center" }}
        onClick={() => onCreate({ loc, type, worker })}>
        <Plus size={13} /> Create
      </button>
    </div>
  );
}

// ==================================================================
function WorkSchedulePlanner() {
  const [users, setUsers] = useState(seedUsers);
  const [locations, setLocations] = useState(seedLocations);
  const [workTypes, setWorkTypes] = useState(seedTypes);
  const monday = mondayOf(new Date());
  const [events, setEvents] = useState(() => seedEvents(monday));
  const [requiredApprovers, setRequiredApprovers] = useState(seedRequiredApprovers);

  // Whether server/app.py is actually reachable. Starts "unknown" (null) so
  // the UI doesn't flash a "local only" badge before the initial load has
  // even had a chance to succeed.
  const [apiAvailable, setApiAvailable] = useState(null);
  const apiAvailableRef = useRef(false);

  // Every apiRequest() call — not just the initial load — reports its
  // success/failure here, so if the backend dies mid-session the badge
  // reflects that on the very next edit instead of staying stuck on
  // whatever it said at load time. If the backend comes back later, the
  // next successful request flips it back automatically.
  useEffect(() => {
    apiStatusListener = (ok) => {
      apiAvailableRef.current = ok;
      setApiAvailable(ok);
    };
    return () => { apiStatusListener = null; };
  }, []);

  // Save-lifecycle tracking, separate from the connectivity check above:
  // this drives red/green specifically for "did my last edit actually get
  // saved", which is a more direct question than "is a backend reachable
  // at all". Red the instant an edit is sent, green only once the backend
  // has actually confirmed it — and it stays red (doesn't quietly flip back
  // to green) if that confirmation never comes.
  const [pendingSaves, setPendingSaves] = useState(0);
  const [hasSaveError, setHasSaveError] = useState(false);
  async function trackedApiRequest(method, path, body) {
    setPendingSaves((n) => n + 1);
    const result = await apiRequest(method, path, body);
    setPendingSaves((n) => Math.max(0, n - 1));
    setHasSaveError(result === null);
    return result;
  }

  // Load persisted state on first mount. If nothing answers (e.g. the page
  // was opened directly via `python -m http.server`, with no server/app.py
  // running), silently keep the built-in seed data and work in memory only.
  const [isSnapshotMode, setIsSnapshotMode] = useState(false);

  // Purely a display preference (not part of the shared schedule data), so
  // it's kept in this browser via localStorage rather than synced to the API.
  const [showEventIds, setShowEventIds] = useState(() => {
    try { return localStorage.getItem("schedule_showEventIds") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("schedule_showEventIds", showEventIds ? "1" : "0"); } catch { /* ignore (private browsing, etc.) */ }
  }, [showEventIds]);

  useEffect(() => {
    // A standalone exported copy (see downloadStandaloneSnapshot) embeds its
    // data directly in the page instead of fetching it from an API. If
    // that's present, use it and skip the network entirely — this is what
    // makes the exported file work fully offline via file://.
    if (typeof window !== "undefined" && window.__SCHEDULE_SNAPSHOT__) {
      const snap = window.__SCHEDULE_SNAPSHOT__;
      if (snap.users) setUsers(snap.users);
      if (snap.locations) setLocations(snap.locations);
      if (snap.workTypes) setWorkTypes(snap.workTypes);
      if (snap.requiredApprovers) setRequiredApprovers(snap.requiredApprovers);
      if (snap.events) setEvents(snap.events);
      apiAvailableRef.current = false;
      setApiAvailable(false);
      setIsSnapshotMode(true);
      return;
    }

    let cancelled = false;
    (async () => {
      const [u, l, t, ra, ev] = await Promise.all([
        apiRequest("GET", "/users"),
        apiRequest("GET", "/locations"),
        apiRequest("GET", "/work_types"),
        apiRequest("GET", "/required_approvers"),
        apiRequest("GET", "/events"),
      ]);
      if (cancelled) return;
      const ok = u && l && t && ra && ev;
      apiAvailableRef.current = !!ok;
      setApiAvailable(!!ok);
      if (ok) {
        setUsers(u);
        setLocations(l);
        setWorkTypes(t);
        setRequiredApprovers(ra);
        setEvents(ev);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Wrapped setters for the three plain config lists. The Config modal still
  // just calls these the same way it always called setUsers/etc — array in,
  // array out — so no changes were needed there; the diffing + API calls
  // happen transparently in between.
  function setUsersSynced(next) {
    setUsers((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!isSnapshotMode) {
        syncListToApi("users", (u) => ({ login: u.login, alias: u.alias, isWorker: u.isWorker, isApprover: u.isApprover }),
          prev, resolved, (oldId, newId) => setUsers((cur) => cur.map((x) => x.id === oldId ? { ...x, id: newId } : x)), trackedApiRequest);
      }
      return resolved;
    });
  }
  function setLocationsSynced(next) {
    setLocations((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!isSnapshotMode) {
        syncListToApi("locations", (l) => ({ name: l.name }), prev, resolved,
          (oldId, newId) => setLocations((cur) => cur.map((x) => x.id === oldId ? { ...x, id: newId } : x)), trackedApiRequest);
      }
      return resolved;
    });
  }
  function setWorkTypesSynced(next) {
    setWorkTypes((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!isSnapshotMode) {
        syncListToApi("work_types", (t) => ({ name: t.name }), prev, resolved,
          (oldId, newId) => setWorkTypes((cur) => cur.map((x) => x.id === oldId ? { ...x, id: newId } : x)), trackedApiRequest);
      }
      return resolved;
    });
  }
  function setRequiredApproversSynced(next) {
    setRequiredApprovers((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!isSnapshotMode) trackedApiRequest("PUT", "/required_approvers", { names: resolved });
      return resolved;
    });
  }

  const [rangeStart, setRangeStart] = useState(monday);
  const [rangeDays, setRangeDays] = useState(7);

  const [currentUserId, setCurrentUserId] = useState("u4");
  const currentUser = users.find((u) => u.id === currentUserId) || users[0]
    || { id: null, login: "", alias: "(no users yet)", isWorker: false, isApprover: false };

  const [configOpen, setConfigOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");

  // Bundles a fully self-contained copy of this app — React/ReactDOM/xlsx
  // and the compiled app itself, all inlined — with the current schedule
  // embedded as data, so someone with no access to this server can open
  // the file directly (file://), view/edit it, and use the regular Export
  // button to send their changes back as CSV/JSON/Excel. Requires this page
  // to currently be served (so it can read its own vendor/app.js files);
  // the resulting downloaded file has no such requirement.
  function escapeForInlineScript(s) {
    return s.replace(/<\/script/gi, "<\\/script");
  }
  async function downloadStandaloneSnapshot() {
    setSnapshotBusy(true);
    setSnapshotError("");
    try {
      const [reactJs, reactDomJs, xlsxJs, appJs] = await Promise.all([
        fetch("vendor/react.production.min.js").then((r) => { if (!r.ok) throw new Error("vendor/react.production.min.js"); return r.text(); }),
        fetch("vendor/react-dom.production.min.js").then((r) => { if (!r.ok) throw new Error("vendor/react-dom.production.min.js"); return r.text(); }),
        fetch("vendor/xlsx.full.min.js").then((r) => { if (!r.ok) throw new Error("vendor/xlsx.full.min.js"); return r.text(); }),
        fetch("app.js").then((r) => { if (!r.ok) throw new Error("app.js"); return r.text(); }),
      ]);
      const snapshot = { users, locations, workTypes, requiredApprovers, events, exportedAt: new Date().toISOString() };
      const snapshotJson = escapeForInlineScript(JSON.stringify(snapshot));
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Field Schedule (offline copy)</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0A0D10; }
  #root { height: 100vh; padding: 16px; box-sizing: border-box; color: #E7EBEE; font-family: system-ui, sans-serif; }
  * { box-sizing: border-box; }
</style>
</head>
<body>
<div id="root">Loading\u2026</div>
<script>${escapeForInlineScript(reactJs)}</script>
<script>${escapeForInlineScript(reactDomJs)}</script>
<script>${escapeForInlineScript(xlsxJs)}</script>
<script>window.__SCHEDULE_SNAPSHOT__ = ${snapshotJson};</script>
<script>${escapeForInlineScript(appJs)}</script>
</body>
</html>
`;
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `field-schedule-offline-${isoDate(new Date())}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setSnapshotError(`Couldn't build the offline copy \u2014 failed to load ${e.message}.`);
    } finally {
      setSnapshotBusy(false);
    }
  }
  const [editingId, setEditingId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [infoPopup, setInfoPopup] = useState(null); // { id, corner: "bottom-right" | "bottom-left" }
  const infoCloseTimer = useRef(null);
  // Coarse-pointer / touch devices don't really have "hover" — tapping a
  // tiny info icon precisely is fiddly there too, so on those devices the
  // info icon jumps straight to the edit modal instead of showing a popup.
  const isTouchDevice = useMemo(() => {
    if (typeof window === "undefined") return false;
    return (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || "ontouchstart" in window;
  }, []);
  function openInfoPopup(id, corner) {
    if (infoCloseTimer.current) { clearTimeout(infoCloseTimer.current); infoCloseTimer.current = null; }
    setInfoPopup({ id, corner });
  }
  function scheduleCloseInfoPopup() {
    infoCloseTimer.current = setTimeout(() => setInfoPopup(null), 150);
  }

  const [recents, setRecents] = useState({ loc: [], type: [], worker: [] });
  const [selVal, setSelVal] = useState({ loc: null, type: null, worker: null });

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [marquee, setMarquee] = useState(null); // {x0,y0,x1,y1,col}

  // Column widths in px, one per visible day. null = split the available
  // screen width evenly. Dragging a divider (at the header) grows/shrinks
  // that column only — the grid is allowed to grow past the viewport width,
  // scrolling horizontally, rather than always being squeezed to fit.
  const [colWidths, setColWidths] = useState(null);
  const dividerDrag = useRef(null);

  const gridRef = useRef(null);
  const colRefs = useRef([]);
  const moveState = useRef(null);

  const locationNames = locations.map((l) => l.name);
  const typeNames = workTypes.map((t) => t.name);
  const workerNames = users.filter((u) => u.isWorker).map((u) => u.alias);

  const days = useMemo(() => Array.from({ length: rangeDays }, (_, i) => addDays(rangeStart, i)), [rangeStart, rangeDays]);

  // How far each day column bleeds into its neighbors, in hours. A block that
  // runs deep past midnight needs enough bleed to render in full further down
  // (or up) in the next/previous column instead of getting clipped/"ghosted".
  const peekHours = useMemo(() => {
    let overflowMin = 0;
    for (const ev of events) {
      const endRel = ev.startMinutes + ev.duration;
      if (endRel > DAY_MIN) overflowMin = Math.max(overflowMin, endRel - DAY_MIN);
      if (ev.startMinutes < 0) overflowMin = Math.max(overflowMin, -ev.startMinutes);
    }
    const hours = Math.ceil(overflowMin / 60) + 1;
    return Math.min(PEEK_HOURS_MAX, Math.max(PEEK_HOURS_MIN, hours));
  }, [events]);

  // Reset to an even split whenever the visible date range changes shape.
  useEffect(() => { setColWidths(null); }, [days.length]);

  function startColResize(e, index) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    e.stopPropagation();
    const widths = colWidths
      ? [...colWidths]
      : days.map((d) => colRefs.current[d]?.getBoundingClientRect().width || 160);
    dividerDrag.current = { index, startX: e.clientX, widths };
    document.addEventListener("pointermove", onColResizeMove);
    document.addEventListener("pointerup", onColResizeEnd);
    document.addEventListener("pointercancel", onColResizeEnd);
  }
  function onColResizeMove(e) {
    const dd = dividerDrag.current;
    if (!dd) return;
    const dx = e.clientX - dd.startX;
    const minW = MIN_COL_WIDTH;
    const next = [...dd.widths];
    next[dd.index] = Math.max(minW, dd.widths[dd.index] + dx);
    setColWidths(next);
  }
  function onColResizeEnd() {
    dividerDrag.current = null;
    document.removeEventListener("pointermove", onColResizeMove);
    document.removeEventListener("pointerup", onColResizeEnd);
    document.removeEventListener("pointercancel", onColResizeEnd);
  }

  function bumpRecent(kind, value) {
    setRecents((r) => ({ ...r, [kind]: [value, ...r[kind].filter((x) => x !== value)] }));
  }
  function pick(kind, value) {
    setSelVal((s) => ({ ...s, [kind]: value }));
    bumpRecent(kind, value);
  }

  // ---- event helpers ----
  function updateEventLocal(id, patch) {
    setEvents((evs) => evs.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function updateEvent(id, patch) {
    updateEventLocal(id, patch);
    if (!isSnapshotMode) trackedApiRequest("PUT", `/events/${id}`, patch);
  }
  function deleteEvent(id) {
    setEvents((evs) => evs.filter((e) => e.id !== id));
    setSelectedIds((s) => { const n = new Set(s); n.delete(id); return n; });
    setEditingId(null);
    if (!isSnapshotMode) trackedApiRequest("DELETE", `/events/${id}`);
  }
  function createEvent({ date, startMinutes, loc, type, worker }) {
    const localEvent = {
      id: uid("ev"), date, startMinutes: snap(startMinutes), duration: MIN_DUR,
      locations: loc ? [loc] : [], types: type ? [type] : [], workers: worker ? [worker] : [], approvedBy: [],
      notes: { format: "text", content: "" }, links: [],
    };
    setEvents((evs) => [...evs, localEvent]);
    if (!isSnapshotMode) {
      trackedApiRequest("POST", "/events", localEvent).then((created) => {
        if (created && created.id && created.id !== localEvent.id) {
          setEvents((evs) => evs.map((e) => e.id === localEvent.id ? { ...e, id: created.id } : e));
        }
      });
    }
  }
  function snap(m) { return Math.round(m / SNAP) * SNAP; }

  // ---- drop on column background: create new ----
  // Shared by both native HTML5 drag-and-drop (desktop) and the touch-drag
  // implementation below (mobile — HTML5 DnD never fires from touch input,
  // so dragging a selector onto the calendar silently did nothing on
  // phones/tablets until this existed).
  function applyDropOnColumn(payload, date, clientY) {
    if (!payload) return;
    const col = colRefs.current[date];
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const y = clientY - rect.top;
    const minutesFromTop = (y / HOUR_PX) * 60 - peekHours * 60;
    const start = snap(minutesFromTop);
    createEvent({
      date, startMinutes: start,
      loc: payload.kind === "loc" ? payload.value : null,
      type: payload.kind === "type" ? payload.value : null,
      worker: payload.kind === "worker" ? payload.value : null,
    });
  }
  function applyDropOnBlock(payload, ev) {
    if (!payload) return;
    if (payload.kind === "loc" && !ev.locations.includes(payload.value)) updateEvent(ev.id, { locations: [...ev.locations, payload.value] });
    if (payload.kind === "type" && !ev.types.includes(payload.value)) updateEvent(ev.id, { types: [...ev.types, payload.value] });
    if (payload.kind === "worker" && !ev.workers.includes(payload.value)) updateEvent(ev.id, { workers: [...ev.workers, payload.value] });
  }
  function handleColDrop(e, date) {
    e.preventDefault();
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData("application/json")); } catch { return; }
    applyDropOnColumn(payload, date, e.clientY);
  }
  // ---- drop directly on an existing block: add-to ----
  function handleBlockDrop(e, ev) {
    e.preventDefault();
    e.stopPropagation();
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData("application/json")); } catch { return; }
    applyDropOnBlock(payload, ev);
  }

  // ---- touch drag: selector box/list item -> calendar ----
  // HTML5 drag-and-drop (draggable + onDragStart/onDrop) is mouse-only; no
  // major mobile browser fires those events for touch. This reimplements
  // just enough of it by hand: track the touch, tell a tap from a drag by
  // movement distance, and on release use elementFromPoint to find whatever
  // day column or block the finger is actually over.
  const touchDragRef = useRef(null);
  const [touchDragGhost, setTouchDragGhost] = useState(null);

  function startTouchDragSource(e, kind, value) {
    if (!value) return;
    const t = e.touches[0];
    touchDragRef.current = { kind, value, startX: t.clientX, startY: t.clientY, dragging: false };
    document.addEventListener("touchmove", onTouchDragMove, { passive: false });
    document.addEventListener("touchend", onTouchDragEnd);
    document.addEventListener("touchcancel", onTouchDragEnd);
  }
  function onTouchDragMove(e) {
    const td = touchDragRef.current;
    if (!td) return;
    const t = e.touches[0];
    if (!td.dragging) {
      const dist = Math.hypot(t.clientX - td.startX, t.clientY - td.startY);
      if (dist < 10) return; // still could be a tap — don't hijack scrolling/tapping yet
      td.dragging = true;
    }
    e.preventDefault(); // now we're sure it's a drag — stop the page from scrolling under the finger
    setTouchDragGhost({ x: t.clientX, y: t.clientY, label: td.value });
  }
  function onTouchDragEnd(e) {
    const td = touchDragRef.current;
    touchDragRef.current = null;
    setTouchDragGhost(null);
    document.removeEventListener("touchmove", onTouchDragMove);
    document.removeEventListener("touchend", onTouchDragEnd);
    document.removeEventListener("touchcancel", onTouchDragEnd);
    if (!td || !td.dragging) return; // it was just a tap — the normal onClick handles selecting it
    const t = e.changedTouches[0];
    const payload = { kind: td.kind, value: td.value };
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (!el) return;
    const blockEl = el.closest("[data-event-id]");
    if (blockEl) {
      const targetEv = events.find((x) => x.id === blockEl.getAttribute("data-event-id"));
      if (targetEv) { applyDropOnBlock(payload, targetEv); return; }
    }
    const colEl = el.closest("[data-day-column]");
    if (colEl) applyDropOnColumn(payload, colEl.getAttribute("data-day-column"), t.clientY);
  }

  // ---- selection ----
  function toggleSelect(id, additive) {
    setSelectedIds((s) => {
      const n = additive ? new Set(s) : new Set();
      if (n.has(id) && additive) n.delete(id); else n.add(id);
      return n;
    });
  }
  function approveSelected(val) {
    const name = currentUser.alias;
    setEvents((evs) => evs.map((e) => {
      if (!selectedIds.has(e.id)) return e;
      const by = e.approvedBy || [];
      const nextBy = val
        ? (by.includes(name) ? by : [...by, name])
        : by.filter((n) => n !== name);
      if (nextBy !== by && !isSnapshotMode) trackedApiRequest("PUT", `/events/${e.id}`, { approvedBy: nextBy });
      return { ...e, approvedBy: nextBy };
    }));
  }

  // ---- pointer-based move / resize ----
  function startMove(e, ev, mode) {
    if (e.button !== 0) return; // left click only — middle button is reserved for panning
    e.stopPropagation();
    e.preventDefault();
    const colW = colRefs.current[ev.date]?.getBoundingClientRect().width || 160;
    moveState.current = {
      id: ev.id, mode, startX: e.clientX, startY: e.clientY,
      origStart: ev.startMinutes, origDur: ev.duration, origDate: ev.date, colW,
    };
    document.addEventListener("mousemove", onMoveDrag);
    document.addEventListener("mouseup", onMoveEnd);
  }
  function onMoveDrag(e) {
    const ms = moveState.current;
    if (!ms) return;
    const dy = e.clientY - ms.startY;
    const deltaMin = snap((dy / HOUR_PX) * 60);
    if (ms.mode === "resize") {
      const newDur = Math.max(MIN_DUR, ms.origDur + deltaMin);
      updateEventLocal(ms.id, { duration: newDur });
      ms.lastPatch = { duration: newDur };
    } else {
      const dx = e.clientX - ms.startX;
      const dayShift = Math.round(dx / (ms.colW || 160));
      const newDate = addDays(ms.origDate, dayShift);
      const patch = { startMinutes: ms.origStart + deltaMin, date: newDate };
      updateEventLocal(ms.id, patch);
      ms.lastPatch = patch;
    }
  }
  function onMoveEnd() {
    const ms = moveState.current;
    if (ms && ms.lastPatch && !isSnapshotMode) trackedApiRequest("PUT", `/events/${ms.id}`, ms.lastPatch);
    moveState.current = null;
    document.removeEventListener("mousemove", onMoveDrag);
    document.removeEventListener("mouseup", onMoveEnd);
  }

  // ---- marquee select ----
  function startMarquee(e, date) {
    if (e.button !== 0) return; // left click only
    if (e.target !== e.currentTarget) return; // only empty background
    setSelectedIds(new Set());
    const col = colRefs.current[date];
    const rect = col.getBoundingClientRect();
    setMarquee({ date, x0: e.clientX, y0: e.clientY - rect.top, x1: e.clientX, y1: e.clientY - rect.top, rectTop: rect.top });
    document.addEventListener("mousemove", onMarqueeMove);
    document.addEventListener("mouseup", onMarqueeEnd);
  }
  function onMarqueeMove(e) {
    setMarquee((m) => m ? { ...m, x1: e.clientX, y1: e.clientY - m.rectTop } : m);
  }
  function onMarqueeEnd() {
    setMarquee((m) => {
      if (m) {
        const top = Math.min(m.y0, m.y1), bottom = Math.max(m.y0, m.y1);
        const minTop = top / HOUR_PX * 60 - peekHours * 60;
        const minBottom = bottom / HOUR_PX * 60 - peekHours * 60;
        const hits = events.filter((ev) => {
          if (ev.date !== m.date) return false;
          const evEnd = ev.startMinutes + ev.duration;
          return evEnd > minTop && ev.startMinutes < minBottom;
        }).map((ev) => ev.id);
        setSelectedIds(new Set(hits));
      }
      return null;
    });
    document.removeEventListener("mousemove", onMarqueeMove);
    document.removeEventListener("mouseup", onMarqueeEnd);
  }

  // ---- pan: middle mouse button (desktop), two-finger drag (touch) ----
  const panState = useRef(null);
  function startPanMouse(e) {
    if (e.button !== 1) return; // middle button only
    e.preventDefault();
    const el = gridRef.current;
    panState.current = { startX: e.clientX, startY: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    document.addEventListener("mousemove", onPanMouseMove);
    document.addEventListener("mouseup", onPanMouseEnd);
  }
  function onPanMouseMove(e) {
    const ps = panState.current;
    if (!ps || !gridRef.current) return;
    gridRef.current.scrollLeft = ps.scrollLeft - (e.clientX - ps.startX);
    gridRef.current.scrollTop = ps.scrollTop - (e.clientY - ps.startY);
  }
  function onPanMouseEnd() {
    panState.current = null;
    document.removeEventListener("mousemove", onPanMouseMove);
    document.removeEventListener("mouseup", onPanMouseEnd);
  }
  function touchCentroid(touches) {
    let x = 0, y = 0;
    for (let i = 0; i < touches.length; i++) { x += touches[i].clientX; y += touches[i].clientY; }
    return { x: x / touches.length, y: y / touches.length };
  }
  function onTouchStartPan(e) {
    if (e.touches.length !== 2) return; // two fingers only — one finger keeps working for tap/select/drag
    const c = touchCentroid(e.touches);
    const el = gridRef.current;
    panState.current = { startX: c.x, startY: c.y, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
  }
  function onTouchMovePan(e) {
    if (!panState.current || e.touches.length !== 2) return;
    e.preventDefault();
    const c = touchCentroid(e.touches);
    const ps = panState.current;
    gridRef.current.scrollLeft = ps.scrollLeft - (c.x - ps.startX);
    gridRef.current.scrollTop = ps.scrollTop - (c.y - ps.startY);
  }
  function onTouchEndPan(e) {
    if (e.touches.length < 2) panState.current = null;
  }

  const editingEvent = events.find((e) => e.id === editingId);
  const totalHeight = (DAY_MIN / 60 + peekHours * 2) * HOUR_PX;
  const hourMarks = Array.from({ length: 24 + peekHours * 2 }, (_, i) => i - peekHours);

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, fontFamily: "system-ui, sans-serif", height: "100%", minHeight: 640, display: "flex", flexDirection: "column", borderRadius: 12, overflow: "hidden", border: `1px solid ${COLORS.line}` }}>
      {/* top bar */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLORS.line}`, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", rowGap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.2, marginRight: 6 }}>Field Schedule</div>
            {isSnapshotMode ? (
            <span
              title="This is an offline copy — nothing here is sent anywhere automatically. Use the Export button when you're done to send your changes back."
              style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 10, color: COLORS.amber,
                border: `1px solid ${COLORS.amber}55`, whiteSpace: "nowrap",
              }}
            >
              {"\u25D1 Offline copy"}
            </span>
          ) : pendingSaves > 0 ? (
            <span
              title="Saving your last change..."
              style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 10, color: COLORS.danger,
                border: `1px solid ${COLORS.danger}55`, whiteSpace: "nowrap",
              }}
            >
              {"\u25CF Saving\u2026"}
            </span>
          ) : hasSaveError ? (
            <span
              title="Your last change couldn't be saved to the server — it only exists in this browser tab right now. It'll retry on your next edit."
              style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 10, color: COLORS.danger,
                border: `1px solid ${COLORS.danger}55`, whiteSpace: "nowrap",
              }}
            >
              {"\u25CF Not saved"}
            </span>
          ) : apiAvailable !== null && (
            <span
              title={apiAvailable ? "Connected to server/app.py — changes are saved" : "No backend reachable — changes are local to this tab only"}
              style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 10, color: apiAvailable ? COLORS.accent : COLORS.faint,
                border: `1px solid ${apiAvailable ? COLORS.accent : COLORS.faint}55`, whiteSpace: "nowrap",
              }}
            >
              {apiAvailable ? "\u25CF Synced" : "\u25CB Local only"}
            </span>
          )}
            {snapshotError && (
              <span style={{ fontSize: 10, color: COLORS.danger }}>{snapshotError}</span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexWrap: "wrap", rowGap: 6 }}>
            <CalendarRange size={14} color={COLORS.faint} />
            <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} style={{ ...inputStyle, width: 132 }} />
            <span style={{ color: COLORS.faint, fontSize: 12 }}>for</span>
            <select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} style={{ ...inputStyle, width: 78 }}>
              {[1, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
            <span style={{ color: COLORS.faint, fontSize: 11 }} title="All block times are shown in your browser's local timezone">
              {localTZName()}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, borderLeft: `1px solid ${COLORS.line}`, paddingLeft: 10, marginLeft: 4, flexShrink: 0 }}>
            {currentUser.isApprover ? <ShieldCheck size={14} color={COLORS.accent} /> : <ShieldOff size={14} color={COLORS.faint} />}
            <select value={currentUserId} onChange={(e) => setCurrentUserId(e.target.value)} style={{ ...inputStyle, width: 150 }}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.alias}</option>)}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <IconBtn title="Bulk add work blocks (JSON)" onClick={() => setBulkImportOpen(true)}><Plus size={16} /></IconBtn>
            <IconBtn
              title={snapshotBusy ? "Building offline copy\u2026" : "Download an offline copy (view/edit without server access)"}
              onClick={downloadStandaloneSnapshot}
            >
              {snapshotBusy ? <span style={{ fontSize: 10 }}>{"\u2026"}</span> : <OfflineIcon size={15} />}
            </IconBtn>
            <IconBtn title="Export" onClick={() => setExportOpen(true)}><Download size={16} /></IconBtn>
            <IconBtn title="Configuration" onClick={() => setConfigOpen(true)}><Settings size={16} /></IconBtn>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", rowGap: 8 }}>
          <CombinedSelectorBox
            categories={[
              { key: "loc", label: "LOCATION", color: "#7FB8E0", options: locationNames },
              { key: "type", label: "TYPE", color: COLORS.amber, options: typeNames },
              { key: "worker", label: "WORKER", color: "#B79AE0", options: workerNames },
            ]}
            selVal={selVal}
            recents={recents}
            onPick={(kind, v) => pick(kind, v)}
            onDragPick={(kind, v) => bumpRecent(kind, v)}
            onTouchDragStart={startTouchDragSource}
          />

          <div style={{ display: "flex", gap: 8, marginLeft: 8 }}>
            <button
              disabled={!currentUser.isApprover || selectedIds.size === 0}
              onClick={() => approveSelected(true)}
              title={`Add ${currentUser.alias} as an approver on the selected blocks`}
              style={{ ...primaryBtnStyle, opacity: (!currentUser.isApprover || selectedIds.size === 0) ? 0.4 : 1, cursor: (!currentUser.isApprover || selectedIds.size === 0) ? "not-allowed" : "pointer" }}
            ><Check size={13} /> Approve as {currentUser.alias}{selectedIds.size ? ` (${selectedIds.size})` : ""}</button>
            <button
              disabled={!currentUser.isApprover || selectedIds.size === 0}
              onClick={() => approveSelected(false)}
              title={`Remove ${currentUser.alias}'s approval from the selected blocks`}
              style={{ ...ghostBtnStyle, opacity: (!currentUser.isApprover || selectedIds.size === 0) ? 0.4 : 1, cursor: (!currentUser.isApprover || selectedIds.size === 0) ? "not-allowed" : "pointer" }}
            >Unapprove</button>
          </div>
        </div>
      </div>

      {/* calendar */}
      <div
        style={{ flex: 1, overflow: "auto", touchAction: "pan-x pan-y", cursor: "default" }}
        ref={gridRef}
        onMouseDown={startPanMouse}
        onTouchStart={onTouchStartPan}
        onTouchMove={onTouchMovePan}
        onTouchEnd={onTouchEndPan}
      >
        <div style={{ display: "flex", width: "100%" }}>
          {/* time gutter */}
          <div style={{ width: 56, flexShrink: 0, position: "sticky", left: 0, background: COLORS.bg, zIndex: 5 }}>
            <div style={{ height: 34, borderBottom: `1px solid ${COLORS.line}` }} />
            <div style={{ position: "relative", height: totalHeight }}>
              {hourMarks.map((h) => (
                <div key={h} style={{ position: "absolute", top: (h + peekHours) * HOUR_PX - 6, right: 6, fontSize: 10, color: COLORS.faint, fontVariantNumeric: "tabular-nums" }}>
                  {minsToLabel(((h % 24) + 24) % 24 * 60)}
                </div>
              ))}
            </div>
          </div>

          {days.map((date, dayIdx) => {
            const dayEvents = events.filter((ev) => {
              const rel = (epochDay(ev.date) - epochDay(date)) * 1440 + ev.startMinutes;
              return rel + ev.duration > -peekHours * 60 && rel < DAY_MIN + peekHours * 60;
            });
            // side-by-side layout for blocks that overlap in this column
            const overlapLayout = layoutOverlaps(
              dayEvents.map((ev) => {
                const rel = (epochDay(ev.date) - epochDay(date)) * 1440 + ev.startMinutes;
                return { id: ev.id, start: rel, end: rel + ev.duration };
              })
            );
            const colStyle = (() => {
              const maxLanes = Object.values(overlapLayout).reduce((m, l) => Math.max(m, l.laneCount), 1);
              const requiredWidth = Math.max(MIN_COL_WIDTH, maxLanes * MIN_LANE_WIDTH);
              return colWidths
                ? { width: Math.max(colWidths[dayIdx], requiredWidth), flex: "0 0 auto" }
                : { flex: "1 1 0", minWidth: requiredWidth };
            })();
            return (
              <div key={date} style={{ ...colStyle, borderRight: `1px solid ${COLORS.line}`, position: "relative" }}>
                <div style={{ height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: COLORS.muted, borderBottom: `1px solid ${COLORS.line}`, position: "sticky", top: 0, background: COLORS.bg, zIndex: 4 }}>
                  {fmtDateShort(date)}
                  <div
                    onPointerDown={(e) => startColResize(e, dayIdx)}
                    title="Drag to resize column"
                    style={{
                      position: "absolute", top: 0, right: -16, width: 32, height: "100%",
                      cursor: "col-resize", zIndex: 6, touchAction: "none",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <div style={{ width: 6, height: 28, borderRadius: 3, background: COLORS.line }} />
                  </div>
                </div>
                <div
                  ref={(el) => { colRefs.current[date] = el; }}
                  data-day-column={date}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleColDrop(e, date)}
                  onMouseDown={(e) => startMarquee(e, date)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const rect = colRefs.current[date].getBoundingClientRect();
                    const minutesFromTop = ((e.clientY - rect.top) / HOUR_PX) * 60 - peekHours * 60;
                    setContextMenu({ x: e.clientX, y: e.clientY, date, startMinutes: minutesFromTop });
                  }}
                  style={{ position: "relative", height: totalHeight, background: COLORS.panel }}
                >
                  {hourMarks.map((h) => (
                    <div key={h} style={{
                      position: "absolute", top: (h + peekHours) * HOUR_PX, left: 0, right: 0, borderTop: `1px solid ${h < 0 || h >= 24 ? COLORS.lineSoft : COLORS.line}`,
                      opacity: h < 0 || h >= 24 ? 0.5 : 1,
                    }} />
                  ))}
                  {/* peek shading for adjacent days */}
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: peekHours * HOUR_PX, background: "rgba(0,0,0,0.25)", pointerEvents: "none" }} />
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: peekHours * HOUR_PX, background: "rgba(0,0,0,0.25)", pointerEvents: "none" }} />

                  {dayEvents.map((ev) => {
                    const rel = (epochDay(ev.date) - epochDay(date)) * 1440 + ev.startMinutes;
                    const top = (rel + peekHours * 60) / 60 * HOUR_PX;
                    const height = Math.max(16, (ev.duration / 60) * HOUR_PX - 2);
                    const isHomeDay = date === ev.date;
                    const isEndDay = date === eventEndDay(ev);
                    const selected = selectedIds.has(ev.id);
                    const lay = overlapLayout[ev.id] || { lane: 0, laneCount: 1 };
                    const gutter = 4, laneGap = 3;
                    const laneWidthPct = 100 / lay.laneCount;
                    const approvedBy = ev.approvedBy || [];
                    const fullyApproved = isFullyApproved(ev, requiredApprovers);
                    const partiallyApproved = !fullyApproved && approvedBy.length > 0;
                    const hasNotes = !!(ev.notes && ev.notes.content && ev.notes.content.trim());
                    const hasLinks = !!(ev.links && ev.links.length > 0);
                    return (
                      <div
                        key={ev.id + "_" + date}
                        data-event-id={ev.id}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleBlockDrop(e, ev)}
                        onMouseDown={(e) => startMove(e, ev, "move")}
                        onClick={(e) => { e.stopPropagation(); toggleSelect(ev.id, e.metaKey || e.ctrlKey || e.shiftKey); }}
                        style={{
                          position: "absolute", top, height, borderRadius: 6,
                          left: `calc(${lay.lane * laneWidthPct}% + ${gutter}px)`,
                          width: `calc(${laneWidthPct}% - ${gutter + laneGap}px)`,
                          background: fullyApproved ? "rgba(79,182,168,0.18)" : partiallyApproved ? "rgba(232,169,78,0.10)" : COLORS.block,
                          border: `1.5px solid ${selected ? COLORS.amber : fullyApproved ? COLORS.accent : partiallyApproved ? "#8A6A33" : COLORS.blockBorder}`,
                          padding: "3px 5px", fontSize: 10.5, overflow: "hidden", cursor: "grab",
                          boxSizing: "border-box", zIndex: selected ? 3 : 2,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "nowrap", gap: 4 }}>
                          <span style={{ color: COLORS.faint, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                            {isHomeDay ? minsToLabel(ev.startMinutes) : "\u22EF continued"}
                          </span>
                          <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                            {hasNotes && (
                              <span title="Has notes" style={{ fontSize: 8.5, fontWeight: 700, color: COLORS.amber, border: `1px solid ${COLORS.amber}77`, borderRadius: 3, padding: "0 3px", lineHeight: "11px" }}>N</span>
                            )}
                            {hasLinks && (
                              <span title="Has links" style={{ fontSize: 8.5, fontWeight: 700, color: "#7FB8E0", border: "1px solid #7FB8E077", borderRadius: 3, padding: "0 3px", lineHeight: "11px" }}>L</span>
                            )}
                            <Info
                              size={10} color={COLORS.faint} style={{ cursor: "pointer", flexShrink: 0 }}
                              onMouseEnter={(e) => {
                                if (isTouchDevice) return;
                                const corner = e.clientX < window.innerWidth / 2 ? "bottom-right" : "bottom-left";
                                openInfoPopup(ev.id, corner);
                              }}
                              onMouseLeave={() => { if (!isTouchDevice) scheduleCloseInfoPopup(); }}
                              onClick={(e) => { e.stopPropagation(); if (isTouchDevice) setEditingId(ev.id); }}
                            />
                            <Pencil size={10} style={{ cursor: "pointer", color: COLORS.faint, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); setEditingId(ev.id); }} />
                          </div>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", marginTop: 2 }}>
                          {ev.locations.map((l) => <Chip key={l} tone="loc">{l}</Chip>)}
                          {ev.types.map((t) => <Chip key={t} tone="type">{t}</Chip>)}
                          {ev.workers.map((w) => <Chip key={w} tone="worker">{w}</Chip>)}
                        </div>
                        {approvedBy.length > 0 && (
                          <div style={{ fontSize: 9.5, color: fullyApproved ? COLORS.accent : COLORS.amber, marginTop: 2 }}>
                            Approved: {approvedBy.join(", ")}
                          </div>
                        )}
                        {showEventIds && (
                          <div style={{ fontSize: 8.5, color: COLORS.faint, fontFamily: "ui-monospace, monospace", marginTop: 2, opacity: 0.8 }}>
                            {ev.id}
                          </div>
                        )}
                        {!isHomeDay && (
                          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `repeating-linear-gradient(90deg, ${COLORS.faint} 0 6px, transparent 6px 12px)`, opacity: 0.6 }} />
                        )}
                        {isEndDay && (
                          <div
                            onMouseDown={(e) => startMove(e, ev, "resize")}
                            title="Drag to adjust duration"
                            style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 6, cursor: "ns-resize" }}
                          />
                        )}
                        {!isEndDay && (
                          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: `repeating-linear-gradient(90deg, ${COLORS.faint} 0 6px, transparent 6px 12px)`, opacity: 0.6 }} />
                        )}
                      </div>
                    );
                  })}

                  {marquee && marquee.date === date && (
                    <div style={{
                      position: "absolute", left: 2, right: 2,
                      top: Math.min(marquee.y0, marquee.y1), height: Math.abs(marquee.y1 - marquee.y0),
                      background: "rgba(232,169,78,0.12)", border: `1px dashed ${COLORS.amber}`, pointerEvents: "none",
                    }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <ContextCreateMenu
          x={contextMenu.x} y={contextMenu.y}
          locations={locationNames} types={typeNames} workers={workerNames}
          onClose={() => setContextMenu(null)}
          onCreate={({ loc, type, worker }) => {
            createEvent({ date: contextMenu.date, startMinutes: contextMenu.startMinutes, loc, type, worker });
            setContextMenu(null);
          }}
        />
      )}

      {touchDragGhost && (
        <div
          style={{
            position: "fixed", left: touchDragGhost.x, top: touchDragGhost.y - 36, zIndex: 200,
            transform: "translate(-50%, -50%)", pointerEvents: "none",
            background: COLORS.panel2, border: `1px solid ${COLORS.accent}`, borderRadius: 8,
            padding: "6px 10px", fontSize: 12, color: COLORS.text, whiteSpace: "nowrap",
            boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
          }}
        >
          {touchDragGhost.label}
        </div>
      )}

      {infoPopup && (() => {
        const popupEvent = events.find((e) => e.id === infoPopup.id);
        if (!popupEvent) return null;
        return (
          <BlockInfoPopup
            ev={popupEvent} corner={infoPopup.corner} requiredApprovers={requiredApprovers}
            onMouseEnter={() => openInfoPopup(infoPopup.id, infoPopup.corner)}
            onMouseLeave={scheduleCloseInfoPopup}
          />
        );
      })()}

      {editingEvent && (
        <EditEventModal
          ev={editingEvent}
          allLocations={locationNames} allTypes={typeNames} allWorkers={workerNames}
          allApprovers={users.filter((u) => u.isApprover).map((u) => u.alias)}
          requiredApprovers={requiredApprovers}
          onSave={(id, patch) => { updateEvent(id, patch); setEditingId(null); }}
          onDelete={deleteEvent}
          onClose={() => setEditingId(null)}
        />
      )}

      {configOpen && (
        <ConfigModal
          users={users} setUsers={setUsersSynced}
          locations={locations} setLocations={setLocationsSynced}
          workTypes={workTypes} setWorkTypes={setWorkTypesSynced}
          requiredApprovers={requiredApprovers} setRequiredApprovers={setRequiredApproversSynced}
          showEventIds={showEventIds} setShowEventIds={setShowEventIds}
          onClose={() => setConfigOpen(false)}
        />
      )}

      {exportOpen && <ExportModal events={events} requiredApprovers={requiredApprovers} onClose={() => setExportOpen(false)} />}

      {bulkImportOpen && (
        <BulkImportModal
          onImport={(newEvents) => {
            setEvents((evs) => [...evs, ...newEvents]);
            if (!isSnapshotMode) {
              newEvents.forEach((localEvent) => {
                trackedApiRequest("POST", "/events", localEvent).then((created) => {
                  if (created && created.id && created.id !== localEvent.id) {
                    setEvents((evs) => evs.map((e) => e.id === localEvent.id ? { ...e, id: created.id } : e));
                  }
                });
              });
            }
          }}
          onClose={() => setBulkImportOpen(false)}
        />
      )}
    </div>
  );
}


const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(WorkSchedulePlanner));
