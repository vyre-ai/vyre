// @ts-check
// node: the transports stream.js and outbox.js take, for Node callers. A base is either
// "unix:<socket path>" (the CLI and the Capsule on the same machine as vyred) or an http(s) URL
// (a path over the LAN, the tailnet or the relay). No connection pooling: a pooled socket from
// before a vyred restart fails the first call after it, which reads as "unreachable".

import http from "node:http";
import https from "node:https";

/**
 * @param {string} base @param {string} path
 * @returns {{ mod: typeof http | typeof https, opts: http.RequestOptions }}
 */
function target(base, path) {
  if (base.startsWith("unix:")) return { mod: http, opts: { socketPath: base.slice(5), path } };
  const u = new URL(path, base);
  return { mod: u.protocol === "https:" ? https : http, opts: { hostname: u.hostname, port: u.port, path: u.pathname + u.search } };
}

/** @type {import("./stream.js").Open} */
export function open({ base, path, headers, signal }) {
  return new Promise((resolve, reject) => {
    const { mod, opts } = target(base, path);
    const req = mod.request({ ...opts, method: "GET", headers, agent: false, signal }, res => {
      res.setEncoding("utf8");
      resolve({ status: res.statusCode || 0, chunks: res });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * One tool call with its Idempotency-Key, answered the registry's way ({ data } | { error }) and
 * never thrown: a transport failure is `unreachable`, which the outbox retries.
 * @param {string} base
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [o]
 * @returns {(tool: string, input: any, key: string) => Promise<{ data?: any, error?: { code: string, message: string } }>}
 */
export function caller(base, { headers = {}, timeoutMs = 15_000 } = {}) {
  return (tool, input, key) => new Promise(resolve => {
    const { mod, opts } = target(base, "/v1/tools/" + encodeURIComponent(tool));
    const body = JSON.stringify(input ?? {});
    const req = mod.request({ ...opts, method: "POST", agent: false, timeout: timeoutMs,
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...headers } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ error: { code: "unreachable", message: `vyred answered ${res.statusCode} with no JSON` } }); }
      });
      res.on("error", e => resolve({ error: { code: "unreachable", message: e.message } }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", e => resolve({ error: { code: "unreachable", message: e.message } }));
    req.end(body);
  });
}
