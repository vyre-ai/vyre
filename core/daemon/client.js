// @ts-check
// client — how anything on this machine talks to vyred: the CLI, the Harness hooks, the Capsule.

import http from "node:http";
import * as config from "../config/index.js";

/**
 * One request to vyred over its socket. Resolves to the parsed { data } or { error } body, or to
 * { error: { code: "unreachable" } } when vyred is not running, so callers can degrade instead
 * of throwing. The Harness hooks rely on that: no vyred means Claude Code behaves as if Vyre
 * were not installed.
 * @param {string} method @param {string} path @param {any} [payload]
 * @param {{ root?: string, caller?: string, timeout?: number, session?: { id: string, key: string } | null }} [opts]
 */
export function request(method, path, payload, { root = config.home(), caller = "cli", timeout = 10_000, session = null } = {}) {
  const socketPath = config.paths(root).socket;
  return new Promise(resolve => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    // agent: false, so no connection is pooled. A pooled one outlives a vyred restart, and the
    // first call after it fails as "unreachable" although the new vyred is up.
    // A caller naming an agent proves it with the key its thread was started with (see vyred's route).
    const key = /(?:^|[\s:])agent:/.test(caller) && process.env.VYRE_AGENT_KEY ? { "x-vyre-agent-key": process.env.VYRE_AGENT_KEY } : {};
    // A caller in a bound session says which one, with the key its SessionStart hook was given.
    const bound = session && session.id && session.key ? { "x-vyre-session": session.id, "x-vyre-session-key": session.key } : {};
    const req = http.request({ socketPath, path, method, timeout, agent: false,
      headers: { "content-type": "application/json", "x-vyre-caller": caller, ...key, ...bound, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ error: { code: "bad_response", message: raw.slice(0, 200) } }); } });
    });
    req.on("error", () => resolve({ error: { code: "unreachable", message: "vyred is not running" } }));
    req.on("timeout", () => { req.destroy(); resolve({ error: { code: "timeout", message: `vyred did not answer within ${timeout}ms` } }); });
    if (data) req.write(data);
    req.end();
  });
}

export const call = (tool, input = {}, opts) => request("POST", "/v1/tools/" + encodeURIComponent(tool), input, opts);
