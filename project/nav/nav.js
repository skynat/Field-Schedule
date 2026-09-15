// Field Schedule — folder/calendar tree navigator.
//
// Deliberately plain JS with no build step and no framework: this page's
// whole job is "render a tree of tiles and let you click into them", which
// doesn't need React. Keeping it separate from app.jsx also means editing
// this file never requires rebuilding app.js (see build.js/README.md).
//
// Mirrors the SAME relative-path trick app.jsx uses for its own API base
// (see APP_BASE there): derive our base from wherever THIS script was
// actually loaded from, so this page works whether it's served at a
// domain root or mounted under a shared path behind a reverse proxy, with
// no config to edit either way.
const APP_BASE = (() => {
  try {
    const src = document.currentScript && document.currentScript.src;
    if (src) return src.slice(0, src.lastIndexOf("/") + 1);
  } catch (e) { /* ignore */ }
  return "/";
})();
const API_BASE = APP_BASE + "api/tree";

const statusEl = document.getElementById("status");
const breadcrumbEl = document.getElementById("breadcrumb");
const gridEl = document.getElementById("grid");

function currentNodeId() {
  const h = location.hash.replace(/^#\/?/, "");
  return h || "root";
}

function navigateTo(nodeId) {
  location.hash = "#" + nodeId;
}

async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function iconFor(node) {
  return node.kind === "folder" ? "📁" : "🗓️";
}

function renderBreadcrumb(breadcrumb) {
  breadcrumbEl.innerHTML = "";
  breadcrumb.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = " / ";
      breadcrumbEl.appendChild(sep);
    }
    const isLast = i === breadcrumb.length - 1;
    if (isLast) {
      const span = document.createElement("span");
      span.className = "current";
      span.textContent = node.name;
      breadcrumbEl.appendChild(span);
    } else {
      const a = document.createElement("a");
      a.textContent = node.name;
      a.onclick = () => navigateTo(node.id);
      breadcrumbEl.appendChild(a);
    }
  });
}

function renderGrid(children, parentId) {
  gridEl.innerHTML = "";
  if (children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Empty. Create a folder or a calendar to get started.";
    gridEl.appendChild(empty);
    return;
  }

  for (const node of children) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.draggable = true;

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = iconFor(node);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = node.name;

    tile.appendChild(icon);
    tile.appendChild(name);

    if (node.kind === "calendar") {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = node.hasFile ? "Synced" : "Not opened yet";
      tile.appendChild(meta);
    }

    const menuBtn = document.createElement("button");
    menuBtn.className = "tile-menu";
    menuBtn.textContent = "⋯";
    menuBtn.title = "Rename or delete";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      showTileMenu(node);
    };
    tile.appendChild(menuBtn);

    tile.onclick = () => {
      if (node.kind === "folder") {
        navigateTo(node.id);
      } else {
        // Navigating here is what triggers the backend to create the
        // calendar's SQLite file on first visit (see main.py) — there's
        // no separate "provision" step to wait on.
        location.href = APP_BASE + "cal/" + node.id + "/";
      }
    };

    // Drag-and-drop move: drag any tile, drop it onto a folder tile.
    tile.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", node.id);
    });
    if (node.kind === "folder") {
      tile.addEventListener("dragover", (e) => {
        e.preventDefault();
        tile.classList.add("drag-over");
      });
      tile.addEventListener("dragleave", () => tile.classList.remove("drag-over"));
      tile.addEventListener("drop", async (e) => {
        e.preventDefault();
        tile.classList.remove("drag-over");
        const draggedId = e.dataTransfer.getData("text/plain");
        if (!draggedId || draggedId === node.id) return;
        try {
          await api("PATCH", "/nodes/" + draggedId, { parentId: node.id });
          load();
        } catch (err) {
          alert("Couldn't move that here: " + err.message);
        }
      });
    }

    gridEl.appendChild(tile);
  }
}

function showTileMenu(node) {
  const choice = prompt(
    `"${node.name}" — type "rename", "delete", or cancel:`
  );
  if (!choice) return;
  if (choice.toLowerCase().startsWith("rename")) {
    const name = prompt("New name:", node.name);
    if (name && name.trim()) {
      api("PATCH", "/nodes/" + node.id, { name: name.trim() }).then(load).catch(
        (err) => alert("Rename failed: " + err.message)
      );
    }
  } else if (choice.toLowerCase().startsWith("delete")) {
    const warn = node.kind === "folder"
      ? `Delete "${node.name}" and everything inside it? This can't be undone.`
      : `Delete calendar "${node.name}" and all its data? This can't be undone.`;
    if (confirm(warn)) {
      api("DELETE", "/nodes/" + node.id).then(load).catch(
        (err) => alert("Delete failed: " + err.message)
      );
    }
  }
}

async function load() {
  const nodeId = currentNodeId();
  statusEl.textContent = "Loading…";
  try {
    const [nodeInfo, children] = await Promise.all([
      api("GET", "/" + nodeId),
      api("GET", "/" + nodeId + "/children"),
    ]);
    renderBreadcrumb(nodeInfo.breadcrumb);
    renderGrid(children, nodeId);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "";
    gridEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Couldn't load this folder: " + err.message;
    gridEl.appendChild(empty);
  }
}

document.getElementById("newFolderBtn").onclick = async () => {
  const name = prompt("New folder name:");
  if (!name || !name.trim()) return;
  try {
    await api("POST", "/" + currentNodeId() + "/folders", { name: name.trim() });
    load();
  } catch (err) {
    alert("Couldn't create folder: " + err.message);
  }
};

document.getElementById("newCalendarBtn").onclick = async () => {
  const name = prompt("New calendar name:");
  if (!name || !name.trim()) return;
  try {
    await api("POST", "/" + currentNodeId() + "/calendars", { name: name.trim() });
    load();
  } catch (err) {
    alert("Couldn't create calendar: " + err.message);
  }
};

window.addEventListener("hashchange", load);
load();
