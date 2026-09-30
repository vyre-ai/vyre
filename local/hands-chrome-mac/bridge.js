// @ts-check
// bridge: the module's end of the socket the native host connects to. One extension is live at a
// time (a person has one Chrome running Vyre); a new hello replaces the old connection, because a
// second host means Chrome restarted or another profile took over, and calls should go to the
// newest. Frames are the same 4-byte-length JSON the host relays untouched (stdio.js).
//
// Nothing the extension sends is trusted to have been redacted: every result and event payload
// goes through redact.value() here as well, so a capability written later cannot forget.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { encode, reader } from "./native-host/stdio.js";
import { socketPath } from "./native-host/host.js";
import * as proto from "./shared/proto.js";
import * as redact from "./shared/redact.js";

export { socketPath };

/** Longer ops than the default 30 s: a batch runs many steps, a replay waits on the network. */
export const OP_TIMEOUTS = { "batch.run": 120_000, "net.replay": 60_000, "api.call": 60_000, "page.wait": 65_000 };

/** @param {string} code @param {string} [message] */
const err = (code, message) => Object.assign(new Error(message || proto.fail(code).message), { code });

/**
 * @param {{ sockPath?: string, timeoutMs?: number, opTimeouts?: Record<string, number>, log?: (m: string) => void }} [o]
 */
export function createBridge({ sockPath = socketPath(), timeoutMs = 30_000, opTimeouts = {}, log = () => {} } = {}) {
  /** @typedef {{ sock: net.Socket, hello: any, pending: Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, op: string }> }} Conn */
  /** @type {Conn|null} */
  let live = null;
  /** @type {Set<Conn>} */
  const conns = new Set();
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  /** @type {net.Server|null} */
  let server = null;
  let seq = 0;

  const fan = (/** @type {any} */ e) => { for (const fn of [...listeners]) { try { fn(e); } catch (x) { log(`listener failed: ${/** @type {Error} */ (x).message}`); } } };

  /** @param {Conn} c @param {any} e */
  const failAll = (c, e) => { for (const [id, p] of c.pending) { clearTimeout(p.timer); p.reject(e); c.pending.delete(id); } };

  /** @param {net.Socket} sock */
  function accept(sock) {
    /** @type {Conn} */
    const c = { sock, hello: null, pending: new Map() };
    conns.add(c);
    const rd = reader();
    sock.on("data", d => {
      let msgs;
      try { msgs = rd.push(d); } catch (e) { log(`bad frame from host: ${/** @type {Error} */ (e).message}`); sock.destroy(); return; }
      for (const m of msgs) onFrame(c, m);
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      conns.delete(c);
      failAll(c, err("no_extension", "the extension disconnected"));
      if (live === c) { live = null; fan({ event: "disconnected" }); }
    });
  }

  /** @param {Conn} c @param {any} m */
  function onFrame(c, m) {
    if (!m || typeof m !== "object") return;
    if (m.event === "hello") {
      if (m.protocol !== proto.PROTOCOL) {
        send(c, { event: "bad_protocol", expected: proto.PROTOCOL, got: m.protocol });
        c.sock.end();
        return;
      }
      const { event: _e, ...said } = m;
      c.hello = redact.value(said);
      if (live && live !== c) {
        failAll(live, err("no_extension", "a newer extension connection replaced this one"));
        live.sock.destroy();
      }
      live = c;
      fan({ event: "hello", ...c.hello });
      return;
    }
    if (c !== live) return; // nothing is believed from a connection that has not said hello
    if (typeof m.event === "string") {
      const { event, ...rest } = m;
      fan({ event, ...clean(rest) });
      return;
    }
    if (m.id === undefined) return;
    const p = c.pending.get(String(m.id));
    if (!p) return; // a late answer to a call that already timed out
    clearTimeout(p.timer);
    c.pending.delete(String(m.id));
    if (m.ok === false) {
      const e = m.error || {};
      p.reject(Object.assign(err(String(e.code || "error"), redact.text(String(e.message || e.code || "the extension refused"))), e.detail !== undefined ? { detail: redact.value(e.detail) } : {}));
    } else p.resolve(result(m.result));
  }

  /**
   * redact.value masks any key named like a secret, and "signature" is one. A held act's page
   * signature is not a secret (it is a hash of the page's shape, and the only proof the release
   * is for the same page), so it alone is passed through; everything else in the result is
   * redacted as usual.
   * @param {any} r
   */
  function result(r) {
    if (r && typeof r === "object" && r.held === true && typeof r.signature === "string") {
      const { signature, ...rest } = r;
      return { ...clean(rest), signature };
    }
    return clean(r);
  }

  /** redact.value, plus redact.url on every field called url (a query parameter named token is a secret whatever its value looks like). @param {any} v */
  function clean(v) {
    return urls(redact.value(v), 0);
  }
  /** @param {any} v @param {number} depth @returns {any} */
  function urls(v, depth) {
    if (depth > 12 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(x => urls(x, depth + 1));
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = /^(url|href|pageUrl|documentURL)$/i.test(k) && typeof x === "string" ? redact.url(x) : urls(x, depth + 1);
    return out;
  }

  /** @param {Conn} c @param {any} frame */
  const send = (c, frame) => new Promise(resolve => { try { c.sock.write(encode(frame), () => resolve(true)); } catch { resolve(false); } });

  return {
    sockPath,
    /** Start listening. Rejects if another process already answers on the path. */
    async listen() {
      const win = process.platform === "win32" && sockPath.startsWith("\\\\");
      if (!win) {
        const dir = path.dirname(sockPath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch { /* a folder we do not own, e.g. a test's temp dir */ }
        if (fs.existsSync(sockPath)) {
          const alive = await new Promise(res => {
            const s = net.connect(sockPath);
            s.once("connect", () => { s.destroy(); res(true); });
            s.once("error", () => { s.destroy(); res(false); });
          });
          if (alive) throw err("in_use", `another Vyre already listens on ${sockPath}`);
          fs.unlinkSync(sockPath);
        }
      }
      server = net.createServer(accept);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(sockPath, () => resolve(null)); });
      if (!win) fs.chmodSync(sockPath, 0o600);
    },
    async close() {
      for (const c of conns) { failAll(c, err("no_extension", "the module is stopping")); c.sock.destroy(); }
      conns.clear(); live = null;
      const s = server; server = null;
      if (s) await new Promise(r => s.close(() => r(null)));
      if (process.platform !== "win32") { try { fs.unlinkSync(sockPath); } catch { /* already gone */ } }
    },
    /** Whether an extension has said hello and is still there. */
    connected: () => Boolean(live),
    /** What the live extension said in its hello (version, browser), redacted, or null. */
    info: () => (live ? live.hello : null),
    /**
     * Ask the extension to do one op. Resolves with its (redacted) result; rejects with an Error
     * whose `code` is the extension's own, or no_extension, or timeout.
     * @param {string} op @param {any} [args] @param {{ timeoutMs?: number }} [o]
     * @returns {Promise<any>}
     */
    call(op, args = {}, o = {}) {
      const c = live;
      if (!c) return Promise.reject(err("no_extension"));
      const id = `m${++seq}`;
      const ms = o.timeoutMs ?? opTimeouts[op] ?? /** @type {Record<string, number>} */ (OP_TIMEOUTS)[op] ?? timeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { c.pending.delete(id); reject(err("timeout", `${op} did not answer in ${ms} ms`)); }, ms);
        c.pending.set(id, { resolve, reject, timer, op });
        send(c, { id, op, args }).then(ok => { if (!ok) { clearTimeout(timer); c.pending.delete(id); reject(err("no_extension", "could not write to the extension")); } });
      });
    },
    /** Tell the extension something without waiting (stop, resume). Resolves once written. @param {any} frame */
    push(frame) { return live ? send(live, frame) : Promise.resolve(false); },
    /** Every event the extension sends, redacted. Returns the function that stops listening. @param {(e: any) => void} fn */
    on(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
