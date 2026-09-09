const {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect
} = React;
function makeIcon(glyph) {
  return function IconGlyph({
    size = 14,
    color,
    style,
    ...rest
  }) {
    return /*#__PURE__*/React.createElement("span", {
      ...rest,
      style: {
        fontSize: size,
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        color,
        flexShrink: 0,
        ...style
      }
    }, glyph);
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
  blockBorder: "#3C4956"
};
const uid = p => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// ---------- backend API client ----------
// Talks to the Flask+SQLite service in server/app.py, if one is reachable.
// Every call fails soft (returns null) so the app keeps working — with
// state held only in memory — when there's no backend at all, e.g. when
// you're just opening index.html via `python -m http.server` for a look.
const API_BASE = "/api";
async function apiRequest(method, path, body) {
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body !== undefined ? {
        "Content-Type": "application/json"
      } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) return null;
    if (res.status === 204) return true;
    return await res.json();
  } catch {
    return null; // no network / no backend running — caller treats this as "stay local"
  }
}
// Diffs an old vs new array of {id, ...} records and pushes the difference
// to the backend: POST for anything new, PUT for anything changed, DELETE
// for anything removed. Used for the users/locations/work_types lists,
// which the Config modal still edits as plain arrays via setState.
function syncListToApi(resource, toApiBody, prev, next, onServerIdAssigned) {
  const prevMap = new Map(prev.map(x => [x.id, x]));
  const nextMap = new Map(next.map(x => [x.id, x]));
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id) && !id.startsWith("__pending_")) apiRequest("DELETE", `/${resource}/${id}`);
  }
  for (const [id, item] of nextMap) {
    const before = prevMap.get(id);
    if (!before) {
      apiRequest("POST", `/${resource}`, toApiBody(item)).then(created => {
        if (created && created.id && created.id !== id) onServerIdAssigned(id, created.id);
      });
    } else if (JSON.stringify(before) !== JSON.stringify(item)) {
      apiRequest("PUT", `/${resource}/${id}`, toApiBody(item));
    }
  }
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
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
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${pad2(m)} ${ampm}`;
}
function minsToLabel(mins) {
  const h = Math.floor((mins % 1440 + 1440) % 1440 / 60);
  const m = (mins % 60 + 60) % 60;
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
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local time";
  }
}
function fmtInTZ(dateObj, useUTC) {
  const y = useUTC ? dateObj.getUTCFullYear() : dateObj.getFullYear();
  const mo = useUTC ? dateObj.getUTCMonth() + 1 : dateObj.getMonth() + 1;
  const da = useUTC ? dateObj.getUTCDate() : dateObj.getDate();
  const h = useUTC ? dateObj.getUTCHours() : dateObj.getHours();
  const m = useUTC ? dateObj.getUTCMinutes() : dateObj.getMinutes();
  return {
    date: `${y}-${pad2(mo)}-${pad2(da)}`,
    time: hmLabel(h, m)
  };
}

// ---------- overlap layout (side-by-side blocks) ----------
// items: [{id, start, end}] in a shared coordinate space (minutes). Returns
// { [id]: { lane, laneCount } } so overlapping items can be given equal
// fractional widths and offset side by side instead of stacking.
function layoutOverlaps(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters = [];
  let current = [],
    currentEnd = -Infinity;
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
      let lane = laneEnds.findIndex(end => end <= it.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(it.end);
      } else laneEnds[lane] = it.end;
      laneOf[it.id] = lane;
    }
    const laneCount = laneEnds.length;
    for (const it of cluster) layout[it.id] = {
      lane: laneOf[it.id],
      laneCount
    };
  }
  return layout;
}
function fmtDateShort(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

// ---------- seed data ----------
const seedUsers = [{
  id: "u1",
  login: "jmartinez",
  alias: "J. Martinez",
  isWorker: true,
  isApprover: false
}, {
  id: "u2",
  login: "asmith",
  alias: "A. Smith",
  isWorker: true,
  isApprover: false
}, {
  id: "u3",
  login: "rt.chen",
  alias: "R. Chen",
  isWorker: true,
  isApprover: true
}, {
  id: "u4",
  login: "dford",
  alias: "D. Ford",
  isWorker: false,
  isApprover: true
}, {
  id: "u5",
  login: "kpatel",
  alias: "K. Patel",
  isWorker: true,
  isApprover: false
}];
const seedLocations = [{
  id: "l1",
  name: "North Yard"
}, {
  id: "l2",
  name: "Warehouse 3"
}, {
  id: "l3",
  name: "Site B - Riverside"
}, {
  id: "l4",
  name: "HQ Loading Dock"
}];
const seedTypes = [{
  id: "t1",
  name: "Install"
}, {
  id: "t2",
  name: "Maintenance"
}, {
  id: "t3",
  name: "Inspection"
}, {
  id: "t4",
  name: "Cleanup"
}];
const seedRequiredApprovers = ["R. Chen", "D. Ford"];
function isFullyApproved(ev, requiredApprovers) {
  const by = ev.approvedBy || [];
  if (requiredApprovers.length > 0) return requiredApprovers.every(name => by.includes(name));
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
  return [{
    id: uid("ev"),
    date: monday,
    startMinutes: 8 * 60,
    duration: 90,
    locations: ["North Yard"],
    types: ["Install"],
    workers: ["J. Martinez", "A. Smith"],
    approvedBy: [],
    notes: {
      format: "text",
      content: "Bring the extra conduit — customer added a run on the north wall."
    },
    links: [{
      label: "Site plan",
      url: "https://example.com/site-plan.pdf",
      description: "Marked-up PDF from the walkthrough"
    }]
  }, {
    id: uid("ev"),
    date: addDays(monday, 1),
    startMinutes: 13 * 60,
    duration: 60,
    locations: ["Warehouse 3"],
    types: ["Maintenance"],
    workers: ["K. Patel"],
    approvedBy: ["D. Ford"],
    notes: {
      format: "text",
      content: ""
    },
    links: []
  }, {
    id: uid("ev"),
    date: addDays(monday, 2),
    startMinutes: 23 * 60 + 30,
    duration: 90,
    locations: ["Site B - Riverside"],
    types: ["Inspection"],
    workers: ["R. Chen"],
    approvedBy: ["D. Ford", "R. Chen"],
    notes: {
      format: "text",
      content: ""
    },
    links: []
  }];
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
    const tokens = splitTopLevel(inner, "&").map(t => t.trim()).filter(Boolean);
    const include = [];
    const exclude = [];
    for (const t of tokens) {
      if (t.startsWith("!")) exclude.push(t.slice(1).trim().toLowerCase());else include.push(t.toLowerCase());
    }
    clauses.push({
      field,
      include,
      exclude
    });
  }
  return clauses;
}
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0,
    cur = "";
  for (const ch of str) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
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
  return {
    format,
    content
  };
}
function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.filter(l => l && String(l.url || "").trim()).map(l => ({
    label: String(l.label || l.url).trim(),
    url: String(l.url).trim(),
    description: String(l.description || "")
  }));
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
    if (!row || typeof row !== "object") {
      errors.push(`Row ${i + 1}: not an object`);
      return;
    }
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) problems.push('"date" must be "YYYY-MM-DD"');
    let startMinutes = null;
    if (typeof row.start !== "string" || !/^\d{1,2}:\d{2}$/.test(row.start)) {
      problems.push('"start" must be "HH:MM" (24-hour)');
    } else {
      const [h, m] = row.start.split(":").map(Number);
      if (h > 23 || m > 59) problems.push('"start" time is out of range');else startMinutes = h * 60 + m;
    }
    if (typeof row.duration !== "number" || row.duration <= 0) problems.push('"duration" must be a positive number of minutes');
    if (row.notes && row.notes.format && !NOTE_FORMATS.includes(row.notes.format)) problems.push('"notes.format" must be one of: ' + NOTE_FORMATS.join(", "));
    if (row.links && (!Array.isArray(row.links) || row.links.some(l => !l || !l.url))) problems.push('"links" must be an array of objects each with a "url"');
    if (problems.length) {
      errors.push(`Row ${i + 1}: ${problems.join("; ")}`);
      return;
    }
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
      links: normalizeLinks(row.links)
    });
  });
  return {
    added,
    errors
  };
}

// Accepts either "[label](url)" (the common Markdown link syntax) or a bare
// URL on its own — in which case the URL doubles as the label.
function parseLinkSyntax(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/^\[(.+?)\]\((\S+?)\)$/);
  if (m) return {
    label: m[1].trim(),
    url: m[2].trim()
  };
  return {
    label: trimmed,
    url: trimmed
  };
}

// Small "i" icon that shows a floating text box on hover (and toggles on
// click/tap, for touch). Used for per-link descriptions.
function InlineInfoHover({
  text
}) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      display: "inline-flex",
      marginLeft: 4
    }
  }, /*#__PURE__*/React.createElement(Info, {
    size: 12,
    color: COLORS.faint,
    style: {
      cursor: "pointer"
    },
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onClick: e => {
      e.stopPropagation();
      setOpen(o => !o);
    }
  }), open && /*#__PURE__*/React.createElement("div", {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    style: {
      position: "absolute",
      bottom: "calc(100% + 6px)",
      left: 0,
      zIndex: 60,
      background: COLORS.panel2,
      border: `1px solid ${COLORS.line}`,
      borderRadius: 6,
      padding: "7px 9px",
      fontSize: 11.5,
      color: COLORS.text,
      width: 220,
      boxShadow: "0 8px 22px rgba(0,0,0,0.45)",
      whiteSpace: "pre-wrap",
      lineHeight: 1.4
    }
  }, text));
}
function eventMatchesClauses(ev, clauses) {
  const fieldValues = {
    location: (ev.locations || []).map(s => s.toLowerCase()),
    locations: (ev.locations || []).map(s => s.toLowerCase()),
    type: (ev.types || []).map(s => s.toLowerCase()),
    types: (ev.types || []).map(s => s.toLowerCase()),
    worker: (ev.workers || []).map(s => s.toLowerCase()),
    workers: (ev.workers || []).map(s => s.toLowerCase()),
    approver: (ev.approvedBy || []).map(s => s.toLowerCase()),
    approvers: (ev.approvedBy || []).map(s => s.toLowerCase())
  };
  for (const c of clauses) {
    const vals = fieldValues[c.field];
    if (!vals) continue;
    for (const inc of c.include) if (!vals.some(v => v.includes(inc))) return false;
    for (const exc of c.exclude) if (vals.some(v => v.includes(exc))) return false;
  }
  return true;
}

// ---------- small UI atoms ----------
function IconBtn({
  onClick,
  title,
  children,
  active
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    title: title,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: 32,
      height: 32,
      borderRadius: 7,
      border: `1px solid ${active ? COLORS.accent : COLORS.line}`,
      background: active ? COLORS.accentDim : "transparent",
      color: active ? COLORS.accent : COLORS.muted,
      cursor: "pointer"
    }
  }, children);
}
function Chip({
  children,
  onRemove,
  tone
}) {
  const toneColor = tone === "loc" ? "#7FB8E0" : tone === "type" ? COLORS.amber : "#B79AE0";
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: 11,
      padding: "2px 6px",
      borderRadius: 5,
      background: "rgba(255,255,255,0.05)",
      border: `1px solid ${toneColor}55`,
      color: toneColor,
      marginRight: 4,
      marginBottom: 4,
      whiteSpace: "nowrap"
    }
  }, children, onRemove && /*#__PURE__*/React.createElement(X, {
    size: 10,
    style: {
      cursor: "pointer"
    },
    onClick: onRemove
  }));
}

// ---------- Selector box (location / type / worker) ----------
function SelectorBox({
  label,
  tone,
  options,
  value,
  recents,
  onPick,
  onDragPick
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = [...options];
    base.sort((a, b) => {
      const ra = recents.indexOf(a),
        rb = recents.indexOf(b);
      const ia = ra === -1 ? 999 : ra,
        ib = rb === -1 ? 999 : rb;
      return ia - ib;
    });
    return q ? base.filter(o => o.toLowerCase().includes(q)) : base;
  }, [options, recents, query]);
  const toneColor = tone === "loc" ? "#7FB8E0" : tone === "type" ? COLORS.amber : "#B79AE0";
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    style: {
      position: "relative",
      flex: 1,
      minWidth: 150
    }
  }, /*#__PURE__*/React.createElement("div", {
    draggable: !!value,
    onDragStart: e => {
      if (!value) return;
      e.dataTransfer.setData("application/json", JSON.stringify({
        kind: tone,
        value
      }));
      onDragPick && onDragPick(value);
    },
    onClick: () => setOpen(o => !o),
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      border: `1px solid ${open ? toneColor : COLORS.line}`,
      borderRadius: 8,
      padding: "8px 10px",
      background: COLORS.panel2,
      cursor: value ? "grab" : "pointer",
      userSelect: "none"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint,
      letterSpacing: 0.3
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: value ? toneColor : COLORS.muted,
      marginTop: 1
    }
  }, value || "Select…")), /*#__PURE__*/React.createElement(ChevronDown, {
    size: 14,
    color: COLORS.faint
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: "calc(100% + 4px)",
      left: 0,
      right: 0,
      zIndex: 40,
      background: COLORS.panel2,
      border: `1px solid ${COLORS.line}`,
      borderRadius: 8,
      boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "6px 8px",
      borderBottom: `1px solid ${COLORS.line}`
    }
  }, /*#__PURE__*/React.createElement(Search, {
    size: 13,
    color: COLORS.faint
  }), /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: query,
    onChange: e => setQuery(e.target.value),
    placeholder: "Type to filter…",
    style: {
      flex: 1,
      background: "transparent",
      border: "none",
      outline: "none",
      color: COLORS.text,
      fontSize: 12
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 200,
      overflowY: "auto"
    }
  }, ordered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 10,
      fontSize: 12,
      color: COLORS.faint
    }
  }, "No matches"), ordered.map(o => /*#__PURE__*/React.createElement("div", {
    key: o,
    draggable: true,
    onDragStart: e => {
      e.dataTransfer.setData("application/json", JSON.stringify({
        kind: tone,
        value: o
      }));
      onDragPick && onDragPick(o);
      setOpen(false);
    },
    onClick: () => {
      onPick(o);
      setOpen(false);
      setQuery("");
    },
    style: {
      padding: "8px 10px",
      fontSize: 13,
      cursor: "pointer",
      color: COLORS.text,
      borderBottom: `1px solid ${COLORS.lineSoft}`
    },
    onMouseEnter: e => e.currentTarget.style.background = "rgba(255,255,255,0.04)",
    onMouseLeave: e => e.currentTarget.style.background = "transparent"
  }, o)))));
}

// ---------- Event edit modal ----------
function EditEventModal({
  ev,
  allLocations,
  allTypes,
  allWorkers,
  allApprovers,
  requiredApprovers,
  onSave,
  onDelete,
  onClose
}) {
  const [locs, setLocs] = useState(ev.locations);
  const [types, setTypes] = useState(ev.types);
  const [workers, setWorkers] = useState(ev.workers);
  const [start, setStart] = useState(minsToInput(ev.startMinutes));
  const [dur, setDur] = useState(ev.duration);
  const [approvedBy, setApprovedBy] = useState(ev.approvedBy || []);
  const [notesFormat, setNotesFormat] = useState(ev.notes && ev.notes.format || "text");
  const [notesContent, setNotesContent] = useState(ev.notes && ev.notes.content || "");
  const [links, setLinks] = useState(ev.links || []);
  const [linkInput, setLinkInput] = useState("");
  const [linkDescInput, setLinkDescInput] = useState("");
  function minsToInput(m) {
    return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
  }
  const remainingApprovers = allApprovers.filter(a => !approvedBy.includes(a));
  const fullyApproved = requiredApprovers.length > 0 ? requiredApprovers.every(name => approvedBy.includes(name)) : approvedBy.length > 0;
  return /*#__PURE__*/React.createElement("div", {
    style: overlayStyle,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modalStyle,
      width: 420
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modalHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Edit work block"), /*#__PURE__*/React.createElement(X, {
    size: 16,
    style: {
      cursor: "pointer"
    },
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Start time"), /*#__PURE__*/React.createElement("input", {
    type: "time",
    value: start,
    onChange: e => setStart(e.target.value),
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Duration (min)"), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: 15,
    step: 15,
    value: dur,
    onChange: e => setDur(Number(e.target.value)),
    style: inputStyle
  }))), /*#__PURE__*/React.createElement(FieldEditor, {
    title: "Locations",
    tone: "loc",
    items: locs,
    all: allLocations,
    onRemove: v => setLocs(locs.filter(x => x !== v)),
    onAdd: v => !locs.includes(v) && setLocs([...locs, v])
  }), /*#__PURE__*/React.createElement(FieldEditor, {
    title: "Types",
    tone: "type",
    items: types,
    all: allTypes,
    onRemove: v => setTypes(types.filter(x => x !== v)),
    onAdd: v => !types.includes(v) && setTypes([...types, v])
  }), /*#__PURE__*/React.createElement(FieldEditor, {
    title: "Workers",
    tone: "worker",
    items: workers,
    all: allWorkers,
    onRemove: v => setWorkers(workers.filter(x => x !== v)),
    onAdd: v => !workers.includes(v) && setWorkers([...workers, v])
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Approved by ", requiredApprovers.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: fullyApproved ? COLORS.accent : COLORS.faint
    }
  }, "(", approvedBy.filter(a => requiredApprovers.includes(a)).length, "/", requiredApprovers.length, " required)")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      marginTop: 4
    }
  }, approvedBy.length === 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: COLORS.faint
    }
  }, "No approvals yet"), approvedBy.map(v => /*#__PURE__*/React.createElement(Chip, {
    key: v,
    tone: "worker",
    onRemove: () => setApprovedBy(approvedBy.filter(x => x !== v))
  }, v, requiredApprovers.includes(v) ? "" : " (extra)")), remainingApprovers.length > 0 && /*#__PURE__*/React.createElement("select", {
    value: "",
    onChange: e => e.target.value && setApprovedBy([...approvedBy, e.target.value]),
    style: {
      ...inputStyle,
      width: "auto",
      padding: "3px 6px",
      fontSize: 11,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "+ add approval…"), remainingApprovers.map(r => /*#__PURE__*/React.createElement("option", {
    key: r,
    value: r
  }, r)))), fullyApproved && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: COLORS.accent,
      marginTop: 4
    }
  }, "All required approvers have signed off.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Notes"), /*#__PURE__*/React.createElement("select", {
    value: notesFormat,
    onChange: e => setNotesFormat(e.target.value),
    style: {
      ...inputStyle,
      width: "auto",
      padding: "3px 6px",
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "text"
  }, "Text"), /*#__PURE__*/React.createElement("option", {
    value: "markdown"
  }, "Markdown"), /*#__PURE__*/React.createElement("option", {
    value: "json"
  }, "JSON"), /*#__PURE__*/React.createElement("option", {
    value: "csv"
  }, "CSV"))), /*#__PURE__*/React.createElement("textarea", {
    value: notesContent,
    onChange: e => setNotesContent(e.target.value),
    placeholder: "Anything a worker or approver should know about this block…",
    rows: 4,
    style: {
      ...inputStyle,
      marginTop: 4,
      resize: "vertical",
      fontFamily: notesFormat === "json" || notesFormat === "csv" ? "ui-monospace, monospace" : "inherit"
    }
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Links"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 4,
      marginTop: 4
    }
  }, links.map((l, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      fontSize: 12.5
    }
  }, /*#__PURE__*/React.createElement(LinkIcon, {
    size: 11,
    color: COLORS.faint
  }), /*#__PURE__*/React.createElement("a", {
    href: l.url,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: "#7FB8E0",
      textDecoration: "underline",
      wordBreak: "break-all"
    }
  }, l.label), /*#__PURE__*/React.createElement(InlineInfoHover, {
    text: l.description
  }), /*#__PURE__*/React.createElement(X, {
    size: 11,
    color: COLORS.faint,
    style: {
      cursor: "pointer",
      marginLeft: "auto"
    },
    onClick: () => setLinks(links.filter((_, x) => x !== i))
  }))), links.length === 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: COLORS.faint
    }
  }, "No links yet")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      padding: 8,
      background: COLORS.panel2,
      borderRadius: 6,
      border: `1px solid ${COLORS.line}`
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: linkInput,
    onChange: e => setLinkInput(e.target.value),
    placeholder: "[Site plan](https://example.com/plan.pdf) — or just paste a URL",
    style: {
      ...inputStyle,
      fontSize: 11.5
    }
  }), /*#__PURE__*/React.createElement("input", {
    value: linkDescInput,
    onChange: e => setLinkDescInput(e.target.value),
    placeholder: "Description (optional) — shown on the info icon",
    style: {
      ...inputStyle,
      fontSize: 11.5,
      marginTop: 6
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...ghostBtnStyle,
      marginTop: 6,
      fontSize: 11,
      padding: "5px 10px"
    },
    onClick: () => {
      if (!linkInput.trim()) return;
      const {
        label,
        url
      } = parseLinkSyntax(linkInput);
      setLinks([...links, {
        label,
        url,
        description: linkDescInput.trim()
      }]);
      setLinkInput("");
      setLinkDescInput("");
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 12
  }), " Add link")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      padding: "12px 16px",
      borderTop: `1px solid ${COLORS.line}`
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelete(ev.id),
    style: dangerBtnStyle
  }, /*#__PURE__*/React.createElement(Trash2, {
    size: 13
  }), " Delete"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: ghostBtnStyle
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const [h, m] = start.split(":").map(Number);
      onSave(ev.id, {
        locations: locs,
        types,
        workers,
        startMinutes: h * 60 + m,
        duration: Math.max(15, dur),
        approvedBy,
        notes: {
          format: notesFormat,
          content: notesContent
        },
        links
      });
    },
    style: primaryBtnStyle
  }, /*#__PURE__*/React.createElement(Check, {
    size: 13
  }), " Save")))));
}
function FieldEditor({
  title,
  tone,
  items,
  all,
  onRemove,
  onAdd
}) {
  const remaining = all.filter(x => !items.includes(x));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      marginTop: 4
    }
  }, items.map(v => /*#__PURE__*/React.createElement(Chip, {
    key: v,
    tone: tone,
    onRemove: () => onRemove(v)
  }, v)), remaining.length > 0 && /*#__PURE__*/React.createElement("select", {
    value: "",
    onChange: e => e.target.value && onAdd(e.target.value),
    style: {
      ...inputStyle,
      width: "auto",
      padding: "3px 6px",
      fontSize: 11,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "+ add…"), remaining.map(r => /*#__PURE__*/React.createElement("option", {
    key: r,
    value: r
  }, r)))));
}

// ---------- Config modal ----------
function ConfigModal({
  users,
  setUsers,
  locations,
  setLocations,
  workTypes,
  setWorkTypes,
  requiredApprovers,
  setRequiredApprovers,
  showEventIds,
  setShowEventIds,
  onClose
}) {
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
    return str.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }
  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || uid("user");
  }
  function addBulkUsers() {
    const names = parseNameList(bulkNames);
    if (names.length === 0) return;
    const existingAliases = new Set(users.map(u => u.alias.toLowerCase()));
    const additions = names.filter(n => !existingAliases.has(n.toLowerCase())).map(n => ({
      id: uid("u"),
      login: slugify(n),
      alias: n,
      isWorker: true,
      isApprover: false
    }));
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
  const approverEligible = users.filter(u => u.isApprover);
  return /*#__PURE__*/React.createElement("div", {
    style: overlayStyle,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modalStyle,
      width: 620
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modalHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Configuration"), /*#__PURE__*/React.createElement(X, {
    size: 16,
    style: {
      cursor: "pointer"
    },
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      padding: "10px 16px 0"
    }
  }, ["users", "locations", "types", "approvals", "view"].map(t => /*#__PURE__*/React.createElement("button", {
    key: t,
    onClick: () => setTab(t),
    style: {
      padding: "6px 12px",
      borderRadius: "6px 6px 0 0",
      border: "none",
      cursor: "pointer",
      background: tab === t ? COLORS.panel2 : "transparent",
      color: tab === t ? COLORS.text : COLORS.muted,
      fontSize: 12,
      textTransform: "capitalize",
      borderBottom: tab === t ? `2px solid ${COLORS.accent}` : "2px solid transparent"
    }
  }, t))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      maxHeight: 420,
      overflowY: "auto"
    }
  }, tab === "users" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Login name",
    value: newLogin,
    onChange: e => setNewLogin(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Alias (display name)",
    value: newAlias,
    onChange: e => setNewAlias(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("button", {
    style: primaryBtnStyle,
    onClick: () => {
      if (!newLogin.trim()) return;
      setUsers([...users, {
        id: uid("u"),
        login: newLogin.trim(),
        alias: newAlias.trim() || newLogin.trim(),
        isWorker: true,
        isApprover: false
      }]);
      setNewLogin("");
      setNewAlias("");
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Add")), /*#__PURE__*/React.createElement("table", {
    style: {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      color: COLORS.faint,
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("th", {
    style: thStyle
  }, "Login"), /*#__PURE__*/React.createElement("th", {
    style: thStyle
  }, "Alias"), /*#__PURE__*/React.createElement("th", {
    style: thStyle
  }, "Worker"), /*#__PURE__*/React.createElement("th", {
    style: thStyle
  }, "Approver"), /*#__PURE__*/React.createElement("th", {
    style: thStyle
  }))), /*#__PURE__*/React.createElement("tbody", null, users.map(u => /*#__PURE__*/React.createElement("tr", {
    key: u.id,
    style: {
      borderTop: `1px solid ${COLORS.lineSoft}`
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: tdStyle
  }, u.login), /*#__PURE__*/React.createElement("td", {
    style: tdStyle
  }, /*#__PURE__*/React.createElement("input", {
    value: u.alias,
    onChange: e => setUsers(users.map(x => x.id === u.id ? {
      ...x,
      alias: e.target.value
    } : x)),
    style: {
      ...inputStyle,
      padding: "3px 6px"
    }
  })), /*#__PURE__*/React.createElement("td", {
    style: tdStyle
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: u.isWorker,
    onChange: e => setUsers(users.map(x => x.id === u.id ? {
      ...x,
      isWorker: e.target.checked
    } : x))
  })), /*#__PURE__*/React.createElement("td", {
    style: tdStyle
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: u.isApprover,
    onChange: e => setUsers(users.map(x => x.id === u.id ? {
      ...x,
      isApprover: e.target.checked
    } : x))
  })), /*#__PURE__*/React.createElement("td", {
    style: tdStyle
  }, /*#__PURE__*/React.createElement(Trash2, {
    size: 13,
    style: {
      cursor: "pointer",
      color: COLORS.faint
    },
    onClick: () => setUsers(users.filter(x => x.id !== u.id))
  })))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 12,
      borderTop: `1px solid ${COLORS.lineSoft}`
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Bulk add — paste a name list (one per line, or comma-separated)"), /*#__PURE__*/React.createElement("textarea", {
    value: bulkNames,
    onChange: e => setBulkNames(e.target.value),
    placeholder: "Paste names here, e.g. from the Approvals tab's copy button…",
    rows: 3,
    style: {
      ...inputStyle,
      resize: "vertical",
      fontFamily: "inherit"
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...primaryBtnStyle,
      marginTop: 6
    },
    onClick: addBulkUsers
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Add all as users"))), tab === "locations" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Location name",
    value: newLoc,
    onChange: e => setNewLoc(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("button", {
    style: primaryBtnStyle,
    onClick: () => {
      if (!newLoc.trim()) return;
      setLocations([...locations, {
        id: uid("l"),
        name: newLoc.trim()
      }]);
      setNewLoc("");
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Add")), locations.map(l => /*#__PURE__*/React.createElement("div", {
    key: l.id,
    style: rowStyle
  }, /*#__PURE__*/React.createElement("span", null, l.name), /*#__PURE__*/React.createElement(Trash2, {
    size: 13,
    style: {
      cursor: "pointer",
      color: COLORS.faint
    },
    onClick: () => setLocations(locations.filter(x => x.id !== l.id))
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 12,
      borderTop: `1px solid ${COLORS.lineSoft}`
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Bulk add — one per line, or comma-separated"), /*#__PURE__*/React.createElement("textarea", {
    value: bulkLocText,
    onChange: e => setBulkLocText(e.target.value),
    placeholder: "North Yard, Warehouse 3, Site B - Riverside…",
    rows: 3,
    style: {
      ...inputStyle,
      resize: "vertical",
      fontFamily: "inherit"
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...primaryBtnStyle,
      marginTop: 6
    },
    onClick: () => {
      const names = parseNameList(bulkLocText);
      const existing = new Set(locations.map(l => l.name.toLowerCase()));
      const additions = names.filter(n => !existing.has(n.toLowerCase())).map(n => ({
        id: uid("l"),
        name: n
      }));
      if (additions.length) setLocations([...locations, ...additions]);
      setBulkLocText("");
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Add all"))), tab === "types" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Work type name",
    value: newType,
    onChange: e => setNewType(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("button", {
    style: primaryBtnStyle,
    onClick: () => {
      if (!newType.trim()) return;
      setWorkTypes([...workTypes, {
        id: uid("t"),
        name: newType.trim()
      }]);
      setNewType("");
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Add")), workTypes.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    style: rowStyle
  }, /*#__PURE__*/React.createElement("span", null, t.name), /*#__PURE__*/React.createElement(Trash2, {
    size: 13,
    style: {
      cursor: "pointer",
      color: COLORS.faint
    },
    onClick: () => setWorkTypes(workTypes.filter(x => x.id !== t.id))
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 12,
      borderTop: `1px solid ${COLORS.lineSoft}`
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Bulk add — one per line, or comma-separated"), /*#__PURE__*/React.createElement("textarea", {
    value: bulkTypeText,
    onChange: e => setBulkTypeText(e.target.value),
    placeholder: "Install, Maintenance, Inspection…",
    rows: 3,
    style: {
      ...inputStyle,
      resize: "vertical",
      fontFamily: "inherit"
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...primaryBtnStyle,
      marginTop: 6
    },
    onClick: () => {
      const names = parseNameList(bulkTypeText);
      const existing = new Set(workTypes.map(t => t.name.toLowerCase()));
      const additions = names.filter(n => !existing.has(n.toLowerCase())).map(n => ({
        id: uid("t"),
        name: n
      }));
      if (additions.length) setWorkTypes([...workTypes, ...additions]);
      setBulkTypeText("");
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Add all"))), tab === "approvals" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Required approvers — every name here must approve a work block before it turns green"), /*#__PURE__*/React.createElement("textarea", {
    value: requiredApprovers.join("\n"),
    onChange: e => setRequiredApprovers(parseNameList(e.target.value)),
    placeholder: "One name per line, or comma-separated…",
    rows: 5,
    style: {
      ...inputStyle,
      resize: "vertical",
      fontFamily: "inherit"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: ghostBtnStyle,
    onClick: copyRequiredApprovers
  }, copyLabel), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: COLORS.faint,
      alignSelf: "center"
    }
  }, "Select all and copy, then paste into the bulk-add box on the Users tab to reuse this list.")), approverEligible.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 12,
      borderTop: `1px solid ${COLORS.lineSoft}`
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Quick toggle from existing approvers"), approverEligible.map(u => /*#__PURE__*/React.createElement("label", {
    key: u.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      padding: "5px 0",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: requiredApprovers.includes(u.alias),
    onChange: e => {
      if (e.target.checked) setRequiredApprovers([...requiredApprovers, u.alias]);else setRequiredApprovers(requiredApprovers.filter(n => n !== u.alias));
    }
  }), u.alias)))), tab === "view" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      color: COLORS.text,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: showEventIds,
    onChange: e => setShowEventIds(e.target.checked)
  }), "Show event ID on calendar blocks"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: COLORS.faint,
      marginTop: 6,
      marginLeft: 24
    }
  }, "Prints each block's underlying database ID (e.g. ", /*#__PURE__*/React.createElement("code", null, "ev_a1b2c3"), ") in small text on the block itself — useful when cross-referencing an export or a support request against what's on screen. This is just a display preference (saved in this browser), not something exported or synced.")))));
}

// ---------- Export modal ----------
function ExportModal({
  events,
  requiredApprovers,
  onClose
}) {
  const [from, setFrom] = useState(addDays(isoDate(new Date()), -7));
  const [to, setTo] = useState(addDays(isoDate(new Date()), 7));
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [tz, setTz] = useState("local"); // "local" | "utc"
  const [includeId, setIncludeId] = useState(false);
  const tzName = localTZName();
  function flattenLinks(links) {
    return (links || []).map(l => {
      let s = `${l.label} (${l.url})`;
      if (l.description) s += ` \u2014 ${l.description}`;
      return s;
    }).join(" | ");
  }
  function buildRows(structured) {
    const clauses = parseFilterSyntax(filter);
    const fromE = epochDay(from),
      toE = epochDay(to);
    const useUTC = tz === "utc";
    const rows = events.filter(ev => {
      const ed = epochDay(ev.date);
      return ed >= fromE && ed <= toE;
    }).filter(ev => eventMatchesClauses(ev, clauses)).map(ev => {
      const s = fmtInTZ(eventStartDate(ev), useUTC);
      const e = fmtInTZ(eventEndDate(ev), useUTC);
      const base = {
        ...(includeId ? {
          id: ev.id
        } : {}),
        date: s.date,
        start: s.time,
        end: e.time,
        timezone: useUTC ? "UTC" : tzName,
        startSort: eventStartDate(ev).getTime(),
        workers: ev.workers.join("; "),
        locations: ev.locations.join("; "),
        types: ev.types.join("; "),
        approvedBy: (ev.approvedBy || []).join("; "),
        fullyApproved: isFullyApproved(ev, requiredApprovers) ? "Yes" : "No"
      };
      return structured ? {
        ...base,
        notes: ev.notes || {
          format: "text",
          content: ""
        },
        links: ev.links || []
      } : {
        ...base,
        notesFormat: ev.notes && ev.notes.format || "text",
        notes: ev.notes && ev.notes.content || "",
        links: flattenLinks(ev.links)
      };
    }).sort((a, b) => a.startSort - b.startSort).map(({
      startSort,
      ...r
    }) => r);
    return rows;
  }
  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  function doExport(kind) {
    try {
      const rows = buildRows(kind === "json");
      setError("");
      if (rows.length === 0) {
        setError("No rows match this range and filter.");
        return;
      }
      if (kind === "csv") {
        const headers = [...(includeId ? ["id"] : []), "date", "start", "end", "timezone", "workers", "locations", "types", "approvedBy", "fullyApproved", "notesFormat", "notes", "links"];
        const csv = [headers.join(",")].concat(rows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(","))).join("\n");
        download("schedule_export.csv", new Blob([csv], {
          type: "text/csv"
        }));
      } else if (kind === "json") {
        download("schedule_export.json", new Blob([JSON.stringify(rows, null, 2)], {
          type: "application/json"
        }));
      } else if (kind === "xlsx") {
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Schedule");
        const arr = XLSX.write(wb, {
          bookType: "xlsx",
          type: "array"
        });
        download("schedule_export.xlsx", new Blob([arr], {
          type: "application/octet-stream"
        }));
      }
    } catch (e) {
      setError("Filter syntax error — check brackets and field names.");
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    style: overlayStyle,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modalStyle,
      width: 480
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modalHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Export schedule"), /*#__PURE__*/React.createElement(X, {
    size: 16,
    style: {
      cursor: "pointer"
    },
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "From"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: from,
    onChange: e => setFrom(e.target.value),
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "To"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: to,
    onChange: e => setTo(e.target.value),
    style: inputStyle
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Times shown as"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setTz("local"),
    style: tz === "local" ? primaryBtnStyle : ghostBtnStyle
  }, "Local (", tzName, ")"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setTz("utc"),
    style: tz === "utc" ? primaryBtnStyle : ghostBtnStyle
  }, "UTC"))), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 12.5,
      color: COLORS.muted,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: includeId,
    onChange: e => setIncludeId(e.target.checked)
  }), "Include event ID column"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, "Filter"), /*#__PURE__*/React.createElement("input", {
    value: filter,
    onChange: e => setFilter(e.target.value),
    placeholder: "location:[North Yard] & type:[! Cleanup]",
    style: inputStyle
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: COLORS.faint,
      marginTop: 4
    }
  }, "Fields: location, type, worker. ", /*#__PURE__*/React.createElement("code", null, "field:[a & b]"), " requires both, ", /*#__PURE__*/React.createElement("code", null, "field:[! a]"), " excludes a. Join clauses with &.")), error && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: COLORS.danger
    }
  }, error), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: primaryBtnStyle,
    onClick: () => doExport("csv")
  }, /*#__PURE__*/React.createElement(Download, {
    size: 13
  }), " CSV"), /*#__PURE__*/React.createElement("button", {
    style: primaryBtnStyle,
    onClick: () => doExport("json")
  }, /*#__PURE__*/React.createElement(Download, {
    size: 13
  }), " JSON"), /*#__PURE__*/React.createElement("button", {
    style: primaryBtnStyle,
    onClick: () => doExport("xlsx")
  }, /*#__PURE__*/React.createElement(Download, {
    size: 13
  }), " Excel")))));
}

// ---------- Bulk JSON import modal ----------
function BulkImportModal({
  onImport,
  onClose
}) {
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
      const {
        added,
        errors
      } = parseBulkEventsJSON(text);
      if (added.length) onImport(added);
      setResult({
        addedCount: added.length,
        errors
      });
    } catch (e) {
      setResult({
        addedCount: 0,
        errors: [e.message]
      });
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    style: overlayStyle,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...modalStyle,
      width: 540
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: modalHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Bulk add work blocks"), /*#__PURE__*/React.createElement(X, {
    size: 16,
    style: {
      cursor: "pointer"
    },
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: COLORS.faint
    }
  }, "Paste a JSON array of blocks. Each item needs ", /*#__PURE__*/React.createElement("code", null, "date"), " (\"YYYY-MM-DD\"),", " ", /*#__PURE__*/React.createElement("code", null, "start"), " (\"HH:MM\", 24-hour) and ", /*#__PURE__*/React.createElement("code", null, "duration"), " (minutes).", " ", /*#__PURE__*/React.createElement("code", null, "locations"), ", ", /*#__PURE__*/React.createElement("code", null, "types"), ", ", /*#__PURE__*/React.createElement("code", null, "workers"), " and ", /*#__PURE__*/React.createElement("code", null, "approvedBy"), " are optional arrays of names — anything not on file yet in Config still gets added to the block as text.", " ", /*#__PURE__*/React.createElement("code", null, "notes"), " (", /*#__PURE__*/React.createElement("code", null, "{format, content}"), ", format is text/json/csv/markdown) and", " ", /*#__PURE__*/React.createElement("code", null, "links"), " (array of ", /*#__PURE__*/React.createElement("code", null, "{label, url, description}"), ") are also optional."), /*#__PURE__*/React.createElement("textarea", {
    value: text,
    onChange: e => setText(e.target.value),
    placeholder: example,
    rows: 11,
    style: {
      ...inputStyle,
      fontFamily: "ui-monospace, monospace",
      fontSize: 11.5,
      resize: "vertical"
    }
  }), result && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: result.errors.length ? COLORS.amber : COLORS.accent
    }
  }, "Added ", result.addedCount, " block", result.addedCount === 1 ? "" : "s", ".", result.errors.length > 0 && /*#__PURE__*/React.createElement("ul", {
    style: {
      margin: "4px 0 0 16px",
      padding: 0
    }
  }, result.errors.map((e, i) => /*#__PURE__*/React.createElement("li", {
    key: i
  }, e))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 8,
      padding: "12px 16px",
      borderTop: `1px solid ${COLORS.line}`
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: ghostBtnStyle
  }, "Close"), /*#__PURE__*/React.createElement("button", {
    onClick: runImport,
    style: primaryBtnStyle
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Import"))));
}

// ---------- shared style objects ----------
const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100
};
const modalStyle = {
  background: COLORS.panel,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 10,
  color: COLORS.text,
  fontFamily: "system-ui, sans-serif"
};
const modalHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 16px",
  borderBottom: `1px solid ${COLORS.line}`,
  fontSize: 14,
  fontWeight: 600
};
const labelStyle = {
  fontSize: 11,
  color: COLORS.faint,
  display: "block",
  marginBottom: 3
};
const inputStyle = {
  width: "100%",
  background: COLORS.panel2,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 6,
  padding: "7px 9px",
  color: COLORS.text,
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box"
};
const thStyle = {
  padding: "4px 6px",
  fontWeight: 500
};
const tdStyle = {
  padding: "5px 6px"
};
const rowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "7px 4px",
  borderBottom: `1px solid ${COLORS.lineSoft}`,
  fontSize: 13
};
const primaryBtnStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: COLORS.accent,
  color: "#0D1512",
  border: "none",
  borderRadius: 7,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer"
};
const ghostBtnStyle = {
  background: "transparent",
  color: COLORS.muted,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 7,
  padding: "7px 12px",
  fontSize: 12,
  cursor: "pointer"
};
const dangerBtnStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  color: COLORS.danger,
  border: `1px solid ${COLORS.danger}55`,
  borderRadius: 7,
  padding: "7px 12px",
  fontSize: 12,
  cursor: "pointer"
};

// ---------- info popup: full block details on hover ----------
function BlockInfoPopup({
  ev,
  corner,
  requiredApprovers,
  onMouseEnter,
  onMouseLeave
}) {
  const approvedBy = ev.approvedBy || [];
  const fullyApproved = isFullyApproved(ev, requiredApprovers);
  const endDay = eventEndDay(ev);
  const endMinutes = (ev.startMinutes + ev.duration) % 1440;
  const timeRange = `${minsToLabel(ev.startMinutes)} \u2013 ${minsToLabel(endMinutes)}` + (endDay !== ev.date ? ` (${fmtDateShort(endDay)})` : "");
  const hasNotes = ev.notes && ev.notes.content && ev.notes.content.trim();
  const posStyle = corner === "bottom-right" ? {
    bottom: 16,
    right: 16
  } : {
    bottom: 16,
    left: 16
  };
  return /*#__PURE__*/React.createElement("div", {
    onMouseEnter: onMouseEnter,
    onMouseLeave: onMouseLeave,
    style: {
      position: "fixed",
      ...posStyle,
      zIndex: 80,
      width: 300,
      maxHeight: "60vh",
      overflowY: "auto",
      background: COLORS.panel,
      border: `1px solid ${COLORS.line}`,
      borderRadius: 10,
      boxShadow: "0 16px 36px rgba(0,0,0,0.5)",
      padding: 14,
      fontSize: 12.5,
      color: COLORS.text
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: COLORS.faint
    }
  }, fmtDateShort(ev.date)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9.5,
      color: COLORS.faint,
      fontFamily: "ui-monospace, monospace"
    }
  }, ev.id)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      marginTop: 2
    }
  }, timeRange), ev.locations.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint
    }
  }, "LOCATIONS"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3
    }
  }, ev.locations.map(l => /*#__PURE__*/React.createElement(Chip, {
    key: l,
    tone: "loc"
  }, l)))), ev.types.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint
    }
  }, "TYPES"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3
    }
  }, ev.types.map(t => /*#__PURE__*/React.createElement(Chip, {
    key: t,
    tone: "type"
  }, t)))), ev.workers.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint
    }
  }, "WORKERS"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3
    }
  }, ev.workers.map(w => /*#__PURE__*/React.createElement(Chip, {
    key: w,
    tone: "worker"
  }, w)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint
    }
  }, "APPROVAL"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3,
      color: fullyApproved ? COLORS.accent : approvedBy.length ? COLORS.amber : COLORS.faint
    }
  }, approvedBy.length === 0 ? "No approvals yet" : `Approved by ${approvedBy.join(", ")}`, fullyApproved && " \u2014 fully approved")), hasNotes && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint
    }
  }, "NOTES (", ev.notes.format, ")"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3,
      whiteSpace: "pre-wrap",
      fontFamily: ev.notes.format === "json" || ev.notes.format === "csv" ? "ui-monospace, monospace" : "inherit",
      fontSize: 11.5,
      lineHeight: 1.4,
      background: COLORS.panel2,
      borderRadius: 6,
      padding: "6px 8px"
    }
  }, ev.notes.content)), ev.links && ev.links.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: COLORS.faint
    }
  }, "LINKS"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3,
      display: "flex",
      flexDirection: "column",
      gap: 3
    }
  }, ev.links.map((l, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 5
    }
  }, /*#__PURE__*/React.createElement(LinkIcon, {
    size: 10,
    color: COLORS.faint
  }), /*#__PURE__*/React.createElement("a", {
    href: l.url,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: "#7FB8E0",
      textDecoration: "underline",
      wordBreak: "break-all"
    }
  }, l.label), /*#__PURE__*/React.createElement(InlineInfoHover, {
    text: l.description
  }))))));
}

// ---------- context create-menu (right click) ----------
function ContextCreateMenu({
  x,
  y,
  locations,
  types,
  workers,
  onCreate,
  onClose
}) {
  const [loc, setLoc] = useState(null);
  const [type, setType] = useState(null);
  const [worker, setWorker] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    function h(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    style: {
      position: "fixed",
      left: x,
      top: y,
      zIndex: 90,
      background: COLORS.panel,
      border: `1px solid ${COLORS.line}`,
      borderRadius: 8,
      padding: 10,
      width: 220,
      boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
      color: COLORS.text,
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: COLORS.faint,
      marginBottom: 6
    }
  }, "New work block"), [["Location", locations, loc, setLoc], ["Type", types, type, setType], ["Worker", workers, worker, setWorker]].map(([label, opts, val, setVal]) => /*#__PURE__*/React.createElement("select", {
    key: label,
    value: val || "",
    onChange: e => setVal(e.target.value || null),
    style: {
      ...inputStyle,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, label, "…"), opts.map(o => /*#__PURE__*/React.createElement("option", {
    key: o,
    value: o
  }, o)))), /*#__PURE__*/React.createElement("button", {
    style: {
      ...primaryBtnStyle,
      width: "100%",
      justifyContent: "center"
    },
    onClick: () => onCreate({
      loc,
      type,
      worker
    })
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " Create"));
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

  // Load persisted state on first mount. If nothing answers (e.g. the page
  // was opened directly via `python -m http.server`, with no server/app.py
  // running), silently keep the built-in seed data and work in memory only.
  const [isSnapshotMode, setIsSnapshotMode] = useState(false);

  // Purely a display preference (not part of the shared schedule data), so
  // it's kept in this browser via localStorage rather than synced to the API.
  const [showEventIds, setShowEventIds] = useState(() => {
    try {
      return localStorage.getItem("schedule_showEventIds") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("schedule_showEventIds", showEventIds ? "1" : "0");
    } catch {/* ignore (private browsing, etc.) */}
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
      const [u, l, t, ra, ev] = await Promise.all([apiRequest("GET", "/users"), apiRequest("GET", "/locations"), apiRequest("GET", "/work_types"), apiRequest("GET", "/required_approvers"), apiRequest("GET", "/events")]);
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
    return () => {
      cancelled = true;
    };
  }, []);

  // Wrapped setters for the three plain config lists. The Config modal still
  // just calls these the same way it always called setUsers/etc — array in,
  // array out — so no changes were needed there; the diffing + API calls
  // happen transparently in between.
  function setUsersSynced(next) {
    setUsers(prev => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (apiAvailableRef.current) {
        syncListToApi("users", u => ({
          login: u.login,
          alias: u.alias,
          isWorker: u.isWorker,
          isApprover: u.isApprover
        }), prev, resolved, (oldId, newId) => setUsers(cur => cur.map(x => x.id === oldId ? {
          ...x,
          id: newId
        } : x)));
      }
      return resolved;
    });
  }
  function setLocationsSynced(next) {
    setLocations(prev => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (apiAvailableRef.current) {
        syncListToApi("locations", l => ({
          name: l.name
        }), prev, resolved, (oldId, newId) => setLocations(cur => cur.map(x => x.id === oldId ? {
          ...x,
          id: newId
        } : x)));
      }
      return resolved;
    });
  }
  function setWorkTypesSynced(next) {
    setWorkTypes(prev => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (apiAvailableRef.current) {
        syncListToApi("work_types", t => ({
          name: t.name
        }), prev, resolved, (oldId, newId) => setWorkTypes(cur => cur.map(x => x.id === oldId ? {
          ...x,
          id: newId
        } : x)));
      }
      return resolved;
    });
  }
  function setRequiredApproversSynced(next) {
    setRequiredApprovers(prev => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (apiAvailableRef.current) apiRequest("PUT", "/required_approvers", {
        names: resolved
      });
      return resolved;
    });
  }
  const [rangeStart, setRangeStart] = useState(monday);
  const [rangeDays, setRangeDays] = useState(7);
  const [currentUserId, setCurrentUserId] = useState("u4");
  const currentUser = users.find(u => u.id === currentUserId) || users[0] || {
    id: null,
    login: "",
    alias: "(no users yet)",
    isWorker: false,
    isApprover: false
  };
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
      const [reactJs, reactDomJs, xlsxJs, appJs] = await Promise.all([fetch("vendor/react.production.min.js").then(r => {
        if (!r.ok) throw new Error("vendor/react.production.min.js");
        return r.text();
      }), fetch("vendor/react-dom.production.min.js").then(r => {
        if (!r.ok) throw new Error("vendor/react-dom.production.min.js");
        return r.text();
      }), fetch("vendor/xlsx.full.min.js").then(r => {
        if (!r.ok) throw new Error("vendor/xlsx.full.min.js");
        return r.text();
      }), fetch("app.js").then(r => {
        if (!r.ok) throw new Error("app.js");
        return r.text();
      })]);
      const snapshot = {
        users,
        locations,
        workTypes,
        requiredApprovers,
        events,
        exportedAt: new Date().toISOString()
      };
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
      const blob = new Blob([html], {
        type: "text/html"
      });
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
    return window.matchMedia && window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  }, []);
  function openInfoPopup(id, corner) {
    if (infoCloseTimer.current) {
      clearTimeout(infoCloseTimer.current);
      infoCloseTimer.current = null;
    }
    setInfoPopup({
      id,
      corner
    });
  }
  function scheduleCloseInfoPopup() {
    infoCloseTimer.current = setTimeout(() => setInfoPopup(null), 150);
  }
  const [recents, setRecents] = useState({
    loc: [],
    type: [],
    worker: []
  });
  const [selVal, setSelVal] = useState({
    loc: null,
    type: null,
    worker: null
  });
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
  const locationNames = locations.map(l => l.name);
  const typeNames = workTypes.map(t => t.name);
  const workerNames = users.filter(u => u.isWorker).map(u => u.alias);
  const days = useMemo(() => Array.from({
    length: rangeDays
  }, (_, i) => addDays(rangeStart, i)), [rangeStart, rangeDays]);

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
  useEffect(() => {
    setColWidths(null);
  }, [days.length]);
  function startColResize(e, index) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const widths = colWidths ? [...colWidths] : days.map(d => colRefs.current[d]?.getBoundingClientRect().width || 160);
    dividerDrag.current = {
      index,
      startX: e.clientX,
      widths
    };
    document.addEventListener("mousemove", onColResizeMove);
    document.addEventListener("mouseup", onColResizeEnd);
  }
  function onColResizeMove(e) {
    const dd = dividerDrag.current;
    if (!dd) return;
    const dx = e.clientX - dd.startX;
    const minW = 70;
    const next = [...dd.widths];
    next[dd.index] = Math.max(minW, dd.widths[dd.index] + dx);
    setColWidths(next);
  }
  function onColResizeEnd() {
    dividerDrag.current = null;
    document.removeEventListener("mousemove", onColResizeMove);
    document.removeEventListener("mouseup", onColResizeEnd);
  }
  function bumpRecent(kind, value) {
    setRecents(r => ({
      ...r,
      [kind]: [value, ...r[kind].filter(x => x !== value)]
    }));
  }
  function pick(kind, value) {
    setSelVal(s => ({
      ...s,
      [kind]: value
    }));
    bumpRecent(kind, value);
  }

  // ---- event helpers ----
  function updateEventLocal(id, patch) {
    setEvents(evs => evs.map(e => e.id === id ? {
      ...e,
      ...patch
    } : e));
  }
  function updateEvent(id, patch) {
    updateEventLocal(id, patch);
    if (apiAvailableRef.current) apiRequest("PUT", `/events/${id}`, patch);
  }
  function deleteEvent(id) {
    setEvents(evs => evs.filter(e => e.id !== id));
    setSelectedIds(s => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setEditingId(null);
    if (apiAvailableRef.current) apiRequest("DELETE", `/events/${id}`);
  }
  function createEvent({
    date,
    startMinutes,
    loc,
    type,
    worker
  }) {
    const localEvent = {
      id: uid("ev"),
      date,
      startMinutes: snap(startMinutes),
      duration: MIN_DUR,
      locations: loc ? [loc] : [],
      types: type ? [type] : [],
      workers: worker ? [worker] : [],
      approvedBy: [],
      notes: {
        format: "text",
        content: ""
      },
      links: []
    };
    setEvents(evs => [...evs, localEvent]);
    if (apiAvailableRef.current) {
      apiRequest("POST", "/events", localEvent).then(created => {
        if (created && created.id && created.id !== localEvent.id) {
          setEvents(evs => evs.map(e => e.id === localEvent.id ? {
            ...e,
            id: created.id
          } : e));
        }
      });
    }
  }
  function snap(m) {
    return Math.round(m / SNAP) * SNAP;
  }

  // ---- drop on column background: create new ----
  function handleColDrop(e, date) {
    e.preventDefault();
    let payload;
    try {
      payload = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }
    if (!payload) return;
    const col = colRefs.current[date];
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minutesFromTop = y / HOUR_PX * 60 - peekHours * 60;
    const start = snap(minutesFromTop);
    createEvent({
      date,
      startMinutes: start,
      loc: payload.kind === "loc" ? payload.value : null,
      type: payload.kind === "type" ? payload.value : null,
      worker: payload.kind === "worker" ? payload.value : null
    });
  }
  // ---- drop directly on an existing block: add-to ----
  function handleBlockDrop(e, ev) {
    e.preventDefault();
    e.stopPropagation();
    let payload;
    try {
      payload = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }
    if (!payload) return;
    if (payload.kind === "loc" && !ev.locations.includes(payload.value)) updateEvent(ev.id, {
      locations: [...ev.locations, payload.value]
    });
    if (payload.kind === "type" && !ev.types.includes(payload.value)) updateEvent(ev.id, {
      types: [...ev.types, payload.value]
    });
    if (payload.kind === "worker" && !ev.workers.includes(payload.value)) updateEvent(ev.id, {
      workers: [...ev.workers, payload.value]
    });
  }

  // ---- selection ----
  function toggleSelect(id, additive) {
    setSelectedIds(s => {
      const n = additive ? new Set(s) : new Set();
      if (n.has(id) && additive) n.delete(id);else n.add(id);
      return n;
    });
  }
  function approveSelected(val) {
    const name = currentUser.alias;
    setEvents(evs => evs.map(e => {
      if (!selectedIds.has(e.id)) return e;
      const by = e.approvedBy || [];
      const nextBy = val ? by.includes(name) ? by : [...by, name] : by.filter(n => n !== name);
      if (nextBy !== by && apiAvailableRef.current) apiRequest("PUT", `/events/${e.id}`, {
        approvedBy: nextBy
      });
      return {
        ...e,
        approvedBy: nextBy
      };
    }));
  }

  // ---- pointer-based move / resize ----
  function startMove(e, ev, mode) {
    if (e.button !== 0) return; // left click only — middle button is reserved for panning
    e.stopPropagation();
    e.preventDefault();
    const colW = colRefs.current[ev.date]?.getBoundingClientRect().width || 160;
    moveState.current = {
      id: ev.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origStart: ev.startMinutes,
      origDur: ev.duration,
      origDate: ev.date,
      colW
    };
    document.addEventListener("mousemove", onMoveDrag);
    document.addEventListener("mouseup", onMoveEnd);
  }
  function onMoveDrag(e) {
    const ms = moveState.current;
    if (!ms) return;
    const dy = e.clientY - ms.startY;
    const deltaMin = snap(dy / HOUR_PX * 60);
    if (ms.mode === "resize") {
      const newDur = Math.max(MIN_DUR, ms.origDur + deltaMin);
      updateEventLocal(ms.id, {
        duration: newDur
      });
      ms.lastPatch = {
        duration: newDur
      };
    } else {
      const dx = e.clientX - ms.startX;
      const dayShift = Math.round(dx / (ms.colW || 160));
      const newDate = addDays(ms.origDate, dayShift);
      const patch = {
        startMinutes: ms.origStart + deltaMin,
        date: newDate
      };
      updateEventLocal(ms.id, patch);
      ms.lastPatch = patch;
    }
  }
  function onMoveEnd() {
    const ms = moveState.current;
    if (ms && ms.lastPatch && apiAvailableRef.current) apiRequest("PUT", `/events/${ms.id}`, ms.lastPatch);
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
    setMarquee({
      date,
      x0: e.clientX,
      y0: e.clientY - rect.top,
      x1: e.clientX,
      y1: e.clientY - rect.top,
      rectTop: rect.top
    });
    document.addEventListener("mousemove", onMarqueeMove);
    document.addEventListener("mouseup", onMarqueeEnd);
  }
  function onMarqueeMove(e) {
    setMarquee(m => m ? {
      ...m,
      x1: e.clientX,
      y1: e.clientY - m.rectTop
    } : m);
  }
  function onMarqueeEnd() {
    setMarquee(m => {
      if (m) {
        const top = Math.min(m.y0, m.y1),
          bottom = Math.max(m.y0, m.y1);
        const minTop = top / HOUR_PX * 60 - peekHours * 60;
        const minBottom = bottom / HOUR_PX * 60 - peekHours * 60;
        const hits = events.filter(ev => {
          if (ev.date !== m.date) return false;
          const evEnd = ev.startMinutes + ev.duration;
          return evEnd > minTop && ev.startMinutes < minBottom;
        }).map(ev => ev.id);
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
    panState.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop
    };
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
    let x = 0,
      y = 0;
    for (let i = 0; i < touches.length; i++) {
      x += touches[i].clientX;
      y += touches[i].clientY;
    }
    return {
      x: x / touches.length,
      y: y / touches.length
    };
  }
  function onTouchStartPan(e) {
    if (e.touches.length !== 2) return; // two fingers only — one finger keeps working for tap/select/drag
    const c = touchCentroid(e.touches);
    const el = gridRef.current;
    panState.current = {
      startX: c.x,
      startY: c.y,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop
    };
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
  const editingEvent = events.find(e => e.id === editingId);
  const totalHeight = (DAY_MIN / 60 + peekHours * 2) * HOUR_PX;
  const hourMarks = Array.from({
    length: 24 + peekHours * 2
  }, (_, i) => i - peekHours);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "system-ui, sans-serif",
      height: "100%",
      minHeight: 640,
      display: "flex",
      flexDirection: "column",
      borderRadius: 12,
      overflow: "hidden",
      border: `1px solid ${COLORS.line}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 16px",
      borderBottom: `1px solid ${COLORS.line}`,
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 700,
      letterSpacing: 0.2,
      marginRight: 6
    }
  }, "Field Schedule"), isSnapshotMode ? /*#__PURE__*/React.createElement("span", {
    title: "This is an offline copy — nothing here is sent anywhere automatically. Use the Export button when you're done to send your changes back.",
    style: {
      fontSize: 10,
      padding: "2px 7px",
      borderRadius: 10,
      color: COLORS.amber,
      border: `1px solid ${COLORS.amber}55`,
      whiteSpace: "nowrap"
    }
  }, "\u25D1 Offline copy") : apiAvailable !== null && /*#__PURE__*/React.createElement("span", {
    title: apiAvailable ? "Connected to server/app.py — changes are saved" : "No backend reachable — changes are local to this tab only",
    style: {
      fontSize: 10,
      padding: "2px 7px",
      borderRadius: 10,
      color: apiAvailable ? COLORS.accent : COLORS.faint,
      border: `1px solid ${apiAvailable ? COLORS.accent : COLORS.faint}55`,
      whiteSpace: "nowrap"
    }
  }, apiAvailable ? "\u25CF Synced" : "\u25CB Local only"), snapshotError && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: COLORS.danger
    }
  }, snapshotError), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement(CalendarRange, {
    size: 14,
    color: COLORS.faint
  }), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: rangeStart,
    onChange: e => setRangeStart(e.target.value),
    style: {
      ...inputStyle,
      width: 132
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.faint,
      fontSize: 12
    }
  }, "for"), /*#__PURE__*/React.createElement("select", {
    value: rangeDays,
    onChange: e => setRangeDays(Number(e.target.value)),
    style: {
      ...inputStyle,
      width: 78
    }
  }, [1, 3, 5, 7, 10, 14].map(n => /*#__PURE__*/React.createElement("option", {
    key: n,
    value: n
  }, n, " days"))), /*#__PURE__*/React.createElement("span", {
    style: {
      color: COLORS.faint,
      fontSize: 11
    },
    title: "All block times are shown in your browser's local timezone"
  }, localTZName())), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      borderLeft: `1px solid ${COLORS.line}`,
      paddingLeft: 10,
      marginLeft: 4
    }
  }, currentUser.isApprover ? /*#__PURE__*/React.createElement(ShieldCheck, {
    size: 14,
    color: COLORS.accent
  }) : /*#__PURE__*/React.createElement(ShieldOff, {
    size: 14,
    color: COLORS.faint
  }), /*#__PURE__*/React.createElement("select", {
    value: currentUserId,
    onChange: e => setCurrentUserId(e.target.value),
    style: {
      ...inputStyle,
      width: 150
    }
  }, users.map(u => /*#__PURE__*/React.createElement("option", {
    key: u.id,
    value: u.id
  }, u.alias)))), /*#__PURE__*/React.createElement(IconBtn, {
    title: "Bulk add work blocks (JSON)",
    onClick: () => setBulkImportOpen(true)
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 16
  })), /*#__PURE__*/React.createElement(IconBtn, {
    title: snapshotBusy ? "Building offline copy\u2026" : "Download an offline copy (view/edit without server access)",
    onClick: downloadStandaloneSnapshot
  }, snapshotBusy ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10
    }
  }, "\u2026") : /*#__PURE__*/React.createElement(OfflineIcon, {
    size: 15
  })), /*#__PURE__*/React.createElement(IconBtn, {
    title: "Export",
    onClick: () => setExportOpen(true)
  }, /*#__PURE__*/React.createElement(Download, {
    size: 16
  })), /*#__PURE__*/React.createElement(IconBtn, {
    title: "Configuration",
    onClick: () => setConfigOpen(true)
  }, /*#__PURE__*/React.createElement(Settings, {
    size: 16
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(SelectorBox, {
    label: "LOCATION",
    tone: "loc",
    options: locationNames,
    value: selVal.loc,
    recents: recents.loc,
    onPick: v => pick("loc", v),
    onDragPick: v => bumpRecent("loc", v)
  }), /*#__PURE__*/React.createElement(SelectorBox, {
    label: "TYPE",
    tone: "type",
    options: typeNames,
    value: selVal.type,
    recents: recents.type,
    onPick: v => pick("type", v),
    onDragPick: v => bumpRecent("type", v)
  }), /*#__PURE__*/React.createElement(SelectorBox, {
    label: "WORKER",
    tone: "worker",
    options: workerNames,
    value: selVal.worker,
    recents: recents.worker,
    onPick: v => pick("worker", v),
    onDragPick: v => bumpRecent("worker", v)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginLeft: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    disabled: !currentUser.isApprover || selectedIds.size === 0,
    onClick: () => approveSelected(true),
    title: `Add ${currentUser.alias} as an approver on the selected blocks`,
    style: {
      ...primaryBtnStyle,
      opacity: !currentUser.isApprover || selectedIds.size === 0 ? 0.4 : 1,
      cursor: !currentUser.isApprover || selectedIds.size === 0 ? "not-allowed" : "pointer"
    }
  }, /*#__PURE__*/React.createElement(Check, {
    size: 13
  }), " Approve as ", currentUser.alias, selectedIds.size ? ` (${selectedIds.size})` : ""), /*#__PURE__*/React.createElement("button", {
    disabled: !currentUser.isApprover || selectedIds.size === 0,
    onClick: () => approveSelected(false),
    title: `Remove ${currentUser.alias}'s approval from the selected blocks`,
    style: {
      ...ghostBtnStyle,
      opacity: !currentUser.isApprover || selectedIds.size === 0 ? 0.4 : 1,
      cursor: !currentUser.isApprover || selectedIds.size === 0 ? "not-allowed" : "pointer"
    }
  }, "Unapprove")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: "auto",
      touchAction: "pan-x pan-y",
      cursor: "default"
    },
    ref: gridRef,
    onMouseDown: startPanMouse,
    onTouchStart: onTouchStartPan,
    onTouchMove: onTouchMovePan,
    onTouchEnd: onTouchEndPan
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 56,
      flexShrink: 0,
      position: "sticky",
      left: 0,
      background: COLORS.bg,
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 34,
      borderBottom: `1px solid ${COLORS.line}`
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      height: totalHeight
    }
  }, hourMarks.map(h => /*#__PURE__*/React.createElement("div", {
    key: h,
    style: {
      position: "absolute",
      top: (h + peekHours) * HOUR_PX - 6,
      right: 6,
      fontSize: 10,
      color: COLORS.faint,
      fontVariantNumeric: "tabular-nums"
    }
  }, minsToLabel((h % 24 + 24) % 24 * 60))))), days.map((date, dayIdx) => {
    const dayEvents = events.filter(ev => {
      const rel = (epochDay(ev.date) - epochDay(date)) * 1440 + ev.startMinutes;
      return rel + ev.duration > -peekHours * 60 && rel < DAY_MIN + peekHours * 60;
    });
    // side-by-side layout for blocks that overlap in this column
    const overlapLayout = layoutOverlaps(dayEvents.map(ev => {
      const rel = (epochDay(ev.date) - epochDay(date)) * 1440 + ev.startMinutes;
      return {
        id: ev.id,
        start: rel,
        end: rel + ev.duration
      };
    }));
    const colStyle = colWidths ? {
      width: colWidths[dayIdx],
      flex: "0 0 auto"
    } : {
      flex: "1 1 0",
      minWidth: 0
    };
    return /*#__PURE__*/React.createElement("div", {
      key: date,
      style: {
        ...colStyle,
        borderRight: `1px solid ${COLORS.line}`,
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: 34,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        color: COLORS.muted,
        borderBottom: `1px solid ${COLORS.line}`,
        position: "sticky",
        top: 0,
        background: COLORS.bg,
        zIndex: 4
      }
    }, fmtDateShort(date)), /*#__PURE__*/React.createElement("div", {
      onMouseDown: e => startColResize(e, dayIdx),
      title: "Drag to resize column",
      style: {
        position: "absolute",
        top: 0,
        right: -4,
        width: 9,
        height: 34,
        cursor: "col-resize",
        zIndex: 6
      }
    }), /*#__PURE__*/React.createElement("div", {
      ref: el => {
        colRefs.current[date] = el;
      },
      onDragOver: e => e.preventDefault(),
      onDrop: e => handleColDrop(e, date),
      onMouseDown: e => startMarquee(e, date),
      onContextMenu: e => {
        e.preventDefault();
        const rect = colRefs.current[date].getBoundingClientRect();
        const minutesFromTop = (e.clientY - rect.top) / HOUR_PX * 60 - peekHours * 60;
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          date,
          startMinutes: minutesFromTop
        });
      },
      style: {
        position: "relative",
        height: totalHeight,
        background: COLORS.panel
      }
    }, hourMarks.map(h => /*#__PURE__*/React.createElement("div", {
      key: h,
      style: {
        position: "absolute",
        top: (h + peekHours) * HOUR_PX,
        left: 0,
        right: 0,
        borderTop: `1px solid ${h < 0 || h >= 24 ? COLORS.lineSoft : COLORS.line}`,
        opacity: h < 0 || h >= 24 ? 0.5 : 1
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: peekHours * HOUR_PX,
        background: "rgba(0,0,0,0.25)",
        pointerEvents: "none"
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: peekHours * HOUR_PX,
        background: "rgba(0,0,0,0.25)",
        pointerEvents: "none"
      }
    }), dayEvents.map(ev => {
      const rel = (epochDay(ev.date) - epochDay(date)) * 1440 + ev.startMinutes;
      const top = (rel + peekHours * 60) / 60 * HOUR_PX;
      const height = Math.max(16, ev.duration / 60 * HOUR_PX - 2);
      const isHomeDay = date === ev.date;
      const isEndDay = date === eventEndDay(ev);
      const selected = selectedIds.has(ev.id);
      const lay = overlapLayout[ev.id] || {
        lane: 0,
        laneCount: 1
      };
      const gutter = 4,
        laneGap = 3;
      const laneWidthPct = 100 / lay.laneCount;
      const approvedBy = ev.approvedBy || [];
      const fullyApproved = isFullyApproved(ev, requiredApprovers);
      const partiallyApproved = !fullyApproved && approvedBy.length > 0;
      const hasNotes = !!(ev.notes && ev.notes.content && ev.notes.content.trim());
      const hasLinks = !!(ev.links && ev.links.length > 0);
      return /*#__PURE__*/React.createElement("div", {
        key: ev.id + "_" + date,
        onDragOver: e => e.preventDefault(),
        onDrop: e => handleBlockDrop(e, ev),
        onMouseDown: e => startMove(e, ev, "move"),
        onClick: e => {
          e.stopPropagation();
          toggleSelect(ev.id, e.metaKey || e.ctrlKey || e.shiftKey);
        },
        style: {
          position: "absolute",
          top,
          height,
          borderRadius: 6,
          left: `calc(${lay.lane * laneWidthPct}% + ${gutter}px)`,
          width: `calc(${laneWidthPct}% - ${gutter + laneGap}px)`,
          background: fullyApproved ? "rgba(79,182,168,0.18)" : partiallyApproved ? "rgba(232,169,78,0.10)" : COLORS.block,
          border: `1.5px solid ${selected ? COLORS.amber : fullyApproved ? COLORS.accent : partiallyApproved ? "#8A6A33" : COLORS.blockBorder}`,
          padding: "3px 5px",
          fontSize: 10.5,
          overflow: "hidden",
          cursor: "grab",
          boxSizing: "border-box",
          zIndex: selected ? 3 : 2
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          color: COLORS.faint,
          fontVariantNumeric: "tabular-nums"
        }
      }, isHomeDay ? minsToLabel(ev.startMinutes) : "\u22EF continued"), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 3
        }
      }, hasNotes && /*#__PURE__*/React.createElement("span", {
        title: "Has notes",
        style: {
          fontSize: 8.5,
          fontWeight: 700,
          color: COLORS.amber,
          border: `1px solid ${COLORS.amber}77`,
          borderRadius: 3,
          padding: "0 3px",
          lineHeight: "11px"
        }
      }, "N"), hasLinks && /*#__PURE__*/React.createElement("span", {
        title: "Has links",
        style: {
          fontSize: 8.5,
          fontWeight: 700,
          color: "#7FB8E0",
          border: "1px solid #7FB8E077",
          borderRadius: 3,
          padding: "0 3px",
          lineHeight: "11px"
        }
      }, "L"), /*#__PURE__*/React.createElement(Info, {
        size: 10,
        color: COLORS.faint,
        style: {
          cursor: "pointer"
        },
        onMouseEnter: e => {
          if (isTouchDevice) return;
          const corner = e.clientX < window.innerWidth / 2 ? "bottom-right" : "bottom-left";
          openInfoPopup(ev.id, corner);
        },
        onMouseLeave: () => {
          if (!isTouchDevice) scheduleCloseInfoPopup();
        },
        onClick: e => {
          e.stopPropagation();
          if (isTouchDevice) setEditingId(ev.id);
        }
      }), /*#__PURE__*/React.createElement(Pencil, {
        size: 10,
        style: {
          cursor: "pointer",
          color: COLORS.faint
        },
        onClick: e => {
          e.stopPropagation();
          setEditingId(ev.id);
        }
      }))), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          flexWrap: "wrap",
          marginTop: 2
        }
      }, ev.locations.map(l => /*#__PURE__*/React.createElement(Chip, {
        key: l,
        tone: "loc"
      }, l)), ev.types.map(t => /*#__PURE__*/React.createElement(Chip, {
        key: t,
        tone: "type"
      }, t)), ev.workers.map(w => /*#__PURE__*/React.createElement(Chip, {
        key: w,
        tone: "worker"
      }, w))), approvedBy.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 9.5,
          color: fullyApproved ? COLORS.accent : COLORS.amber,
          marginTop: 2
        }
      }, "Approved: ", approvedBy.join(", ")), showEventIds && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 8.5,
          color: COLORS.faint,
          fontFamily: "ui-monospace, monospace",
          marginTop: 2,
          opacity: 0.8
        }
      }, ev.id), !isHomeDay && /*#__PURE__*/React.createElement("div", {
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `repeating-linear-gradient(90deg, ${COLORS.faint} 0 6px, transparent 6px 12px)`,
          opacity: 0.6
        }
      }), isEndDay && /*#__PURE__*/React.createElement("div", {
        onMouseDown: e => startMove(e, ev, "resize"),
        title: "Drag to adjust duration",
        style: {
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 6,
          cursor: "ns-resize"
        }
      }), !isEndDay && /*#__PURE__*/React.createElement("div", {
        style: {
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `repeating-linear-gradient(90deg, ${COLORS.faint} 0 6px, transparent 6px 12px)`,
          opacity: 0.6
        }
      }));
    }), marquee && marquee.date === date && /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        left: 2,
        right: 2,
        top: Math.min(marquee.y0, marquee.y1),
        height: Math.abs(marquee.y1 - marquee.y0),
        background: "rgba(232,169,78,0.12)",
        border: `1px dashed ${COLORS.amber}`,
        pointerEvents: "none"
      }
    })));
  }))), contextMenu && /*#__PURE__*/React.createElement(ContextCreateMenu, {
    x: contextMenu.x,
    y: contextMenu.y,
    locations: locationNames,
    types: typeNames,
    workers: workerNames,
    onClose: () => setContextMenu(null),
    onCreate: ({
      loc,
      type,
      worker
    }) => {
      createEvent({
        date: contextMenu.date,
        startMinutes: contextMenu.startMinutes,
        loc,
        type,
        worker
      });
      setContextMenu(null);
    }
  }), infoPopup && (() => {
    const popupEvent = events.find(e => e.id === infoPopup.id);
    if (!popupEvent) return null;
    return /*#__PURE__*/React.createElement(BlockInfoPopup, {
      ev: popupEvent,
      corner: infoPopup.corner,
      requiredApprovers: requiredApprovers,
      onMouseEnter: () => openInfoPopup(infoPopup.id, infoPopup.corner),
      onMouseLeave: scheduleCloseInfoPopup
    });
  })(), editingEvent && /*#__PURE__*/React.createElement(EditEventModal, {
    ev: editingEvent,
    allLocations: locationNames,
    allTypes: typeNames,
    allWorkers: workerNames,
    allApprovers: users.filter(u => u.isApprover).map(u => u.alias),
    requiredApprovers: requiredApprovers,
    onSave: (id, patch) => {
      updateEvent(id, patch);
      setEditingId(null);
    },
    onDelete: deleteEvent,
    onClose: () => setEditingId(null)
  }), configOpen && /*#__PURE__*/React.createElement(ConfigModal, {
    users: users,
    setUsers: setUsersSynced,
    locations: locations,
    setLocations: setLocationsSynced,
    workTypes: workTypes,
    setWorkTypes: setWorkTypesSynced,
    requiredApprovers: requiredApprovers,
    setRequiredApprovers: setRequiredApproversSynced,
    showEventIds: showEventIds,
    setShowEventIds: setShowEventIds,
    onClose: () => setConfigOpen(false)
  }), exportOpen && /*#__PURE__*/React.createElement(ExportModal, {
    events: events,
    requiredApprovers: requiredApprovers,
    onClose: () => setExportOpen(false)
  }), bulkImportOpen && /*#__PURE__*/React.createElement(BulkImportModal, {
    onImport: newEvents => {
      setEvents(evs => [...evs, ...newEvents]);
      if (apiAvailableRef.current) {
        newEvents.forEach(localEvent => {
          apiRequest("POST", "/events", localEvent).then(created => {
            if (created && created.id && created.id !== localEvent.id) {
              setEvents(evs => evs.map(e => e.id === localEvent.id ? {
                ...e,
                id: created.id
              } : e));
            }
          });
        });
      }
    },
    onClose: () => setBulkImportOpen(false)
  }));
}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(WorkSchedulePlanner));