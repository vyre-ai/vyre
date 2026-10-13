// @ts-check
// The drill-in sidebar as rules: which panel a path opens, how Back folds it, and how a panel's list is searched and grouped. Pure, so Node tests it.
// The state is the URL: a path inside a place drills into that place's panel, `?side=main` keeps the page and shows the main sidebar again, so a reload, the browser's back button
// and a shared link all keep the same sidebar.

/** @typedef {{ id: string, title: string, root: string, prefixes: string[] }} Panel */
/** @type {readonly Panel[]} */
export const PANELS = Object.freeze([
  { id: "projects", title: "Projects", root: "/u/projects", prefixes: ["/u/project", "/u/projects"] },
  { id: "chats", title: "Chat", root: "/u/chats", prefixes: ["/u/chats"] },
  { id: "records", title: "Records", root: "/u/records/contact", prefixes: ["/u/records", "/u/record"] },
  { id: "drive", title: "Files", root: "/u/files", prefixes: ["/u/files", "/u/drive"] },
  { id: "agents", title: "Agents", root: "/u/assistants", prefixes: ["/u/assistants"] },
  { id: "flows", title: "Flows", root: "/u/flows", prefixes: ["/u/flows"] },
  { id: "settings", title: "Settings", root: "/u/settings", prefixes: ["/u/settings", "/u/appearance", "/u/spaces", "/u/access", "/u/about", "/u/install"] },
]);

const clean = (/** @type {string} */ p) => (String(p || "").split("?")[0].replace(/\/+$/, "") || "/");
const params = (/** @type {string | undefined} */ search) => new URLSearchParams(String(search || "").replace(/^\?/, ""));

/** The panel a path drills into, or null for the main sidebar. A place's own front page (/u/projects, /u/chats) is the main sidebar; a path inside it (or any /u/records path) is the panel. @param {string} path @param {string} [search] */
export function panelFor(path, search) {
  if (params(search).get("side") === "main") return null;
  const p = clean(path);
  for (const panel of PANELS) {
    const inside = panel.prefixes.some((x) => p === x || p.startsWith(x + "/"));
    if (!inside) continue;
    return panel.id;
  }
  return null;
}

/** The same page with the sidebar's side set (`main`) or cleared (null), keeping every other parameter. @param {string} path @param {string | undefined} search @param {"main" | null} side */
export function withSide(path, search, side) {
  const q = params(search);
  if (side) q.set("side", side); else q.delete("side");
  const s = q.toString();
  return clean(path) + (s ? `?${s}` : "");
}

/** Where Back goes: the same page with the main sidebar, or null when the main sidebar already shows. @param {string} path @param {string} [search] */
export function backTo(path, search) {
  return panelFor(path, search) ? withSide(path, search, "main") : null;
}

/** @typedef {{ id: string, label: string, group?: string }} PanelItem */
/** Items whose label contains what was typed (case and edge spaces ignored). @template {PanelItem} T @param {T[]} items @param {string} q */
export function filterItems(items, q) {
  const w = String(q || "").trim().toLowerCase();
  return w ? items.filter((i) => i.label.toLowerCase().includes(w)) : items;
}

/** Sections by group, in the order each group first appears; items with no group share one unlabelled section. @template {PanelItem} T @param {T[]} items */
export function groupItems(items) {
  /** @type {{ label: string, items: T[] }[]} */ const out = [];
  for (const it of items) {
    const label = it.group ?? "";
    let g = out.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; out.push(g); }
    g.items.push(it);
  }
  return out;
}
