#!/usr/bin/env node
// app-walk-g21: the template studio the way a person uses it (G21): New template, fields and choices (no JSON), the page projects open on, a Flow attached under Automations, Save, Test mode, Go live,
// Start project (it opens on the chosen page), and Make a template from a free-flow project. TEST BOX ONLY. It starts a vyred of its own in a temp home (kernel on), serves a web export of the app in
// front of it and drives a browser, keeping a picture and a line of what the page said at each step, and checks the behaviour as it goes.
//   node scripts/app-walk-g21.mjs --dist apps/app/dist [--out team/0.3.3/proof/G21]
import "./mac-test-guard.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { start } from "../core/daemon/index.js";
import { paths } from "../core/config/index.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const OUT = path.resolve(flag("--out", "g21-walk"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const transcript = [];
const say = (s) => { console.log(s); transcript.push(s); };
let failures = 0;
const check = (ok, what) => { say(`${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) failures++; };

const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-g21-walk-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const space = d.kernel.id.space, owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
const host = d.registry.deps.flowsHost.get(space);

// seeded: a Flow the template can attach, and a free-flow project with some work in it
const def = await call("flows.define", { flow: { format: 1, name: "welcome_contact", label: "Welcome the client", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "c", kind: "create", type: "contact", set: { name: { expr: "\"Welcome \" + trigger.stage" } } }] } });
await host.flows.tools["flows.approve"](host.personChain(), { id: def.id, version: def.version, hash: def.hash });
const plain = await call("work.project.create", { name: "Okafor Estate" });
for (const [title, note] of [["Collect the death certificate", "Ask the family for a certified copy"], ["Open the estate account", ""]]) await d.kernel.gateway.records.create(ownerChain, "task", { title, project: { urn: plain.project }, ...(note ? { note } : {}) });
const idOf = (urn) => String(urn).split("/").pop();

const SOCKET = paths(root).socket;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) {
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
void SOCKET;

const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", serviceWorkers: "block" });
const pg = await ctx.newPage();
let n = 0;
const shot = async (name) => { await pg.waitForTimeout(1500); await pg.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true }); };
const body = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
const field = (label, placeholder) => pg.getByLabel(label, { exact: false }).first().or(placeholder ? pg.getByPlaceholder(placeholder).first() : pg.getByLabel(label).first());
const choose = async (label, option) => { await pg.getByRole("button", { name: new RegExp(label, "i") }).first().click(); await pg.getByText(option, { exact: false }).last().click(); };

try {
  say("1. Templates, then New template");
  await pg.goto(`${BASE}/u/templates`, { waitUntil: "domcontentloaded" });
  await pg.getByText("New template", { exact: true }).first().click({ timeout: 60000 });
  await shot("new-template");
  check(!/\{\s*"name"/.test(await body()), "the editor shows fields, not JSON");

  say("2. Fill it in with fields and choices");
  await field("Name", "Estate plan").fill("Okafor intake");
  await choose("opens on", "Files");
  await pg.getByPlaceholder("attorney").first().fill("attorney");
  await pg.getByRole("button", { name: /^Add$/ }).first().click();
  await pg.getByPlaceholder("Gather documents").first().fill("Collect the death certificate");
  await choose("Who does it", "A person");
  await choose("Attach a Flow", "Welcome the client");
  await pg.getByRole("button", { name: /^Attach$/ }).first().click();
  await shot("filled");
  check((await body()).includes("Welcome the client") && (await body()).includes("Runs"), "the Flow is attached under Automations");

  say("3. Save as a draft version");
  await pg.getByRole("button", { name: /Save as a draft version/ }).first().click();
  await pg.waitForURL(/\/u\/templates\/tpl_/, { timeout: 30000 });
  await shot("saved-draft");
  const tpl = pg.url().split("/").pop();
  const stored = await call("work.template.get", { template: tpl, version: 1 });
  check(stored.body.opens_on === "files" && stored.body.automations?.length === 1 && stored.body.stages[0].tasks[0].doer === "person:owner", `the box stored what the fields said (opens_on ${stored.body.opens_on}, ${stored.body.automations?.length} automation, doer ${stored.body.stages[0].tasks[0].doer})`);

  say("4. Test mode, then Go live");
  await pg.getByText("Test mode", { exact: true }).first().click();
  await pg.getByText("Nothing is created, sent or changed", { exact: false }).first().waitFor({ timeout: 20000 });
  await shot("test-mode");
  check((await body()).includes("Automation: the Flow"), "test mode lists the attached Flow and runs none");
  await pg.getByText("Go live", { exact: true }).first().click();
  await pg.getByText("Start a project", { exact: false }).first().waitFor({ timeout: 20000 });

  say("5. Start a project: it opens on the chosen page, and the attached Flow runs");
  await pg.getByPlaceholder("Rivera Family Trust").first().fill("Okafor Family");
  await pg.getByRole("button", { name: /Start project/ }).first().click();
  await pg.waitForURL(/\/u\/project\//, { timeout: 30000 });
  await shot("project-opens-on-files");
  const t = await body();
  check(t.indexOf("Files") > -1 && t.indexOf("Stages") > -1 && t.indexOf("Files") < t.indexOf("Stages"), "the project opens with Files first, before Stages and Chats (the page the template chose)");
  const contacts = ((await d.kernel.gateway.records.query(ownerChain, "contact", { page: { limit: 50 } })).rows || []).map((r) => r.data.name);
  check(contacts.includes("Welcome Okafor intake") || contacts.some((x) => /^Welcome /.test(x)), `the attached Flow ran for the new project (${contacts.join(", ")})`);

  say("6. Make a template from a free-flow project");
  await pg.goto(`${BASE}/u/project/${idOf(plain.project)}`, { waitUntil: "domcontentloaded" });
  await pg.getByText("Make a template", { exact: true }).first().click({ timeout: 60000 });
  await pg.waitForURL(/\/u\/templates\/tpl_/, { timeout: 30000 });
  await pg.getByText("Collect the death certificate", { exact: false }).first().waitFor({ timeout: 30000 });
  await shot("template-from-free-flow-project");
  const tb = await body();
  check(tb.includes("Collect the death certificate") && tb.includes("Open the estate account") && tb.includes("Working"), "the free-flow project's tasks are the draft's working stage");
} catch (e) {
  failures++; say(`FAIL walk stopped: ${e && e.message}`); await shot("stopped").catch(() => {});
}
fs.writeFileSync(path.join(OUT, "walk.txt"), transcript.join("\n") + "\n");
await browser.close(); server.close(); await d.stop();
process.exit(failures ? 1 : 0);
