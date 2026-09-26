// @ts-check
// sideview: a session on the left, Chrome filling the rest, in one call (team/briefs/sideview-layout.md).
//
// The session window gets `ratio` of the display's width (0.29 by default) and its full height
// between the menu bar and the Dock; Chrome's front window takes the rest, edge to edge. The
// frames the windows had before are kept in memory, and close puts them back.
//
// Moving a window is not reading it or pressing anything in it, so the floor applies only as far
// as it has to: a password manager, a system sign-in or permission dialog, or a security pane of
// System Settings is never moved (a model must not be able to drag one under a window it
// controls). Vyre's own surfaces may be tiled: that is what the side view is for.

import { execFile } from "node:child_process";
import { untouchable } from "../screen-mac/floor.js";
import { dialogsAllowed } from "../../core/config/dialogs.js";
import { SideviewError } from "./runner.js";
import { CHROME, SESSION_APPS, leftFrame, pickBrowser, pickSession, ratioOf, rightFrame, screenOf } from "./layout.js";

/** How long a launched or newly opened Chrome gets to show its window. */
const BROWSER_WAIT_MS = 5000;
const BROWSER_STEP_MS = 250;

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** Open Chrome, with a URL as a new tab of its front window. Refused under tests. @param {string|null} url */
function openChrome(url) {
  return new Promise((ok, no) => {
    if (!dialogsAllowed()) return no(new SideviewError("no_dialog", "opening Chrome is off here (a test, a dev home, or VYRE_NO_DIALOGS)"));
    execFile("/usr/bin/open", ["-a", "Google Chrome", ...(url ? [url] : [])], { timeout: 10_000 }, e => e ? no(new SideviewError("no_browser", "Google Chrome could not be opened; is it installed?")) : ok(undefined));
  });
}

/** @param {unknown} u */
function checkUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { throw new SideviewError("bad_input", "url must be an http or https URL"); }
  if (!["http:", "https:"].includes(x.protocol)) throw new SideviewError("bad_input", "url must be an http or https URL");
  return x.href;
}

/** @param {unknown} s */
function checkSession(s) {
  if (s === undefined || s === null || s === "front" || s === "terminal") return /** @type {"front"|"terminal"} */ (s || "front");
  if (typeof s === "object") {
    const o = /** @type {any} */ (s);
    if (Number.isInteger(o.pid) && o.pid > 0) return { pid: o.pid };
    if (typeof o.bundle === "string" && /^[A-Za-z0-9.-]{3,200}$/.test(o.bundle)) return { bundle: o.bundle };
  }
  throw new SideviewError("bad_input", 'session is "front", "terminal", {"bundle": "<bundle id>"} or {"pid": <pid>}');
}

const brief = (/** @type {any} */ w, /** @type {any} */ frame) => ({ app: w.app, bundle: w.bundle, pid: w.pid, title: w.title, frame });

export class Sideview {
  /**
   * @param {{
   *   tile: { request: (req: Record<string, unknown>) => Promise<any> },
   *   call?: (tool: string, input?: any) => Promise<any>,
   *   launch?: (url: string|null) => Promise<void>,
   *   activate?: () => boolean,
   *   region?: import("./layout.js").Rect | null,
   *   waitMs?: number, stepMs?: number,
   * }} o
   */
  constructor({ tile, call = async () => ({}), launch = openChrome, activate = () => dialogsAllowed(), region = null, waitMs = BROWSER_WAIT_MS, stepMs = BROWSER_STEP_MS }) {
    this.tile = tile; this.call = call; this.launch = launch; this.activate = activate; this.region = region;
    this.waitMs = waitMs; this.stepMs = stepMs;
    /** Frames before the side view, by "pid:index", so close can put them back. @type {Map<string, any>} */
    this.saved = new Map();
    /** @type {any} */
    this.state = null;
  }

  /** @param {Record<string, unknown>} bundlesAndPids */
  frames(bundlesAndPids) { return this.tile.request({ cmd: "frames", ...bundlesAndPids }); }

  /** The Glass page for a target on the paired box. @param {string} target */
  async glassUrl(target) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(target)) throw new SideviewError("bad_input", "glass is an agent's name, or box");
    let r;
    try { r = await this.call("link.status"); } catch { r = null; }
    const d = r && r.data;
    if (!d || !d.linked || !d.box || typeof d.box.address !== "string") throw new SideviewError("no_box", "Glass is on the box, and this Mac is not paired with one (vyre link pair <address>)");
    return new URL(`/glass/${encodeURIComponent(target)}`, d.box.address).href;
  }

  /**
   * @param {{ session?: unknown, browser?: string, glass?: string, url?: string, ratio?: number }} [input]
   */
  async open(input = {}) {
    const ratio = ratioOf(input.ratio);
    const session = checkSession(input.session);
    const browser = input.browser === undefined ? (input.glass ? "glass" : "chrome") : input.browser;
    if (browser !== "chrome" && browser !== "glass") throw new SideviewError("bad_input", 'browser is "chrome" or "glass"');
    if (browser === "glass" && input.url) throw new SideviewError("bad_input", "url and glass are two different pages; give one");
    const url = browser === "glass" ? await this.glassUrl(String(input.glass || "box")) : input.url ? checkUrl(input.url) : null;

    const ask = {
      bundles: [...new Set([...SESSION_APPS, CHROME, ...(typeof session === "object" && session.bundle ? [session.bundle] : [])])],
      pids: typeof session === "object" && session.pid ? [session.pid] : [],
    };
    let f = await this.frames(ask);
    const left = pickSession(f.windows || [], f.front || null, session);
    if (!left) throw new SideviewError("no_session", typeof session === "object" ? "that app has no window to put on the left" : "no terminal window is open to put on the left");
    const why = untouchable({ bundle: left.bundle, app: left.app, window: left.title });
    if (why && why !== "a Vyre surface") throw new SideviewError("floor", `the side view never moves ${why}`);

    let right = pickBrowser(f.windows || []);
    if (!right || url) {
      await this.launch(url);
      const until = Date.now() + this.waitMs;
      // Bounded: only while this one call waits for the window it just asked Chrome for.
      for (;;) {
        f = await this.frames(ask);
        right = pickBrowser(f.windows || []);
        if (right) break;
        if (Date.now() >= until) throw new SideviewError("no_browser", "Chrome did not show a window in time");
        await sleep(this.stepMs);
      }
    }
    // Picked again after a launch: the session window's index can shift, not its pid.
    const again = (f.windows || []).filter((/** @type {any} */ w) => w.pid === left.pid);
    const leftNow = again.find((/** @type {any} */ w) => w.title === left.title) || again.find((/** @type {any} */ w) => w.index === left.index) || left;

    const screen = screenOf(f.screens || [], leftNow.frame);
    const area = this.region || (screen && screen.visible);
    if (!area) throw new SideviewError("no_screen", "no display to lay the windows out on");

    for (const w of [leftNow, right]) {
      const k = `${w.pid}:${w.index}`;
      if (!this.saved.has(k)) this.saved.set(k, { pid: w.pid, index: w.index, title: w.title, frame: w.frame });
    }

    const a = await this.tile.request({ cmd: "set", moves: [{ pid: leftNow.pid, index: leftNow.index, title: leftNow.title, frame: leftFrame(area, ratio) }] });
    const la = a.results && a.results[0];
    if (!la || la.code === "gone") throw new SideviewError("gone", "the session window closed while it was being moved");
    const b = await this.tile.request({
      cmd: "set", moves: [{ pid: right.pid, index: right.index, title: right.title, frame: rightFrame(area, la.frame) }],
      activate: this.activate() ? [right.pid, leftNow.pid] : [],
    });
    const ra = b.results && b.results[0];
    if (!ra || ra.code === "gone") throw new SideviewError("gone", "the Chrome window closed while it was being moved");

    this.state = { left: brief(leftNow, la.frame), right: brief(right, ra.frame), ratio, area, url, at: Date.now() };
    return { open: true, ...this.state, exact: Boolean(la.exact && ra.exact) };
  }

  async close() {
    if (!this.saved.size) return { open: false, restored: 0 };
    const moves = [...this.saved.values()];
    const r = await this.tile.request({ cmd: "set", moves });
    this.saved.clear();
    this.state = null;
    return { open: false, restored: (r.results || []).filter((/** @type {any} */ x) => x.code !== "gone").length };
  }

  status() {
    return this.state ? { open: true, ...this.state } : { open: false };
  }
}
