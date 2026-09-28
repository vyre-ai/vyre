// @ts-check
// lib/vyre-core-client: the one way vyred, the CLI and the Capsule's JS side talk to vyre-core
// (ADR 0040 section 3). Pure, no feature state: HTTP over vyre-core's unix socket, { data } or
// { error } back, never a throw for an answer core gave.
//
// Who connects matters, not what the client says: core checks the connecting process itself. So
// a privileged write goes from the originating client (CLI, Capsule) straight to core, with its
// proof in `presence`; vyred uses this only to proxy reads open to any owner-uid caller.

import http from "node:http";

export const DEFAULT_SOCKET = "/var/run/vyre-core.sock";

/**
 * One call to vyre-core.
 * @param {{ socket?: string, method?: "GET"|"POST", path: string, body?: any, presence?: string, timeout?: number }} o
 *   presence: the x-vyre-presence header for a write.
 * @returns {Promise<{ data?: any, error?: { code: string, message: string, methods?: string[] }, status?: number }>}
 */
export function coreCall({ socket = DEFAULT_SOCKET, method = "POST", path, body, presence, timeout = 10_000 }) {
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
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error("vyre-core didn't answer in time"), { code: "timeout" })));
    req.on("error", e => resolve({ error: { code: /** @type {any} */ (e).code === "ENOENT" || /** @type {any} */ (e).code === "ECONNREFUSED" ? "core_unavailable" : "core_unreachable", message: e.message } }));
    if (text !== undefined) req.write(text);
    req.end();
  });
}

/** A tool on vyre-core. @param {string} tool @param {any} input @param {{ socket?: string, presence?: string }} [o] */
export const coreTool = (tool, input, o = {}) => coreCall({ ...o, path: `/v1/tools/${encodeURIComponent(tool)}`, body: input });

/** Whether vyre-core answers here: { name, protocol, version } or null. @param {string} [socket] */
export async function coreHello(socket = DEFAULT_SOCKET) {
  const r = await coreCall({ socket, method: "GET", path: "/v1/hello", timeout: 2000 });
  return r.data && r.data.name === "vyre-core" ? r.data : null;
}
