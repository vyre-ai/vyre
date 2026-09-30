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

/** @typedef {{ uuid: string, text: string, at: number|null }} RewindPoint */
/** @typedef {"both"|"conversation"|"code"} Restore */
/** @typedef {Restore|"fork"} Choice */

/** What a rewind restores, in Claude Code's order and words; the first is the default. */
export const RESTORES = Object.freeze(/** @type {{ id: Restore, label: string, title: string, code: boolean }[]} */ ([
  { id: "both", label: "Restore code and conversation", title: "Goes back to just before this message and puts back the files changed since; its words come back to edit", code: true },
  { id: "conversation", label: "Restore conversation", title: "Goes back to just before this message; the files stay as they are; its words come back to edit", code: false },
  { id: "code", label: "Restore code", title: "Puts back the files changed since this message; the conversation stays", code: true },
]));

/** "Fork from here" (threads.fork's `at`): the other item beside Restore, offered only when the
 *  sheet is given onFork - an older caller with just onChoose sees the three Restore items alone. */
export const FORK = Object.freeze(/** @type {{ id: "fork", label: string, title: string, code: boolean }} */ (
  { id: "fork", label: "Fork from here", title: "Starts a new session with the conversation up to just before this message, that carries on without touching this one", code: false }
));

/**
 * The rewind sheet: "Rewind to an earlier message", your messages newest first, each with its
 * time, and what to restore, as Claude Code offers it: code and conversation (the default),
 * conversation, or code. Conversation goes back in this same session to just before the message
 * (threads.rewind; a running turn is stopped): that message and everything after it go, and its
 * words come back in the composer. Code puts back the files the session's tools changed since
 * and keeps the conversation. The first message cannot be rewound to: the box's note says so
 * here. Arrows up and down pick the message, left and right what to restore, Enter rewinds, Esc
 * closes. A box without threads.rewind shows the list with the button off; one whose rewind
 * restores the conversation only (codeOk false) has the code choices off.
 * @param {{ points: RewindPoint[], can: () => boolean|null, codeOk?: () => boolean|null,
 *   onChoose: (p: RewindPoint, restore: Restore) => Promise<string|null>|void, onClose: () => void,
 *   onFork?: (p: RewindPoint) => Promise<string|null>|void, canFork?: () => boolean|null }} o
 *   onChoose resolves to an error message to show, or null. codeOk: true once the box is known to
 *   restore files; until then (null) the code choices wait, off. onFork, the fourth item beside
 *   Restore ("Fork from here", threads.fork's `at`): omitted, the sheet offers Restore alone, as
 *   before. canFork: true once the box is known to fork; until then (null) the item waits, off -
 *   defaults to `can` (rewind and fork need the same capability on an older box).
 * @returns {{ el: HTMLElement, key: (e: KeyboardEvent) => boolean, refresh: () => void, restore: () => Choice }}
 */
export function rewindSheet(o) {
  let sel = 0, busy = false;
  /** The choice picked by hand; else the default, the first the box can do. */
  let picked = /** @type {Choice|null} */ (null);
  const codeOk = () => (o.codeOk ? o.codeOk() === true : false);
  const forkOk = () => (o.canFork ? o.canFork() : o.can());
  const allowed = () => [...RESTORES.filter(r => !r.code || codeOk()), ...(o.onFork && forkOk() === true ? [FORK] : [])];
  const restore = () => /** @type {Choice} */ (picked && allowed().some(r => r.id === picked) ? picked : allowed()[0].id);
  const note = h("div", { class: "cv-rewind-note", role: "status" });
  const list = h("div", { class: "cv-rewind-list", role: "listbox", "aria-label": "Earlier messages" });
  const opts = h("div", { class: "cv-rewind-opts", role: "radiogroup", "aria-label": "Restore" });
  const acts = h("div", { class: "cv-rewind-acts" });
  const el = h("div", { class: "cv-rewind", role: "dialog", "aria-label": "Rewind" },
    h("div", { class: "cv-rewind-head" }, h("span", null, "Rewind to an earlier message"), h("span", { class: "kbd" }, "Esc Esc")),
    list, opts, acts, note);
  async function choose() {
    const p = o.points[sel];
    if (!p || busy) return;
    const r = restore();
    if (r === "fork") {
      if (!o.onFork || forkOk() !== true) return;
      busy = true; put(note, "Forking…"); draw();
      const err = await o.onFork(p);
      busy = false; put(note, err || ""); draw();
      return;
    }
    if (o.can() === false) return;
    busy = true; put(note, r === "code" ? "Restoring the files…" : "Rewinding…"); draw();
    const err = await o.onChoose(p, r);
    busy = false;
    put(note, err || "");
    draw();
  }
  function step(/** @type {number} */ d) {
    const xs = allowed(), i = xs.findIndex(r => r.id === restore());
    if (xs.length < 2) return;
    picked = xs[(i + d + xs.length) % xs.length].id;
    draw();
  }
  function draw() {
    const cur = restore();
    const off = cur === "fork" ? forkOk() !== true : o.can() === false;
    put(list, o.points.length ? o.points.map((p, i) => h("button", { type: "button", role: "option", class: "cv-rewind-row" + (i === sel ? " on" : ""),
      "aria-selected": String(i === sel), onclick: () => { sel = i; draw(); } },
      h("span", { class: "cv-rewind-text ellipsis" }, p.text),
      h("span", { class: "cv-rewind-meta" }, p.at ? clock(p.at) : ""))) :
      h("div", { class: "cv-menu-empty" }, "No earlier messages to go back to"));
    put(opts, [...RESTORES, ...(o.onFork ? [FORK] : [])].map(r => {
      const no = r.id === "fork" ? forkOk() !== true : (r.code && !codeOk());
      return h("button", { type: "button", role: "radio", class: "btn btn-ghost btn-sm cv-rw-opt cv-rw-" + r.id + (r.id === cur ? " on" : ""),
        "aria-checked": String(r.id === cur), disabled: no || busy,
        title: no ? (r.id === "fork" ? (forkOk() === false ? NEEDS_UPDATE : "Checking whether this server can fork sessions") : (o.codeOk?.() === false ? NEEDS_UPDATE : "Checking whether this server can put files back")) : r.title,
        onclick: () => { picked = r.id; draw(); } }, r.label);
    }));
    put(acts,
      h("button", { class: "btn btn-ghost btn-sm cv-rw-go", type: "button", disabled: off || busy || !o.points.length,
        title: off ? NEEDS_UPDATE : (allowed().find(r => r.id === cur)?.title || ""), onclick: () => choose() },
        cur === "fork" ? "Fork here" : (cur === "code" ? "Restore here" : "Rewind here"), h("span", { class: "kbd" }, "⏎")),
      h("button", { class: "btn btn-ghost btn-sm cv-rw-cancel", type: "button", onclick: o.onClose }, "Cancel", h("span", { class: "kbd" }, "Esc")));
    if (off) put(note, NEEDS_UPDATE);
  }
  draw();
  return {
    el,
    refresh: draw,
    restore,
    key(e) {
      if (e.key === "Escape") { o.onClose(); return true; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { if (o.points.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + o.points.length) % o.points.length; draw(); } return true; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { step(e.key === "ArrowRight" ? 1 : -1); return true; }
      if (e.key === "Enter") { choose(); return true; }
      return false;
    },
  };
}
