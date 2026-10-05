// @ts-check
// screen: what the assistant may know about the Mac's screen, and where that knowledge stops.
//
// The helper reports what the accessibility tree says. This file decides what of it leaves the
// module: the floor's blind places (floor.js) get the app and window title and nothing else,
// secure input is stripped again here even if the helper sent it, and only named fields pass,
// so a helper that grew a new field cannot leak it by accident. It also holds a small cache
// that the helper's change lines invalidate, so a burst of calls between two changes costs one
// read of the screen.
//
// Nothing in here logs, emits an event, or writes screen content to disk. The one file it
// writes is a screenshot the caller asked for, in a private folder, deleted after a minute.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { blind } from "./floor.js";
import { ScreenError, grantMessage, responsibleApp } from "./runner.js";

/**
 * Whether this process may raise a system dialog. Copied from core/vault/mac/dialogs.js (modules
 * do not import across folders): never under tests unless a person there asked for it.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dialogsAllowed(env = process.env) {
  if (env.VYRE_NO_DIALOGS === "1") return false;
  if (env.NODE_TEST_CONTEXT && env.VYRE_TEST_DIALOGS !== "1") return false;
  return true;
}

const SECURE = "AXSecureTextField";
const BOX_TTL_MS = 60_000;

/** @param {any} v */
const str = v => (typeof v === "string" ? v : null);
/** @param {any} f */
const frame = f => (f && typeof f === "object" && [f.x, f.y, f.w, f.h].every(Number.isFinite) ? { x: f.x, y: f.y, w: f.w, h: f.h } : null);
/** @param {any} a */
const appOf = a => ({ name: str(a && a.name), bundle: str(a && a.bundle), pid: Number.isInteger(a && a.pid) ? a.pid : null });
/** @param {any} b @returns {import("./floor.js").Where} */
const placeOf = b => ({ bundle: str(b && b.app && b.app.bundle), app: str(b && b.app && b.app.name), window: str(b && b.window && b.window.title), url: str(b && b.url) });

/** What a blind place gets: which app and which window, and why there is nothing more. */
function blindResult(/** @type {any} */ b, /** @type {string} */ reason) {
  return { app: appOf(b.app), window: { title: str(b.window && b.window.title) }, blind: reason };
}

/**
 * Only the fields the tool promises, with secure input stripped whatever the helper said.
 * @param {any} b
 */
export function shape(b) {
  const f = b.focused && typeof b.focused === "object" ? b.focused : null;
  const secure = b.secure === true || Boolean(f && (f.role === SECURE || f.subrole === SECURE));
  const focused = f ? {
    role: str(f.role), subrole: str(f.subrole), name: str(f.name), frame: frame(f.frame),
    ...(secure ? {} : { value: str(f.value), selectedText: str(f.selectedText) }),
  } : null;
  return {
    app: appOf(b.app),
    window: b.window ? { title: str(b.window.title), frame: frame(b.window.frame) } : null,
    focused,
    url: str(b.url),
    text: str(b.text),
    truncated: b.truncated === true,
    secure,
    at: Number.isFinite(b.at) ? b.at : null,
  };
}

export class Screen {
  /**
   * @param {{
   *   helper: import("./runner.js").Helper,
   *   call?: (tool: string, input?: any) => Promise<any>,
   *   now?: () => number,
   *   maxAgeMs?: number,
   *   shotDir?: string,
   *   shotTtlMs?: number,
   *   capture?: (args: string[]) => Promise<void>,
   *   dialogs?: () => boolean,
   *   responsible?: () => string,
   * }} o
   */
  constructor({ helper, call = async () => ({ error: { code: "no_such_tool" } }), now = Date.now, maxAgeMs = 2000, shotDir = os.tmpdir(),
    shotTtlMs = 60_000, capture = screencapture, dialogs = () => dialogsAllowed(), responsible = responsibleApp }) {
    Object.assign(this, { helper, call, now, maxAgeMs, shotDir, shotTtlMs, capture, dialogs, responsible });
    /** @type {Map<string, { at: number, body: any }>} */
    this.cache = new Map();
    /** @type {{ at: number, origin: string|null } | null} */
    this.box = null;
    /** @type {Set<string>} */
    this.shots = new Set();
    /** @type {Set<NodeJS.Timeout>} */
    this.timers = new Set();
    // A change line or a fresh helper means everything cached may describe a screen that is gone.
    helper.onChanged(() => this.cache.clear());
    helper.onRestart(() => this.cache.clear());
  }

  /**
   * The paired box's origin, so the Deck and Glass in a browser count as Vyre surfaces. Asked of
   * wink.server.call names.status on the call that needs it, kept for a minute at most; no link means no box.
   */
  async boxOrigin() {
    if (this.box && this.now() - this.box.at < BOX_TTL_MS) return this.box.origin;
    let origin = null;
    try {
      const r = await this.call("wink.server.call", { tool: "names.status", input: {} });
      const d = r && r.data;
      if (d && typeof d.address === "string") origin = d.address;
    } catch {}
    this.box = { at: this.now(), origin };
    return origin;
  }

  /** @param {string} key @param {boolean} ages @param {() => Promise<any>} read */
  async cached(key, ages, read) {
    const hit = this.cache.get(key);
    if (hit && (!ages || this.now() - hit.at <= this.maxAgeMs)) return { ...hit.body, cached: true };
    const body = await read();
    this.cache.set(key, { at: this.now(), body });
    return { ...body, cached: false };
  }

  /**
   * The screen context of the front app, or of `pid` (tests read the window they opened).
   * The cheap "where" comes first, so a blind place never has its text read at all.
   * @param {{ text?: boolean, textMax?: number }} [input] @param {{ pid?: number }} [o]
   */
  async context({ text = true, textMax = 4000 } = {}, { pid } = {}) {
    const t0 = this.now();
    textMax = Math.max(0, Math.min(Number.isInteger(textMax) ? textMax : 4000, 20000));
    const at = pid ? { pid } : {};
    const where = await this.cached(`where|${pid || "front"}`, false, () => this.helper.request({ cmd: "where", ...at }));
    const box = await this.boxOrigin();
    const first = blind(placeOf(where), { box });
    if (first) return blindResult(where, first);
    const p = where.app && where.app.pid;
    // Text goes stale without a notification (a page that updates itself), so it ages out;
    // the rest changes only when macOS says so.
    const full = await this.cached(`context|${p}|${text}|${textMax}`, text, () =>
      this.helper.request({ cmd: "context", pid: p, text, textMax, ...(text ? { maxAgeMs: this.maxAgeMs } : {}) }));
    // The front app can change between the two reads; the floor judges what was actually read.
    const again = blind(placeOf(full), { box });
    if (again) return blindResult(full, again);
    return { ...shape(full), cached: where.cached && full.cached, ms: this.now() - t0 };
  }

  /**
   * A screenshot of the front window (or the main display), on demand only. Returned as a path
   * in a private folder rather than base64, see index.js.
   * @param {{ window?: boolean }} [input] @param {{ pid?: number }} [o]
   */
  async shot({ window = true } = {}, { pid } = {}) {
    const where = await this.helper.request({ cmd: "where", ...(pid ? { pid } : {}) });
    const box = await this.boxOrigin();
    const reason = blind(placeOf(where), { box });
    if (reason) return blindResult(where, reason);
    const info = await this.helper.request({ cmd: "shotinfo", pid: where.app && where.app.pid });
    if (!info.granted) {
      // Asking macOS shows a system dialog; only when a person may be there to answer it.
      if (this.dialogs()) { try { await this.helper.request({ cmd: "requestCapture" }); } catch {} }
      throw new ScreenError("not_granted", grantMessage(this.responsible(), "Screen Recording"));
    }
    let args;
    if (window) {
      if (!Number.isInteger(info.windowId)) throw new ScreenError("no_window", "the front app has no window on screen");
      args = ["-x", "-o", `-l${info.windowId}`];
    } else {
      // Every window on the display is in the picture, so every one of them faces the floor.
      for (const w of info.windows || []) {
        const r = blind({ bundle: str(w.bundle), app: str(w.app), window: str(w.title) }, { box });
        if (r) return { ...blindResult(where, r), blind: `${r} is on screen` };
      }
      args = ["-x", "-m"];
    }
    const dir = fs.mkdtempSync(path.join(this.shotDir, "vyre-shot-"));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, window ? "window.png" : "screen.png");
    try { await this.capture([...args, file]); }
    catch { fs.rmSync(dir, { recursive: true, force: true }); throw new ScreenError("shot_failed", "screencapture did not produce a picture"); }
    if (!fs.existsSync(file)) { fs.rmSync(dir, { recursive: true, force: true }); throw new ScreenError("shot_failed", "screencapture did not produce a picture"); }
    fs.chmodSync(file, 0o600);
    this.shots.add(dir);
    const timer = setTimeout(() => { this.timers.delete(timer); this.forget(dir); }, this.shotTtlMs);
    timer.unref();
    this.timers.add(timer);
    return { path: file, ...pngSize(file), expiresAt: this.now() + this.shotTtlMs, app: appOf(where.app), window: { title: str(where.window && where.window.title) } };
  }

  /** @param {string} dir */
  forget(dir) { this.shots.delete(dir); fs.rmSync(dir, { recursive: true, force: true }); }

  async stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const d of [...this.shots]) this.forget(d);
    this.cache.clear();
    await this.helper.stop();
  }
}

/** Width and height from a PNG's header, so the caller knows the size without decoding it. */
function pngSize(/** @type {string} */ file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    if (b.toString("ascii", 12, 16) !== "IHDR") return {};
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch { return {}; }
}

/** @param {string[]} args */
function screencapture(args) {
  return new Promise((ok, no) => execFile("/usr/sbin/screencapture", args, { timeout: 10_000 }, e => (e ? no(e) : ok())));
}
