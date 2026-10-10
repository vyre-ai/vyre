// @ts-check
// lib/vyre-core-client: the one way vyred, the CLI and the Capsule's JS side talk to vyre-core
// (ADR 0040 section 3). Pure, no feature state: HTTP over vyre-core's unix socket, { data } or
// { error } back, never a throw for an answer core gave.
//
// Who connects matters, not what the client says: core checks the connecting process itself. So
// a privileged write goes from the originating client (CLI, Capsule) straight to core, with its
// proof in `presence`; vyred uses this only to proxy reads open to any owner-uid caller.

import http from "node:http";

import fs from "node:fs";
import nodePath from "node:path";

export const DEFAULT_SOCKET = "/Library/Application Support/Vyre/run/vyre-core.sock";

/**
 * Is this socket vyre-core's own? A socket, owned by core's uid, in a folder only core or root
 * can write. Checked before a proof is sent, so a socket someone else put in its place never
 * collects one. Returns why not, or null.
 * @param {string} socket @param {number} coreUid @param {(p: string) => fs.Stats} [lstat] tests only
 */
export function socketProblem(socket, coreUid, lstat = p => fs.lstatSync(p)) {
  let s, d;
  try { s = lstat(socket); d = lstat(nodePath.dirname(socket)); } catch { return "vyre-core's socket isn't there"; }
  if (!s.isSocket()) return "vyre-core's socket isn't a socket";
  if (s.uid !== coreUid) return `vyre-core's socket belongs to uid ${s.uid}, not vyre-core`;
  if (!d.isDirectory() || (d.uid !== coreUid && d.uid !== 0) || (d.mode & 0o022)) return "vyre-core's socket is in a folder others can write";
  return null;
}

/**
 * One call to vyre-core.
 * @param {{ socket?: string, method?: "GET"|"POST", path: string, body?: any, presence?: string, coreUid?: number, timeout?: number }} o
 *   presence: the x-vyre-presence header for a write. coreUid: vyre-core's own uid; a proof is
 *   sent only to a socket that uid owns (socketProblem), and never without it.
 * @returns {Promise<{ data?: any, error?: { code: string, message: string, methods?: string[] }, status?: number }>}
 */
export function coreCall({ socket = DEFAULT_SOCKET, method = "POST", path, body, presence, coreUid, timeout = 10_000 }) {
  if (presence) {
    const why = typeof coreUid === "number" ? socketProblem(socket, coreUid) : "a proof goes to vyre-core only once its uid is known";
    if (why) return Promise.resolve({ error: { code: "core_untrusted", message: why } });
  }
  return new Promise(resolve => {
    const text = method === "POST" ? JSON.stringify(body ?? {}) : undefined;
    /** @type {Record<string, string|number>} */
    const headers = { accept: "application/json" };
    if (text !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(text); }
    if (presence) headers["x-vyre-presence"] = presence;
    const req = http.request({ socketPath: socket, method, path, headers, agent: false }, res => {
      const parts = [];
      res.on("data", d => parts.push(d));
      res.on("end", () => {
        try { resolve({ ...JSON.parse(Buffer.concat(parts).toString("utf8")), status: res.statusCode }); }
        catch { resolve({ error: { code: "bad_answer", message: "vyre-core's answer wasn't JSON" }, status: res.statusCode }); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error("vyre-core didn't answer in time (wait a minute and call again)"), { code: "timeout" })));
    req.on("error", e => resolve({ error: { code: /** @type {any} */ (e).code === "ENOENT" || /** @type {any} */ (e).code === "ECONNREFUSED" ? "core_unavailable" : "core_unreachable", message: e.message } }));
    if (text !== undefined) req.write(text);
    req.end();
  });
}

/** A tool on vyre-core. @param {string} tool @param {any} input @param {{ socket?: string, presence?: string, coreUid?: number }} [o] */
export const coreTool = (tool, input, o = {}) => coreCall({ ...o, path: `/v1/tools/${encodeURIComponent(tool)}`, body: input });

/** Whether vyre-core answers here: { name, protocol, version } or null. @param {string} [socket] */
export async function coreHello(socket = DEFAULT_SOCKET) {
  const r = await coreCall({ socket, method: "GET", path: "/v1/hello", timeout: 2000 });
  return r.data && r.data.name === "vyre-core" ? r.data : null;
}

/** Where the installer (phase 4) says where core is: root-owned, in core's root-owned tree. */
export const CORE_CONFIG = "/Library/Application Support/Vyre/core.json";

/**
 * vyre-core's socket and uid, from the installer's core.json, or null when there is none or it
 * can't be trusted: the file and every folder above it must be root's and closed to other writes, or a
 * model could point vyred at a core of its own. Never read from the environment.
 * @param {string} [file] tests only
 * @param {{ lstat: (p: string) => fs.Stats, read: (p: string) => string }} [io] tests only
 * @returns {{ socket: string, uid: number } | null}
 */
export function readCoreConfig(file = CORE_CONFIG, io = { lstat: p => fs.lstatSync(p), read: p => fs.readFileSync(p, "utf8") }) {
  try {
    // The file, then every folder up to /, as strict.js walks core's own tree.
    const dirs = [];
    for (let d = nodePath.dirname(nodePath.resolve(file)); ; d = nodePath.dirname(d)) { dirs.push(d); if (d === nodePath.dirname(d)) break; }
    for (const [p, dir] of [[file, false], ...dirs.map(d => [d, true])]) {
      const s = io.lstat(/** @type {string} */ (p));
      if ((dir ? !s.isDirectory() : !s.isFile()) || s.uid !== 0 || (s.mode & 0o022)) return null;
    }
    const c = JSON.parse(io.read(file));
    if (typeof c.socket !== "string" || !nodePath.isAbsolute(c.socket) || !Number.isInteger(c.uid) || c.uid <= 0) return null;
    return { socket: c.socket, uid: c.uid };
  } catch { return null; }
}

/**
 * The link vyred's presence uses on a Mac with vyre-core (core/presence core.link). Every call
 * that carries a proof checks the socket is core's first.
 * @param {{ socket: string, uid: number }} c
 */
export function coreLink({ socket, uid }) {
  return {
    /** @param {string} tool @param {any} input @param {string} header */
    async verify(tool, input, header) {
      const why = socketProblem(socket, uid);
      if (why) return { ok: false, message: why };
      const r = await coreTool("presence.verify", { tool, input, proof: header }, { socket });
      return r.data && typeof r.data.ok === "boolean" ? r.data : { ok: false, message: (r.error && r.error.message) || "vyre-core gave no answer" };
    },
    async keys() {
      const r = await coreTool("presence.keys", {}, { socket });
      if (!Array.isArray(r.data)) throw new Error((r.error && r.error.message) || "vyre-core gave no key list");
      return r.data;
    },
    /**
     * Any tool on core, a proof passed through as it came (vyred's forwarders, ADR 0040 phase 2).
     * @param {string} tool @param {any} input @param {string} [header]
     */
    async call(tool, input, header) {
      return coreTool(tool, input, { socket, coreUid: uid, ...(header ? { presence: header } : {}) });
    },
    /**
     * core's events after `after`, held open up to `wait` ms. Information only.
     * @param {number} after @param {number} [wait]
     */
    async events(after, wait = 55_000) {
      const r = await coreCall({ socket, method: "GET", path: `/v1/events?after=${Math.max(0, Math.floor(after))}&wait=${wait}`, timeout: wait + 5000 });
      if (!r.data) throw new Error((r.error && r.error.message) || "vyre-core gave no events");
      return r.data;
    },
    /** @param {string} tool @param {any} input */
    async challenge(tool, input) {
      const r = await coreTool("presence.challenge", { tool, input }, { socket });
      return r.data || { error: r.error || { code: "core_unreachable", message: "vyre-core gave no challenge" } };
    },
  };
}
