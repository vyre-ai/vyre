// @ts-check
// identity/login-listener: the box's side of POST /login (sign in from any device). Loopback only; the public gate carries the request from <space>.vyre.run (core/wink/control/gate.js).
// A JSON body of at most 4 KB read within 5 seconds, one request per connection. The answer carries Access-Control-Allow-Origin for an origin on the hosted list (web.vyre.run), and for none other.
// The source of a request is the first x-forwarded-for entry when the peer is the gate on loopback; that address is what the rate limits count.
import http from "node:http";

export const PATH = "/login";
const LIMIT = 4 * 1024, READ_MS = 5_000;

/**
 * @param {{ host?: string, port?: number, origins: () => string[], handle: (op: any, source: string) => Promise<{ status: number, body: any }> }} o
 */
export function listen({ host = "127.0.0.1", port = 0, origins, handle }) {
  const server = http.createServer({ maxHeaderSize: 8 * 1024, requestTimeout: READ_MS, headersTimeout: READ_MS }, (req, res) => {
    const origin = String(req.headers.origin || "").toLowerCase().replace(/\/+$/, "");
    const cors = origin && origins().includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };
    const send = (/** @type {number} */ code, /** @type {any} */ body) => {
      if (res.headersSent) return;
      const text = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(code, { "content-length": String(Buffer.byteLength(text)), "cache-control": "no-store", connection: "close", ...(text ? { "content-type": "application/json" } : {}), ...cors });
      res.end(text);
    };
    if (String(req.url || "").split("?")[0] !== PATH) return send(404);
    if (req.method !== "POST") return send(405);
    /** @type {Buffer[]} */ const chunks = []; let n = 0, over = false;
    req.on("data", c => { n += c.length; if (n > LIMIT) { over = true; req.destroy(); } else chunks.push(c); });
    req.on("error", () => {});
    req.on("end", async () => {
      if (over) return;
      const peer = String(req.socket.remoteAddress || "");
      const fwd = /^(::1|127\.|::ffff:127\.)/.test(peer) ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
      let op;
      try { op = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: { code: "bad_input", message: "That request was not understood." } }); }
      if (!op || typeof op !== "object" || Array.isArray(op)) return send(400, { error: { code: "bad_input", message: "That request was not understood." } });
      try { const r = await handle(op, fwd || peer); send(r.status, r.body); } catch { send(500, { error: { code: "failed", message: "Sign-in did not work. Try again in a minute." } }); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({ server, port: a.port, url: `http://${host}:${a.port}${PATH}`, close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }) });
    });
  });
}
