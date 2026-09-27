// @ts-check
// A screenshot of Settings, Connections, with no vyred: a plain server on 127.0.0.1 (port 0) serves
// deck/ and answers /v1/tools/* from deck/fixtures/connections.json, then deck/test/shoot.js takes
// the shot in headless Chrome. Every other tool answers no_such_tool, so the rest of Settings
// shows its own empty states. A test helper, not part of the product.
//
//   node deck/test/connections-shots.js <out-dir> [form]
//
// With no form: connections.png and connections-phone.png, the list with the tracker's tools and
// the work account's test open (its admin console block included). With a form, the Add a Google
// account form in that mode, at desktop and phone width: signin, waiting (after pressing Sign in
// with Google, with window.open stubbed to a stand-in tab so nothing goes to Google), or
// service-account. waiting-blocked is the same with window.open returning null.
// "all" takes every one.

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
const list = `document.querySelector("#connections").scrollIntoView({ block: "start" }); await wait(300);
  document.querySelector('[data-server="tracker"] button[data-act="test"]').click(); await wait(600);
  document.querySelector('[data-account="work"] button[data-act="test"]').click(); await wait(600);
  document.querySelector("#connections").scrollIntoView({ block: "start" });`;
// The Google form in one mode. The waiting shot gives the page a stand-in tab, so nothing is
// opened or sent to Google, and the panel shows as it does when the tab opened.
const fakeTab = `const fake = { opener: null, closed: false, location: { href: "" }, close() { this.closed = true; } };`;
// The Google form in one mode. northwind-google is already granted to google, so no passkey sheet.
const form = mode => `${fakeTab} document.querySelector("#connections").scrollIntoView({ block: "start" }); await wait(300);
  click('[data-act="add-google"]'); await wait(600);
  const f = document.querySelector('form[data-form="google"]');
  ${mode === "service-account" ? `click('[data-auth="service-account"]'); await wait(100);` : ""}
  f.querySelector("#cg-name").value = "${mode === "service-account" ? "work" : "dana"}";
  ${mode === "service-account" ? `f.querySelector("#cg-email").value = "alex@harlowlegal.com";` : ""}
  const it = f.querySelector("#cg-item"); it.value = "${mode === "service-account" ? "harlow-google-sa" : "northwind-google"}"; it.dispatchEvent(new Event("change"));
  ${mode === "waiting" ? `window.open = () => fake; f.requestSubmit(); await wait(800);` : ""}
  document.querySelector('[data-form="google"]').scrollIntoView({ block: "start" }); await wait(200);`;
const SHOTS = { "": list, signin: form("signin"), waiting: form("waiting"),
  "waiting-blocked": form("waiting").replace("window.open = () => fake;", "window.open = () => null;"), "service-account": form("service-account") };
const want = process.argv[3] || "";
if (want !== "all" && !(want in SHOTS)) { console.error(`form is one of ${Object.keys(SHOTS).filter(Boolean).join(", ")}, or all`); process.exit(2); }

// Async, not spawnSync: this process is the server the shot's page talks to.
const shoot = (name, w, hgt, script) => new Promise(r => spawn(process.execPath, [path.join(DECK, "test", "shoot.js"), path.join(out, name), base, String(w), String(hgt), script],
  { stdio: "inherit" }).on("exit", r));
fs.mkdirSync(out, { recursive: true });
for (const [mode, script] of Object.entries(SHOTS)) {
  if (want !== "all" && mode !== want) continue;
  const stem = mode ? `connections-${mode}` : "connections";
  await shoot(`${stem}.png`, 1440, mode ? 1000 : 1800, script);
  await shoot(`${stem}-phone.png`, 390, mode ? 1400 : 2400, script);
}
server.close();
