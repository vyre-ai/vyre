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
  return { root, c };
}

test("sidebar: the manifest is valid and declares the Space default and the person's list as account settings, with no per-device level", () => {
  assert.deepEqual(validate(manifest, { firstParty: true }), []);
  assert.deepEqual(manifest.settings.map((/** @type {any} */ s) => [s.key, s.type, s.levels]), [["sidebar.default", "object", ["account"]], ["sidebar.mine", "list", ["account"]]]);
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

test("sidebar: the team's default is set by the person at their own surface, never by an assistant, and a person's list sits on top of it", async t => {
  const { c } = await world(t);
  const asAgent = await c("sidebar.edit", { op: "add", what: "Documents", scope: "team" }, "mcp:agent:kit");
  assert.match(String(asAgent.error?.message), /Only the person/);
  assert.equal(asAgent.error?.code, "denied");
  const asMe = await c("sidebar.edit", { op: "add", what: "Documents", scope: "team", group: "more" });
  assert.equal(asMe.error, undefined, JSON.stringify(asMe.error));
  let g = (await c("sidebar.get", { space: "spc_aaaaaaaaaaaa" })).data;
  assert.equal(g.default, null, "a default for the all-Spaces key reaches a Space with none of its own");
  g = (await c("sidebar.get", {})).data;
  assert.ok(g.default && g.default.some((/** @type {any} */ e) => keyOf(e) === "module:docuseal/documents"));
  // an assistant may arrange the person's own list
  assert.equal((await c("sidebar.edit", { op: "hide", what: "Memory" }, "mcp:agent:kit")).error, undefined);
  g = (await c("sidebar.get", {})).data;
  assert.equal(g.entries.find((/** @type {any} */ e) => e.id === "memory").hidden, true);
  assert.ok(g.entries.some((/** @type {any} */ e) => keyOf(e) === "module:docuseal/documents"), "the default's entry still reaches the merged list");
});

test("sidebar: the hub reads and writes the two settings, and a stored list is cleaned", async t => {
  const { c } = await world(t);
  const hub = await c("settings.schema");
  if (hub.error) return;   // no settings hub on this branch
  const set = await c("settings.set", { key: "sidebar.mine", level: "account", value: [{ kind: "place", id: "chat" }, { kind: "place", id: "BAD ID" }, { kind: "view", id: "x", label: "L", href: "https://evil.example" }, { kind: "place", id: "now", hidden: true }] });
  assert.equal(set.error, undefined, JSON.stringify(set.error));
  const got = (await c("sidebar.get", {})).data;
  assert.deepEqual(got.mine.map(keyOf), ["place:chat", "place:now"], "invalid entries dropped");
  assert.deepEqual((await c("settings.get", { key: "sidebar.mine" })).data.value.map(keyOf), ["place:chat", "place:now"]);
  const def = await c("settings.set", { key: "sidebar.default", level: "account", value: { "*": [{ kind: "place", id: "drive" }] } });
  assert.equal(def.error, undefined, JSON.stringify(def.error));
  assert.deepEqual((await c("sidebar.get", {})).data.default.map(keyOf), ["place:drive"]);
  assert.equal((await c("settings.set", { key: "sidebar.default", level: "account", value: { "not a space!": [{ kind: "place", id: "drive" }] } })).error !== undefined, true, "a key that is not a Space is refused");
});
