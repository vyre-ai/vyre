// @ts-check
// The Space's first page for each role (spaces.landing): the setting the spaces module owns, the
// check the settings hub calls before it stores a value, and the read the spaces list carries.
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
import { KEY, ROLE_IDS, landingProblems, landingValue, roleKey } from "./landing.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"));

/** A vyred in a temp home, with the settings hub and the spaces module running. @param {any} t */
async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
  return { root, c, d };
}

test("spaces: the manifest is valid and declares the first page for each role as an account setting, checked by the module's own tool", () => {
  assert.deepEqual(validate(manifest, { firstParty: true }), []);
  const s = manifest.settings.find((/** @type {any} */ x) => x.key === KEY);
  assert.ok(s, "the spaces module declares spaces.landing");
  assert.deepEqual([s.type, s.levels, s.apply, s.check.tool], ["object", ["account"], "live", "spaces.check"]);
  assert.ok(manifest.does.tools.some((/** @type {any} */ t) => typeof t === "object" && t.name === "spaces.check"), "the check tool is the module's own");
});

test("spaces: the roles are the four a person sees, and the kernel's temp is the guest", () => {
  assert.deepEqual([...ROLE_IDS], ["owner", "admin", "member", "guest"]);
  assert.deepEqual(landingProblems({ owner: "/u/now", admin: "/u/chats", member: "/u/records/contact", guest: "/u/now" }), []);
  assert.equal(roleKey("owner"), "owner");
  assert.equal(roleKey("admin"), "admin");
  assert.equal(roleKey("member"), "member");
  assert.equal(roleKey("temp"), "guest", "the kernel's temp is the person-facing guest");
  assert.equal(roleKey("manager"), null, "a role with no key of its own has no first page");
  assert.equal(roleKey(""), null);
});

test("spaces: a value that is not a set of first pages is refused, with the next step", () => {
  assert.match(landingProblems("/u/now")[0], /set of first pages/);
  assert.match(landingProblems(["/u/now"])[0], /set of first pages/);
  assert.match(landingProblems({ boss: "/u/now" })[0], /is not a role/);
  assert.match(landingProblems({ owner: "https://example.com" })[0], /must be a page of the app/);
  assert.match(landingProblems({ owner: "/u/now/../settings" })[0], /must be a page of the app/);
  assert.match(landingProblems({ owner: 7 })[0], /must be a page of the app/);
});

test("spaces: the setting goes through the hub, and a bad value is refused before it is stored", async t => {
  const { c } = await world(t);
  const set = await c("settings.set", { key: KEY, level: "account", value: { member: "/u/chats" } });
  assert.equal(set.error, undefined, JSON.stringify(set.error));
  const got = await c("settings.get", { key: KEY });
  assert.deepEqual(got.data.value, { member: "/u/chats" });
  const bad = await c("settings.set", { key: KEY, level: "account", value: { boss: "/u/now" } });
  assert.ok(bad.error, "a role that is not one of ours is refused");
  assert.match(bad.error.message, /is not a role/);
  assert.deepEqual((await c("settings.get", { key: KEY })).data.value, { member: "/u/chats" }, "the value that was there stays");
  const route = await c("settings.set", { key: KEY, level: "account", value: { member: "/u/chats/../now" } });
  assert.ok(route.error, "a route that walks up the tree is refused");
  assert.match(route.error.message, /must be a page of the app/);
});

test("spaces: the value is read from the hub for the list, and nothing when it is off", async () => {
  const ctx = { call: async (/** @type {string} */ tool, /** @type {any} */ input) => { assert.equal(tool, "settings.get"); assert.equal(input.key, KEY); return { data: { value: { member: "/u/chats" } } }; } };
  assert.deepEqual(await landingValue(ctx), { member: "/u/chats" });
  const off = { call: async () => { throw Object.assign(new Error("no settings hub"), { code: "unavailable" }); } };
  assert.equal(await landingValue(off), null, "no hub, no first page: the app opens Home");
  const empty = { call: async () => ({ data: { value: undefined } }) };
  assert.equal(await landingValue(empty), null, "nothing set, no first page");
});
