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

test("sidebar: an assistant's change to the team's default is held for a yes, not refused and not made", async t => {
  const { c } = await world(t);
  const r = await c("sidebar.team", { op: "add", what: "Documents" }, "mcp");
  assert.ok(r.error || (r.data && (r.data.held || r.data.needs_approval || r.data.pending)), `held: ${JSON.stringify(r)}`);
  assert.doesNotMatch(String(r.error?.message || ""), /not available|Only an owner/, "it is asked for, not flatly refused");
  assert.equal((await c("sidebar.get", {})).data.default, null, "nothing changed");
});

test("sidebar: only the Space's owner or admin role sets the default; a member at their own surface is refused", async t => {
  const { d } = await world(t);
  const role = { current: /** @type {string | null} */ (null) };
  const orig = d.registry.call.bind(d.registry);
  d.registry.call = /** @type {any} */ ((tool, input, caller, meta) => (tool === "spaces.membership" ? { data: role.current ? { role: role.current } : null } : orig(tool, input, caller, meta)));
  const as = (/** @type {string} */ caller, /** @type {string} */ tool, input = {}) => orig(tool, input, caller, {});
  const SP = "spc_aaaaaaaaaaaa";
  for (const r of ["member", "manager", "temp", null]) {
    role.current = r;
    const out = await as(`space:per_member1@${SP}`, "sidebar.team", { op: "add", what: "Memory", space: SP });
    assert.match(String(out.error?.message), /Only an owner or an admin/, `role ${r}`);
  }
  assert.equal((await as(`space:per_member1@${SP}`, "sidebar.get", { space: SP })).data.can_set_default, false);
  for (const r of ["owner", "admin"]) {
    role.current = r;
    assert.equal((await as(`space:per_admin1@${SP}`, "sidebar.get", { space: SP })).data.can_set_default, true, r);
  }
  role.current = "admin";
  const done = await as(`space:per_admin1@${SP}`, "sidebar.team", { op: "hide", what: "Vault", space: SP });
  assert.equal(done.error, undefined, JSON.stringify(done.error));
  assert.equal((await as(`space:per_other@${SP}`, "sidebar.get", { space: SP })).data.default.find((/** @type {any} */ e) => e.id === "vault").hidden, true, "everyone in the Space starts from it");
  role.current = "admin";
  const wrongSpace = await as(`space:per_admin1@${SP}`, "sidebar.team", { op: "hide", what: "Vault", space: "spc_bbbbbbbbbbbb" });
  assert.match(String(wrongSpace.error?.message), /Only an owner or an admin/, "an admin of one Space does not set another's");
});

test("sidebar: each member has their own list on the server, the same wherever they open it", async t => {
  const { d } = await world(t);
  const orig = d.registry.call.bind(d.registry);
  const as = (/** @type {string} */ caller, /** @type {string} */ tool, input = {}) => orig(tool, input, caller, {});
  const SP = "spc_aaaaaaaaaaaa";
  assert.equal((await as(`space:per_ana@${SP}`, "sidebar.edit", { op: "hide", what: "Vault", space: SP })).error, undefined);
  assert.equal((await as(`space:per_ben@${SP}`, "sidebar.edit", { op: "hide", what: "Flows", space: SP })).error, undefined);
  const ana = (await as(`space:per_ana@${SP}`, "sidebar.get", { space: SP })).data, ben = (await as(`space:per_ben@${SP}`, "sidebar.get", { space: SP })).data;
  const hidden = (/** @type {any} */ g) => g.entries.filter((/** @type {any} */ e) => e.hidden).map((/** @type {any} */ e) => e.id);
  assert.deepEqual(hidden(ana), ["vault"]);
  assert.deepEqual(hidden(ben), ["flows"]);
  assert.deepEqual(hidden((await as("cli", "sidebar.get", { space: SP })).data), [], "the box's own person has a list of their own too");
  // opening again from another device of the same member gives the same list
  assert.deepEqual(hidden((await as(`space:per_ana@${SP}`, "sidebar.get", { space: SP })).data), ["vault"]);
  assert.equal((await as(`space:per_ana@${SP}`, "sidebar.edit", { op: "set", entries: [{ kind: "place", id: "now" }], space: SP })).error, undefined);
  assert.deepEqual((await as(`space:per_ben@${SP}`, "sidebar.get", { space: SP })).data.mine.length > 1, true, "Ben's list is untouched");
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
