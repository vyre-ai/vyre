// @ts-check
// The hub file (ADR 0035) in a real vyred in a temp home: it mirrors every change with a rev, a
// person's hand edit applies, a bad one is named and kept out, one that widens what Claude may do
// waits for the person, a broken file is kept aside, and a session can't touch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { rules } from "../harness/rules.js";
import { backup } from "../names/backup.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

async function world(t, { before } = /** @type {{ before?: (root: string) => void }} */ ({})) {
  const root = tempHome(t);
  const projects = path.join(root, "projects");
  const home = path.join(projects, "northwind");
  fs.mkdirSync(path.join(home, ".vyre"), { recursive: true });
  fs.writeFileSync(path.join(home, ".vyre", "project.json"), JSON.stringify({ name: "Northwind Bakery", slug: "northwind" }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, projectsDir: projects, settings: { claude_dir: path.join(root, "claude") } }));
  before?.(root);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  const file = path.join(root, "hub.json");
  const hub = () => JSON.parse(fs.readFileSync(file, "utf8"));
  /** Edit the file as a person would, then give the watcher a moment. */
  const edit = async (/** @type {(h: any) => void} */ f) => { const h = hub(); f(h); fs.writeFileSync(file, JSON.stringify(h, null, 2)); await sleep(400); };
  return { root, d, c, file, hub, edit };
}

test("hub.json is made at first start and mirrors every change, each with the next rev", async t => {
  const { d, c, hub } = await world(t);
  const r0 = hub().rev;
  assert.deepEqual(hub().account, {});
  await c("settings.set", { key: "sessions.effort", value: "high" });
  await c("settings.set", { key: "sessions.max_turns", value: 40, project: "northwind" });
  assert.equal(hub().account["sessions.effort"], "high");
  assert.equal(hub().projects.northwind["sessions.max_turns"], 40);
  assert.equal(hub().rev, r0 + 2);
  const ev = d.events.since(0, { type: "settings.changed" });
  assert.deepEqual(ev.map(e => e.payload.rev), [r0 + 1, r0 + 2]);
  // A key kept elsewhere (a module's tool) still moves rev, and never lands in the file.
  await c("settings.set", { key: "push.watch", value: false });
  assert.equal(hub().rev, r0 + 3);
  assert.ok(!("push.watch" in hub().account));
  await c("settings.reset", { key: "sessions.effort" });
  assert.ok(!("sessions.effort" in hub().account));
  assert.equal((await c("settings.schema")).data.hub.rev, r0 + 4);
});

test("a person's edit to hub.json applies live and says so; a bad value is kept out and named on its row", async t => {
  const { d, c, hub, edit } = await world(t);
  await edit(h => { h.account["sessions.effort"] = "max"; });
  const e = d.events.since(0, { type: "settings.changed" }).at(-1);
  assert.equal(e?.payload.key, "sessions.effort");
  assert.equal(e.payload.by, "hub.json");
  assert.equal((await c("settings.get", { key: "sessions.effort" })).data.value, "max");
  const before = fs.readFileSync(path.join(d.paths.root, "hub.json"), "utf8");
  await edit(h => { h.account["sessions.max_turns"] = 0; h.account["bakery.oven"] = true; });
  const row = (await c("settings.get", { key: "sessions.max_turns" })).data;
  assert.equal(row.value, undefined, "the bad value is not in effect");
  assert.match(row.problem, /hub\.json: sessions\.max_turns/);
  assert.equal(hub().account["sessions.max_turns"], 0, "the person's text stays in the file");
  assert.notEqual(before, fs.readFileSync(path.join(d.paths.root, "hub.json"), "utf8"));
});

test("a hand edit that widens what Claude may do waits for the person, then applies with their confirm", async t => {
  const { d, c, edit, hub } = await world(t);
  const n = d.events.since(0, { type: "settings.changed" }).length;
  await edit(h => { h.account["sessions.mode"] = "bypassPermissions"; });
  let row = (await c("settings.get", { key: "sessions.mode" })).data;
  assert.equal(row.value, "default", "not applied");
  assert.deepEqual(row.pending, { level: "account", value: "bypassPermissions", from: "hub.json" });
  assert.equal(d.events.since(0, { type: "settings.changed" }).length, n, "nothing changed");
  assert.equal((await d.registry.call("settings.get", { key: "sessions.mode" }, "mcp:agent:kit")).data.value, "default");
  // The person accepts it in the Deck: the same set, with confirm.
  assert.ok(!(await c("settings.set", { key: "sessions.mode", value: "bypassPermissions", confirm: true })).error);
  row = (await c("settings.get", { key: "sessions.mode" })).data;
  assert.equal(row.value, "bypassPermissions");
  assert.equal(row.pending, undefined);
  assert.equal(hub().account["sessions.mode"], "bypassPermissions");
});

test("edits made while vyred was off are read at start, and a held one still waits", async t => {
  const { c } = await world(t, { before: root => fs.writeFileSync(path.join(root, "hub.json"), JSON.stringify({ rev: 3,
    account: { "sessions.fast": true, "sessions.mode": "dontAsk" }, projects: { northwind: { "sessions.effort": "low" } } })) });
  assert.equal((await c("settings.get", { key: "sessions.fast" })).data.value, true);
  assert.equal((await c("settings.get", { key: "sessions.effort", project: "northwind" })).data.value, "low");
  const mode = (await c("settings.get", { key: "sessions.mode" })).data;
  assert.equal(mode.value, "default");
  assert.equal(mode.pending.value, "dontAsk");
});

test("a broken hub.json is named, kept aside on the next change, and rebuilt from what is in effect", async t => {
  const { root, c, hub } = await world(t);
  await c("settings.set", { key: "sessions.effort", value: "high" });
  fs.writeFileSync(path.join(root, "hub.json"), "{ \"account\": { \"sessions.effort\": ");
  await sleep(400);
  assert.match((await c("settings.schema")).data.hub.problem, /not valid JSON/);
  assert.equal((await c("settings.get", { key: "sessions.effort" })).data.value, "high", "what was in effect stays");
  await c("settings.set", { key: "sessions.fast", value: true });
  assert.equal(fs.readFileSync(path.join(root, "hub.json.bad"), "utf8"), "{ \"account\": { \"sessions.effort\": ", "the person's text is kept");
  assert.deepEqual(hub().account, { "sessions.effort": "high", "sessions.fast": true });
  assert.equal((await c("settings.schema")).data.hub.problem, undefined);
});

test("a session never writes or reads hub.json, and a backup carries it", async t => {
  const { root, c } = await world(t);
  const file = path.join(root, "hub.json");
  for (const [tool, input] of /** @type {[string, any][]} */ ([["Write", { file_path: file, content: "{}" }], ["Edit", { file_path: file, old_string: "a", new_string: "b" }],
    ["Read", { file_path: file }], ["Bash", { command: `sed -i s/default/bypassPermissions/ ${file}` }]])) {
    assert.equal(rules({ tool, input, home: root, cwd: root }).decision, "deny", tool);
  }
  await c("settings.set", { key: "sessions.effort", value: "high" });
  const out = path.join(root, "..", `b-${process.pid}.tar.gz`);
  t.after(() => fs.rmSync(out, { force: true }));
  const r = await backup({ root, file: out });
  assert.ok(r.included.includes("hub.json"), JSON.stringify(r.included));
});

// ---- step 2 and 3: device and session levels, snapshot, check and choicesFrom ---------------------

/** A home module with a device-level look, a checked value, run-time choices and a session chip. */
function oven(/** @type {string} */ root, { slow = false } = {}) {
  const dir = path.join(root, "modules", "oven");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "oven", version: "0.1.0", roles: ["box", "local"],
    does: { tools: ["oven.check", "oven.presets", "oven.chip.get", "oven.chip.set"] }, settings: [
      { key: "oven.look", group: "appearance", label: "Look", type: "enum", enum: ["crust", "crumb"], default: "crust", levels: ["account", "device"], apply: "live" },
      { key: "oven.recipe", group: "appearance", label: "Recipe", type: "string", default: "sourdough", levels: ["account", "device"], apply: "live",
        check: { tool: "oven.check" }, choicesFrom: { tool: "oven.presets", read: "presets" } },
      { key: "oven.chip", group: "appearance", label: "Chip", type: "string", levels: ["account", "session"], apply: "live",
        store: { tool: { get: { tool: "oven.chip.get", input: { thread: "$session" }, read: "chip" }, set: { tool: "oven.chip.set", input: { thread: "$session", chip: "$value" } } } } },
    ] }));
  fs.writeFileSync(path.join(dir, "index.js"), `const chips = {};
export default { async start(ctx) {
  ctx.tool("oven.check", { input: { type: "object" }, run: async i => {
    ${slow ? "await new Promise(r => setTimeout(r, 900));" : ""}
    return i.value === "rye" ? { ok: false, message: "Northwind Bakery bakes no rye" } : { ok: true };
  } });
  ctx.tool("oven.presets", { run: async () => ({ presets: [{ id: "sourdough", label: "Sourdough" }, { id: "rye", label: "Rye" }, "brioche"] }) });
  ctx.tool("oven.chip.get", { input: { type: "object" }, run: async i => ({ chip: chips[i.thread || "*"] }) });
  ctx.tool("oven.chip.set", { input: { type: "object" }, run: async i => { chips[i.thread || "*"] = i.chip ?? undefined; return {}; } });
  return { async stop() {} };
} };`);
}

test("a device's value beats the account's for that device only; the owner's device reads its own by default", async t => {
  const { d, c, hub, edit } = await world(t, { before: root => oven(root) });
  assert.ok(!(await c("settings.set", { key: "oven.look", value: "crumb", device: "tailnet:alex-phone" })).error);
  assert.equal(hub().devices["tailnet:alex-phone"]["oven.look"], "crumb");
  assert.equal((await c("settings.get", { key: "oven.look", device: "tailnet:alex-phone" })).data.value, "crumb");
  assert.equal((await c("settings.get", { key: "oven.look", device: "mac:alex-mbp" })).data.value, "crust", "another device keeps the account's");
  // The phone over the tailnet, signed in, names no device and still reads its own.
  const phone = await d.registry.call("settings.get", { key: "oven.look" }, "tailnet:alex-phone", { person: { id: "p1" } });
  assert.deepEqual([phone.data.value, phone.data.source, phone.data.device_id], ["crumb", "device", "tailnet:alex-phone"]);
  const snap = await d.registry.call("settings.snapshot", {}, "tailnet:alex-phone", { person: { id: "p1" } });
  assert.equal(snap.data.device, "tailnet:alex-phone", "the id it resolved is echoed");
  assert.equal(snap.data.values["oven.look"], "crumb");
  assert.equal(snap.data.sources["oven.look"], "device");
  assert.deepEqual(snap.data.levels["oven.look"], { device: "crumb" });
  assert.equal(snap.data.rev, hub().rev);
  // A hand edit of the devices section applies like any other.
  await edit(h => { h.devices["mac:alex-mbp"] = { "oven.look": "crumb" }; });
  assert.equal((await c("settings.get", { key: "oven.look", device: "mac:alex-mbp" })).data.value, "crumb");
  const e = d.events.since(0, { type: "settings.changed" }).at(-1).payload;
  assert.deepEqual([e.key, e.level, e.device, e.by], ["oven.look", "device", "mac:alex-mbp", "hub.json"]);
  // The device's own reset brings the account's back.
  await c("settings.reset", { key: "oven.look", device: "tailnet:alex-phone", level: "device" });
  assert.equal((await c("settings.get", { key: "oven.look", device: "tailnet:alex-phone" })).data.value, "crust");
});

test("a key's check is asked before anything is stored, by hand or by tool, and its choices come from its module", async t => {
  const { c, hub, edit } = await world(t, { before: root => oven(root) });
  const r = await c("settings.set", { key: "oven.recipe", value: "rye" });
  assert.equal(r.error.code, "bad_input");
  assert.match(r.error.message, /Northwind Bakery bakes no rye/);
  assert.ok(!(await c("settings.set", { key: "oven.recipe", value: "brioche" })).error);
  await edit(h => { h.account["oven.recipe"] = "rye"; });
  const row = (await c("settings.get", { key: "oven.recipe" })).data;
  assert.equal(row.value, "brioche", "a refused hand edit never applies");
  assert.match(row.problem, /no rye/);
  assert.equal(hub().account["oven.recipe"], "rye", "the text stays for the person to fix");
  const k = (await c("settings.schema")).data.keys.find((/** @type {any} */ x) => x.key === "oven.recipe");
  assert.deepEqual([k.type, k.enum, k.labels.rye], ["enum", ["sourdough", "rye", "brioche"], "Rye"]);
});

test("a check that is off or too slow refuses; choices that can't be asked say so", async t => {
  const { c } = await world(t, { before: root => oven(root, { slow: true }) });
  const r = await c("settings.set", { key: "oven.recipe", value: "brioche" });
  assert.equal(r.error.code, "bad_input");
  assert.match(r.error.message, /oven\.check took too long/);
  assert.equal((await c("settings.get", { key: "oven.recipe" })).data.value, "sourdough");
});

test("a session's own value goes through its module's tools and beats the account's for that thread", async t => {
  const { c, hub } = await world(t, { before: root => oven(root) });
  await c("settings.set", { key: "oven.chip", value: "loaf" });
  const r0 = hub().rev;
  assert.ok(!(await c("settings.set", { key: "oven.chip", value: "roll", session: "thread-juno-1" })).error);
  const row = (await c("settings.get", { key: "oven.chip", session: "thread-juno-1" })).data;
  assert.deepEqual([row.value, row.source], ["roll", "session"]);
  assert.equal((await c("settings.get", { key: "oven.chip", session: "thread-kit-2" })).data.value, "loaf");
  assert.equal(hub().rev, r0 + 1, "a session change moves rev too");
  assert.ok(!("oven.chip" in hub().account), "and never lands in the file");
});

test("a secret setting never goes into hub.json, and a hand edit of one is named, not applied", async t => {
  const { c, hub, edit, root } = await world(t, { before: root => {
    const dir = path.join(root, "modules", "safe");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "safe", version: "0.1.0", roles: ["box", "local"], settings: [
      { key: "safe.token", label: "Token", type: "string", secret: true, levels: ["account"], apply: "live" }] }));
    fs.writeFileSync(path.join(dir, "index.js"), "export default { async start() { return { async stop() {} }; } };");
  } });
  assert.ok(!(await c("settings.set", { key: "safe.token", value: "nw-secret-123" })).error);
  assert.equal((await c("settings.get", { key: "safe.token" })).data.value, "nw-secret-123", "in effect for the person");
  assert.ok(!fs.readFileSync(path.join(root, "hub.json"), "utf8").includes("nw-secret"), "never on disk in the hub");
  await edit(h => { h.account["safe.token"] = "juno-guess"; });
  const row = (await c("settings.get", { key: "safe.token" })).data;
  assert.equal(row.value, "nw-secret-123");
  assert.match(row.problem, /never holds safe\.token, a secret/);
  assert.ok(hub().rev > 0);
});

test("/theme.css and /v1/theme serve the appearance module's answer per device, with rev as the ETag and a 304", async t => {
  const http = await import("node:http");
  const { d } = await world(t, { before: root => {
    const dir = path.join(root, "modules", "appearance");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "appearance", version: "0.1.0", roles: ["box", "local"], does: { tools: ["appearance.resolve"] } }));
    fs.writeFileSync(path.join(dir, "index.js"), `export default { async start(ctx) {
  ctx.tool("appearance.resolve", { input: { type: "object" }, run: async i => ({ theme: "vyre", scheme: i.device === "tailnet:alex-phone" ? "paper" : "dark",
    tokens: { color: { dark: {}, paper: {} } }, css: ":root { --bg: " + (i.device === "tailnet:alex-phone" ? "#fff" : "#000") + "; }", version: "v1", rev: 7 }) });
  return { async stop() {} };
} };`);
  } });
  const get = (/** @type {string} */ p, /** @type {Record<string, string>} */ headers = {}) => new Promise(ok => {
    http.request({ socketPath: d.paths.socket, path: p, headers: { "x-vyre-caller": "deck", ...headers } }, res => {
      let b = ""; res.on("data", x => (b += x)); res.on("end", () => ok({ status: res.statusCode, etag: res.headers.etag, type: res.headers["content-type"], body: b }));
    }).end();
  });
  const css = /** @type {any} */ (await get("/theme.css?device=tailnet:alex-phone"));
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);
  assert.equal(css.body, ":root { --bg: #fff; }");
  assert.equal(css.etag, '"7-tailnet:alex-phone"');
  assert.equal((/** @type {any} */ (await get("/theme.css?device=tailnet:alex-phone", { "if-none-match": css.etag }))).status, 304);
  const json = /** @type {any} */ (await get("/v1/theme?device=mac:alex-mbp"));
  assert.equal(json.status, 200);
  assert.deepEqual([JSON.parse(json.body).data.scheme, JSON.parse(json.body).data.rev], ["dark", 7]);
});

test("a thread's chip changing in sessions is also a session-level settings.changed, with the next rev", async t => {
  const { d, hub } = await world(t);
  const r0 = (await call("settings.schema", {}, { root: d.paths.root })).data.hub.rev;
  d.events.emit("switchboard", "mode.changed", { mode: "plan" }, { thread: "thread-juno-1" });
  d.events.emit("switchboard", "model.switched", { model: "sonnet" }, { thread: "thread-juno-1" });
  await sleep(50);
  const ev = d.events.since(0, { type: "settings.changed" }).map(e => e.payload).filter(p => p.level === "session");
  assert.deepEqual(ev.map(p => [p.key, p.session, p.value, p.by]), [["sessions.mode", "thread-juno-1", "plan", "session"], ["sessions.model", "thread-juno-1", "sonnet", "session"]]);
  assert.deepEqual(ev.map(p => p.rev), [r0 + 1, r0 + 2]);
  assert.ok(hub());
});
