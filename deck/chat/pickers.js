// @ts-check
// The composer's pickers: one list menu shape for "/" commands, "@" files and the model, and the
// rewind sheet (Esc Esc). The Composer board's look: a header line, rows with one selected,
// a footer of keys. Rows are text nodes only (lib/markdown.js is not needed: nothing here is
// markdown), so nothing a session named can become markup.

import { h, put } from "../js/dom.js";
import { clock } from "../js/fmt.js";
import { NEEDS_UPDATE } from "./core/caps.js";

/**
 * @typedef {{ key: string, render: () => any, value?: any }} MenuRow
 * @typedef {{ el: HTMLElement, open: (rows: MenuRow[], pick: (row: MenuRow) => void, head?: any, foot?: any) => void,
 *   close: () => void, isOpen: () => boolean, move: (d: number) => void, pick: () => boolean, selected: () => MenuRow|null,
 *   kind: string|null, setKind: (k: string|null) => void }} ListMenu
 */

/**
 * A list menu above the composer. Arrows move, Enter or Tab picks (the composer routes the
 * keys), a click picks; mousedown does not take focus from the text box.
 * @param {string} [label]
 * @returns {ListMenu}
 */
export function listMenu(label = "Suggestions") {
  const el = h("div", { class: "composer-menu cv-menu", role: "listbox", "aria-label": label, hidden: true });
  /** @type {MenuRow[]} */
  let rows = [];
  let sel = 0;
  /** @type {((row: MenuRow) => void) | null} */
  let onPick = null;
  let head = null, foot = null;
  const menu = {
    el, kind: /** @type {string|null} */ (null),
    setKind(/** @type {string|null} */ k) { menu.kind = k; },
    open(/** @type {MenuRow[]} */ list, /** @type {(row: MenuRow) => void} */ pick, h1 = null, f1 = null) {
      rows = list; onPick = pick; head = h1; foot = f1;
      if (sel >= rows.length) sel = 0;
      el.hidden = false;
      draw();
    },
    close() { el.hidden = true; rows = []; sel = 0; onPick = null; menu.kind = null; el.replaceChildren(); },
    isOpen: () => !el.hidden,
    selected: () => rows[sel] || null,
    move(/** @type {number} */ d) { if (!rows.length) return; sel = (sel + d + rows.length) % rows.length; draw(); },
    pick() {
      const row = rows[sel];
      if (!row || !onPick) return false;
      onPick(row);
      return true;
    },
  };
  function draw() {
    put(el,
      head ? h("div", { class: "cv-menu-head" }, head) : null,
      rows.length ? rows.map((r, i) => h("button", { type: "button", role: "option", class: i === sel ? "on" : null, "aria-selected": String(i === sel),
        "data-key": r.key, onmousedown: (/** @type {Event} */ e) => e.preventDefault(), onclick: () => { sel = i; menu.pick(); } }, r.render()))
        : h("div", { class: "cv-menu-empty" }, "Nothing matches"),
      foot ? h("div", { class: "cv-menu-foot" }, foot) : null,
    );
  }
  return menu;
}

/** "⏎ run", printed as keys. @param {...[string, string]} pairs */
export const keysLine = (...pairs) => pairs.map(([k, what], i) => [i ? " · " : null, h("span", { class: "kbd" }, k), " ", what]);

/**
 * @typedef {{ uuid: string, text: string, at: number|null, files_changed?: number|null }} RewindPoint
 * @typedef {"conversation"|"code"|"both"} Restore
 */

/**
 * The rewind sheet: "Rewind to an earlier message", newest first, each with its time and the
 * file changes after it (when the box says). Choosing one offers what to restore: the
 * conversation (the words come back to the composer to edit), the code, or both. Arrows move,
 * 1 2 3 restore, Esc closes. A box without threads.rewind shows the list with the buttons off.
 * @param {{ points: RewindPoint[], can: () => boolean|null, onChoose: (p: RewindPoint, restore: Restore) => Promise<string|null>|void, onClose: () => void }} o
 *   onChoose resolves to an error message to show, or null.
 * @returns {{ el: HTMLElement, key: (e: KeyboardEvent) => boolean, refresh: () => void }}
 */
export function rewindSheet(o) {
  let sel = 0, busy = false;
  const note = h("div", { class: "cv-rewind-note", role: "status" });
  const list = h("div", { class: "cv-rewind-list", role: "listbox", "aria-label": "Earlier messages" });
  const acts = h("div", { class: "cv-rewind-acts" });
  const el = h("div", { class: "cv-rewind", role: "dialog", "aria-label": "Rewind" },
    h("div", { class: "cv-rewind-head" }, h("span", null, "Rewind to an earlier message"), h("span", { class: "kbd" }, "Esc Esc")),
    list, acts, note);
  const after = (/** @type {RewindPoint} */ p) => typeof p.files_changed === "number"
    ? (p.files_changed ? `${p.files_changed} file change${p.files_changed === 1 ? "" : "s"} after this` : "no file changes after this") : null;
  async function choose(/** @type {Restore} */ restore) {
    const p = o.points[sel];
    if (!p || busy || o.can() === false) return;
    busy = true; draw();
    const err = await o.onChoose(p, restore);
    busy = false;
    if (err) put(note, err);
    draw();
  }
  function draw() {
    const off = o.can() === false;
    put(list, o.points.length ? o.points.map((p, i) => h("button", { type: "button", role: "option", class: "cv-rewind-row" + (i === sel ? " on" : ""),
      "aria-selected": String(i === sel), onclick: () => { sel = i; draw(); } },
      h("span", { class: "cv-rewind-text ellipsis" }, p.text),
      h("span", { class: "cv-rewind-meta" }, [p.at ? clock(p.at) : null, after(p)].filter(Boolean).join(" · ")))) :
      h("div", { class: "cv-menu-empty" }, "No earlier messages to go back to"));
    const btn = (/** @type {Restore} */ r, /** @type {string} */ label, /** @type {string} */ k) => h("button", { class: "btn btn-ghost btn-sm cv-rw-" + r, type: "button",
      disabled: off || busy || !o.points.length, title: off ? NEEDS_UPDATE : null, onclick: () => choose(r) }, label, h("span", { class: "kbd" }, k));
    put(acts, btn("conversation", "Conversation", "1"), btn("code", "Code", "2"), btn("both", "Both", "3"),
      h("button", { class: "btn btn-ghost btn-sm cv-rw-cancel", type: "button", onclick: o.onClose }, "Cancel", h("span", { class: "kbd" }, "Esc")));
    if (off) put(note, NEEDS_UPDATE);
  }
  draw();
  return {
    el,
    refresh: draw,
    key(e) {
      if (e.key === "Escape") { o.onClose(); return true; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { if (o.points.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + o.points.length) % o.points.length; draw(); } return true; }
      if (e.key === "1" || e.key === "Enter") { choose("conversation"); return true; }
      if (e.key === "2") { choose("code"); return true; }
      if (e.key === "3") { choose("both"); return true; }
      return false;
    },
  };
}
