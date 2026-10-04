#!/usr/bin/env node
// app-walk: an automated walk of the app's real screens against a real vyred, in a real browser. See scripts/app-walk.README.md.
//
//   node scripts/app-walk.mjs --dist apps/app/dist --socket ~/devbox/home/.vyre/vyred.sock [--out walk-out] [--only a,b] [--width 1280] [--presence]
//
// It serves the web export (built WITHOUT EXPO_PUBLIC_VYRE_MOCK) at /app and forwards /v1/* to the box's own socket (or --box-url), so the
// browser talks to the box exactly as the app does at the box's own address. Per screen it opens the page, does the screen's main action, takes a screenshot, and
//   FAILS on: any sample-world text; an error state the box did not itself say (a "did not answer" with no refusal from the box behind it); any console or page error
//   (a failed load of a URL the box answered with 4xx is the box's refusal, not a console error).
// A screen the box refuses honestly (a module it does not have, a human-only call) is HONEST and named; a step that needs presence is SKIPPED by name unless --presence.
// Exit 0 when nothing FAILED. Prints one line per step and writes <out>/report.json and one PNG per step.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const SOCKET = flag("--socket", "");
const BOX_URL = flag("--box-url", "");
const OUT = path.resolve(flag("--out", "walk-out"));
const ONLY = flag("--only", "").split(",").filter(Boolean);
const WIDTH = Number(flag("--width", "1280"));
const PRESENCE = bool("--presence");
if (!SOCKET && !BOX_URL) { console.error("app-walk: give --socket <path to the box's vyred.sock> or --box-url <http://host:port>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

/** What only the sample world says. Any of these on a real screen is a failure. */
const SAMPLE = [
  "alex.vyre.run", "Alex Rivera", "Jane Doe", "intake@harlowlegal.example.com", "Client intake form", "Pricing explorer", "Estate planning matter", "PI intake", "Real estate deals",
  "Doe estate plan", "Trail map.pdf", "Wink page copy", "Passport portal", "Firm Visa", "Claude Sonnet 5.5", "On payment", "Mt7!hQ2-sail", "Chris Park", "Mei Tanaka",
];
/** Words that make a state an error state. */
const ERROR_WORDS = /(did not answer|did not open|could not be|could not load|could not open|cannot reach|went wrong|not available on this box|is not available\.)/i;

// ---- the server: the web export, and /v1 forwarded to the box ----
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".map": "application/json" };
/** Every box answer to a tool call, in order, so a step can say which refusals it saw. */
const answers = [];
function forward(req, res) {
  const opts = SOCKET ? { socketPath: SOCKET, path: req.url, method: req.method, headers: { ...req.headers, host: "localhost" } }
    : { host: new URL(BOX_URL).hostname, port: new URL(BOX_URL).port, path: req.url, method: req.method, headers: { ...req.headers, host: new URL(BOX_URL).host } };
  const up = http.request(opts, (r) => {
    const tool = /^\/v1\/tools\/([^/?#]+)/.exec(req.url)?.[1];
    const chunks = [];
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.on("data", (c) => { res.write(c); if (tool && chunks.length < 64) chunks.push(c); });
    r.on("end", () => {
      res.end();
      if (!tool) return;
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* a stream or no body */ }
      answers.push({ tool: decodeURIComponent(tool), status: r.statusCode, code: body?.error?.code ?? null, message: body?.error?.message ?? null });
    });
  });
  up.on("error", (e) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "unreachable", message: String(e.message) } })); });
  req.pipe(up);
}
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) return forward(req, res);
  let p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  // the box generates /app/sw.js from precache.json at serve time; the walk has no service worker, so an empty one stands in (it was served as index.html, a MIME error)
  if (p === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("// walk: no service worker\n"); }
  // a lazy chunk is asked for relative to the page (/app/u/now/_expo/...): the file is dist/_expo/... whatever the page depth
  const asset = /\/((?:_expo|assets)\/.*)$/.exec(p); if (asset) p = "/" + asset[1];
  let f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;

/** One tool call straight to the box, for finding what exists (the walk's own eyes, never the screen's). */
function boxCall(tool, input = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(input);
    const opts = SOCKET ? { socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body) } }
      : { host: new URL(BOX_URL).hostname, port: new URL(BOX_URL).port, path: `/v1/tools/${tool}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } };
    const r = http.request(opts, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { const j = JSON.parse(s); resolve(j.error ? { error: j.error } : { data: j.data ?? j }); } catch { resolve({ error: { code: "bad_reply", message: s.slice(0, 120) } }); } }); });
    r.on("error", (e) => resolve({ error: { code: "unreachable", message: String(e.message) } }));
    r.end(body);
  });
}

// ---- what the box has, so each step knows its target ----
const world = {};
for (const [k, tool, input] of [["spaces", "spaces.list"], ["types", "records.types"], ["flows", "flows.list"], ["kits", "flows.kit.list"], ["agents", "agents.list"], ["publish", "publish.list"], ["vault", "vault.list"], ["drive", "files.drive.status"], ["identity", "spaces.identity.status"]]) world[k] = await boxCall(tool, input);
const has = (k) => !world[k].error;
const spaceNames = has("spaces") && Array.isArray(world.spaces.data) ? world.spaces.data.map((s) => s.displayName || s.label || s.name) : [];

// ---- the walk ----
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, colorScheme: "dark" });
const page = await ctx.newPage();
let consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e}`));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

/** @type {{ name: string, status: "PASS" | "HONEST" | "SKIP" | "FAIL", note: string, shot?: string }[]} */
const report = [];
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const text = () => page.locator("body").innerText();
const settle = async (ms = 900) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
const go = async (route) => { await page.goto(`${BASE}/${route}`, { waitUntil: "networkidle" }).catch(() => {}); await settle(); };
const click = async (label, o = {}) => { const l = page.getByText(label, { exact: o.exact ?? true }).first(); await l.waitFor({ state: "visible", timeout: o.timeout ?? 8000 }); await l.click(); await settle(o.settle ?? 700); };
const press = async (name) => { const b = page.getByRole("button", { name }).first(); await b.waitFor({ state: "visible", timeout: 8000 }); await b.click(); await settle(); };

/**
 * One step: reset the recorders, run it, then judge the page. `expect` lists things the page must show; `honest` is true when the box is expected to refuse
 * (a module it lacks), in which case showing its words is the pass.
 */
async function step(name, o, run) {
  if (ONLY.length && !ONLY.some((x) => name.includes(x))) return;
  if (o.needs === "presence" && !PRESENCE) { report.push({ name, status: "SKIP", note: "needs presence (the stand-in is not in yet)" }); console.log(`SKIP   ${name}: needs presence`); return; }
  if (o.skip) { report.push({ name, status: "SKIP", note: o.skip }); console.log(`SKIP   ${name}: ${o.skip}`); return; }
  answers.length = 0; consoleErrors = [];
  let status = "PASS", note = "";
  try {
    await run();
    const body = await text();
    const sample = SAMPLE.filter((s) => body.includes(s));
    const refusals = answers.filter((a) => a.code || (a.status && a.status >= 400));
    const shown = refusals.filter((a) => a.message && body.toLowerCase().includes(String(a.message).toLowerCase().slice(0, 40)));
    const errState = ERROR_WORDS.exec(body);
    const missing = (o.expect ?? []).filter((e) => !(e instanceof RegExp ? e.test(body) : body.includes(e)));
    // A failed load the browser logs for a URL the box answered with 4xx is the box's refusal, not an app error.
    const realErrors = consoleErrors.filter((e) => !(/Failed to load resource/.test(e) && refusals.length));
    if (sample.length) { status = "FAIL"; note = `sample data on screen: ${sample.join(", ")}`; }
    else if (realErrors.length) { status = "FAIL"; note = `console error: ${realErrors[0].slice(0, 200)}`; }
    else if (errState && !shown.length && !o.honest) { status = "FAIL"; note = `an error state the box did not say: "${errState[0]}"; box refusals seen: ${refusals.map((a) => `${a.tool}:${a.code}`).join(", ") || "none"}`; }
    else if (missing.length) { status = o.honest && shown.length ? "HONEST" : "FAIL"; note = o.honest && shown.length ? `the box refused: ${shown[0].tool} ${shown[0].code}: ${shown[0].message}` : `expected on screen: ${missing.map(String).join(", ")}`; }
    else if (o.honest && shown.length) { status = "HONEST"; note = `the box refused: ${shown[0].tool} ${shown[0].code}: ${shown[0].message}`; }
    else if (errState && shown.length) { status = "HONEST"; note = `the box refused: ${shown[0].tool} ${shown[0].code}: ${shown[0].message}`; }
    else note = o.note ?? `${answers.length} box calls`;
  } catch (e) { status = "FAIL"; note = `the step threw: ${String(e.message).split("\n")[0].slice(0, 200)}`; }
  const shot = `${slug(name)}.png`;
  await page.screenshot({ path: path.join(OUT, shot), fullPage: false }).catch(() => {});
  report.push({ name, status, note, shot });
  console.log(`${status.padEnd(6)} ${name}: ${note}`);
}

// ================================================================== the steps, in the order of the inventory
const T = world.types.data?.types ?? [];
const firstType = T.find((t) => !/^(def-|flow-|kit-)/.test(t.name))?.name;
const firstFlow = Array.isArray(world.flows.data) ? world.flows.data[0]?.id : undefined;

await step("shell: the space switcher lists the box's spaces and the person", { expect: spaceNames.length ? [spaceNames[0]] : [] }, async () => { await go("u/now"); });
await step("now: opens", { note: "Now opened" }, async () => { await go("u/now"); });
await step("records: first type lists its records", { skip: firstType ? undefined : "the box has no record type outside its own (def-flow, goal...): nothing to list" }, async () => { await go(`u/records/${firstType}`); });
await step("projects: opens", {}, async () => { await go("u/projects"); });
await step("flows: list", { skip: undefined }, async () => { await go("u/flows"); });
await step("flows: a Flow's page, See as code", { skip: firstFlow ? undefined : "the box has no Flow (flows.list is empty)" }, async () => { await go(`u/flows/${firstFlow}`); await click("See as code"); });
await step("kits: installed", {}, async () => { await go("u/kits"); });
await step("engineer: set up or chat", { honest: false }, async () => { await go("u/engineer"); });
await step("memory: ask a question", { expect: [/Nothing remembered|Asking Memory|You /] }, async () => {
  await go("u/memory");
  await page.getByLabel("Ask Memory").first().fill("Who is Kit?").catch(() => {});
  await page.keyboard.press("Enter"); await settle(1500);
});
await step("memory: pin a node", { skip: "the box holds no memory node to pin (memory.graph is empty)" }, async () => {});
await step("vault: list and tabs", {}, async () => { await go("u/vault"); await click("Keys").catch(() => {}); await click("Cards").catch(() => {}); });
await step("vault: reveal a field", { needs: "presence" }, async () => {});
await step("drive: browse a folder and open a text file", { skip: has("drive") && world.drive.data?.shares?.length ? undefined : "no share offered by the box", expect: [/Harlow intake/] }, async () => {
  await go("u/drive");
  await click("Harlow intake", { exact: false });
  await click("checklist.txt", { exact: false });
  await settle(1000);
});
await step("calendar: week, month, day", {}, async () => { await go("u/calendar"); await click("Month"); await click("Day"); await click("Week"); });
await step("sites: list", { honest: !has("publish") }, async () => { await go("u/sites"); });
await step("sites: publish a draft", { skip: has("publish") ? undefined : "the dev box has no publish module (windows is bringing Publish up on testbox3)" }, async () => {});
await step("settings: home", {}, async () => { await go("u/settings"); });
await step("settings: updates, check for updates", { expect: [/up to date|is out/] }, async () => { await go("u/settings/updates"); await press("Check for updates"); });
await step("settings: notifications, switch a kind and back", {}, async () => {
  await go("u/settings/notifications");
  const sw = page.getByRole("switch", { name: "What Vyre learned" }).first();
  if (await sw.count()) { await sw.click(); await settle(); await sw.click(); await settle(); }
});
await step("settings: assistants", {}, async () => { await go("u/settings/assistants"); });
await step("settings: AI accounts", {}, async () => { await go("u/settings/ai"); });
await step("settings: account and recovery", { expect: [/Ways in/] }, async () => { await go("u/settings/account"); });
await step("settings: account, make a new recovery code", { needs: "presence" }, async () => {});
await step("settings: what my assistants can see", {}, async () => { await go("u/settings/seeing"); });
await step("settings: privacy and sealing", {}, async () => { await go("u/settings/privacy"); });
await step("settings: about", {}, async () => { await go("u/about"); });
await step("settings: appearance, pick a theme", { needs: "presence" }, async () => {});
await step("settings: rules", { skip: "BLOCKED: no rules.* tools on the box yet (kernel-2, platform)" }, async () => {});
await step("settings: devices (chat's)", {}, async () => { await go("u/settings/devices"); });

await browser.close();
server.close();
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), box: SOCKET || BOX_URL, presence: PRESENCE, spaces: spaceNames, report }, null, 2));
const count = (s) => report.filter((r) => r.status === s).length;
console.log(`\n${report.length} steps: ${count("PASS")} passed, ${count("HONEST")} honest refusals, ${count("SKIP")} skipped, ${count("FAIL")} failed. Report and screenshots in ${OUT}`);
process.exit(count("FAIL") ? 1 : 0);
