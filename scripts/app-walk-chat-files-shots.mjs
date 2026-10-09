#!/usr/bin/env node
// app-walk-chat-files-shots: screenshots of a chat's Files panel (made and received files, one shared, one previewed) at 1440 and 390 wide, light and dark. TEST BOX ONLY. It starts a vyred of its own in a temp home (kernel on), seeds the
// a chat with files, serves a web export of the app in front of it and drives a browser.
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
const OUT = path.resolve(flag("--out", "chat-files-shots"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-chat-files-shots-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const space = d.kernel.id.space, owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;                      // for the seeding calls
const COOKIE = d.registry.deps.cliSessions.startStandIn("chat-files-shots").token;           // the browser's own person session (the dev stand-in, this process only)
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {});
await call("work.chat.rename", { chat: chat.id, title: "Which documents are missing?" }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const rec = ((await d.kernel.gateway.records.query(ownerChain, "chat-record", { filter: { field: "chat", op: "eq", value: chat.id }, page: { limit: 1 } })).rows || [])[0];
const drive = d.kernel.gateway.drive, enc = (s) => new TextEncoder().encode(s);
const dir = `${rec.data.drive}/chat/${chat.id}`, made = `${rec.data.drive}/made/${chat.id}`;
await drive.put(ownerChain, `${dir}/Client intake notes.txt`, enc("Rivera, Maria. Widowed 2019. Two children. House in Raleigh, one brokerage account.\nWants a revocable trust and pour-over will.\nBeneficiaries: Ana and Luis, equal shares."));
await drive.put(ownerChain, `${dir}/Existing trust.pdf`, enc("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 24 90 Td (Rivera Family Trust, 2019) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF"));
await drive.put(ownerChain, `${made}/Document checklist.md`, enc("# Missing documents\n- Deed to the Raleigh house\n- Latest brokerage statement\n- Prior will, if any"));
await drive.put(ownerChain, `${made}/Family tree.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
await call("work.file.share", { path: `${made}/Document checklist.md` });
// Backups: the box's own Space is backed up, the team's Harbor Space is not (its owner has not turned backups on)
await d.kernel.spaces.host({ owner: "per_" + "c".repeat(26), name: "Harbor" });
await call("spaces.bundle.enrol", { code: "abcdefghijklmnopqrstuvwxyz" });
// a project with a history: started from the estate-plan template (its stage), tasks, mail and texts logged on it, a file shared, a chat about it
for (const name of ["research", "drafting"]) {
  await call("agents.create", { name, kind: "agent", projects: [], instructions: name === "research" ? "Finds and reads the documents." : "Drafts the trust and the will." });
  const actor = { kind: "agent", id: name, space: d.kernel.id.space };
  await d.kernel.gateway.grants.addActor(ownerChain, actor, { presence: proof("grants.role", { actor }, `vyre://${d.kernel.id.space}/member/${name}`) });
}
const lib = await call("work.template.install", { id: "law-firm/estate-plan" });
await call("work.template.golive", { template: lib.template, version: lib.version });
const proj = await call("work.start-project", { template: lib.template, name: "Rivera Family Trust", repo: "" });
const about = { urn: proj.project };
const day = 86400000, ago = (n) => new Date(Date.now() - n * day).toISOString();
const mk = (type, data) => d.kernel.gateway.records.create(ownerChain, type, data);
await mk("communication", { kind: "email", direction: "outbound", at: ago(6), subject: "Engagement letter for the Rivera trust", to: "dana.whitfield@example.com", record: about });
await mk("communication", { kind: "email", direction: "inbound", at: ago(4), subject: "Signed engagement letter", from: "dana.whitfield@example.com", record: about });
await mk("communication", { kind: "text", direction: "outbound", at: ago(2), subject: "Your documents are ready to review", to: "+1 919 555 0142", record: about });
await mk("communication", { kind: "call", direction: "inbound", at: ago(1), subject: "Dana asked about the deed", from: "Dana Whitfield", record: about });
await mk("task", { title: "Collect the Raleigh deed", status: "done", record: about }).catch(() => null);

await call("work.chat.link", { chat: chat.id, record: proj.project, shared: true });
const project = proj.slug;
void project;
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
const SIZES = [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]];
for (const scheme of (process.env.SCHEMES || "light,dark").split(",")) for (const [label, viewport] of SIZES) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(10000);
  pg.on("pageerror", (e) => console.log("page error:", String(e.message).slice(0, 200)));
  const shot = async (name) => { await pg.waitForTimeout(2500); const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200); console.log(`${name}-${label}-${scheme}:`, text); await pg.screenshot({ path: path.join(OUT, `${name}-${label}-${scheme}.png`) }); };
  await pg.goto(`${BASE}/u/chats`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(3500);
  await pg.screenshot({ path: path.join(OUT, `debug-list-${label}-${scheme}.png`) });
  await pg.getByText("Personal", { exact: true }).first().click().catch((e) => console.log("no chat row:", e.message.slice(0, 80)));
  await pg.waitForTimeout(2500);
  await pg.getByLabel("Chat tools").first().click().catch((e) => console.log("no tools button:", e.message));
  await pg.getByText("Files", { exact: true }).first().click().catch((e) => console.log("no Files row:", e.message));
  await shot("files-list");
  await pg.getByText("Document checklist.md", { exact: false }).first().click().catch(() => {});
  await shot("files-shared-preview");
  await pg.getByText("Family tree.png", { exact: false }).first().click().catch(() => {});
  await shot("files-image-preview");
  await pg.getByText("Client intake notes.txt", { exact: false }).first().click().catch(() => {});
  await shot("files-private-preview");
  // the project's Timeline tab and "Chat about this" on the new-chat screen: one shot each, desktop only
  {
    await pg.goto(`${BASE}/u/project/${String(proj.project).split("/").pop()}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(3000);
    await pg.getByText("Timeline", { exact: true }).first().click().catch((e) => console.log("no Timeline tab:", e.message.slice(0, 80)));
    await shot("project-timeline");
  }
  {
    await pg.goto(`${BASE}/u/settings/backups`, { waitUntil: "domcontentloaded" });
    await shot("settings-backups");
  }
  if (label === "1440") {
    await pg.goto(`${BASE}/u/chats/new?about=${encodeURIComponent(proj.project)}&name=${encodeURIComponent("Rivera Family Trust")}`, { waitUntil: "domcontentloaded" });
    await shot("chat-about-this");
  }
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(0);
