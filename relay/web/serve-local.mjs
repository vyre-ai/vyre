// @ts-check
// serve-local: runs relay/web/worker.js over a folder scripts/build-web-out.mjs laid out, on a local port, so the rehearsal can open the page in a
// browser with the very policy and headers web.vyre.run will send. A runner only, never a Mac.   node relay/web/serve-local.mjs web-out [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import worker from "./worker.js";

const dir = path.resolve(process.argv[2] || "web-out");
const TYPES = /** @type {Record<string, string>} */ ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".ico": "image/x-icon" });
const env = { ASSETS: { fetch: async (/** @type {Request} */ req) => {
  const f = path.join(dir, decodeURIComponent(new URL(req.url).pathname));
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(f), { headers: { "content-type": TYPES[path.extname(f)] || "application/octet-stream" } });
} } };
http.createServer(async (q, s) => {
  const r = await worker.fetch(new Request(`http://${q.headers.host}${q.url}`, { method: q.method }), env);
  s.writeHead(r.status, Object.fromEntries(r.headers));
  s.end(q.method === "HEAD" ? undefined : Buffer.from(await r.arrayBuffer()));
}).listen(Number(process.argv[3] || 8787), "127.0.0.1", () => console.log(`web-out on http://127.0.0.1:${process.argv[3] || 8787}`));
