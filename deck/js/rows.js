// @ts-check
// Whole rows are the target, not just their title (#33). A list row that has one main link (a session on Now, a project, a remembered fact) opens
// that link wherever the row is clicked, except on a control inside it (a button, a field, another link) or when words were selected. The same
// layer gives the row a context menu (Open, Open in a new tab, Copy link) and Up and Down between the rows of a list. Hover, focus and pressed
// look is the stylesheet's (css/rows.css). Rows are found by class from ROW_CLASSES, so a new list joins by adding its row class here.

/** The row classes that open their main link as a whole. */
export const ROW_CLASSES = Object.freeze(["work-row", "pl-row", "fact-row"]);
const CONTROL = ["a", "button", "input", "select", "textarea", "label", "summary", "video", "audio"];
const CONTROL_ATTR = ["contenteditable", "data-no-row"];

/** The row an element is in, or null. @param {any} el */
export function rowOf(el) {
  for (let n = el; n && n.tagName; n = n.parentNode) {
    const cls = String(n.className?.baseVal ?? n.className ?? "").split(/\s+/);
    if (ROW_CLASSES.some(c => cls.includes(c))) return n;
  }
  return null;
}

/** Whether a click landed on something that does its own thing: a control between the target and the row. @param {any} target @param {any} row */
export function onControl(target, row) {
  for (let n = target; n && n !== row && n.tagName; n = n.parentNode) {
    if (CONTROL.includes(String(n.tagName || "").toLowerCase())) return true;
    if (CONTROL_ATTR.some(a => n.getAttribute?.(a) != null && n.getAttribute(a) !== "false")) return true;
    const role = n.getAttribute?.("role");
    if (role === "button" || role === "link" || role === "menuitem") return true;
  }
  return false;
}

/** The row's main link: the first plain link that is not a button. Null for a row with none (a paired Mac's project has no board here). @param {any} row */
export function primaryLink(row) {
  for (const a of row.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href || /\bbtn\b/.test(a.className)) continue;
    return a;
  }
  return null;
}

/** The rows of the list a row is in, in order, that have a link to open. @param {any} row */
export function siblingRows(row) {
  const rows = [];
  for (const c of row.parentNode?.childNodes || []) if (c.tagName && rowOf(c) === c && primaryLink(c)) rows.push(c);
  return rows;
}

/**
 * Wire the layer once for a document. Returns a function that takes it off.
 * @param {Document} [doc]
 */
export function installRows(doc = document) {
  /** @type {HTMLElement|null} */ let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };

  /** @param {MouseEvent} e */
  const onClick = e => {
    if (e.defaultPrevented || e.button !== 0) return;
    const row = rowOf(e.target);
    if (!row || onControl(e.target, row)) return;
    // Words selected in the row are being read or copied, not opened.
    try { if (String(doc.defaultView?.getSelection?.() || "").trim()) return; } catch { /* no selection API */ }
    const link = primaryLink(row);
    if (!link) return;
    e.preventDefault();
    // The link's own click, with the person's modifiers, so the router (or the browser for a new tab) does what it always does.
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey }));
  };

  /** @param {MouseEvent} e */
  const onContext = e => {
    closeMenu();
    const row = rowOf(e.target);
    if (!row || onControl(e.target, row)) return;
    const link = primaryLink(row);
    if (!link) return;
    e.preventDefault();
    const href = new URL(link.getAttribute("href") || "", doc.location.href).href;
    const item = (/** @type {string} */ label, /** @type {() => void} */ fn) => {
      const b = doc.createElement("button");
      b.type = "button"; b.setAttribute("role", "menuitem"); b.className = "ctx-item"; b.textContent = label;
      b.addEventListener("click", () => { closeMenu(); fn(); });
      return b;
    };
    menu = doc.createElement("div");
    menu.className = "ctx-menu"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Row actions");
    menu.style.left = Math.min(e.clientX, (doc.defaultView?.innerWidth || 9999) - 200) + "px";
    menu.style.top = Math.min(e.clientY, (doc.defaultView?.innerHeight || 9999) - 130) + "px";
    menu.append(item("Open", () => link.click()), item("Open in a new tab", () => { doc.defaultView?.open(href, "_blank", "noopener,noreferrer"); }),
      item("Copy link", () => { void doc.defaultView?.navigator?.clipboard?.writeText(href); }));
    doc.body.append(menu);
    /** @type {any} */ (menu.firstChild)?.focus?.();
  };

  /** @param {KeyboardEvent} e */
  const onKey = e => {
    if (menu && menu.contains(/** @type {any} */ (e.target))) {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(/** @type {any} */ (e.target));
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i + items.length - 1) % items.length]?.focus(); }
      return;
    }
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = /** @type {any} */ (e.target);
    if (!t || /^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tagName)) || t.isContentEditable) return;
    const row = rowOf(t);
    if (!row) return;
    const rows = siblingRows(row), i = rows.indexOf(row);
    const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    /** @type {any} */ (primaryLink(next))?.focus();
  };
  const onAway = (/** @type {Event} */ e) => { if (menu && !menu.contains(/** @type {any} */ (e.target))) closeMenu(); };

  doc.addEventListener("click", onClick);
  doc.addEventListener("contextmenu", onContext);
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("pointerdown", onAway, true);
  doc.addEventListener("scroll", closeMenu, true);
  return () => { closeMenu(); doc.removeEventListener("click", onClick); doc.removeEventListener("contextmenu", onContext); doc.removeEventListener("keydown", onKey); doc.removeEventListener("pointerdown", onAway, true); doc.removeEventListener("scroll", closeMenu, true); };
}
