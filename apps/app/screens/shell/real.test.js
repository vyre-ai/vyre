// @ts-check
// The shell on the real box against a fake box shaped like the dev box's spaces.list and spaces.identity.status.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const S1 = { id: "spc_a", name: "juniperdev.vyre.run", label: "juniperdev", displayName: "Juniper Studio", status: "done", role: "owner" };
const S2 = { id: "spc_b", name: "mine.vyre.run", label: "mine", status: "done", role: "member" };
const ID = { exists: true, name: "devbox.vyre.run", label: "devbox", pending: false };

/** @param {any} spaces @param {any} id */
const box = (spaces, id) => async (/** @type {string} */ tool) => (tool === "spaces.list" ? spaces : tool === "spaces.identity.status" ? id : { data: {} });

/** The shell's data from a fake box, through the source and the model. */
async function load1(/** @type {any} */ sp, /** @type {any} */ id) {
  const { shellSource } = await import("./real-source.ts");
  const { shellFrom } = await import("./real-model.ts");
  const r = await shellSource(/** @type {any} */ (box(sp, id))).load();
  return shellFrom(r.spaces, r.identity);
}

test("one space is the whole switcher; two are just the two; names and roles are the box's", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const { shellFrom } = await import("./real-model.ts");
  const load = async (/** @type {any} */ sp, /** @type {any} */ id) => { const r = await shellSource(/** @type {any} */ (box(sp, id))).load(); return shellFrom(r.spaces, r.identity); };
  const one = await load({ data: [S1] }, { data: ID });
  assert.deepEqual(one.spaces, [{ id: "spc_a", name: "Juniper Studio", tag: "Juniper Studio", sub: "Owner", address: "juniperdev.vyre.run" }], "the tag is the space's own name");
  const two = await load({ data: [S1, S2] }, { data: ID });
  assert.deepEqual(two.spaces.map((s) => [s.id, s.name, s.sub]), [["spc_a", "Juniper Studio", "Owner"], ["spc_b", "mine", "Member"]]);
});

test("the person is their identity on this box, and a missing identity still shows the spaces", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const d = await load1({ data: [S1] }, { data: ID });
  assert.deepEqual(d.me, { name: "Devbox", sub: "devbox.vyre.run", vyreName: "devbox.vyre.run" });
  const none = await load1({ data: [S1] }, { error: { code: "not_found", message: "no identity" } });
  assert.deepEqual(none.me, { name: "You", sub: "", vyreName: "" });
  assert.equal(none.spaces.length, 1);
});

test("a box with no identity of its own shows the name this computer has, never You", { skip: !strip }, async () => {
  const { pickIdentity, meFrom } = await import("./real-model.ts");
  const host = { exists: true, name: "sam.vyre.run", label: "Sam" };
  assert.deepEqual(meFrom(pickIdentity(null, host)), { name: "Sam", sub: "sam.vyre.run", vyreName: "sam.vyre.run" });
  assert.equal(pickIdentity({ name: "devbox.vyre.run" }, host)?.name, "devbox.vyre.run", "the box's own wins");
  assert.equal(pickIdentity(null, null), null);
});

test("a space still being created says so, and an empty box has no Space", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const d = await load1({ data: [{ ...S2, status: "creating" }] }, { data: ID });
  assert.equal(d.spaces[0].sub, "Setting up");
  const dead = await load1({ data: [{ ...S2, status: "failed" }] }, { data: ID });
  assert.deepEqual(dead.spaces.map((s) => s.id), [], "a space that never got its home is not listed");
  const e = await load1({ data: [] }, { data: ID });
  assert.deepEqual(e.spaces.map((s) => s.id), []);
  assert.equal(m.showingName(e, ""), "Space");
  assert.equal(m.startSpace(e), "");
});

test("the showing space's name is the one picked, else the only one", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const d = await load1({ data: [S1, S2] }, { data: ID });
  assert.deepEqual([m.showingName(d, "spc_b"), m.showingName(d, ""), m.startSpace(d), m.startSpace(d, "spc_b")], ["mine", "Juniper Studio", "spc_a", "spc_b"]);
});

test("a box that cannot list spaces is an error with its code, not an empty shell", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  await assert.rejects(shellSource(/** @type {any} */ (box({ error: { code: "offline", message: "the box did not answer" } }, { data: ID }))).load(), (/** @type {any} */ e) => e.code === "offline");
});

import { spaceName as spaceNameOf } from "./real-model.ts";
test("a space is never called by its id: its name, label or address; Personal for the personal space; else Space; Personal and My Cloud by tier", () => {
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    assert.equal(spaceNameOf({ id: "spc_x1", name: "spc_x1" }), "Space");
    assert.equal(warned, 1, "the gap is logged");
    assert.equal(spaceNameOf({ id: "spc_1", displayName: "spc_9zk4", label: "SPC_9ZK4", name: "spc_9zk4" }), "Space");
  } finally { console.warn = warn; }
  assert.equal(spaceNameOf({ id: "spc_x1", name: "spc_x1", setup: { who: "personal" } }), "My Home");
  assert.equal(spaceNameOf({ id: "s1", name: "alex.vyre.run", tier: "basic", setup: { who: "personal" } }), "My Home");
  assert.equal(spaceNameOf({ id: "s1", name: "alex.vyre.run", tier: "cloud", setup: { who: "personal" } }), "My Cloud");
  assert.equal(spaceNameOf({ id: "s2", name: "juniper.vyre.run", tier: "cloud", setup: { who: "team" } }), "juniper");
  assert.equal(spaceNameOf({ id: "spc_x1", name: "example.vyre.run" }), "example");
  assert.equal(spaceNameOf({ id: "spc_x1", name: "spc_x1", label: "juniper" }), "juniper");
  assert.equal(spaceNameOf({ id: "spc_x1", name: "x", displayName: "Juniper Studio" }), "Juniper Studio");
  assert.equal(spaceNameOf({ id: "spc_1", displayName: "spc_9zk4", label: "Juniper Studio" }), "Juniper Studio");
});

test("a Space keeps its server id, and a web address is not one", async () => {
  const { spacesFrom } = await import("./real-model.ts");
  const rows = spacesFrom([
    { id: "spc_aaaaaaaaaaaa", name: "cedar.vyre.run", role: "owner", status: "done", server: "boxa" },
    { id: "spc_bbbbbbbbbbbb", name: "birch.vyre.run", role: "owner", status: "done", server: "https://birch.vyre.run" },
  ]);
  assert.equal(rows[0].server, "boxa");
  assert.equal(rows[1].server, undefined);
});

test("the switcher: Personal, then a team space with its Cloud tag; nobody sees Basic, Pro or an id", async () => {
  const { spacesFrom } = await import("./real-model.ts");
  const rows = spacesFrom([
    { id: "spc_1", name: "alex.vyre.run", tier: "basic", setup: { who: "personal" }, role: "owner", status: "done" },
    { id: "spc_2", name: "juniper.vyre.run", tier: "cloud", setup: { who: "team" }, role: "member", status: "done" },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.sub]), [["My Home", "Owner"], ["juniper", "Member"]]);
  assert.equal(rows[0].basic, true);
  assert.ok(!rows.map((r) => `${r.name} ${r.sub}`).join(" ").match(/Basic|Pro\b|spc_/));
});
