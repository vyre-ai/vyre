// @ts-check
// client — how anything on this machine talks to vyred: the CLI, the Harness hooks, the Capsule.

import crypto from "node:crypto";
import http from "node:http";
import * as config from "../config/index.js";

/**
 * One request to vyred over its socket. Resolves to the parsed { data } or { error } body, or to
 * { error: { code: "unreachable" } } when Vyre is not running, so callers can degrade instead
 * of throwing. The Harness hooks rely on that: no vyred means Claude Code behaves as if Vyre
 * were not installed. `opts.headers` adds headers, such as a presence proof; the caller header
 * and the body's own headers win on a clash.
 * @param {string} method @param {string} path @param {any} [payload]
 * @param {{ root?: string, caller?: string, timeout?: number, session?: { id: string, key: string } | null, headers?: Record<string, string>, socket?: string }} [opts]
 */
export function request(method, path, payload, { root, caller = "cli", timeout = 10_000, session = null, headers = {}, socket } = {}) {
  // Inside a session Vyre started, VYRE_SOCKET is that session's own socket (ADR 0030 phase 3):
  // vyred binds the caller there, so what this says it is changes nothing. An explicit root or
  // socket wins, so a test or a CLI aimed at another home is never sent to the session's vyred.
  const socketPath = socket || (root === undefined && process.env.VYRE_SOCKET) || config.paths(root ?? config.home()).socket;
  return new Promise(resolve => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    // agent: false, so no connection is pooled. A pooled one outlives a vyred restart, and the
    // first call after it fails as "unreachable" although the new vyred is up.
    // A caller naming an agent proves it with the key its thread was started with (see vyred's route).
    const key = /(?:^|[\s:])agent:/.test(caller) && process.env.VYRE_AGENT_KEY ? { "x-vyre-agent-key": process.env.VYRE_AGENT_KEY } : {};
    // A caller in a bound session says which one, with the key its SessionStart hook was given.
    const bound = session && session.id && session.key ? { "x-vyre-session": session.id, "x-vyre-session-key": session.key } : {};
    const req = http.request({ socketPath, path, method, timeout, agent: false,
      headers: { ...headers, "content-type": "application/json", "x-vyre-caller": caller, ...key, ...bound, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ error: { code: "bad_response", message: raw.slice(0, 200) } }); } });
    });
    req.on("error", () => resolve({ error: { code: "unreachable", message: "Vyre is not running" } }));
    req.on("timeout", () => { req.destroy(); resolve({ error: { code: "timeout", message: `Vyre did not answer within ${timeout}ms` } }); });
    if (data) req.write(data);
    req.end();
  });
}

export const call = (tool, input = {}, opts) => request("POST", "/v1/tools/" + encodeURIComponent(tool), input, opts);

/** Answers that mean "not now", not "no": the same write is tried again with the same key. */
const LATER = new Set(["unreachable", "timeout", "restarting"]);

/**
 * A call that changes something, made once (docs/adr/0029-resilience.md, R2). It carries an
 * Idempotency-Key, and if vyred is unreachable, too slow or restarting it tries again with the
 * same key for up to `patience` ms, so a vyred restart mid-send delivers the words once instead
 * of failing or sending them twice. One call of write() is one intent: a second send is a new
 * write() and gets a new key.
 * @param {string} tool @param {any} [input]
 * @param {Parameters<typeof request>[3] & { key?: string, patience?: number }} [opts]
 */
export async function write(tool, input = {}, { key = crypto.randomUUID(), patience = 20_000, headers = {}, ...opts } = {}) {
  const t0 = Date.now();
  let pause = 250;
  for (;;) {
    const r = await call(tool, input, { ...opts, headers: { ...headers, "idempotency-key": key } });
    if (!r.error || !LATER.has(r.error.code) || Date.now() - t0 + pause > patience) return r;
    await new Promise(res => setTimeout(res, pause));
    pause = Math.min(pause * 2, 2_000);
  }
}
