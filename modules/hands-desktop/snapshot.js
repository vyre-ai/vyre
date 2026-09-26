// @ts-check
// snapshot: the raw AT-SPI tree from computerd, shaped into what the hands reason about.
//
// macOS publishes an accessibility tree through AXUIElement, Chrome publishes one through its
// debugging protocol, and GTK and Qt publish one through AT-SPI2. Three protocols, one structure,
// and the loop above them is never told which body it is driving.
//
// computerd does the protocol talking inside the container, because pyatspi is AT-SPI2's usable
// binding. This file owns the decisions: which roles are worth offering and what counts as named.
// Those are the part worth testing without a desktop running.

/** Roles a person could act on. Everything else (panels, labels, fillers) is layout. */
export const ACTIONABLE = new Set([
  "push button", "toggle button", "check box", "radio button", "combo box", "text",
  "entry", "menu item", "check menu item", "radio menu item", "link", "list item",
  "table cell", "page tab", "slider", "spin button",
]);

/**
 * @typedef {{ path: string, role: string, name?: string, nameless?: boolean, enabled: boolean,
 *   focused?: boolean, value?: any, labels?: string[], frame?: { x: number, y: number, w: number, h: number },
 *   container?: string, identifier?: string }} Control
 * @typedef {{ app: string, window: string, controls: Control[], named: number, nameless: number }} Snapshot
 */

/**
 * @param {string} app the app the tree was read from ("" when computerd picked the focused one)
 * @param {any} raw computerd's `/tree` answer: `{window, nodes: [...]}`
 * @returns {Snapshot}
 */
export function toSnapshot(app, raw) {
  /** @type {Control[]} */
  const controls = [];
  for (const n of (raw && Array.isArray(raw.nodes) ? raw.nodes : [])) {
    if (!n || !ACTIONABLE.has(n.role)) continue;
    // Trimmed: an accessibility tree hands back whitespace-only names constantly, and a name of
    // " " is exactly as unreadable as no name at all.
    const name = String(n.name || "").trim();
    /** @type {Control} */
    const c = { path: String(n.path), role: n.role, enabled: n.enabled !== false };
    if (name) c.name = name; else c.nameless = true;
    if (n.description) c.labels = [name, String(n.description)].filter(Boolean);
    if (n.focused) c.focused = true;
    if (typeof n.w === "number" && n.w > 0 && n.h > 0) c.frame = { x: n.x, y: n.y, w: n.w, h: n.h };
    if (n.value !== undefined && n.value !== null && n.value !== "") c.value = n.value;
    if (n.container) c.container = String(n.container);
    if (n.id) c.identifier = String(n.id);
    controls.push(c);
  }
  return {
    app,
    // The window title is the verification signal here, and a good one: nearly every Linux app
    // marks an unsaved document in its title, so a save that worked is visible without asking
    // the app anything.
    window: (raw && raw.window) || "",
    controls,
    named: controls.filter(c => !c.nameless).length,
    nameless: controls.filter(c => c.nameless).length,
  };
}
