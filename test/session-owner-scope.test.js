// @ts-check
// reviewer-2's KW-1: a member's `*/*` read grant covered `vyre://<space>/session/<id>`, so any member read any person's session lines. A session is now owner-scoped in the kernel: reading one needs the
// session's `owner` attribute (offered by a first-party module that declared needs.kernel.attrs) to name the person asking; no attribute, no reader. Real kernel rig.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "./kernel-rig.js";

const SPACE = "spc_aaaaaaaaaaaa";
const s = (/** @type {string} */ id) => `vyre://${SPACE}/session/${id}`;

test("a session is read only by its owner: a member with a */* read grant, a manager and an admin cannot read another person's, the owner can, an unattributed one is read by nobody", async () => {
  const rig = await createRig({ space: SPACE, people: { per_bob: "member", per_cat: "manager", per_dan: "admin", per_eve: "member" } });
  const handle = rig.k.kernelFor({ name: "work", needs: { kernel: { actions: [], attrs: true } } });
  handle.registerAttrs("session", (/** @type {string} */ urn) => (urn === s("alex-chat") ? { owner: "per_eve" } : urn === s("bob-chat") ? { owner: "per_bob" } : {}));
  const may = async (/** @type {any} */ chain, /** @type {string} */ resource) => (await rig.k.gateway.authorize({ chain, action: "records.read", resource })).effect !== "deny";
  assert.equal(await may(rig.person("per_eve"), s("alex-chat")), true, "the owner of the session reads it");
  for (const p of ["per_bob", "per_cat", "per_dan", "per_alex"]) assert.equal(await may(rig.person(p), s("alex-chat")), false, `${p} must not read another person's session`);
  assert.equal(await may(rig.person("per_bob"), s("bob-chat")), true, "a member reads their own");
  assert.equal(await may(rig.person("per_eve"), s("bob-chat")), false);
  assert.equal(await may(rig.person("per_bob"), s("unattributed")), false, "no owner attribute: nobody (fail closed)");
  assert.equal(await may(rig.ownerChain, s("unattributed")), false, "not even the Space's owner");
  // the viewer chain the work module reads under (person + its service) is still the person's reach, and no wider
  const viaWork = rig.withService(rig.person("per_bob"), "work");
  assert.equal(await may(viaWork, s("alex-chat")), false);
  // other resource types are untouched
  assert.equal(await may(rig.person("per_bob"), `vyre://${SPACE}/contact/c1`), true);
});

test("registerAttrs exists only for a module that declared needs.kernel.attrs", async () => {
  const rig = await createRig({ space: SPACE });
  const plain = rig.k.kernelFor({ name: "notes", needs: { kernel: { actions: [] } } });
  assert.equal(typeof plain.registerAttrs, "undefined");
});

test("installModule takes actions per prefix: a service is narrowed to its own types, a change replaces its grants, the same again changes nothing", async () => {
  const rig = await createRig({ space: SPACE, defs: [] });
  const gs = rig.k.grants;
  const mine = (/** @type {string} */ name) => [...gs.list ? [] : []];
  const may = async (/** @type {string} */ svc, /** @type {string} */ action, /** @type {string} */ resource) => (await rig.k.gateway.authorize({ chain: rig.k.gateway.serviceChain(svc), action, resource })).effect !== "deny";
  await gs.installModule("flows", { actions: [], grants: [{ prefix: "flow/*", actions: ["records.read", "records.create"] }, { prefix: "run/*", actions: ["records.read"] }] });
  assert.equal(await may("flows", "records.create", `vyre://${SPACE}/flow/f1`), true);
  assert.equal(await may("flows", "records.create", `vyre://${SPACE}/run/r1`), false, "run is read only");
  assert.equal(await may("flows", "records.read", `vyre://${SPACE}/run/r1`), true);
  assert.equal(await may("flows", "records.read", `vyre://${SPACE}/contact/c1`), false, "nothing outside its own types");
  void mine;
  const before = rig.k.log.read({ type: "grant.created" }).length;
  await gs.installModule("flows", { actions: [], grants: [{ prefix: "flow/*", actions: ["records.read", "records.create"] }, { prefix: "run/*", actions: ["records.read"] }] });
  assert.equal(rig.k.log.read({ type: "grant.created" }).length, before, "the same grants again write nothing");
  await gs.installModule("flows", { actions: [], grants: [{ prefix: "flow/*", actions: ["records.read"] }] });
  assert.equal(await may("flows", "records.create", `vyre://${SPACE}/flow/f1`), false, "narrowed: create is gone");
  assert.equal(await may("flows", "records.read", `vyre://${SPACE}/run/r1`), false, "and run with it");
});

test("AT-1: a provider supplies only owner and project, only for a type it may; the kernel's own keys win", async () => {
  const rig = await createRig({ space: SPACE });
  const h = rig.k.kernelFor({ name: "work", needs: { kernel: { actions: [], attrs: true, attrTypes: ["note"] } } });
  assert.throws(() => h.registerAttrs("contact", () => ({})), /declared/, "a type the module did not declare");
  h.registerAttrs("note", () => ({ owner: "per_x", sensitivity: "normal", space: "spc_other" }));
  // the provider's sensitivity and space are ignored: only owner survives
  const seen = await rig.k.gateway.authorize({ chain: rig.ownerChain, action: "records.read", resource: `vyre://${SPACE}/note/n1` });
  assert.notEqual(seen.reason, "wrong_space", "a provider cannot move a resource to another space");
});

test("per-prefix grants: a reinstall that WIDENS a prefix replaces the old grants (never adds beside them), so nothing stays wider than the latest declaration", async () => {
  const rig = await createRig({ space: SPACE });
  const may = async (/** @type {string} */ action, /** @type {string} */ res) => (await rig.k.gateway.authorize({ chain: rig.k.gateway.serviceChain("flows"), action, resource: res })).effect !== "deny";
  await rig.k.grants.installModule("flows", { actions: [], grants: [{ prefix: "flow/*", actions: ["records.read"] }] });
  assert.equal(await may("records.create", `vyre://${SPACE}/flow/f1`), false);
  await rig.k.grants.installModule("flows", { actions: [], grants: [{ prefix: "flow/*", actions: ["records.read", "records.create"] }, { prefix: "*/*", actions: ["records.read"] }] });
  assert.equal(await may("records.create", `vyre://${SPACE}/flow/f1`), true, "the widened declaration is what is in force");
  await rig.k.grants.installModule("flows", { actions: [], grants: [{ prefix: "flow/*", actions: ["records.read"] }] });
  assert.equal(await may("records.create", `vyre://${SPACE}/flow/f1`), false, "narrowed again: the wider one is gone");
  assert.equal(await may("records.read", `vyre://${SPACE}/contact/c1`), false);
});
