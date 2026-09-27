// @ts-check
// appearance in a real vyred in a temp home: the three settings it declares (ADR 0035), the check
// the hub and every write of appearance.tokens go through, the presets, what surfaces read
// (appearance.resolve, its css format, GET /v1/appearance/theme), the fallback when a stored value
// breaks a rule, the old theme values and colours, and a daemon that is fine without it.

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
/** Does the registry accept the device level yet (ADR 0035, build step 2)? */
async function deviceLevel() {
  const s = await registry();
  if (!s) return false;
  const d = { key: "x.y", group: "x", label: "Y", type: "string", levels: ["account", "device"], apply: "live" };
  return s.validateDecls("x", [d]).length === 0;
}

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

test("appearance: the manifest and its three settings are valid", async () => {
  assert.deepEqual(validate(manifest), []);
  const [th, sc, tk] = manifest.settings;
  assert.deepEqual([th.key, th.group, th.type, th.default, th.levels, th.apply, th.label], ["appearance.theme", "appearance", "string", "vyre", ["account"], "live", "Theme"]);
  assert.deepEqual([th.choicesFrom.tool, th.check.tool], ["appearance.presets", "appearance.check"]);
  assert.deepEqual([sc.key, sc.type, sc.enum, sc.default, sc.levels], ["appearance.scheme", "enum", ["system", "dark", "paper"], "system", ["account"]]);
  assert.deepEqual([tk.key, tk.group, tk.type, tk.default, tk.levels, tk.apply, tk.label, tk.advanced], ["appearance.tokens", "appearance", "object", {}, ["account"], "live", "Design tokens", true]);
  assert.equal(tk.check.tool, "appearance.check");
  for (const d of [th, tk]) assert.ok(manifest.does.tools.includes(d.check.tool));
  for (const side of ["get", "set"]) assert.ok(manifest.does.tools.includes(tk.store.tool[side].tool), side);
  // The hub's own checker, where the settings module has landed (native-core), holds it to the
  // stricter rules of a module from outside Vyre too: its stores, check and choicesFrom name only
  // its own tools.
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
  await refused({ color: { dark: { beacon: "#C6F36B" } } }, /beacon \(attention\) is reused as primaryBg/);
  await refused({ color: { paper: { focus: "#EEEAE2" } } }, /^paper: focus on bg .* needs 3:1$/);
  await refused({ color: { dark: { label: "#3A3733" } } }, /^dark: label on bg .* needs 4\.5:1$/);
  await refused({ type: { mono: [11, 13] } }, /under the 12 pt minimum/);
  await refused({ control: { touch: 40 } }, /under the 44 pt touch target/);
  await refused({ font: { sans: " " } }, /^font\.sans is empty$/);
  r = await c("appearance.check", { override: "blue" });
  assert.equal(r.data.ok, false);
});

test("appearance: check answers the hub's call, { key, value }, with ok or a message naming the failing pair", async t => {
  const { c } = await world(t);
  let r = await c("appearance.check", { key: "appearance.tokens", value: { radius: { card: 16 } } });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.message, undefined);
  r = await c("appearance.check", { key: "appearance.tokens", value: { color: { paper: { text2: "#B8B2A8" } } } });
  assert.equal(r.data.ok, false);
  assert.match(r.data.message, /^paper: text2 on bg is \d\.\d\d:1, needs 4\.5:1/);
  assert.ok(r.data.problems.length >= 1);
  r = await c("appearance.check", { key: "appearance.tokens", value: [1] });
  assert.deepEqual([r.data.ok, r.data.message], [false, "appearance.tokens is an object shaped like a partial tokens.json"]);
  // The preset key: only an installed preset; an old value says where it went.
  assert.equal((await c("appearance.check", { key: "appearance.theme", value: "vyre" })).data.ok, true);
  r = await c("appearance.check", { key: "appearance.theme", value: "kit/ocean" });
  assert.deepEqual([r.data.ok, r.data.message], [false, "appearance.theme: no preset kit/ocean; appearance.presets lists the installed ones"]);
  r = await c("appearance.check", { key: "appearance.theme", value: "paper" });
  assert.match(r.data.message, /paper is a scheme now; set appearance\.scheme to paper/);
  r = await c("appearance.check", { key: "sessions.model", value: "opus" });
  assert.equal(r.data.ok, false);
});

test("appearance: presets lists Vyre's own", async t => {
  const { c } = await world(t);
  const r = await c("appearance.presets");
  assert.deepEqual(r.data, { presets: [{ id: "vyre", label: "Vyre", schemes: ["dark", "paper"] }] });
});

test("appearance: a bad override is refused whole and stores nothing; a good one changes resolve", async t => {
  const { c, root } = await world(t);
  let r = await c("appearance.resolve");
  assert.deepEqual([r.data.theme, r.data.scheme], ["vyre", "system"]);
  assert.equal(r.data.version, SHIPPED);
  assert.deepEqual(r.data.tokens, theme.tokens());
  assert.match(r.data.css, /^:root \{/m);
  assert.match(r.data.css, /^:root\[data-theme="paper"\] \{/m);

  const bad = await c("appearance.tokens.set", { value: { radius: { card: 16 }, control: { touch: 30 } } });
  assert.equal(bad.error.code, "bad_input");
  assert.match(bad.error.message, /control\.touch: 30 is under the 44 pt touch target/);
  assert.deepEqual(bad.error.detail.problems, ["control.touch: 30 is under the 44 pt touch target"]);
  assert.equal((await c("appearance.tokens.get")).data.value, undefined, "nothing stored");
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);

  const since = Number((await request("GET", "/v1/health", undefined, { root })).data.last_event);
  r = await c("appearance.tokens.set", { value: { radius: { card: 16 }, color: { dark: { bg: "#000000" } } } });
  assert.ok(!r.error, JSON.stringify(r.error));
  r = await c("appearance.resolve");
  assert.equal(r.data.tokens.radius.card, 16);
  assert.equal(r.data.tokens.color.dark.bg, "#000000");
  assert.equal(r.data.tokens.color.dark.panel, theme.tokens().color.dark.panel, "merged by key");
  assert.notEqual(r.data.version, SHIPPED);
  assert.match(r.data.css, /--radius-card: 16px;/);
  const ev = (await request("GET", `/v1/events?since=${since}&type=appearance.changed`, undefined, { root })).data;
  assert.deepEqual(ev.map((/** @type {any} */ e) => e.payload), [{ version: r.data.version, theme: "vyre", scheme: "system" }]);

  // null removes it, and the shipped tokens are back.
  await c("appearance.tokens.set", { value: null });
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);
});

test("appearance: only a person writes the tokens; an agent is refused", async t => {
  const { c } = await world(t);
  const r = await c("appearance.tokens.set", { value: { radius: { card: 16 } } }, "mcp:agent:kit");
  assert.equal(r.error.code, "denied");
  assert.equal((await c("appearance.tokens.get")).data.value, undefined);
});

test("appearance: through the hub, settings.set checks the tokens and settings.reset removes them", async t => {
  const { c, hub, root } = await world(t);
  if (!hub) return t.skip("the settings module (native-core) is not on this branch");
  let r = await c("settings.schema");
  const keys = r.data.keys.filter((/** @type {any} */ k) => k.group === "appearance").map((/** @type {any} */ k) => k.key);
  assert.deepEqual(keys, ["appearance.theme", "appearance.scheme", "appearance.tokens"]);

  r = await c("settings.set", { key: "appearance.tokens", value: { color: { dark: { beacon: "#C6F36B" } } } });
  assert.ok(r.error, "refused");
  assert.match(r.error.message, /beacon \(attention\) is reused/);
  assert.deepEqual((await c("settings.get", { key: "appearance.tokens" })).data.value, {}, "the default, nothing stored");
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);

  r = await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 } } });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual([r.data.value, r.data.source], [{ radius: { card: 16 } }, "account"]);
  const after = (await c("appearance.resolve")).data;
  assert.equal(after.tokens.radius.card, 16);
  assert.notEqual(after.version, SHIPPED);

  const since = Number((await request("GET", "/v1/health", undefined, { root })).data.last_event);
  r = await c("settings.set", { key: "appearance.scheme", value: "paper" });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal((await c("appearance.resolve")).data.scheme, "paper");
  // settings.changed is emitted before appearance hears of it; give the listener a turn.
  await new Promise(res => setTimeout(res, 50));
  const ev = (await request("GET", `/v1/events?since=${since}&type=appearance.changed`, undefined, { root })).data;
  assert.deepEqual(ev.map((/** @type {any} */ e) => e.payload), [{ version: after.version, theme: "vyre", scheme: "paper" }], "one event for one change");

  r = await c("settings.reset", { key: "appearance.tokens" });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal((await c("appearance.resolve")).data.version, SHIPPED);
  assert.equal((await c("settings.set", { key: "appearance.scheme", value: "neon" })).error.code, "bad_input");
});

test("appearance: an old theme value (system, dark, paper) reads as the vyre preset and that scheme", async t => {
  const { c, hub } = await world(t);
  if (!hub) return t.skip("the settings module (native-core) is not on this branch");
  const r = await c("settings.set", { key: "appearance.theme", value: "dark" });
  if (r.error) return t.skip(`the hub refuses the old value now (check runs): ${r.error.message}`);
  let x = (await c("appearance.resolve")).data;
  assert.deepEqual([x.theme, x.scheme, x.problems], ["vyre", "dark", undefined]);
  // A scheme the person set wins over the one the old value implied.
  await c("settings.set", { key: "appearance.scheme", value: "paper" });
  x = (await c("appearance.resolve")).data;
  assert.deepEqual([x.theme, x.scheme], ["vyre", "paper"]);
  await c("settings.set", { key: "appearance.theme", value: "system" });
  await c("settings.reset", { key: "appearance.scheme" });
  x = (await c("appearance.resolve")).data;
  assert.deepEqual([x.theme, x.scheme], ["vyre", "system"]);
});

test("appearance: a stored value that breaks a rule never paints; resolve falls back to the preset and names it", async t => {
  const { c, root, hub } = await world(t);
  await c("appearance.tokens.set", { value: { radius: { card: 16 } } });
  // A value saved under older rules, or by hand: written past the check, straight into the table.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(config.paths(root).db);
  db.prepare("UPDATE appearance_tokens SET value = ? WHERE scope = 'account'").run(JSON.stringify({ radius: { card: 16 }, control: { touch: 30 } }));
  db.close();
  let r = (await c("appearance.resolve")).data;
  assert.equal(r.version, SHIPPED, "the preset's tokens, whole");
  assert.equal(r.tokens.radius.card, theme.tokens().radius.card, "not half applied");
  assert.deepEqual(r.problems, ["control.touch: 30 is under the 44 pt touch target"]);
  assert.doesNotMatch(r.css, /--control-touch: 30px/);

  // A preset that isn't installed paints vyre and says so.
  if (!hub) return;
  const s = await c("settings.set", { key: "appearance.theme", value: "kit/ocean" });
  if (s.error) { assert.match(s.error.message, /no preset kit\/ocean/); return; }
  r = (await c("appearance.resolve")).data;
  assert.equal(r.theme, "vyre");
  assert.ok(r.problems.includes('appearance.theme: no preset "kit/ocean"; painting vyre'), r.problems.join("; "));
});

test("appearance: a device's value beats the account's", async t => {
  if (!(await deviceLevel())) return t.skip("the settings registry does not accept the device level yet (ADR 0035, native-core build step 2)");
  // Once it does, the declarations should say so too.
  for (const d of manifest.settings) assert.deepEqual(d.levels, ["account", "device"], `${d.key}: add "device" to its levels (ADR 0035)`);
  const { c, hub } = await world(t);
  if (!hub) return t.skip("the settings module is not running");
  if ((await c("settings.snapshot")).error) return t.skip("settings.snapshot is not there yet (ADR 0035, section 5)");
  await c("settings.set", { key: "appearance.scheme", value: "dark" });
  const r = await c("settings.set", { key: "appearance.scheme", value: "paper", level: "device", device: "tailnet:phone" });
  assert.ok(!r.error, JSON.stringify(r.error));
  const phone = (await c("appearance.resolve", { device: "tailnet:phone" })).data;
  const mac = (await c("appearance.resolve", { device: "mac:studio" })).data;
  assert.deepEqual([phone.scheme, mac.scheme], ["paper", "dark"]);
  assert.equal(typeof phone.rev, "number");
});

test("appearance: format css is only the custom properties, for /theme.css", async t => {
  const { c, root } = await world(t);
  await c("appearance.tokens.set", { value: { radius: { card: 16 } } });
  const full = (await c("appearance.resolve")).data;
  const css = (await c("appearance.resolve", { format: "css" })).data;
  assert.equal(typeof css, "string");
  assert.equal(css, full.css);
  assert.match(css, /--radius-card: 16px;/);
  const r = /** @type {any} */ (await get(root, "/v1/appearance/theme?format=css&device=mac:studio"));
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/css/);
  assert.equal(r.body, css);
  assert.equal((await c("appearance.resolve", { format: "svg" })).error.code, "bad_input");
});

test("appearance: GET /v1/appearance/theme is resolve over HTTP, with the version as its ETag", async t => {
  const { c, root } = await world(t);
  const r = /** @type {any} */ (await get(root, "/v1/appearance/theme"));
  assert.equal(r.status, 200);
  const data = (await c("appearance.resolve")).data;
  assert.deepEqual(JSON.parse(r.body).data, data);
  assert.equal(r.headers.etag, data.rev !== undefined ? `"${data.rev}"` : `"${SHIPPED}-vyre-system"`);
  const again = /** @type {any} */ (await get(root, "/v1/appearance/theme", { "if-none-match": r.headers.etag }));
  assert.equal(again.status, 304);
  // With the hub's rev as the ETag, only a change through the hub moves it.
  if (data.rev !== undefined) await c("settings.set", { key: "appearance.tokens", value: { radius: { card: 16 } } });
  else await c("appearance.tokens.set", { value: { radius: { card: 16 } } });
  const changed = /** @type {any} */ (await get(root, "/v1/appearance/theme", { "if-none-match": r.headers.etag }));
  assert.equal(changed.status, 200, "a change is a new version");
});

test("appearance: the legacy config.theme.colors folds in under the person's tokens, only when it keeps the rules", async t => {
  const { c } = await world(t, { theme: { colors: { dark: { graphite: "#050505", recall: "#EBC76B" }, light: { "rule-strong": "#C0C0C0" } } } });
  let r = (await c("appearance.resolve")).data;
  assert.equal(r.tokens.color.dark.bg, "#050505");
  assert.equal(r.tokens.color.paper.ruleStrong, "#C0C0C0");
  assert.deepEqual(r.legacy, { applied: true, unknown: ["recall"], problems: [] });
  // The person's own tokens win over the legacy colours.
  await c("appearance.tokens.set", { value: { color: { dark: { bg: "#000000" } } } });
  r = (await c("appearance.resolve")).data;
  assert.equal(r.tokens.color.dark.bg, "#000000");
  assert.equal(r.tokens.color.paper.ruleStrong, "#C0C0C0");
});

test("appearance: legacy colours that break a rule are left out, and said so", async t => {
  const { c } = await world(t, { theme: { colors: { dark: { beacon: "#C6F36B" } } } });
  const r = (await c("appearance.resolve")).data;
  assert.equal(r.version, SHIPPED);
  assert.equal(r.legacy.applied, false);
  assert.ok(r.legacy.problems.some((/** @type {string} */ p) => p.includes("beacon (attention) is reused")));
});

test("appearance: switched off, vyred is healthy, the tools and route are gone, /theme.css still serves", async t => {
  const { c, root } = await world(t, { disable: ["appearance"] });
  const h = await request("GET", "/v1/health", undefined, { root });
  assert.ok(h.data && h.data.version, JSON.stringify(h));
  const mods = (await request("GET", "/v1/modules", undefined, { root })).data;
  assert.equal(mods.find((/** @type {any} */ m) => m.name === "appearance").state, "off");
  assert.equal((await c("appearance.resolve")).error.code, "no_such_tool");
  assert.equal(/** @type {any} */ (await get(root, "/v1/appearance/theme")).status, 404);
  assert.equal(/** @type {any} */ (await get(root, "/theme.css")).status, 200);
  const s = await c("settings.schema");
  if (!s.error) assert.ok(!s.data.keys.some((/** @type {any} */ k) => k.key.startsWith("appearance.")), "its settings go with it");
});
