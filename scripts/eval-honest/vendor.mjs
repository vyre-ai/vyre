// @ts-check
// The fake vendor (Acme and Orbit) the evals call: a plain HTTP service on this machine. For the honest eval it runs as its OWN PROCESS (`node vendor.mjs --key K`, which prints "PORT <n>"), so a plain
// Claude Code run that curls it never depends on the daemon's event loop (a run 1 hang showed the in-process one stop answering while the daemon was busy). Every request is logged
// ("METHOD /path?query") for the checks; /__hits reads the log, /__reset clears it, /__hit adds a line (the reset proof). The control paths need no key and are for this machine only.
import http from "node:http";
import { fileURLToPath } from "node:url";

/** @param {string} key @returns {{ server: http.Server, hits: string[] }} */
export function makeVendor(key) {
  /** @type {string[]} */ const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const send = (/** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(body)); };
    // A request body is read and dropped, so a POST in flight never holds the socket.
    req.resume();
    if (url.pathname === "/__hits") return send(200, hits);
    if (url.pathname === "/__reset") { hits.length = 0; return send(200, { ok: true }); }
    if (url.pathname === "/__hit") { hits.push(String(url.searchParams.get("line") || "")); return send(200, { ok: true }); }
    hits.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: "bad key" });
    if (url.pathname === "/v1/status") return send(200, { status: "ok", service: "acme" });
    if (url.pathname === "/v1/customers") return send(200, { data: [{ id: "cus_1", name: "Test Customer" }].slice(0, Number(url.searchParams.get("limit") || 10)), has_more: false });
    if (url.pathname === "/v1/notes" && req.method === "POST") return send(200, { id: "note_1" });
    return send(404, { error: "not found" });
  });
  server.keepAliveTimeout = 1000;
  return { server, hits };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--key");
  const { server } = makeVendor(i >= 0 ? process.argv[i + 1] : "fixture-acme-key-0001");
  server.listen(0, "127.0.0.1", () => console.log(`PORT ${/** @type {any} */ (server.address()).port}`));
  process.on("disconnect", () => process.exit(0));
}
