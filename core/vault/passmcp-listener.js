// @ts-check
// core/vault/passmcp-listener.js: the HTTP side of the Vault MCP (passmcp.js). POST /vault-mcp only; a JSON body of at most 64 KB read within 5 seconds; one request per connection; everything else is a bare
// 404 or 405. It binds where it is told (loopback unless the owner says otherwise); whatever carries it to the internet (the relay) reaches that address. The source of a request is the peer address, or the
// first x-forwarded-for entry when the peer is loopback (the relay in front of it), and is what the lockout counts.

import http from "node:http";

const LIMIT = 64 * 1024, READ_MS = 5_000;

/** @param {{ host: string, port: number, handle: (q: { method: string, headers: Record<string, any>, body: string, source: string }) => Promise<{ status: number, body?: any, headers?: Record<string, string> }> }} o */
export function listenMcp({ host, port, handle }) {
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: READ_MS, headersTimeout: READ_MS }, (req, res) => {
    const send = (/** @type {number} */ code, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => {
      if (res.headersSent) return;
      const text = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(code, { "content-length": String(Buffer.byteLength(text)), "cache-control": "no-store", connection: "close", ...(text ? { "content-type": "application/json" } : {}), ...headers });
      res.end(text);
    };
    if (String(req.url || "").split("?")[0] !== "/vault-mcp") return send(404);
    if (req.method !== "POST") return send(405);
    /** @type {Buffer[]} */ const chunks = []; let n = 0, over = false;
    req.on("data", c => { n += c.length; if (n > LIMIT) { over = true; req.destroy(); } else chunks.push(c); });
    req.on("error", () => {});
    req.on("end", async () => {
      if (over) return;
      const peer = String(req.socket.remoteAddress || "");
      const fwd = /^(::1|127\.|::ffff:127\.)/.test(peer) ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
      try {
        const r = await handle({ method: "POST", headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), source: fwd || peer });
        send(r.status, r.body, r.headers);
      } catch { send(500); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({ server, port: a.port, url: `http://${host}:${a.port}/vault-mcp`, close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }) });
    });
  });
}
