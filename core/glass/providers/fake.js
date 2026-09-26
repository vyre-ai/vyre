// @ts-check
// fake: a stand-in computerd for tests, serving the /fs contract in providers/computer.js from
// a temp folder through the same LocalTree the box uses. It checks the bearer token, so a test
// can see that the provider sends it, and it records each route it served.
//
// Not loaded by the module; tests import it.

import http from "node:http";
import { LocalTree } from "./box.js";

/**
 * Start a fake computerd on 127.0.0.1 over `dir`. Resolves with its URL, the token it wants,
 * what it served, and close().
 * @param {string} dir @param {{ token?: string }} [opts]
 */
export async function fakeComputerd(dir, opts = {}) {
  const token = opts.token || "fake-helper-token-0123";
  const tree = new LocalTree(dir);
  /** @type {string[]} */
  const served = [];
  const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const fail = (res, e) => {
    const code = e.code || "failed";
    const status = code === "exists" ? 409 : code === "too_large" ? 413 : code === "range" ? 416 : code === "wrong_size" ? 400 : /does not exist/.test(e.message) ? 404 : /private|outside|climbs|absolute/.test(e.message) ? 403 : 400;
    send(res, status, { error: { code, message: e.message } });
  };
  const readJson = async req => { let raw = ""; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://computerd");
    served.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: { code: "denied", message: "bad token" } });
    const p = url.searchParams.get("path") || "";
    try {
      if (req.method === "GET" && url.pathname === "/fs/list") return send(res, 200, await tree.list(p));
      if (req.method === "GET" && url.pathname === "/fs/stat") return send(res, 200, await tree.stat(p));
      if (req.method === "GET" && url.pathname === "/fs/read") {
        const r = await tree.read(p, req.headers.range);
        const length = r.total ? r.end - r.start + 1 : 0;
        res.writeHead(r.partial ? 206 : 200, { "content-type": "application/octet-stream", "content-length": String(length),
          ...(r.partial ? { "content-range": `bytes ${r.start}-${r.end}/${r.total}` } : {}) });
        r.stream.pipe(res);
        return;
      }
      if (req.method === "PUT" && url.pathname === "/fs/write") {
        const r = await tree.write(p, req, { size: Number(url.searchParams.get("size")), overwrite: url.searchParams.get("overwrite") === "1" });
        return send(res, 200, r);
      }
      if (req.method === "POST" && url.pathname === "/fs/move") { const b = await readJson(req); await tree.move(b.from, b.to); return send(res, 200, { moved: true }); }
      if (req.method === "POST" && url.pathname === "/fs/mkdir") { const b = await readJson(req); await tree.mkdir(b.path); return send(res, 200, { created: true }); }
      if (req.method === "POST" && url.pathname === "/fs/trash") { const b = await readJson(req); return send(res, 200, await tree.trash(b.path)); }
      return send(res, 404, { error: { code: "not_found", message: url.pathname } });
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else res.destroy();
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${addr.port}`, token, served, tree,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }),
  };
}
