// @ts-check
// The lender's door to Vyre for a chat's session (contracts/lent-spawn.md, lent.http). The session's Vyre MCP server speaks to "vyred" over a unix socket (VYRE_SOCKET); on a lent computer that socket is this one, in the
// runner, and every tool call it carries goes to the Space's home as the wire call `lent.http`, where it is the chat's session's own call (the same caller binding and kernel credential as on the box). Only
// POST /v1/tools/<name> is carried; nothing here knows what a tool is or decides who may call it: the home does, exactly as it does for a session on the box.
import fs from "node:fs";
import http from "node:http";

const MAX_BODY = 128 * 1024;

/**
 * @param {{ socket: string, call: (r: { method: "GET" | "POST", path: string, body: string, caller: string }) => Promise<{ status: number, body: string }> }} o
 * @returns {Promise<{ socket: string, close: () => Promise<void> }>}
 */
export async function openVyreDoor(o) {
  const say = (/** @type {any} */ res, /** @type {number} */ status, /** @type {string} */ body) => { res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); };
  const err = (/** @type {any} */ res, /** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) => say(res, status, JSON.stringify({ error: { code, message } }));
  const server = http.createServer((req, res) => {
    const get = req.method === "GET" && req.url === "/v1/tools";
    if (!get && (req.method !== "POST" || !/^\/v1\/tools\/[A-Za-z0-9._%-]{1,140}$/.test(String(req.url || "")))) return err(res, 404, "not_found", "this door carries tool calls only");
    const parts = /** @type {Buffer[]} */ ([]); let n = 0, over = false;
    req.on("data", c => { n += c.length; if (n > MAX_BODY) { over = true; req.destroy(); } else parts.push(c); });
    req.on("error", () => {});
    req.on("end", async () => {
      if (over) return err(res, 413, "too_large", "that request is too large");
      const caller = String(req.headers["x-vyre-caller"] || "").startsWith("harness") ? "harness" : "mcp";
      try { const r = await o.call({ method: get ? "GET" : "POST", path: String(req.url), body: get ? "" : Buffer.concat(parts).toString("utf8") || "{}", caller }); say(res, r.status, r.body); }
      catch (e) {
        const code = String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "");
        err(res, code === "conflict" || code === "not_found" ? 410 : 502, code === "conflict" || code === "not_found" ? "moved" : "unreachable", code === "conflict" || code === "not_found" ? "this session is not on this computer any more" : "the Space's home did not answer");
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(o.socket, () => resolve(undefined)); });
  fs.chmodSync(o.socket, 0o600);
  return { socket: o.socket, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => { try { fs.rmSync(o.socket, { force: true }); } catch { /* gone */ } r(undefined); }); }) };
}
