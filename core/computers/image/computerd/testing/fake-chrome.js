#!/usr/bin/env node
// @ts-check
// A fake Chrome for computerd's tests: it speaks --remote-debugging-pipe's framing (one JSON text
// per message, ended by a NUL byte) and answers the handful of CDP methods computerd and
// hands-chrome use. Imported, FakeChrome runs in memory over two streams. Run as a program (as
// computerd's CHROME_BIN, through a small wrapper script), it reads fd 3 and writes fd 4 as real
// Chrome does, and writes its argv and the names of its environment variables to
// <--user-data-dir>/fake-chrome.json so a test can check what it was started with.
//
// Sessions work as in Chrome's flattened mode: the root session (no sessionId), browser sessions
// from Target.attachToBrowserTarget, and page sessions attached from either. Discovery,
// auto-attach and Fetch are per session, and detaching a session ends its children with it.
//
// Methods: Target.getTargets, attachToTarget, attachToBrowserTarget, detachFromTarget,
// setDiscoverTargets, setAutoAttach, createTarget, closeTarget, createBrowserContext,
// Browser.getVersion, Browser.close (answers, then exits), Fetch.enable/disable, any
// Domain.enable/disable, and for tests: Test.echo (answers {echo: params} after sending a
// Test.echoed event on the same session), Test.delay {ms}, Test.rootEvent (an event on the root
// session) and Test.exit (exits without answering).

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ targetId: string, parent: string, browser: boolean, discover: boolean, autoAttach: boolean, fetch: any }} Session */

const ROOT = "";

export class FakeChrome {
  /** @param {{ onExit?: () => void }} [o] */
  constructor(o = {}) {
    this.onExit = o.onExit || (() => {});
    /** @type {(text: string) => void} */
    this.out = () => {};
    /** @type {Map<string, any>} */
    this.targets = new Map();
    /** @type {Map<string, Session>} sessionId -> session; ROOT is the pipe's own */
    this.sessions = new Map([[ROOT, { targetId: "browser", parent: "", browser: true, discover: false, autoAttach: false, fetch: null }]]);
    /** @type {Array<{ id: number, method: string, sessionId?: string, params: any }>} every call received, in order */
    this.seen = [];
    this.n = 0;
    this.exited = false;
    this.newTarget("about:blank");
  }

  /** Sessions other than the root, for assertions. */
  attached() { return [...this.sessions.keys()].filter(k => k !== ROOT); }

  /**
   * Read NUL-framed messages from `input` and write answers to `output`.
   * @param {import("node:stream").Readable} input @param {import("node:stream").Writable} output
   */
  wire(input, output) {
    this.output = output;
    this.out = text => { if (!this.exited) output.write(text + "\0"); };
    /** @type {Buffer[]} */
    let partial = [];
    input.on("data", chunk => {
      let start = 0;
      for (;;) {
        const i = chunk.indexOf(0, start);
        if (i < 0) break;
        const whole = Buffer.concat([...partial, chunk.subarray(start, i)]);
        partial = [];
        start = i + 1;
        // Answered on a later turn, as across a real pipe: never inside the caller's own write.
        const text = whole.toString("utf8");
        setImmediate(() => this.receive(text));
      }
      if (start < chunk.length) partial.push(Buffer.from(chunk.subarray(start)));
    });
  }

  /** Stop answering and close the output, as a Chrome that died would. */
  exit() {
    if (this.exited) return;
    this.exited = true;
    try { this.output && this.output.end(); } catch {}
    this.onExit();
  }

  /** An event on one session (ROOT for none). @param {string} sid @param {string} method @param {any} params */
  emit(sid, method, params) {
    this.out(JSON.stringify({ method, params, ...(sid ? { sessionId: sid } : {}) }));
  }

  /** @param {string} url @param {string} [browserContextId] */
  newTarget(url, browserContextId = "ctx-default") {
    const targetId = `T${++this.n}`;
    const info = { targetId, type: "page", title: url, url, attached: false, canAccessOpener: false, browserContextId };
    this.targets.set(targetId, info);
    for (const [sid, s] of [...this.sessions]) {
      if (!s.browser) continue;
      if (s.discover) this.emit(sid, "Target.targetCreated", { targetInfo: info });
      if (s.autoAttach) this.attach(targetId, sid);
    }
    return info;
  }

  /** Attach a page from session `parent`, announcing it there. @param {string} targetId @param {string} parent */
  attach(targetId, parent) {
    const info = this.targets.get(targetId);
    const sessionId = `S${++this.n}`;
    this.sessions.set(sessionId, { targetId, parent, browser: false, discover: false, autoAttach: false, fetch: null });
    info.attached = true;
    this.emit(parent, "Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: false });
    return sessionId;
  }

  /** End a session and, as Chrome does, every session attached from it. @param {string} sid */
  drop(sid) {
    const s = this.sessions.get(sid);
    if (!s || sid === ROOT) return;
    this.sessions.delete(sid);
    for (const [child, cs] of [...this.sessions]) if (cs.parent === sid) this.drop(child);
    if (this.sessions.has(s.parent)) this.emit(s.parent, "Target.detachedFromTarget", { sessionId: sid, targetId: s.targetId });
  }

  /** @param {string} text */
  receive(text) {
    if (this.exited) return;
    const m = JSON.parse(text);
    const params = m.params || {};
    const sid = typeof m.sessionId === "string" ? m.sessionId : ROOT;
    this.seen.push({ id: m.id, method: m.method, sessionId: m.sessionId, params });
    const ok = (/** @type {any} */ result) => this.send({ id: m.id, result, ...(sid ? { sessionId: sid } : {}) });
    const fail = (/** @type {number} */ code, /** @type {string} */ message) => this.send({ id: m.id, error: { code, message }, ...(sid ? { sessionId: sid } : {}) });
    const here = this.sessions.get(sid);
    if (!here) return fail(-32001, "Session with given id not found.");
    const targetDomain = m.method.startsWith("Target.") || m.method.startsWith("Browser.");
    if (targetDomain && !here.browser && !["Target.setAutoAttach", "Target.attachToTarget", "Target.getTargets", "Target.detachFromTarget"].includes(m.method)) {
      return fail(-32601, `'${m.method}' wasn't found`);
    }
    switch (m.method) {
      case "Target.getTargets": return ok({ targetInfos: [...this.targets.values()] });
      case "Target.attachToTarget": {
        if (!this.targets.has(params.targetId)) return fail(-32602, "No target with given id found");
        return ok({ sessionId: this.attach(params.targetId, sid) });
      }
      case "Target.attachToBrowserTarget": {
        const sessionId = `B${++this.n}`;
        this.sessions.set(sessionId, { targetId: "browser", parent: sid, browser: true, discover: false, autoAttach: false, fetch: null });
        this.emit(sid, "Target.attachedToTarget", { sessionId, targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true }, waitingForDebugger: false });
        return ok({ sessionId });
      }
      case "Target.detachFromTarget": {
        const child = this.sessions.get(params.sessionId);
        if (!child || child.parent !== sid) return fail(-32602, "No session with given id");
        this.drop(params.sessionId);
        return ok({});
      }
      case "Target.setDiscoverTargets": {
        const was = here.discover;
        here.discover = params.discover === true;
        if (here.discover && !was) for (const info of this.targets.values()) this.emit(sid, "Target.targetCreated", { targetInfo: info });
        return ok({});
      }
      case "Target.setAutoAttach": {
        const was = here.autoAttach;
        here.autoAttach = params.autoAttach === true;
        if (here.browser && here.autoAttach && !was) for (const t of this.targets.values()) if (t.type === "page") this.attach(t.targetId, sid);
        return ok({});
      }
      case "Target.createTarget": return ok({ targetId: this.newTarget(params.url || "about:blank", params.browserContextId).targetId });
      case "Target.closeTarget": {
        const targetId = params.targetId;
        if (!this.targets.has(targetId)) return fail(-32602, "No target with given id found");
        for (const [s, st] of [...this.sessions]) if (st.targetId === targetId) this.drop(s);
        this.targets.delete(targetId);
        for (const [s, st] of this.sessions) if (st.browser && st.discover) this.emit(s, "Target.targetDestroyed", { targetId });
        return ok({ success: true });
      }
      case "Target.createBrowserContext": return ok({ browserContextId: `ctx-${++this.n}` });
      case "Browser.getVersion": return ok({ protocolVersion: "1.3", product: "Chrome/140.0.0.0", revision: "@fake", userAgent: "Mozilla/5.0 FakeChrome", jsVersion: "14.0" });
      case "Browser.close": ok({}); return this.exit();
      case "Fetch.enable": here.fetch = params; return ok({});
      case "Fetch.disable": here.fetch = null; return ok({});
      case "Test.echo": {
        this.emit(sid, "Test.echoed", { n: params.n });
        return ok({ echo: params });
      }
      case "Test.delay": { setTimeout(() => { if (this.sessions.has(sid)) ok({ waited: params.ms }); }, Number(params.ms) || 0); return; }
      case "Test.rootEvent": { this.emit(ROOT, "Test.rooted", {}); return ok({}); }
      case "Test.exit": return this.exit();
      default:
        // Page.enable, Runtime.enable, DOM.enable and friends: hands-chrome turns them on per page.
        if (/^[A-Z][A-Za-z]*\.(enable|disable)$/.test(m.method)) return ok({});
        return fail(-32601, `'${m.method}' wasn't found`);
    }
  }

  /** @param {any} m */
  send(m) { this.out(JSON.stringify(m)); }
}

// ---- as a program: computerd's CHROME_BIN in its tests --------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const profile = (args.find(a => a.startsWith("--user-data-dir=")) || "").slice("--user-data-dir=".length);
  // Never creates the profile folder: a fake still starting after its test removed the temp dir
  // must not bring it back.
  if (profile) {
    try {
      fs.writeFileSync(path.join(profile, "fake-chrome.json"), JSON.stringify({ args, env: Object.keys(process.env).sort(), pid: process.pid }));
      // What a real Chrome leaves behind, so computerd's cleanup of the next start can be seen.
      fs.writeFileSync(path.join(profile, "SingletonLock"), "fake");
    } catch {}
  }
  if (!args.includes("--remote-debugging-pipe")) { process.stderr.write("fake-chrome: no --remote-debugging-pipe\n"); process.exit(3); }
  const input = new net.Socket({ fd: 3, readable: true, writable: false });
  const output = new net.Socket({ fd: 4, readable: false, writable: true });
  const fake = new FakeChrome({ onExit: () => setTimeout(() => process.exit(0), 20) });
  fake.wire(input, output);
  // computerd gone means nobody will ever write to fd 3 again: exit, as Chrome does.
  input.on("end", () => process.exit(0));
  input.on("error", () => process.exit(0));
  process.stderr.write("fake-chrome: up\n");
}
