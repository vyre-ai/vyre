// @ts-check
// Small pieces the Vault views share: icons the Deck's set lacks, a once-a-second ticker that
// stops in a background tab, sheets, the copy toast, and the helpers for inputs a value goes into.

import { h, put } from "../js/dom.js";
import { icon as deckIcon } from "../js/icons.js";
import { initial } from "../js/fmt.js";
import { showToast } from "../js/toast.js";

// Constant drawings only (16 grid, 1.5 stroke), parsed like icons.js does.
const EXTRA = {
  card: '<rect x="2" y="4" width="12" height="8.5" rx="1.5"/><path d="M2 7h12M4.5 10.2h2.5"/>',
  star: '<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8L2.5 6.5l3.8-.5z"/>',
  starOn: '<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8L2.5 6.5l3.8-.5z" fill="currentColor"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  shield: '<path d="M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4C5.2 13.1 3 10.8 3 7.8v-4z"/><path d="M5.8 8l1.6 1.6 3-3.2"/>',
  back: '<path d="M9.5 3.5L5 8l4.5 4.5"/>',
  archive: '<rect x="2" y="3" width="12" height="3" rx="0.8"/><path d="M3 6v7h10V6M6.5 9h3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.3 4.5l.7 9h6l.7-9"/>',
  wand: '<path d="M3 13l7-7M9 3.5v2M12.5 7h-2M11.5 4.5l-1 1M4.5 4v1.5M3.8 4.8h1.5"/>',
  refresh: '<path d="M13 8a5 5 0 11-1.5-3.5M13 3v2.5h-2.5"/>',
  all: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8"/><rect x="9" y="9" width="4.5" height="4.5" rx="0.8"/>',
  sshkey: '<circle cx="5.5" cy="8" r="3"/><path d="M8.5 8h6M12.5 8v2.5M14.5 8v2"/><circle cx="5.5" cy="8" r="0.8" fill="currentColor" stroke="none"/>',
};
const parser = new DOMParser();

/** An icon from the Deck's set, or one of the Vault's own. */
export function icon(name, size = 16) {
  if (!(name in EXTRA)) return deckIcon(/** @type {any} */ (name), size);
  const src = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA[name]}</svg>`;
  return /** @type {SVGElement} */ (document.importNode(parser.parseFromString(src, "image/svg+xml").documentElement, true));
}
export const kindIcon = kind => icon(({ login: "login", card: "card", note: "lines", "api-key": "key", "env-set": "terminal", "ssh-key": "sshkey", secret: "lock" })[kind] || "key");

/** The one-letter tile for an agent or module. */
export const tile = (name, size = 22) => h("span", { class: "initial vt-tile", "aria-hidden": "true", style: { width: size + "px", height: size + "px" } }, initial(name));

/** Twelve dots, whatever the value's length: the length is not the page's to know. */
export const DOTS = "•".repeat(12);

// ---- a ticker: once a second while the tab is visible, never in the background ---------------

const ticks = new Set();
let timer = 0;
function run() { for (const fn of ticks) { try { fn(Date.now()); } catch {} } }
function sync() {
  const want = ticks.size > 0 && document.visibilityState === "visible";
  if (want && !timer) { timer = window.setInterval(run, 1000); run(); }
  if (!want && timer) { clearInterval(timer); timer = 0; }
}
document.addEventListener("visibilitychange", sync);
/** Call fn now and every second while visible. Returns a stop. */
export function everySecond(fn) { ticks.add(fn); sync(); fn(Date.now()); return () => { ticks.delete(fn); sync(); }; }

/** "1:30" */
export const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// ---- inputs that take a value ---------------------------------------------------------------

/** A password input for a value going in. Nothing ever sets its value but the person typing. */
export function secretInput(label, id, { optional = false, text = false } = {}) {
  return /** @type {HTMLInputElement} */ (h("input", { type: text ? "text" : "password", autocomplete: "off", class: "input", id, "aria-label": label,
    spellcheck: "false", autocapitalize: "off", "data-lpignore": "true", "data-1p-ignore": "true", "data-vt-secret": "", required: !optional }));
}
/** Empty every input under el that took a value. Called after each send, on redraw and on leaving. */
export function clearSecrets(el) {
  for (const i of el.querySelectorAll("[data-vt-secret]")) /** @type {HTMLInputElement} */ (i).value = "";
}
export const field = (label, input, hint, extra) => h("label", { class: "vt-field" }, h("span", { class: "lbl" }, label), input, extra || null, hint ? h("span", { class: "vt-hint" }, hint) : null);
export const errText = e => (!e ? "" : e.code === "no_such_tool" || e.missing ? "This box does not support that yet." : e.code === "denied" ? `The box refused: ${e.message}` : String(e.message || e));

/** A button that asks once more before it acts. */
export function confirmButton(label, confirmLabel, cls, act) {
  let armed = false, t = 0;
  const b = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: cls, onclick: async () => {
    if (!armed) { armed = true; put(b, confirmLabel); t = window.setTimeout(() => { armed = false; put(b, label); }, 4000); return; }
    clearTimeout(t); armed = false; b.disabled = true;
    try { await act(); } finally { b.disabled = false; put(b, label); }
  } }, label));
  return b;
}

// ---- sheets ---------------------------------------------------------------------------------

/**
 * A modal sheet: centred on a desk, from the bottom on a phone. Esc and the backdrop close it.
 * Returns { el, close }. `onClose` runs once.
 * @param {{ label: string, title: string, body: any[], onClose?: () => void, wide?: boolean }} o
 */
export function sheet({ label, title, body, onClose, wide }) {
  const prev = /** @type {HTMLElement|null} */ (document.activeElement);
  let done = false;
  const close = () => {
    if (done) return; done = true;
    document.removeEventListener("keydown", onKey, true);
    back.remove();
    try { onClose?.(); } catch {}
    prev?.focus?.({ preventScroll: true });
  };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
  const titleEl = h("h2", { class: "vt-sheet-title", id: "vt-sheet-h", tabindex: "-1" }, title);
  const box = h("div", { class: "vt-sheet" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-labelledby": "vt-sheet-h" },
    h("div", { class: "vt-ptop" }, h("span", { class: "lbl" }, label), h("button", { type: "button", class: "ibtn", "aria-label": "Close", onclick: close }, icon("close", 13))),
    titleEl, body);
  const back = h("div", { class: "vt-backdrop", onclick: e => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener("keydown", onKey, true);
  titleEl.focus({ preventScroll: true });
  return { el: box, close };
}

// ---- the copy toast -------------------------------------------------------------------------

/** @type {import("../js/toast.js").Toast | null} */ let mine = null;
/**
 * "Copied the password of acme-mail. Clipboard clears in 1:30 · Clear now", with a 1px bar
 * that drains to when the clipboard clears. The Deck's one toast (js/toast.js) draws it.
 * @param {{ text: string, clearsAt?: number | null, onClear?: (() => Promise<void>) | null }} o
 */
export function toast({ text, clearsAt = null, onClear = null }) {
  hideToast();
  const left = h("span", { class: "vt-toast-left" });
  let stop = () => {};
  mine = showToast({
    text: clearsAt ? [text, " Clipboard clears in ", left] : text,
    ms: clearsAt ? Math.max(0, clearsAt - Date.now()) : 5000,
    bar: !!clearsAt,
    action: clearsAt && onClear ? { label: "Clear now", run: () => { onClear(); } } : null,
    dismiss: icon("close", 12),
    onClose: () => { stop(); mine = null; },
  });
  if (clearsAt) stop = everySecond(now => { put(left, mmss(clearsAt - now)); if (now >= clearsAt) hideToast(); });
}
export function hideToast() { mine?.close(); }

/** Favorites: a per-viewer convenience, kept in this browser only. */
export const favorites = {
  get() { try { return new Set(JSON.parse(localStorage.getItem("vyre.vault.fav") || "[]")); } catch { return new Set(); } },
  toggle(name) {
    const s = favorites.get();
    if (s.has(name)) s.delete(name); else s.add(name);
    try { localStorage.setItem("vyre.vault.fav", JSON.stringify([...s])); } catch {}
    return s;
  },
};
