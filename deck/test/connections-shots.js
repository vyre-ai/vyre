// @ts-check
// A screenshot of Settings, Connections, with no vyred: a plain server on 127.0.0.1 (port 0) serves
// deck/ and answers /v1/tools/* from deck/fixtures/connections.json, then deck/test/shoot.js takes
// the shot in headless Chrome. Every other tool answers no_such_tool, so the rest of Settings
// shows its own empty states. A test helper, not part of the product.
//
//   node deck/test/connections-shots.js <out-dir>     writes connections.png (and -phone.png)

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || ".");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(DECK, "fixtures", "connections.json"), "utf8"));
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const fresh = v => typeof v === "string" ? (m => (m ? Date.now() - Number(m[1]) * UNIT[m[2]] : v))(/^\$ago:(\d+)([smhd])$/.exec(v))
  : Array.isArray(v) ? v.map(fresh) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fresh(x)])) : v;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const send = (status, body, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (url.pathname.startsWith("/v1/tools/") && req.method === "POST") {
    let b = "";
    req.on("data", c => (b += c));
    req.on("end", () => {
      const tool = decodeURIComponent(url.pathname.slice(10));
      const input = (() => { try { return JSON.parse(b || "{}"); } catch { return {}; } })();
      const src = FIXTURE[tool];
      if (src === undefined) return send(404, JSON.stringify({ error: { code: "no_such_tool", message: `no tool ${tool}` } }));
      const data = src && typeof src === "object" && "$by" in src ? (src.cases[input[src.$by]] ?? src.cases["*"]) : src;
      send(200, JSON.stringify({ data: fresh(data) }));
    });
    return;
  }
  if (url.pathname === "/v1/modules") return send(200, JSON.stringify({ data: [] }));
  if (url.pathname.startsWith("/v1/")) return send(404, JSON.stringify({ error: { code: "no_such_tool", message: "not here" } }));
  const file = path.join(DECK, path.normalize(url.pathname).replace(/^\/+/, ""));
  if (file.startsWith(DECK + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
  send(200, fs.readFileSync(path.join(DECK, "index.html")), "text/html");
});

await new Promise(r => server.listen(0, "127.0.0.1", () => r(null)));
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/settings#connections`;
// Open the tracker's tool list, so the shot shows which tools are held.
const script = `document.querySelector("#connections").scrollIntoView({ block: "start" }); await wait(300);
  document.querySelector('[data-server="tracker"] button[data-act="test"]').click(); await wait(600);
  document.querySelector('[data-account="work"] button[data-act="test"]').click(); await wait(600);
  document.querySelector("#connections").scrollIntoView({ block: "start" });`;
// Async, not spawnSync: this process is the server the shot's page talks to.
const shoot = (name, w, hgt) => new Promise(r => spawn(process.execPath, [path.join(DECK, "test", "shoot.js"), path.join(out, name), base, String(w), String(hgt), script],
  { stdio: "inherit" }).on("exit", r));
fs.mkdirSync(out, { recursive: true });
await shoot("connections.png", 1440, 1800);
await shoot("connections-phone.png", 390, 2400);
server.close();
