// @ts-check
// clipboard: how `vault.copy` puts a value on the Mac's pasteboard and takes it off again
// (ADR 0006, decision 4). The value never goes back to the caller; it goes from vyred to the
// helper's stdin and from there to the pasteboard.
//
//   - With the Swift helper (mac/clip.swift): the copy is for this Mac only and marked concealed
//     and transient. vyred clears it after 90 seconds, on lock or sleep, and when it stops, and
//     only if the pasteboard's changeCount has not moved, so something the person copied since
//     is never wiped. The helper also clears when its stdin closes, so a crash still wipes it.
//   - Without swiftc: `pbcopy` on stdin, a SHA-256 of the value kept, and at 90 seconds `pbpaste`
//     compared with it before clearing. Clipboard managers see this copy, and the result says so.
//   - Anywhere but a Mac: refused with words a person can act on.
//
// The helper runs only while something of ours is on the pasteboard, so an idle vyred has no
// child process and no timer here.

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lines } from "./mac/helper.js";

export const CLEAR_AFTER_MS = 90_000;
const REPLY_MS = 10_000;

const sha = v => crypto.createHash("sha256").update(String(v)).digest("hex");

/** Run a command with `input` on stdin; resolve with its stdout. Never puts input in an error. */
function pipe(cmd, input, env) {
  return new Promise((resolve, reject) => {
    let out = "";
    let c;
    try { c = spawn(cmd, [], { stdio: "pipe", env }); } catch { return reject(new Error(`${cmd} could not start`)); }
    const t = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(`${cmd} did not finish`)); }, REPLY_MS);
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", d => { if (out.length < 1 << 20) out += d; });
    c.on("error", () => { clearTimeout(t); reject(new Error(`${cmd} could not start`)); });
    c.on("close", code => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code})`)); });
    c.stdin.on("error", () => {});
    c.stdin.end(input);
  });
}

export class Clipboard {
  /**
   * @param {{ helper?: import("./mac/helper.js").Helper | null, platform?: string, env?: NodeJS.ProcessEnv,
   *   pasteboard?: string, clearAfter?: number, now?: () => number,
   *   timers?: { set: (fn: () => void, ms: number) => any, clear: (t: any) => void }, log?: (m: string) => void,
   *   onEmpty?: () => void }} deps
   * `pasteboard` names a private pasteboard for the helper; tests use one so the real clipboard is never touched.
   * `onEmpty` runs once nothing of ours is on the pasteboard any more.
   */
  constructor({ helper = null, platform = process.platform, env = process.env, pasteboard, clearAfter = CLEAR_AFTER_MS, now = Date.now, timers, log = () => {}, onEmpty = () => {} } = {}) {
    this.onEmpty = onEmpty;
    this.helper = helper;
    this.platform = platform;
    this.env = env;
    this.pasteboard = pasteboard || null;
    this.clearAfter = clearAfter;
    this.now = now;
    this.log = log;
    this.timers = timers || {
      set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clear: t => clearTimeout(t),
    };
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this.child = null;
    /** Replies awaited from the current child; each child has its own queue. @type {((msg: any) => void)[]} */
    this.waiting = [];
    /** What of ours is on the pasteboard now. @type {{ via: "helper", count: number } | { via: "pbcopy", hash: string } | null} */
    this.held = null;
    this.timer = null;
  }

  /** Why copying cannot work here, or null. */
  refusal() {
    if (this.platform !== "darwin") return "copying to the clipboard works on a Mac only; on this machine use vyre vault get --reveal in a terminal you trust";
    return null;
  }

  /**
   * Put `text` on the pasteboard. Returns when it will be cleared, never the text.
   * @param {string} text
   * @returns {Promise<{ clearsAt: number, via: "helper"|"pbcopy", warning?: string }>}
   */
  async copy(text) {
    const no = this.refusal();
    if (no) throw Object.assign(new Error(no), { code: "unsupported" });
    let via = /** @type {"helper"|"pbcopy"} */ ("pbcopy");
    if (this.helper && this.helper.usable()) {
      try {
        const r = await this.request({ op: "copy", text });
        if (!r || r.ok !== true || typeof r.count !== "number") throw new Error("the clipboard helper refused the copy");
        this.held = { via: "helper", count: r.count };
        via = "helper";
      } catch (e) {
        this.log(`vault clipboard helper unavailable${this.pasteboard ? "" : ", using pbcopy"}: ${/** @type {Error} */ (e).message}`);
        this.stopChild();
      }
    }
    // A named private pasteboard is a promise not to touch the real one: without the helper,
    // refuse rather than fall back to pbcopy.
    if (via === "pbcopy" && this.pasteboard) throw Object.assign(new Error("the private pasteboard needs the clipboard helper, which is not available"), { code: "unsupported" });
    if (via === "pbcopy") {
      await pipe("pbcopy", text, this.env);
      this.held = { via: "pbcopy", hash: sha(text) };
    }
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; this.clear("timeout").catch(() => {}); }, this.clearAfter);
    const out = { clearsAt: this.now() + this.clearAfter, via };
    return via === "pbcopy" ? { ...out, warning: "copied with pbcopy: clipboard managers and Universal Clipboard can see it" } : out;
  }

  /**
   * Take our copy off the pasteboard, unless something else has replaced it since.
   * @param {string} [why] @returns {Promise<{ cleared: boolean }>}
   */
  async clear(why = "clear") {
    if (this.timer) { this.timers.clear(this.timer); this.timer = null; }
    const h = this.held;
    this.held = null;
    if (!h) return { cleared: false };
    let cleared = false;
    try {
      if (h.via === "helper") {
        const r = await this.request({ op: "clear", ifCount: h.count });
        cleared = Boolean(r && r.cleared);
        this.stopChild();
      } else {
        const now = await pipe("pbpaste", "", this.env);
        if (sha(now) === h.hash) { await pipe("pbcopy", "", this.env); cleared = true; }
      }
    } catch (e) {
      this.log(`vault clipboard could not clear (${why}): ${/** @type {Error} */ (e).message}`);
      this.stopChild();
    }
    if (!this.held) this.onEmpty();
    return { cleared };
  }

  /** Whether something of ours is on the pasteboard. */
  holding() { return Boolean(this.held); }

  async stop() {
    await this.clear("stop");
    this.stopChild();
  }

  // ---- the helper process -----------------------------------------------------------------

  async start() {
    if (this.child) return this.child;
    const c = await /** @type {import("./mac/helper.js").Helper} */ (this.helper).spawn(this.pasteboard ? ["--pasteboard", this.pasteboard] : [], { env: this.env });
    /** @type {((msg: any) => void)[]} */
    const waiting = [];
    this.child = c;
    this.waiting = waiting;
    lines(c.stdout, msg => { const w = waiting.shift(); if (w) w(msg); });
    c.stderr.resume();
    c.stdin.on("error", () => {});
    const gone = () => {
      if (this.child === c) this.child = null;
      for (const w of waiting.splice(0)) w(null);
    };
    c.on("error", gone);
    c.on("exit", gone);
    return c;
  }

  /** One request, one reply line. A dead or silent helper resolves null, never with the request. */
  async request(msg) {
    const c = await this.start();
    const waiting = this.waiting;
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; reject(new Error("the clipboard helper did not answer")); } }, REPLY_MS);
      waiting.push(r => {
        if (done) return;
        done = true; clearTimeout(t);
        r ? resolve(r) : reject(new Error("the clipboard helper stopped"));
      });
      c.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  /** Close the helper's stdin; it clears anything of ours still there and exits. */
  stopChild() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin.end(); } catch { /* already gone */ } }
  }
}
