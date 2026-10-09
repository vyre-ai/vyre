#!/usr/bin/env node
// app-walk-projects-shots: screenshots of the template studio and the project pages at 1440 and 390 wide, light and dark. TEST BOX ONLY. It starts a vyred of its own in a temp home (kernel on), seeds the
// Estate plan template, a project started from it (with its team, tasks, a file and a chat) and a free-flow project, serves a web export of the app in front of it and drives a browser.
//   node scripts/app-walk-projects-shots.mjs --dist apps/app/dist-shots [--out dir]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { start } from "../core/daemon/index.js";
import { paths } from "../core/config/index.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-shots"));
const OUT = path.resolve(flag("--out", "projects-shots"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-projects-shots-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const space = d.kernel.id.space, owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;                      // for the seeding calls
const COOKIE = d.registry.deps.cliSessions.startStandIn("projects-shots").token;           // the browser's own person session (the dev stand-in, this process only)
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
await call("agents.create", { name: "research", kind: "agent", projects: [], instructions: "Finds and reads the documents." });
await call("agents.create", { name: "drafting", kind: "agent", projects: [], instructions: "Drafts the trust and the will." });
for (const name of ["research", "drafting"]) {
  const actor = { kind: "agent", id: name, space };
  await d.kernel.gateway.grants.addActor(ownerChain, actor, { presence: proof("grants.role", { actor }, `vyre://${space}/member/${name}`) });
}
const lib = await call("work.template.install", { id: "law-firm/estate-plan" });
await call("work.template.golive", { template: lib.template, version: lib.version });
const started = await call("work.start-project", { template: lib.template, name: "Rivera Family Trust", repo: "" });
const plain = await call("work.project.create", { name: "Plain chats" });
const idOf = (urn) => String(urn).split("/").pop();
const tplId = idOf(started.project), plainId = idOf(plain.project);
const drive = d.kernel.gateway.drive;
if (drive) try { await drive.put(ownerChain, `Projects/${tplId}/files/Existing trust.pdf`, new TextEncoder().encode("%PDF stand-in")); await drive.put(ownerChain, `Projects/${tplId}/files/Deed.txt`, new TextEncoder().encode("deed")); } catch (e) { console.log("no file:", e.message); }
try {
  const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {});
  await call("work.chat.rename", { chat: chat.id, title: "Which documents are missing?" }).catch(() => {});
  await call("work.chat.move", { chat: chat.id, project: started.slug }).catch((e) => console.log("no chat move:", e.message));
} catch (e) { console.log("no chat:", e.message); }
await new Promise((r) => setTimeout(r, 1500));

// ---- the app in front of it
const SOCKET = paths(root).socket;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) {
    // the app's tool calls go straight to this process's registry as the owner's session (a socket client of a shell on this box is classed by where it runs, which a screenshot walk must not depend on)
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && u.pathname.startsWith("/v1/tools/")) {
      let raw = ""; req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        let input = {}; try { input = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
        const r = await d.registry.call(decodeURIComponent(u.pathname.slice("/v1/tools/".length)), input, "cli", { token: TOKEN });
        send(200, r.error ? { error: r.error } : { data: r.data });
      });
      return;
    }
    console.log("unserved:", req.method, u.pathname);
    return send(u.pathname === "/v1/health" ? 200 : 404, u.pathname === "/v1/health" ? { ok: true } : { error: { code: "not_found", message: "not served by the walk" } });
  }
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(DIST, p);
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const SIZES = [["1440", { width: 1440, height: 900 }], ["1920", { width: 1920, height: 1000 }], ["390", { width: 390, height: 844 }]];
for (const scheme of ["light", "dark"]) for (const [label, viewport] of SIZES) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  const pg = await ctx.newPage();
  const shot = async (name) => { await pg.waitForTimeout(3500); const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160); console.log(`${name}-${label}-${scheme}:`, text); await pg.screenshot({ path: path.join(OUT, `${name}-${label}-${scheme}.png`), fullPage: name === "studio-test" }); };
  if (label !== "1920") {
    await pg.goto(`${BASE}/u/templates`, { waitUntil: "domcontentloaded" }); await shot("templates");
    await pg.goto(`${BASE}/u/templates/${lib.template}`, { waitUntil: "domcontentloaded" }); await shot("studio");
    const test = pg.getByText("Test mode", { exact: true }).first(); if (await test.count()) { await test.click().catch(() => {}); await shot("studio-test"); }
    await pg.goto(`${BASE}/u/project/${plainId}`, { waitUntil: "domcontentloaded" }); await shot("project-free");
  }
  await pg.goto(`${BASE}/u/project/${tplId}`, { waitUntil: "domcontentloaded" }); await shot("project-template");
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(0);
