// @ts-check
// First-load proof in a real browser: a fresh Chrome profile opens a page that runs the loader's own
// adopt.js (sealed in the built loader tree and checked by the real sw.js at install) against a
// real release.js build. The build's entry then asks for /app/assets/ files at run time, the way
// the Expo app asks for its fonts and icons. Passes only when, on that very first load, the
// service worker controls the page, adopts the build, and every /app request returns 200 with the
// exact bytes, while a file the manifest does not list stays a 404. The box handshake
// (relay.web.release) is not part of this proof; the page supplies the sha and manifest hash a box
// would. Run on a throwaway runner with CHROME set (stable, for WebCrypto Ed25519), never a Mac.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { keygen, build, loader } from "../release.js";
import worker from "../worker.js";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("set CHROME to a Chrome binary"); process.exit(3); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-boot-"));
const key = path.join(tmp, "release.key");
keygen(key);
const out = path.join(tmp, "out");
await loader({ release: "1.0.0", key, out });

const FONT = Buffer.from("wOF2-fake-font-bytes-" + "x".repeat(200));
const ICON = Buffer.from("\x89PNG-fake-icon-bytes-" + "y".repeat(120), "latin1");
const dist = path.join(tmp, "dist");
fs.mkdirSync(path.join(dist, "_expo/static/js/web"), { recursive: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "assets/font.woff2"), FONT);
fs.writeFileSync(path.join(dist, "assets/icon.png"), ICON);
fs.writeFileSync(path.join(dist, "_expo/static/js/web/entry.js"), `(async () => {
  const get = async p => { const r = await fetch(p); return { status: r.status, bytes: r.status === 200 ? Array.from(new Uint8Array(await r.arrayBuffer())).length : 0 }; };
  const result = { font: await get("/app/assets/font.woff2"), icon: await get("/app/assets/icon.png"), unlisted: await get("/app/assets/nope.png"), controlled: !!navigator.serviceWorker.controller };
  await fetch("/__report", { method: "POST", body: JSON.stringify({ stage: "app", result }) });
})();`);
fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html><div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script>`);
const built = await build({ dist, release: "0.4.2", key, out });
const sha = built.sha;
const manifestHex = built.manifest;

const page = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { registerWorker, adoptInWorker } from "/adopt.js";
const post = o => fetch("/__report", { method: "POST", body: JSON.stringify(o) });
post({ stage: "started" });
const t0 = performance.now();
const hadController = !!navigator.serviceWorker.controller;
const registered = registerWorker();
await adoptInWorker({ sha: ${JSON.stringify(sha)}, manifest: ${JSON.stringify(manifestHex)} }, registered);
await post({ stage: "adopted", hadControllerAtStart: hadController, controlledAfter: !!navigator.serviceWorker.controller, ms: Math.round(performance.now() - t0) });
const m = await (await fetch("/v/${sha}/release-manifest.json")).json();
for (const f of m.entry) { const s = document.createElement("script"); s.src = "/v/${sha}/" + f; s.integrity = m.files[f]; s.crossOrigin = "anonymous"; s.async = false; document.body.appendChild(s); }
</script>`;

/** @type {any[]} */
const reports = [];
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8", ".css": "text/css", ".json": "application/json" };
const env = { ASSETS: { fetch: async req => {
  const p = new URL(req.url).pathname;
  const f = path.join(out, p === "/" ? "index.html" : p);
  return f.startsWith(out) && fs.existsSync(f) && fs.statSync(f).isFile() ? new Response(fs.readFileSync(f), { headers: { "content-type": TYPES[path.extname(f)] || "application/octet-stream" } }) : new Response("missing", { status: 404 });
} } };
const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, "http://localhost");
  console.log("request", rq.method, rq.url);
  if (url.pathname === "/__report") { let b = ""; for await (const c of rq) b += c; reports.push(JSON.parse(b)); rs.end("ok"); return; }
  if (url.pathname === "/boot.html") { rs.setHeader("content-type", "text/html"); rs.end(page); return; }
  const r = await worker.fetch(new Request(`http://localhost:${port}${rq.url}`), env);
  rs.writeHead(r.status, Object.fromEntries(r.headers)); rs.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
const port = /** @type {any} */ (server.address()).port;

// /adopt.js is served by the real Worker from the sealed loader tree; /boot.html is the harness page.
const c = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${path.join(tmp, "profile")}`, `http://localhost:${port}/boot.html`], { stdio: "ignore" });
const end = Date.now() + 60000;
while (!reports.some(r => r.stage === "app") && Date.now() < end) await new Promise(r => setTimeout(r, 300));
c.kill();
server.close();

const failures = [];
const adopted = reports.find(r => r.stage === "adopted");
const app = reports.find(r => r.stage === "app");
console.log(JSON.stringify({ adopted, app }, null, 2));
if (!adopted) failures.push("the page never finished adopting the build");
else {
  if (adopted.hadControllerAtStart) failures.push("not a first load: the page was already controlled");
  if (!adopted.controlledAfter) failures.push("the worker did not take control before the app started");
}
if (!app) failures.push("the app never ran");
else {
  const r = app.result;
  if (r.font.status !== 200 || r.font.bytes !== FONT.length) failures.push(`font: ${JSON.stringify(r.font)}`);
  if (r.icon.status !== 200 || r.icon.bytes !== ICON.length) failures.push(`icon: ${JSON.stringify(r.icon)}`);
  if (r.unlisted.status !== 404) failures.push(`an unlisted /app file answered ${r.unlisted.status}`);
}
if (failures.length) { console.log("FIRST LOAD DID NOT HOLD:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("First load: the worker took control, adopted the build, and served the /app font and icon with the exact bytes.");
fs.rmSync(tmp, { recursive: true, force: true });
