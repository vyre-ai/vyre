// @ts-check
// The Deck as an installed phone app: what changes when it runs from the home screen, the pull
// down that opens Find, the line that says the box is out of reach, and reopening where the user
// left off. Everything here is shell; views never import it.
//
//   start({ view, deck })  once, before the first route
//   remember(path)         on every route, so a cold launch from the home screen reopens it

import { h, put, go } from "./dom.js";
import { attempt, reachable } from "./api.js";
import { icon } from "./icons.js";
import { when } from "./fmt.js";

const LAST = "vyre.last";
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const session = (() => { try { return window.sessionStorage; } catch { return null; } })();

/** Running from the home screen (iOS Safari sets navigator.standalone; everyone else the media query). */
export const standalone = () => /** @type {any} */ (navigator).standalone === true || matchMedia("(display-mode: standalone)").matches;
/** iPhone or iPad Safari, where install is Share, then Add to Home Screen, and push needs it installed. */
export const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
const phone = () => matchMedia("(max-width: 760px)").matches;

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
  reopen();
  offlineLine(deck);
  pullToFind(view);
}

/** The status bar follows the theme: Graphite in dark, Paper's ground in paper. */
function themeColor() {
  const paper = document.documentElement.dataset.theme === "paper";
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", paper ? "#F4F1EA" : "#0E0D0C");
}

/** A cold launch from the home screen opens at /now (the manifest's start_url); go back to where
 * the user was instead, if that was within the last day. A reload in the same tab keeps its path. */
function reopen() {
  if (!standalone() || session?.getItem("vyre.launched")) return;
  try { session?.setItem("vyre.launched", "1"); } catch {}
  if (location.pathname !== "/now" && location.pathname !== "/") return;
  let last = null;
  try { last = JSON.parse(store?.getItem(LAST) || "null"); } catch {}
  if (!last || typeof last.path !== "string" || !last.path.startsWith("/") || last.path.startsWith("//")) return;
  if (Date.now() - last.at > 86_400_000 || last.path === "/now") return;
  history.replaceState(null, "", last.path);
}

/** One line under the status bar while the box does not answer. It never covers the view: the
 * view keeps showing what it last drew, or what the service worker kept. */
function offlineLine(/** @type {HTMLElement} */ deck) {
  const since = { at: 0 };
  const retry = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: check }, "Retry");
  const text = h("span", { class: "reach-text" });
  const bar = h("div", { class: "reach", role: "status", hidden: true }, h("span", { class: "dot beacon" }), text, retry);
  deck.prepend(bar);
  const draw = (/** @type {boolean} */ ok) => {
    if (ok) {
      if (!bar.hidden) { bar.hidden = true; window.dispatchEvent(new Event("deck:navigate")); } // redraw the view from the box
      return;
    }
    if (bar.hidden) since.at = Date.now();
    put(text, navigator.onLine === false ? "This phone is offline." : "Your box is not answering.",
      " ", h("span", { class: "faint" }, `Showing what this phone kept, since ${when(since.at)}.`));
    bar.hidden = false;
  };
  async function check() {
    put(retry, "Checking");
    await attempt("system.info");
    put(retry, "Retry");
  }
  window.addEventListener("deck:reach", e => draw(!!/** @type {CustomEvent} */ (e).detail));
  window.addEventListener("offline", () => draw(false));
  window.addEventListener("online", check);
  // Coming back to the app after the phone slept: ask once, not on a timer.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !bar.hidden) check(); });
  if (!reachable || navigator.onLine === false) draw(false);
}

/** Pull down from the top of any phone screen to open Find. Only when everything under the finger
 * is scrolled to the top, and never from a text field. The page itself does not rubber-band
 * (deck.css), so this is the only thing a pull does. */
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
    if (t.closest("input, textarea, select, [contenteditable], .no-pull") || !atTop(t)) return;
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
