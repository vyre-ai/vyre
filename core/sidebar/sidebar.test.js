// @ts-check
// The sidebar module in a real vyred in a temp home: its two settings through the settings hub, the merged answer, the edits the assistant makes by name, and who may set the team's.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { validate } from "../modules/index.js";
import { tempHome } from "../../test/helpers.js";
import { keyOf } from "../../lib/sidebar/model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"));

/** A vyred in a temp home, with a module installed that has two screens. @param {any} t */
async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const dir = path.join(root, "modules", "docuseal");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "docuseal", version: "0.1.0", description: "Documents.", roles: ["box"], requires: [], does: { tools: [] }, watches: {}, shows: { cli: [] }, needs: {}, teaches: {},
    screens: [{ id: "documents", label: "Documents", path: "documents" }, { id: "templates", label: "Templates", path: "templates" }] }));
  fs.writeFileSync(path.join(dir, "index.js"), "export default { async start() { return {}; } };\n");
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
  return { root, c, d };
}

test("sidebar: the manifest is valid and declares the Space default and the person's list as account settings, with no per-device level", () => {
  assert.deepEqual(validate(manifest, { firstParty: true }), []);
  assert.deepEqual(manifest.settings.map((/** @type {any} */ s) => [s.key, s.type, s.levels]), [["sidebar.default", "object", ["account"]], ["sidebar.mine", "object", ["account"]]]);
});

test("sidebar: with nothing stored the built-in places are the default, and an installed module's screens are offered", async t => {
  const { c } = await world(t);
  const r = (await c("sidebar.get", {})).data;
  assert.equal(r.default, null);
  assert.deepEqual(r.mine, []);
  assert.deepEqual(r.entries.slice(0, 3).map(keyOf), ["place:now", "place:chat", "place:projects"]);
  assert.ok(r.entries.some((/** @type {any} */ e) => e.id === "settings"));
  const m = r.modules.find((/** @type {any} */ x) => x.module === "docuseal");
  assert.deepEqual(m && m.screens.map((/** @type {any} */ s) => s.id), ["documents", "templates"]);
});

test("sidebar: \"put Documents in my sidebar\" adds the module screen for me, and it shows in the merged list", async t => {
  const { c } = await world(t);
  const r = await c("sidebar.edit", { op: "add", what: "Documents" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.scope, "me");
  const got = (await c("sidebar.get", {})).data;
  assert.ok(got.entries.some((/** @type {any} */ e) => keyOf(e) === "module:docuseal/documents"));
  assert.deepEqual(got.mine.map(keyOf).includes("module:docuseal/documents"), true);
  assert.equal(got.default, null, "the team's default was not touched");
  assert.match(String((await c("sidebar.edit", { op: "add", what: "Nonexistent thing" })).error?.message), /could not tell which/);
  assert.match(String((await c("sidebar.edit", { op: "add", entry: { kind: "module", module: "docuseal", screen: "nope" } })).error?.message), /not installed/);
});

test("sidebar: hide, show, move, group and remove", async t => {
  const { c } = await world(t);
  await c("sidebar.edit", { op: "hide", what: "Vault" });
  let g = (await c("sidebar.get", {})).data;
  assert.equal(g.entries.find((/** @type {any} */ e) => e.id === "vault").hidden, true);
  await c("sidebar.edit", { op: "show", key: "place:vault" });
  g = (await c("sidebar.get", {})).data;
  assert.ok(!g.entries.find((/** @type {any} */ e) => e.id === "vault").hidden);
  await c("sidebar.edit", { op: "move", key: "place:kits", index: 0 });
  assert.equal((await c("sidebar.get", {})).data.entries[0].id, "kits");
  await c("sidebar.edit", { op: "group", what: "Drive", group: "Work" });
  assert.equal((await c("sidebar.get", {})).data.entries.find((/** @type {any} */ e) => e.id === "drive").group, "Work");
  await c("sidebar.edit", { op: "remove", what: "Flows" });
  assert.equal((await c("sidebar.get", {})).data.entries.find((/** @type {any} */ e) => e.id === "flows").hidden, true, "a place is hidden, not deleted");
  assert.equal((await c("sidebar.edit", { op: "hide", key: "place:settings" })).data.ok, true);
  assert.ok(!(await c("sidebar.get", {})).data.entries.find((/** @type {any} */ e) => e.id === "settings").hidden, "settings cannot be hidden");
});

test("sidebar: the team's default is sidebar.team: the person sets it, and a person's own list sits on top of it", async t => {
  const { c } = await world(t);
  const r = await c("sidebar.team", { op: "add", what: "Documents", group: "more" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.scope, "team");
  let g = (await c("sidebar.get", { space: "spc_aaaaaaaaaaaa" })).data;
  assert.ok(g.default && g.default.some((/** @type {any} */ e) => keyOf(e) === "module:docuseal/documents"), "a default for the all-Spaces key reaches a Space with none of its own");
  assert.equal(g.can_set_default, true);
  g = (await c("sidebar.get", {})).data;
  assert.ok(g.default && g.default.some((/** @type {any} */ e) => keyOf(e) === "module:docuseal/documents"));
  // an assistant may arrange the person's OWN list at once
  assert.equal((await c("sidebar.edit", { op: "hide", what: "Memory" }, "mcp")).error, undefined);
  g = (await c("sidebar.get", {})).data;
  assert.equal(g.entries.find((/** @type {any} */ e) => e.id === "memory").hidden, true);
  assert.ok(g.entries.some((/** @type {any} */ e) => keyOf(e) === "module:docuseal/documents"), "the default's entry still reaches the merged list");
  assert.deepEqual((await c("sidebar.get", {}, "mcp")).data.can_set_default, false, "an assistant is told it may not set the default itself");
});

test("sidebar: a proven assistant's change to the team's default is held for a yes: it is not made and not flatly refused", async t => {
  const { d } = await world(t);
  const r = await d.registry.call("sidebar.team", { op: "add", what: "Documents" }, "mcp:agent:kit", { thread: "thr_abcdefgh" });
  assert.ok(r.error, JSON.stringify(r));
  assert.notEqual(r.error.code, "denied", `held, not refused: ${JSON.stringify(r.error)}`);
  assert.doesNotMatch(String(r.error.message), /not available|Only an owner/);
  assert.equal((await d.registry.call("sidebar.get", {}, "cli", {})).data.default, null, "nothing changed");
  // the same assistant arranges the person's own list at once
  const own = await d.registry.call("sidebar.edit", { op: "hide", what: "Memory" }, "mcp:agent:kit", { thread: "thr_abcdefgh" });
  assert.equal(own.error, undefined, JSON.stringify(own.error));
});

test("sidebar: set replaces a whole list (the app's drag and drop), cleaned, for me and for the team", async t => {
  const { c } = await world(t);
  const r = await c("sidebar.edit", { op: "set", entries: [{ kind: "place", id: "drive" }, { kind: "place", id: "now" }, { kind: "bad" }, { kind: "place", id: "drive" }] });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.data.entries.map(keyOf), ["place:drive", "place:now"]);
  assert.deepEqual((await c("sidebar.get", {})).data.mine.map(keyOf), ["place:drive", "place:now"]);
  assert.match(String((await c("sidebar.edit", { op: "set", entries: [] })).error?.message), /at least one/);
  assert.equal((await c("sidebar.get", {})).data.default, null, "nothing was set for the team by that");
  assert.equal((await c("sidebar.team", { op: "set", entries: [{ kind: "place", id: "now" }] })).error, undefined);
  assert.deepEqual((await c("sidebar.get", {})).data.default.map(keyOf), ["place:now"]);
});

test("sidebar: reset drops my own list and leaves the team's", async t => {
  const { c } = await world(t);
  await c("sidebar.team", { op: "hide", what: "Vault" });
  await c("sidebar.edit", { op: "hide", what: "Flows" });
  assert.deepEqual((await c("sidebar.get", {})).data.entries.filter((/** @type {any} */ e) => e.hidden).map((/** @type {any} */ e) => e.id).sort(), ["flows", "vault"]);
  assert.equal((await c("sidebar.edit", { op: "reset" })).error, undefined);
  const g = (await c("sidebar.get", {})).data;
  assert.deepEqual(g.mine, []);
  assert.deepEqual(g.entries.filter((/** @type {any} */ e) => e.hidden).map((/** @type {any} */ e) => e.id), ["vault"], "the team's choice stands");
});

test("sidebar: the hub reads and writes the two settings, and a stored list is cleaned", async t => {
  const { c } = await world(t);
  const hub = await c("settings.schema");
  if (hub.error) return;   // no settings hub on this branch
  const set = await c("settings.set", { key: "sidebar.mine", level: "account", value: { entries: [{ kind: "place", id: "chat" }, { kind: "place", id: "BAD ID" }, { kind: "view", id: "x", label: "L", href: "https://evil.example" }, { kind: "place", id: "now", hidden: true }] } });
  assert.equal(set.error, undefined, JSON.stringify(set.error));
  const got = (await c("sidebar.get", {})).data;
  assert.deepEqual(got.mine.map(keyOf), ["place:chat", "place:now"], "invalid entries dropped");
  assert.deepEqual((await c("settings.get", { key: "sidebar.mine" })).data.value.entries.map(keyOf), ["place:chat", "place:now"]);
  const def = await c("settings.set", { key: "sidebar.default", level: "account", value: { "*": [{ kind: "place", id: "drive" }] } });
  assert.equal(def.error, undefined, JSON.stringify(def.error));
  assert.deepEqual((await c("sidebar.get", {})).data.default.map(keyOf), ["place:drive"]);
  assert.equal((await c("settings.set", { key: "sidebar.default", level: "account", value: { "not a space!": [{ kind: "place", id: "drive" }] } })).error !== undefined, true, "a key that is not a Space is refused");
});
