// @ts-check
// appearance in a real vyred in a temp home: the three settings it declares (ADR 0035), the check
// the hub calls before it stores one, the presets as the hub's choices, device beating account,
// what surfaces read (appearance.resolve, its css format, and vyred's /v1/theme and /theme.css),
// the fallback when a stored value breaks a rule, the old values, and a daemon fine without it.
//
// The hub tests need native-core's settings module (ADR 0035 steps 1 to 3) and skip without it.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import * as config from "../config/index.js";
import { validate } from "../modules/index.js";
import { tempHome } from "../../test/helpers.js";
import * as theme from "../../lib/theme/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"));
const SHIPPED = theme.version(theme.tokens());

/** native-core's settings registry, where it has landed on this branch, else null. */
async function registry() {
  try { return await import("../config/settings.js"); } catch { return null; }
}
const NO_HUB = "the settings module (native-core, ADR 0035) is not on this branch";

/** Write a row straight into a table in vyred's store, past every check: an old or hand-made value. @param {string} root @param {string} sql @param {any[]} args */
async function poke(root, sql, ...args) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(config.paths(root).db);
  try { db.prepare(sql).run(...args); } finally { db.close(); }
}
/** A setting's value as an old build left it in settings_values. @param {string} root @param {string} key @param {any} value @param {string} [scope] */
const oldSetting = (root, key, value, scope = "account") => poke(root, `INSERT INTO settings_values (scope, key, value, by, at) VALUES (?, ?, ?, 'old', ?)
  ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, scope, key, JSON.stringify(value), Date.now());
const turn = () => new Promise(res => setTimeout(res, 60));

/** A vyred in a temp home with only what these tests need running. @param {any} t */
async function world(t, { disable = /** @type {string[]} */ ([]), theme: legacy = /** @type {any} */ (undefined) } = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn", ...disable] }, ...(legacy ? { theme: legacy } : {}) }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
  const hub = !(await c("settings.schema")).error;
  return { root, c, hub };
}

/** A raw GET over vyred's socket, for the status and headers. @param {string} root @param {string} p @param {Record<string, string>} [headers] */
function get(root, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.paths(root).socket, path: p, method: "GET", agent: false, headers: { "x-vyre-caller": "cli", ...headers } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", x => { raw += x; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("appearance: the manifest and its three settings are valid, at account and device level, with no store", async () => {
  assert.deepEqual(validate(manifest), []);
  const [th, sc, tk] = manifest.settings;
  assert.deepEqual([th.key, th.group, th.type, th.default, th.apply, th.label], ["appearance.theme", "appearance", "string", "vyre", "live", "Theme"]);
  assert.deepEqual([th.choicesFrom, th.check], [{ tool: "appearance.presets", read: "presets" }, { tool: "appearance.check" }]);
  assert.deepEqual([sc.key, sc.type, sc.enum, sc.default], ["appearance.scheme", "enum", ["system", "dark", "paper"], "system"]);
  assert.deepEqual([tk.key, tk.type, tk.default, tk.apply, tk.label, tk.advanced, tk.check], ["appearance.tokens", "object", {}, "live", "Design tokens", true, { tool: "appearance.check" }]);
  for (const d of manifest.settings) {
    assert.deepEqual(d.levels, ["account", "device"], d.key);
    assert.equal(d.store, undefined, `${d.key}: the hub keeps it`);
  }
  assert.deepEqual(manifest.does.tools.map(t => (typeof t === "string" ? t : t.name)), ["appearance.check", "appearance.presets", "appearance.resolve"]);
  // The hub's own checker, where it has landed, holds it to the rules of a module from outside
  // Vyre too: check and choicesFrom name only its own tools, and a device-level key has no store.
  const settings = await registry();
  if (settings) {
    assert.deepEqual(settings.validateDecls("appearance", manifest.settings, { firstParty: false, tools: manifest.does.tools }), []);
    assert.deepEqual(validate(manifest, { firstParty: true }), []);
  }
});

test("appearance: check accepts a good override and names each broken rule", async t => {
  const { c } = await world(t);
  let r = await c("appearance.check", { override: { color: { dark: { bg: "#000000" } }, radius: { card: 16 }, font: { sans: "Inter Tight" } } });
  assert.deepEqual(r.data, { ok: true, problems: [] });
  const refused = async (/** @type {any} */ override, /** @type {RegExp} */ want) => {
    const x = await c("appearance.check", { override });
    assert.equal(x.data.ok, false, JSON.stringify(override));
    assert.ok(x.data.problems.some((/** @type {string} */ p) => want.test(p)), `${want}: ${x.data.problems.join("; ")}`);
  };
  await refused({ status: { order: [] } }, /^status may not be overridden$/);
  await refused({ layout: { rail: 10 } }, /^layout may not be overridden$/);
  await refused({ icon: { stroke: 2 } }, /^icon may not be overridden$/);
  await refused({ color: { attentionAlt: {} } }, /^color\.attentionAlt may not be overridden$/);
  await refused({ color: { dark: { brand: "#123456" } } }, /is not a colour role/);
  await refused({ radius: { huge: 40 } }, /^radius\.huge is not a token$/);
  await refused({ color: { dark: { beacon: "#F1EEE6" } } }, /beacon \(attention\) is reused as primaryBg/);
  await refused({ color: { paper: { focus: "#EEEAE2" } } }, /^paper: focus on bg .* needs 3:1$/);
  await refused({ color: { dark: { label: "#3A3733" } } }, /^dark: label on bg .* needs 4\.5:1$/);
  await refused({ type: { mono: [11, 13] } }, /under the 12 pt minimum/);
  await refused({ control: { touch: 40 } }, /under the 44 pt touch target/);
  await refused({ font: { sans: " " } }, /^font\.sans is empty$/);
  r = await c("appearance.check", { override: "blue" });
  assert.equal(r.data.ok, false);
});

test("appearance: check answers the hub's call, { key, value, level, device? }, with ok or a message naming the failing pair", async t => {
  const { c } = await world(t);
  let r = await c("appearance.check", { key: "appearance.tokens", value: { radius: { card: 16 } }, level: "device", device: "tailnet:phone" });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.message, undefined);
  r = await c("appearance.check", { key: "appearance.tokens", value: { color: { paper: { text2: "#B8B2A8" } } }, level: "account" });
  assert.equal(r.data.ok, false);
  assert.match(r.data.message, /^paper: text2 on bg is \d\.\d\d:1, needs 4\.5:1/);
  r = await c("appearance.check", { key: "appearance.tokens", value: [1], level: "account" });
  assert.deepEqual([r.data.ok, r.data.message], [false, "appearance.tokens is an object shaped like a partial tokens.json"]);
  assert.equal((await c("appearance.check", { key: "appearance.theme", value: "vyre", level: "account" })).data.ok, true);
  r = await c("appearance.check", { key: "appearance.theme", value: "kit/ocean", level: "account" });
  assert.deepEqual([r.data.ok, r.data.message], [false, "appearance.theme: no preset kit/ocean; appearance.presets lists the installed ones"]);
  r = await c("appearance.check", { key: "appearance.theme", value: "paper", level: "account" });
  assert.match(r.data.message, /paper is a scheme now; set appearance\.scheme to paper/);
  assert.equal((await c("appearance.check", { key: "sessions.model", value: "opus" })).data.ok, false);
});

test("appearance: presets lists Vyre's own, and the hub shows them as appearance.theme's choices", async t => {
  const { c, hub } = await world(t);
  assert.deepEqual((await c("appearance.presets")).data, { presets: [{ id: "vyre", label: "Vyre", schemes: ["dark", "paper"] }] });
  if (!hub) return t.skip(NO_HUB);
  const row = (await c("settings.schema")).data.keys.find((/** @type {any} */ k) => k.key === "appearance.theme");
  assert.deepEqual([row.enum, row.labels, row.choices_unavailable], [["vyre"], { vyre: "Vyre" }, undefined]);
});

test("appearance: with nothing set, resolve is the vyre preset, following the device, with its css", async t => {
  const { c, hub } = await world(t);
  const r = (await c("appearance.resolve")).data;
  assert.deepEqual([r.theme, r.scheme, r.version, r.problems], ["vyre", "system", SHIPPED, undefined]);
  assert.deepEqual(r.tokens, theme.tokens());
  assert.match(r.css, /^:root \{/m);
  assert.match(r.css, /^:root\[data-theme="paper"\] \{/m);
  if (hub) assert.equal(typeof r.rev, "number", "the hub's rev");
  else assert.equal(r.rev, undefined);
});

test("appearance: settings.set runs the check, refuses a bad value whole, and a good one repaints once", async t => {
  const { c, hub, root } = await world(t);
  if (!hub) return t.skip(NO_HUB);
  const keys = (await c("settings.schema")).data.keys.filter((/** @type {any} */ k) => k.group === "appearance").map((/** @type {any} */ k) => k.key);
  assert.deepEqual(keys, ["appearance.theme", "appearance.scheme", "appearance.tokens"]);

  let r = await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 }, control: { touch: 30 } } });
  assert.equal(r.error.code, "bad_input");
  assert.equal(r.error.message, "control.touch: 30 is under the 44 pt touch target");
  r = await c("settings.set", { key: "appearance.tokens", value: { color: { dark: { beacon: "#F1EEE6" } } } });
  assert.match(r.error.message, /beacon \(attention\) is reused/);
  assert.deepEqual((await c("settings.get", { key: "appearance.tokens" })).data.value, {}, "the default, nothing stored");
  assert.equal((await c("settings.set", { key: "appearance.theme", value: "kit/ocean" })).error.message, "appearance.theme: no preset kit/ocean; appearance.presets lists the installed ones");
  assert.equal((await c("settings.set", { key: "appearance.scheme", value: "neon" })).error.code, "bad_input");
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);

  const since = Number((await request("GET", "/v1/health", undefined, { root })).data.last_event);
  r = await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 }, color: { dark: { bg: "#000000" } } } });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual([r.data.source], ["account"]);
  const after = (await c("appearance.resolve")).data;
  assert.equal(after.tokens.radius.card, 16);
  assert.equal(after.tokens.color.dark.bg, "#000000");
  assert.equal(after.tokens.color.dark.panel, theme.tokens().color.dark.panel, "merged by key");
  assert.match(after.css, /--radius-card: 16px;/);
  await turn();
  const ev = (await request("GET", `/v1/events?since=${since}&type=appearance.changed`, undefined, { root })).data;
  assert.deepEqual(ev.map((/** @type {any} */ e) => e.payload), [{ version: after.version, theme: "vyre", scheme: "system" }], "one event for one change");

  r = await c("settings.reset", { key: "appearance.tokens" });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);
});

test("appearance: only a person changes the theme; an agent is refused", async t => {
  const { c, hub } = await world(t);
  if (!hub) return t.skip(NO_HUB);
  const r = await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 } } }, "mcp:agent:kit");
  assert.equal(r.error.code, "denied");
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);
});

test("appearance: a device's value beats the account's, and the check runs at device level too", async t => {
  const { c, hub } = await world(t);
  if (!hub) return t.skip(NO_HUB);
  const phone = { level: "device", device: "tailnet:phone" };
  let r = await c("settings.set", { key: "appearance.tokens", value: { control: { touch: 30 } }, ...phone });
  assert.equal(r.error.code, "bad_input");
  assert.equal(r.error.message, "control.touch: 30 is under the 44 pt touch target");

  assert.ok(!(await c("settings.set", { key: "appearance.scheme", value: "dark" })).error);
  assert.ok(!(await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 } } })).error);
  r = await c("settings.set", { key: "appearance.scheme", value: "paper", ...phone });
  assert.ok(!r.error, JSON.stringify(r.error));
  r = await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 20 } }, ...phone });
  assert.ok(!r.error, JSON.stringify(r.error));

  const onPhone = (await c("appearance.resolve", { device: "tailnet:phone" })).data;
  const onMac = (await c("appearance.resolve", { device: "mac:studio" })).data;
  assert.deepEqual([onPhone.scheme, onPhone.tokens.radius.card, onPhone.device], ["paper", 20, "tailnet:phone"]);
  assert.deepEqual([onMac.scheme, onMac.tokens.radius.card, onMac.device], ["dark", 16, "mac:studio"]);
  assert.equal(onPhone.rev, onMac.rev, "one hub, one rev");
  assert.notEqual(onPhone.version, onMac.version);
  // A device's value goes, and the account's is back for it.
  assert.ok(!(await c("settings.reset", { key: "appearance.scheme", ...phone })).error);
  assert.equal((await c("appearance.resolve", { device: "tailnet:phone" })).data.scheme, "dark");
});

test("appearance: vyred's /v1/theme and /theme.css serve resolve's answer per device, with the rev as the ETag", async t => {
  const { c, root } = await world(t);
  const probe = /** @type {any} */ (await get(root, "/v1/theme"));
  if (probe.status === 404) return t.skip("vyred does not serve /v1/theme on this branch (native-core, ADR 0035 section 3)");
  await c("settings.set", { key: "appearance.scheme", value: "paper", level: "device", device: "tailnet:phone" });
  await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 } }, level: "device", device: "tailnet:phone" });
  const want = (await c("appearance.resolve", { device: "tailnet:phone" })).data;
  const json = /** @type {any} */ (await get(root, "/v1/theme?device=tailnet:phone"));
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body).data, want);
  assert.equal(json.headers.etag, `"${want.rev}-tailnet:phone"`);
  const css = /** @type {any} */ (await get(root, "/theme.css?device=tailnet:phone"));
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  assert.equal(css.body, want.css);
  assert.match(css.body, /--radius-card: 16px;/);
  const mac = /** @type {any} */ (await get(root, "/theme.css?device=mac:studio"));
  assert.doesNotMatch(mac.body, /--radius-card: 16px;/, "another device keeps the account's");
  // Unchanged: 304. A change through the hub moves the rev, and the ETag with it.
  assert.equal(/** @type {any} */ (await get(root, "/v1/theme?device=tailnet:phone", { "if-none-match": json.headers.etag })).status, 304);
  await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 18 } }, level: "device", device: "tailnet:phone" });
  const moved = /** @type {any} */ (await get(root, "/v1/theme?device=tailnet:phone", { "if-none-match": json.headers.etag }));
  assert.equal(moved.status, 200);
  assert.equal(JSON.parse(moved.body).data.tokens.radius.card, 18);
});

test("appearance: format css is only the custom properties", async t => {
  const { c } = await world(t);
  const full = (await c("appearance.resolve")).data;
  const css = (await c("appearance.resolve", { format: "css" })).data;
  assert.equal(typeof css, "string");
  assert.equal(css, full.css);
  assert.equal((await c("appearance.resolve", { format: "svg" })).error.code, "bad_input");
});

test("appearance: a stored value that breaks a rule never paints; resolve falls back to the preset and names it", async t => {
  const { c, root, hub } = await world(t);
  if (!hub) return t.skip(NO_HUB);
  // Values an older build saved under older rules, written past the check.
  await oldSetting(root, "appearance.tokens", { radius: { card: 16 }, control: { touch: 30 } });
  let r = (await c("appearance.resolve")).data;
  assert.equal(r.version, SHIPPED, "the preset's tokens, whole");
  assert.equal(r.tokens.radius.card, theme.tokens().radius.card, "not half applied");
  assert.deepEqual(r.problems, ["control.touch: 30 is under the 44 pt touch target"]);
  assert.doesNotMatch(r.css, /--control-touch: 30px/);
  await oldSetting(root, "appearance.theme", "kit/ocean");
  r = (await c("appearance.resolve")).data;
  assert.equal(r.theme, "vyre");
  assert.ok(r.problems.includes('appearance.theme: no preset "kit/ocean"; painting vyre'), r.problems.join("; "));
});

test("appearance: an old theme value (system, dark, paper) reads as the vyre preset and that scheme", async t => {
  const { c, root, hub } = await world(t);
  if (!hub) return t.skip(NO_HUB);
  await oldSetting(root, "appearance.theme", "dark");
  let x = (await c("appearance.resolve")).data;
  assert.deepEqual([x.theme, x.scheme, x.problems], ["vyre", "dark", undefined]);
  // A scheme the person set wins over the one the old value implied.
  assert.ok(!(await c("settings.set", { key: "appearance.scheme", value: "paper" })).error);
  x = (await c("appearance.resolve")).data;
  assert.deepEqual([x.theme, x.scheme], ["vyre", "paper"]);
});

test("appearance: the old appearance_tokens row is read until the person changes the tokens through the hub", async t => {
  const { c, root, hub } = await world(t);
  if (!hub) return t.skip(NO_HUB);
  await poke(root, "INSERT INTO appearance_tokens (scope, value, at) VALUES ('account', ?, ?)", JSON.stringify({ radius: { card: 16 } }), Date.now());
  assert.equal((await c("appearance.resolve")).data.tokens.radius.card, 16, "the old value paints");
  assert.ok(!(await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 20 } } })).error);
  assert.equal((await c("appearance.resolve")).data.tokens.radius.card, 20, "the hub's value wins");
  assert.ok(!(await c("settings.reset", { key: "appearance.tokens" })).error);
  await turn();
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED, "the old row went with the first change");
});

test("appearance: the legacy config.theme.colors folds in under the person's tokens, only when it keeps the rules", async t => {
  const { c, hub } = await world(t, { theme: { colors: { dark: { graphite: "#050505", recall: "#EBC76B" }, light: { "rule-strong": "#C0C0C0" } } } });
  let r = (await c("appearance.resolve")).data;
  assert.equal(r.tokens.color.dark.bg, "#050505");
  assert.equal(r.tokens.color.paper.ruleStrong, "#C0C0C0");
  assert.deepEqual(r.legacy, { applied: true, unknown: ["recall"], problems: [] });
  if (!hub) return;
  // The person's own tokens win over the legacy colours.
  assert.ok(!(await c("settings.set", { key: "appearance.tokens", value: { color: { dark: { bg: "#000000" } } } })).error);
  r = (await c("appearance.resolve")).data;
  assert.equal(r.tokens.color.dark.bg, "#000000");
  assert.equal(r.tokens.color.paper.ruleStrong, "#C0C0C0");
});

test("appearance: legacy colours that break a rule are left out, and said so", async t => {
  const { c } = await world(t, { theme: { colors: { dark: { beacon: "#F1EEE6" } } } });
  const r = (await c("appearance.resolve")).data;
  assert.equal(r.version, SHIPPED);
  assert.equal(r.legacy.applied, false);
  assert.ok(r.legacy.problems.some((/** @type {string} */ p) => p.includes("beacon (attention) is reused")));
});

test("appearance: no route of its own; switched off, vyred is healthy, /theme.css still serves and /v1/theme is gone", async t => {
  const on = await world(t);
  assert.equal(/** @type {any} */ (await get(on.root, "/v1/appearance/theme")).status, 404, "the ADR's routes are the only ones");
  const { c, root } = await world(t, { disable: ["appearance"] });
  const h = await request("GET", "/v1/health", undefined, { root });
  assert.ok(h.data && h.data.version, JSON.stringify(h));
  const mods = (await request("GET", "/v1/modules", undefined, { root })).data;
  assert.equal(mods.find((/** @type {any} */ m) => m.name === "appearance").state, "off");
  assert.equal((await c("appearance.resolve")).error.code, "no_such_tool");
  assert.equal(/** @type {any} */ (await get(root, "/theme.css")).status, 200);
  assert.equal(/** @type {any} */ (await get(root, "/v1/theme")).status, 404);
  const s = await c("settings.schema");
  if (!s.error) assert.ok(!s.data.keys.some((/** @type {any} */ k) => k.key.startsWith("appearance.")), "its settings go with it");
});
