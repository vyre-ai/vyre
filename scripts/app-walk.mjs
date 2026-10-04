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
const CALLER = flag("--caller", "deck");
const PRESENCE = bool("--presence");
const SETUP = bool("--setup");
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
const ERROR_WORDS = /(did not answer|did not open|did not load|could not be|could not load|could not open|cannot reach|went wrong|not available on this box|not available on your home|is not available\.)/i;

// ---- the server: the web export, and /v1 forwarded to the box ----
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".map": "application/json" };
/** Every box answer to a tool call, in order, so a step can say which refusals it saw. */
const answers = [];
/** The tools that ask for a person's proof. A header on any other call would turn a plain read into a proof check, so only these get it. @param {string} t */
const needsProof = (t) => /^(vault\.(reveal|put|unlock)|spaces\.identity\.(code\.replace|entry\.remove)|settings\.set|rules\.(define|enable|disable|remove|accept|dismiss)|tasks\.decide|records\.reveal|flows\.approve|spaces\.members\.|spaces\.devices\.lend|files\.drive\.restore)/.test(decodeURIComponent(t));
function forward(req, res) {
  // With --presence the dev box's hand-made stand-in answers every proof ask (method "stand-in", logged as such on the box); it is honoured only on a development build.
  if (PRESENCE && !req.headers["x-vyre-presence"] && needsProof(/^\/v1\/tools\/([^/?#]+)/.exec(req.url)?.[1] ?? "")) req.headers["x-vyre-presence"] = "stand-in";
  const opts = SOCKET ? { socketPath: SOCKET, path: req.url, method: req.method, headers: { ...req.headers, host: "localhost", "x-vyre-caller": CALLER } }
    : { host: new URL(BOX_URL).hostname, port: new URL(BOX_URL).port, path: req.url, method: req.method, headers: { ...req.headers, host: new URL(BOX_URL).host, "x-vyre-caller": CALLER } };
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
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(DIST, p);
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  // A missing file with an extension is a 404 (the box's /app/sw.js has no copy here); only a route falls back to the page.
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;

/** One tool call straight to the box, for finding what exists (the walk's own eyes, never the screen's). */
function boxCall(tool, input = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(input);
    const opts = SOCKET ? { socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": CALLER, ...(PRESENCE && needsProof(tool) ? { "x-vyre-presence": "stand-in" } : {}), "content-type": "application/json", "content-length": Buffer.byteLength(body) } }
      : { host: new URL(BOX_URL).hostname, port: new URL(BOX_URL).port, path: `/v1/tools/${tool}`, method: "POST", headers: { "x-vyre-caller": CALLER, "content-type": "application/json", "content-length": Buffer.byteLength(body) } };
    const r = http.request(opts, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { const j = JSON.parse(s); resolve(j.error ? { error: j.error } : { data: j.data ?? j }); } catch { resolve({ error: { code: "bad_reply", message: s.slice(0, 120) } }); } }); });
    r.on("error", (e) => resolve({ error: { code: "unreachable", message: String(e.message) } }));
    r.end(body);
  });
}

// ---- what the box has, so each step knows its target ----
const world = {};
for (const [k, tool, input] of [["spaces", "spaces.list"], ["types", "records.types"], ["flows", "flows.list"], ["kits", "flows.kit.list"], ["agents", "agents.list"], ["publish", "publish.list"], ["vault", "vault.list"], ["drive", "files.drive.status"], ["spaceDrive", "files.drive.space.list"], ["identity", "spaces.identity.status"]]) world[k] = await boxCall(tool, input);
// What the box itself holds is never sample: a dev box seeded with a "Jane Doe" contact shows it for real. Read every type's rows and the tasks once, and drop any sample word the box holds.
const boxHeld = JSON.stringify([world.spaces, world.agents, world.vault, world.flows, world.kits, await boxCall("tasks.list"), ...(await Promise.all(((world.types.data?.types ?? []).map((t) => t.name)).filter((n) => !/^(def-|flow-|kit-)/.test(n)).map((n) => boxCall("records.list", { type: n, limit: 200 }))))]);
for (let i = SAMPLE.length - 1; i >= 0; i--) if (boxHeld.includes(SAMPLE[i])) SAMPLE.splice(i, 1);
const has = (k) => !world[k].error;
const spaceNames = has("spaces") && Array.isArray(world.spaces.data) ? world.spaces.data.map((s) => s.displayName || s.label || s.name) : [];

// ---- the walk ----
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
const page = await ctx.newPage();
// The stand-in names directory (testbox3) sends no CORS headers yet (windows' fix 489ea442f is not on it), so a browser cannot read its answer. The walk adds the header on the way back;
// the answer itself is the directory's, untouched.
const DIRECTORY = process.env.WALK_NAMES_DIRECTORY || "";
// The LIVE names directory is never touched by a walk: any request to it is aborted and counted, and a walk that claims names (--setup) refuses to start unless the build holds the stand-in host.
let liveNameCalls = 0;
await ctx.route(/^https:\/\/names\.vyre\.run\//, (route) => { liveNameCalls++; return route.abort(); });
if (SETUP) {
  const js = fs.readdirSync(path.join(DIST, "_expo/static/js/web")).filter((f) => f.startsWith("entry-")).map((f) => fs.readFileSync(path.join(DIST, "_expo/static/js/web", f), "utf8")).join("");
  const host = DIRECTORY.replace(/^https?:\/\//, "");
  if (!DIRECTORY || !js.includes(host)) { console.error(`app-walk: --setup needs WALK_NAMES_DIRECTORY and a build made with EXPO_PUBLIC_VYRE_NAMES_DIRECTORY set to it (the build does not hold "${host}"); refusing to start so no name is claimed on the live directory`); process.exit(3); }
}
if (DIRECTORY) await ctx.route(`${DIRECTORY}/**`, async (route) => { const r = await route.fetch(); await route.fulfill({ response: r, headers: { ...r.headers(), "access-control-allow-origin": "*" } }); });
let consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e}`));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

/** @type {{ name: string, status: "PASS" | "HONEST" | "SKIP" | "FAIL", note: string, shot?: string }[]} */
const report = [];
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const text = () => page.locator("body").innerText();
const settle = async (ms = 900) => { await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); await page.waitForTimeout(ms); };
const go = async (route) => { await page.goto(`${BASE}/${route}`, { waitUntil: "domcontentloaded" }).catch(() => {}); await settle(); };
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
await step("vault: reveal a field", { needs: "presence" }, async () => {
  let items = (await boxCall("vault.list")).data?.items ?? [];
  if (!items.length) { await boxCall("vault.put", { name: "walk-login", kind: "login", fields: { username: "walk", password: "walk-pw-123" } }); items = (await boxCall("vault.list")).data?.items ?? []; }
  if (!items.length) throw new Error("the box would not take a vault item from the walk (vault.put refused)");
  await go("u/vault");
  await click(items[0].name, { exact: false });
  await click("Reveal", { exact: false });
  await settle(1500);
  const body = await text();
  if (!/walk-pw-123|•/.test(body) && !/Reveal|Hide/.test(body)) throw new Error("no reveal result on screen");
});
await step("drive: browse a folder and open a text file", { skip: has("drive") && world.drive.data?.shares?.length ? undefined : "no share offered by the box", expect: [/Harlow intake/] }, async () => {
  await go("u/drive");
  await click("Box folders");
  await click("Harlow intake", { exact: false });
  await click("checklist.txt", { exact: false });
  await settle(1000);
});
await step("drive: the space's own Drive opens (Space tab)", { honest: !has("spaceDrive"), expect: [/Drive is empty|Nothing here|did not open|no Drive yet/i] }, async () => { await go("u/drive"); await settle(1200); });
await step("calendar: week, month, day", {}, async () => { await go("u/calendar"); await click("Month"); await click("Day"); await click("Week"); });
await step("settings: home", {}, async () => { await go("u/settings"); });
await step("settings: updates, check for updates", { expect: [/up to date|is out/] }, async () => { await go("u/settings/updates"); await press("Check for updates"); });
await step("settings: notifications, switch a kind and back", {}, async () => {
  await go("u/settings/notifications");
  const sw = page.getByRole("switch", { name: "What Vyre learned" }).first();
  if (await sw.count()) { await sw.click(); await settle(); await sw.click(); await settle(); }
});
await step("settings: assistants", {}, async () => { await go("u/settings/assistants"); });
await step("settings: AI accounts", {}, async () => { await go("u/settings/ai"); });
await step("settings: account and recovery", { expect: [/ways in/i] }, async () => { await go("u/settings/account"); });
await step("settings: account, make a new recovery code", { skip: "not walkable on a headless box: the recovery code replace needs a real person presence (lead ruling 4 Oct)", expect: [/I wrote it down/] }, async () => {
  await go("u/settings/account");
  await press("Make a new recovery code");
  await settle(1500);
  // The new code is shown once; keep it where the dev box keeps its own (RECOVERY beside the home), never in the report.
  const code = await page.locator("[selectable], div").filter({ hasText: /^[A-Za-z0-9 -]{20,}$/ }).first().innerText().catch(() => "");
  if (code) fs.writeFileSync(path.join(OUT, ".new-recovery"), code, { mode: 0o600 });
});
await step("settings: what my assistants can see", {}, async () => { await go("u/settings/seeing"); });
await step("settings: privacy and sealing", {}, async () => { await go("u/settings/privacy"); });
await step("settings: about", {}, async () => { await go("u/about"); });
await step("settings: appearance, pick a theme", { needs: "presence" }, async () => {
  await go("u/appearance");
  await click("Paper");
  await settle(1200);
  const got = await boxCall("settings.get", { key: "appearance.scheme" });
  if (JSON.stringify(got).indexOf("paper") < 0) throw new Error(`the theme write did not reach the box: ${JSON.stringify(got).slice(0, 160)}`);
  await boxCall("settings.set", { key: "appearance.scheme", value: "system" });
});
await step("settings: rules", { skip: "BLOCKED: no rules.* tools on the box yet (kernel-2, platform)" }, async () => {});
await step("settings: devices (chat's)", {}, async () => { await go("u/settings/devices"); });

await step("join: a link in /u/install/join's own query fills nothing and leaves the address bare", {}, async () => {
  const tok = "https://harlow.vyre.run/join/eyJ2IjoxfQ.c2lnLWFiYw";
  await go(`u/install/join?link=${encodeURIComponent(tok)}`);
  await page.screenshot({ path: path.join(OUT, "join-query-ignored.png") });
  const search = await page.evaluate(() => window.location.search);
  if (search) throw new Error(`the address still carries a query: ${search.slice(0, 40)}`);
  const field = page.getByLabel("Invite link").first();
  if (await field.count()) { const v = await field.inputValue(); if (v) throw new Error("the Invite link field was filled from the query"); }
});
await step("join: /app/join?link= is taken out of the address and held, not left in it", {}, async () => {
  const tok = "https://harlow.vyre.run/join/eyJ2IjoxfQ.c2lnLWFiYw";
  await page.goto(`${BASE}/join?link=${encodeURIComponent(tok)}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(3500);
  await page.screenshot({ path: path.join(OUT, "join-link-held.png") });
  const href = await page.evaluate(() => window.location.href);
  if (/link=|eyJ2/.test(href)) throw new Error(`the token is still in the address: ${href.slice(0, 80)}`);
});
await step("join: /app/join#link= (fragment) is taken out of the address and held", {}, async () => {
  const tok = "https://harlow.vyre.run/join/eyJ2IjoxfQ.c2lnLWFiYw";
  await page.goto(`${BASE}/join#link=${encodeURIComponent(tok)}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(3500);
  await page.screenshot({ path: path.join(OUT, "join-fragment-held.png") });
  const where = await page.evaluate(() => ({ path: window.location.pathname, hash: window.location.hash, search: window.location.search }));
  if (where.hash || where.search) throw new Error(`the address still carries ${where.hash || where.search}`);
  if (!/\/u\/install\/join$/.test(where.path)) throw new Error(`did not end at the join route: ${where.path}`);
  // The held link was used: it filled the Invite link field (the box then refuses this made-up token in its own words, or opens the card).
  const field = page.getByLabel("Invite link").first();
  const v = (await field.count()) ? await field.inputValue() : "";
  const t = (await text()).replace(/\s+/g, " ");
  if (!/harlow\.vyre\.run\/join\//.test(v) && !/harlow/i.test(t.replace(/harlow\.vyre\.run\/join\/\.\.\./, ""))) throw new Error(`the held link was not used: field="${v.slice(0, 40)}" page="${t.slice(0, 160)}"`);
});
await step("RC1: a browser with no identity sees no Create, makes no claim and opens no identity storage", {}, async () => {
  const ctx2 = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, serviceWorkers: "block" });
  const pg = await ctx2.newPage();
  await pg.addInitScript(() => {
    window.__spy = { fetches: [], dbs: [] };
    const f = window.fetch; window.fetch = (...a) => { window.__spy.fetches.push(String(a[0] && a[0].url || a[0])); return f.apply(window, a); };
    const o = indexedDB.open.bind(indexedDB); indexedDB.open = (...a) => { window.__spy.dbs.push(String(a[0])); return o(...a); };
  });
  // A box with no identity: the name step is the first thing a person sees. Only this read is answered by the walk; nothing else is changed.
  await pg.route("**/v1/tools/spaces.identity.status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { exists: false, name: null } }) }));
  await pg.goto(`${BASE}/u/install`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await pg.waitForTimeout(3500);
  await pg.screenshot({ path: path.join(OUT, "rc1-no-identity.png") });
  const body = await pg.locator("body").innerText();
  const spy = await pg.evaluate(() => window.__spy);
  await ctx2.close();
  if (/Continue with|Create with|Face ID/i.test(body)) throw new Error(`a Create path is on screen: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  if (!/Scan from my phone|phone/i.test(body)) throw new Error(`the pair path is not on screen: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  if (spy.fetches.some((u) => /\/v1\/ids\/claim/.test(u))) throw new Error("a claim request was made");
  if (spy.dbs.some((d) => /vyre-identity/i.test(d))) throw new Error(`the identity database was opened: ${spy.dbs.join(",")}`);
});
await step("setup: create a space on this computer, close partway, resume", { skip: SETUP ? undefined : "starts a real space on the dev box: pass --setup" }, async () => {
  await go("u/install/create");
  await page.getByLabel("Name").first().fill(`Walk ${Date.now().toString(36).slice(-4)}`);
  await settle(1500);
  await page.screenshot({ path: path.join(OUT, "setup-1-name.png") });
  await click("Continue");
  await click("On this computer");
  await page.screenshot({ path: path.join(OUT, "setup-2-here.png") });
  await click("Create it here", { settle: 4000 });
  await page.screenshot({ path: path.join(OUT, "setup-3-after-create.png") });
  const t3 = await text();
  if (!/Give .* a look/.test(t3)) throw new Error(`stopped after Create it here: ${t3.replace(/\s+/g, " ").slice(0, 300)}`);
  // Close partway: leave the flow and open it again; setup must resume at the look step, with no second sign-in.
  await go("u/spaces");
  await go("u/install");
  await page.screenshot({ path: path.join(OUT, "setup-4-reopened.png") });
  const t4 = await text();
  if (!/Give .* a look/.test(t4)) throw new Error(`setup did not resume at the look step after closing: ${t4.replace(/\s+/g, " ").slice(0, 300)}`);
  await click("Continue");
  await page.screenshot({ path: path.join(OUT, "setup-5-members.png") });
  const members = (await text()).replace(/\s+/g, " ").slice(0, 200);
  for (const later of ["Later", "Later", "Start empty"]) { await click(later, { settle: 1500 }).catch(() => {}); }
  await page.screenshot({ path: path.join(OUT, "setup-6-done.png") });
  const t6 = await text();
  if (!/is ready/.test(t6)) throw new Error(`setup did not reach its done page (members step said: ${members}): ${t6.replace(/\s+/g, " ").slice(0, 300)}`);
});

await browser.close();
server.close();
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), box: SOCKET || BOX_URL, presence: PRESENCE, spaces: spaceNames, report }, null, 2));
if (liveNameCalls) console.log(`NOTE: ${liveNameCalls} request(s) to the live names directory were blocked`);
const count = (s) => report.filter((r) => r.status === s).length;
console.log(`\n${report.length} steps: ${count("PASS")} passed, ${count("HONEST")} honest refusals, ${count("SKIP")} skipped, ${count("FAIL")} failed. Report and screenshots in ${OUT}`);
process.exit(count("FAIL") ? 1 : 0);
