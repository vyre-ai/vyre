// @ts-check
// The Deck as an installed phone app: what changes when it runs from the home screen, the pull
// down that opens Find, the line that says the box is out of reach, and reopening where the user
// left off. Everything here is shell; views never import it.
//
//   start({ view, deck })  once, before the first route
//   reopen()               once, at launch: the path to reopen (the shell decides), or null
//   remember(path)         on every route, so a cold launch from the home screen reopens it
//
// start() also tells the box when someone is looking at this app (push.seen), so a push that
// would only repeat what is on screen can be held back by the box. It reports at launch, on each
// visibility change, and on the first tap or key after a minute without a report. No timer.
// It also starts the keyboard inset (js/keyboard.js), so a field on a phone is never under the keys.

import { h, put, go, isPhone } from "./dom.js";
import { call, kick, streamState } from "./api.js";
import { reconnectPill } from "./reconnect.js";
import { surfaceId } from "../glass/util.js";
import { icon } from "./icons.js";
import { watchKeyboard } from "./keyboard.js";

const LAST = "vyre.last";
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const session = (() => { try { return window.sessionStorage; } catch { return null; } })();

/** Running from the home screen (iOS Safari sets navigator.standalone; everyone else the media query). */
export const standalone = () => /** @type {any} */ (navigator).standalone === true || matchMedia("(display-mode: standalone)").matches;
/** iPhone or iPad Safari, where install is Share, then Add to Home Screen, and push needs it installed. */
export const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
const phone = () => isPhone();

/** Paths worth reopening. Onboarding and a one-off search are not. */
const keep = (/** @type {string} */ p) => !/^\/(onboard|find|ask)\b/.test(p);

/** @param {string} path */
export function remember(path) {
  if (!keep(path)) return;
  try { store?.setItem(LAST, JSON.stringify({ path, at: Date.now() })); } catch {}
}

/** @param {{ view: HTMLElement, deck: HTMLElement }} shell */
export function start({ view, deck }) {
  const root = document.documentElement;
  if (standalone()) root.dataset.display = "standalone";
  if (ios()) root.dataset.ios = "";
  themeColor();
  new MutationObserver(themeColor).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  offlineLine(deck);
  pullToFind(view);
  seenReports();
  watchKeyboard();
}

const SEEN_EVERY = 60_000;
let seenAt = 0;
/**
 * One push.seen report. A box without the tool (no_such_tool), or one out of reach, is fine:
 * this is a hint, never something to show.
 * @param {boolean} visible
 */
function seen(visible) {
  seenAt = Date.now();
  // Hidden: the page may be going away, so the request is sent to outlive it.
  // standalone: the app runs installed, which `vyre phone add` ticks off (the box says so once per 10 minutes per surface).
  // device: this app's push device (phone-setup.js keeps it), so `vyre phone add` knows which phone opened installed.
  let device = null;
  try { device = store?.getItem("vyre.push.device") || null; } catch {}
  call("push.seen", { surface: surfaceId(), visible, standalone: standalone(), ...(device ? { device } : {}) }, { keepalive: !visible }).catch(() => {});
}

/** Launch, visibility changes, and input after a quiet minute. Listeners only, all passive. */
function seenReports() {
  const visible = () => document.visibilityState === "visible";
  if (visible()) seen(true);
  document.addEventListener("visibilitychange", () => seen(visible()));
  const touched = () => { if (visible() && Date.now() - seenAt >= SEEN_EVERY) seen(true); };
  window.addEventListener("pointerdown", touched, { passive: true, capture: true });
  window.addEventListener("keydown", touched, { passive: true, capture: true });
}

/** The status bar follows the theme: Graphite in dark, Paper's ground in paper. */
function themeColor() {
  const paper = document.documentElement.dataset.theme === "paper";
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", paper ? "#F4F1EA" : "#0E0D0C");
}

/** A cold launch from the home screen opens at /now (the manifest's start_url); the path to go
 * back to instead, if the user was there within the last day, or null. The shell makes the move
 * (it stays on Now when something needs the user). A reload in the same tab keeps its path.
 * @returns {string | null} */
export function reopen() {
  if (!standalone() || session?.getItem("vyre.launched")) return null;
  try { session?.setItem("vyre.launched", "1"); } catch {}
  if (location.pathname !== "/now" && location.pathname !== "/") return null;
  let last = null;
  try { last = JSON.parse(store?.getItem(LAST) || "null"); } catch {}
  if (!last || typeof last.path !== "string" || !last.path.startsWith("/") || last.path.startsWith("//")) return null;
  if (Date.now() - last.at > 86_400_000 || last.path === "/now") return null;
  return last.path;
}

/** One quiet pill under the header (the phone's) while the box does not answer (js/reconnect.js,
 * ADR 0029 R3). It never covers the view: the view keeps what it last drew, and the stream, when
 * it is back, replays what was missed from its cursor, so nothing is redrawn or remounted. */
function offlineLine(/** @type {HTMLElement} */ deck) {
  const retry = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: kick }, "Retry");
  const text = h("span", { class: "reach-text" });
  const bar = h("div", { class: "reach", role: "status", hidden: true }, h("span", { class: "dot" }), text, retry);
  const head = deck.querySelector(".ph-head");
  if (head) head.after(bar); else deck.prepend(bar);
  const pill = reconnectPill({ show: words => { put(text, words); bar.hidden = false; }, hide: () => { bar.hidden = true; } });
  window.addEventListener("deck:stream", e => pill.state(/** @type {CustomEvent} */ (e).detail));
  window.addEventListener("offline", () => pill.net());
  window.addEventListener("online", () => pill.net());
  if (streamState) pill.state(streamState);
}

/** Pull down from the top of one of the three pages (Now, Chats, Agents) to open Find, the same
 * as a tap on Lumen. Only when everything under the finger is scrolled to the top, never
 * from a text field or a row that swipes, and never on a pushed screen (a chat pages backwards
 * when pulled at its top). The page itself does not rubber-band (deck.css), so this is the only
 * thing a pull does, and a sideways swipe (the pager) cancels it. */
function pullToFind(/** @type {HTMLElement} */ view) {
  const THRESHOLD = 72;
  const hint = h("div", { class: "pull", "aria-hidden": "true" }, icon("search", 14), h("span", null, "Pull to find"));
  view.before(hint);
  /** @type {{ y: number, x: number, dy: number } | null} */ let pull = null;
  const atTop = (/** @type {EventTarget | null} */ t) => {
    for (let el = /** @type {HTMLElement | null} */ (t); el && el !== document.body; el = el.parentElement) {
      if (el.scrollTop > 0) return false;
      if (el === view) return true;
    }
    return true;
  };
  view.addEventListener("touchstart", e => {
    pull = null;
    if (!phone() || e.touches.length !== 1 || location.pathname.startsWith("/find")) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t.closest(".pager") || t.closest("input, textarea, select, [contenteditable], [data-swipe], .no-pull") || !atTop(t)) return;
    pull = { y: e.touches[0].clientY, x: e.touches[0].clientX, dy: 0 };
  }, { passive: true });
  view.addEventListener("touchmove", e => {
    if (!pull) return;
    const dy = e.touches[0].clientY - pull.y, dx = Math.abs(e.touches[0].clientX - pull.x);
    if (dy < 0 || dx > dy) { reset(); return; }
    pull.dy = dy;
    const p = Math.min(1, dy / THRESHOLD);
    hint.style.setProperty("--pull", String(p));
    hint.classList.add("on");
    hint.classList.toggle("ready", p >= 1);
    put(/** @type {HTMLElement} */ (hint.lastChild), p >= 1 ? "Release to find" : "Pull to find");
  }, { passive: true });
  const end = () => {
    const ready = pull && pull.dy >= THRESHOLD;
    reset();
    if (ready) go("/find");
  };
  view.addEventListener("touchend", end, { passive: true });
  view.addEventListener("touchcancel", reset, { passive: true });
  function reset() { pull = null; hint.classList.remove("on", "ready"); hint.style.removeProperty("--pull"); }
}
