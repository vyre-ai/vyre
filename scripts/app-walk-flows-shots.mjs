#!/usr/bin/env node
// app-walk-flows-shots: screenshots of a Flow with parallel lanes and a sub-flow (its canvas, and its run history while a lane waits for the owner) at 1440 and 390 wide, light and dark. TEST BOX ONLY.
// It starts a vyred of its own in a temp home (kernel on), defines and runs the two Flows, serves a web export of the app in front of it and drives a browser.
//   node scripts/app-walk-flows-shots.mjs --dist apps/app/dist [--out dir]
import "./mac-test-guard.mjs";
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
const OUT = path.resolve(flag("--out", "flows-shots"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-flows-shots-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const space = d.kernel.id.space, owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
// two Flows: a sub-flow, and one that splits into two lanes (one waits for the owner), runs the sub-flow in the other and goes on after the join
const host = d.registry.deps.flowsHost.get(space);
const install = async (flow) => { const r = await d.registry.call("flows.define", { flow }, "cli", { token: TOKEN }); if (!r.data || !r.data.ok) throw new Error(JSON.stringify(r)); await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash }); return r.data; };
await d.kernel.gateway.records.define(ownerChain, { add_types: [{ name: "filing-note", label: "Filing note", fields: [{ name: "body", kind: "text", label: "Body" }] }] });
await install({ format: 1, name: "inner_note", label: "Write the inner note", authorship: "human", trigger: { on: "manual" }, returns: { body: { expr: "steps.c.record.data.body" } }, steps: [{ id: "c", kind: "create", type: "filing-note", set: { body: "inner" } }] });
const outer = await install({ format: 1, name: "file_it", label: "File it", authorship: "human", trigger: { on: "manual" }, steps: [
  { id: "p", kind: "parallel", steps: [
    { id: "review", kind: "branch", steps: [{ id: "look", kind: "assign", to: `person:${owner}`, title: "Look it over", output: { kind: "decision" }, how: "person", await: true }] },
    { id: "draft", kind: "branch", steps: [{ id: "s", kind: "subflow", flow: "inner_note" }] },
  ] },
  { id: "after", kind: "create", type: "filing-note", set: { body: { expr: "\"after: \" + steps.s.result.body" } } },
] });
await host.flows.tools["flows.start"](host.personChain(), { id: outer.id, input: {} });
await new Promise((r) => setTimeout(r, 4000));
const FLOW_ID = outer.id;
if (process.env.DEBUGRUN) { const rr = await call("flows.runs", { id: FLOW_ID }).catch((e) => ({ e: String(e) })); console.log("runs:", JSON.stringify(rr).slice(0, 300)); const rid = (Array.isArray(rr) ? rr : []).find((x) => !x.parent)?.id; if (rid) console.log("describe:", JSON.stringify(await call("flows.describe", { run: rid }).catch((e) => ({ e: String(e) }))).slice(0, 600)); }

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
        const tool = decodeURIComponent(u.pathname.slice("/v1/tools/".length));
        const r = await d.registry.call(tool, input, "cli", { token: TOKEN });
        if (r.error) console.log("tool error:", tool, r.error.code, String(r.error.message).slice(0, 160));
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
const SIZES = [["1440", { width: 1440, height: 1100 }], ["390", { width: 390, height: 1400 }]];
for (const scheme of ["light", "dark"]) for (const [label, viewport] of SIZES) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  const pg = await ctx.newPage();
  pg.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text().slice(0, 200)); });
  pg.on("response", (r) => { if (r.status() === 404) console.log("404:", r.url().slice(0, 160)); });
  pg.on("response", async (r) => { if (/flows\.describe/.test(r.url())) console.log("describe response:", r.status(), (await r.text().catch(() => "")).slice(0, 200)); });
  pg.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 200)));
  await pg.goto(`${BASE}/u/flows`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(3500);
  await pg.screenshot({ path: path.join(OUT, `flows-${label}-${scheme}.png`), fullPage: true });
  await pg.goto(`${BASE}/u/flows/${FLOW_ID}`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(5000);
  const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
  console.log(`flow-${label}-${scheme}:`, text);
  await pg.screenshot({ path: path.join(OUT, `flow-${label}-${scheme}.png`), fullPage: true });
  // t3: pick a run and the box explains it in plain words
  await pg.getByText(/^Run of /).first().click().catch((e) => console.log("no run row:", e.message.slice(0, 80)));
  await pg.waitForTimeout(3000);
  const explained = await pg.getByText("Explain this run", { exact: true }).count();
  console.log(`explain-${label}-${scheme}: ${explained ? "shown" : "NOT shown"}: ${(await pg.locator("body").innerText()).replace(/\s+/g, " ").match(/Explain this run.{0,200}/)?.[0] ?? ""}`);
  await pg.screenshot({ path: path.join(OUT, `t3-explain-run-${label}-${scheme}.png`), fullPage: true });
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(0);
