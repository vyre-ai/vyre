// @ts-check
// A team's members and the sidebar service of the Space's kernel (core/sidebar/service.js): each member has their own list on the server, the same wherever they open it; the Space's
// default is set by the owner or admin ROLE the kernel states and by no one else; and a request that is not from one member's own chain gets nothing.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createSidebarService, } from "./service.js";
import { keyOf } from "../../lib/sidebar/model.js";
import { CALLS } from "../../kernel/remote/wire.js";

const SP = "spc_aaaaaaaaaaaa";
const ROLES = /** @type {Record<string, string | null>} */ ({ per_owner: "owner", per_admin: "admin", per_manager: "manager", per_ana: "member", per_ben: "member", per_temp: "temp" });

/** A Space's home with a fake kernel that states each person's role. @param {any} t */
async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const kernel = { gateway: { members: { roleOf: (/** @type {any} */ a) => (a.space === SP ? ROLES[a.id] ?? null : null) } } };
  const svc = createSidebarService({ space: SP, kernel, registry: d.registry });
  const chain = (/** @type {string} */ person, space = SP) => ({ space, hops: [{ actor: { kind: "person", id: person, space } }] });
  const as = (/** @type {string} */ person, /** @type {"get" | "edit" | "team"} */ call, input = {}) => svc[call](chain(person), input);
  const hidden = (/** @type {any} */ g) => g.entries.filter((/** @type {any} */ e) => e.hidden).map((/** @type {any} */ e) => e.id);
  return { d, svc, as, chain, hidden };
}

test("the sidebar is a group of the Space kernel's remote calls", () => {
  assert.deepEqual(CALLS.sidebar, ["get", "edit", "team"]);
});

test("each member has their own list on the server, the same wherever they open it, and the box's own person has theirs", async t => {
  const { d, as, hidden } = await world(t);
  await as("per_ana", "edit", { op: "hide", what: "Vault" });
  await as("per_ben", "edit", { op: "hide", what: "Flows" });
  assert.deepEqual(hidden(await as("per_ana", "get")), ["vault"]);
  assert.deepEqual(hidden(await as("per_ben", "get")), ["flows"]);
  assert.deepEqual(hidden(await as("per_ana", "get")), ["vault"], "opened again, from another device: the same list");
  assert.deepEqual(hidden((await d.registry.call("sidebar.get", {}, "cli", {})).data), [], "the box's own person is not a member's list");
  await as("per_ana", "edit", { op: "set", entries: [{ kind: "place", id: "now" }, { kind: "place", id: "settings" }] });
  assert.equal((await as("per_ana", "get")).mine.length, 2);
  assert.ok((await as("per_ben", "get")).mine.length > 2, "Ben's list is untouched");
});

test("only the Space's owner or admin role sets the default; a member, a manager and a temp at their own surface are refused", async t => {
  const { as, hidden } = await world(t);
  for (const person of ["per_ana", "per_manager", "per_temp"]) {
    assert.equal((await as(person, "get")).can_set_default, false, person);
    await assert.rejects(as(person, "team", { op: "hide", what: "Memory" }), e => /Only an owner or an admin/.test(String(/** @type {any} */ (e).message)) && /** @type {any} */ (e).code === "not_allowed", person);
  }
  for (const person of ["per_owner", "per_admin"]) assert.equal((await as(person, "get")).can_set_default, true, person);
  const done = await as("per_admin", "team", { op: "hide", what: "Vault" });
  assert.equal(done.scope, "team");
  assert.deepEqual(hidden(await as("per_ben", "get")), ["vault"], "everyone in the Space starts from it");
  // a member's own list sits on top of it
  await as("per_ben", "edit", { op: "show", what: "Vault" });
  assert.deepEqual(hidden(await as("per_ben", "get")), [], "Ben showed it again for himself");
  assert.deepEqual(hidden(await as("per_ana", "get")), ["vault"], "Ana still starts from the team's");
});

test("a request from someone who is not a member, from another Space, or from more than one person's chain gets nothing", async t => {
  const { svc, chain } = await world(t);
  await assert.rejects(svc.get(chain("per_stranger"), {}), /** @type {any} */ e => e.code === "not_found");
  await assert.rejects(svc.get(chain("per_ana", "spc_bbbbbbbbbbbb"), {}), /** @type {any} */ e => e.code === "not_found");
  await assert.rejects(svc.get({ space: SP, hops: [{ actor: { kind: "person", id: "per_ana", space: SP } }, { actor: { kind: "agent", id: "kit", space: SP } }] }, {}), /** @type {any} */ e => e.code === "not_found");
  await assert.rejects(svc.team(chain("per_ana"), { op: "set", entries: [{ kind: "place", id: "now" }], as: "per_owner" }), /Only an owner/, "a request cannot name its own person or role");
});

test("through the Space's remote server: a member's sidebar call arrives as a kernel call and answers, and the role is the kernel's", async t => {
  const { d } = await world(t);
  const { createRemoteServer } = await import("../../kernel/remote/server.js");
  const kernel = {
    gateway: { members: { roleOf: (/** @type {any} */ a) => (a.space === SP ? ROLES[a.id] ?? null : null) } },
    chains: { fromFacts: async (/** @type {any} */ f) => ({ space: SP, hops: [{ actor: { kind: "person", id: f.person, space: SP } }] }) },
  };
  const server = createRemoteServer({ space: SP, kernel, log: () => {}, services: { sidebar: createSidebarService({ space: SP, kernel, registry: d.registry }) } });
  let n = 0;
  const ask = async (/** @type {string} */ person, /** @type {string} */ call, /** @type {any} */ arg) => server.serve({ v: 1, space: SP, id: `rq_${++n}`, ts: Date.now(), call, args: [arg] }, { device_key_id: `dk_${person}`, person, path: "relay" });
  const g = /** @type {any} */ (await ask("per_ana", "sidebar.get", {}));
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.result.can_set_default, false);
  const e = /** @type {any} */ (await ask("per_ana", "sidebar.edit", { op: "hide", what: "Vault" }));
  assert.equal(e.ok, true, JSON.stringify(e));
  const refused = /** @type {any} */ (await ask("per_ana", "sidebar.team", { op: "hide", what: "Vault" }));
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /Only an owner or an admin/);
  const admin = /** @type {any} */ (await ask("per_admin", "sidebar.team", { op: "hide", what: "Memory" }));
  assert.equal(admin.ok, true, JSON.stringify(admin));
  assert.equal(((/** @type {any} */ (await ask("per_ben", "sidebar.get", {}))).result.entries.find((/** @type {any} */ x) => x.id === "memory")).hidden, true);
  assert.equal((/** @type {any} */ (await ask("per_stranger", "sidebar.get", {}))).ok, false, "a person the Space does not know gets nothing");
});
