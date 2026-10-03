// @ts-check
// How the box reaches this device (link.health, ADR 0014 part 4), said one way everywhere in the
// Deck: the line ("direct 12 ms", "relayed via fra 80 ms"), the dot's colour, and the one watcher.
// Settings' Network row, the Chat header and the Glass header all use it.
//
// Light by default: link.health is asked when a view opens and at most once a minute while the
// page is visible. A hidden tab keeps no timer and asks nothing; shown again, it asks only once the
// last answer is a minute old. Views opened inside that minute share the last answer.

import { h } from "./dom.js";
import { attempt } from "./api.js";
import { since } from "./fmt.js";
import { pathMark } from "./status-mark.js";

export const HEALTH_EVERY = 60_000;

/** "direct 12 ms", "relayed via fra 80 ms", "peer relay 30 ms", "offline" or "unknown". */
export function linkLine(x) {
  const ms = typeof x?.latencyMs === "number" ? ` ${x.latencyMs} ms` : "";
  if (x?.path === "direct") return `direct${ms}`;
  if (x?.path === "relay") return `relayed${x.relay ? ` via ${x.relay}` : ""}${ms}`;
  if (x?.path === "peer-relay") return `peer relay${ms}`;
  return x?.why === "the node is offline" ? "offline" : "unknown";
}

/** The path dot (js/status-mark.js pathMark): direct, relayed for any relay, unknown when the path is not known. Relayed is normal, never a warning. */
export function linkDot(x) {
  if (x?.path === "direct") return "direct";
  if (x?.path === "relay" || x?.path === "peer-relay") return "relayed";
  return "unknown";
}

/** "last handshake 3 min ago", "no handshake yet", or why the path is unknown. */
export function handshakeLine(x, now = Date.now()) {
  if (x?.lastHandshake) return `last handshake ${now - x.lastHandshake < 60_000 ? "under a minute" : since(x.lastHandshake, now)} ago`;
  return x?.path === "unknown" ? x.why || "" : "no handshake yet";
}

/** The last answer, shared by every view on the page, and the ask in flight. */
let last = { at: 0, r: /** @type {{ data?: any, error?: any } | null} */ (null) };
/** @type {Promise<{ data?: any, error?: any }> | null} */ let asking = null;

/** link.health, asked at most once a minute for the whole page. */
function ask() {
  if (last.r && Date.now() - last.at < HEALTH_EVERY) return Promise.resolve(last.r);
  asking ||= attempt("link.health").then(r => { last = { at: Date.now(), r }; asking = null; return r; });
  return asking;
}

/**
 * Follow link.health while the page is visible. fn gets the answer, or null when this vyred has
 * no link module (the caller then shows nothing).
 * @param {(x: any | null) => void} fn
 * @returns {() => void} stop
 */
export function watchHealth(fn) {
  let timer = 0, stopped = false;
  const visible = () => document.visibilityState === "visible";
  const again = () => {
    clearTimeout(timer); timer = 0;
    if (!stopped && visible()) timer = window.setTimeout(load, Math.max(0, HEALTH_EVERY - (Date.now() - last.at)));
  };
  async function load() {
    timer = 0;
    if (stopped || !visible()) return;
    const r = await ask();
    if (stopped) return;
    fn(r.error ? null : r.data || {});
    again();
  }
  const onVisible = () => { if (visible()) again(); else { clearTimeout(timer); timer = 0; } };
  document.addEventListener("visibilitychange", onVisible);
  load();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
}

/**
 * The path dot for a header (direct, relayed, none) with the line as its title ("direct 12 ms").
 * Hidden until link.health answers, and when there is no link module.
 * @returns {{ el: HTMLElement, stop: () => void }}
 */
export function healthDot() {
  const el = h("span", { class: "sm sm-path-none health-dot", role: "img", hidden: true });
  const stop = watchHealth(x => {
    if (!x) { el.hidden = true; return; }
    const line = linkLine(x);
    el.className = `${pathMark(linkDot(x)).className} health-dot`;
    el.title = line;
    el.setAttribute("aria-label", `Connection to your server: ${line}`);
    el.hidden = false;
  });
  return { el, stop };
}
