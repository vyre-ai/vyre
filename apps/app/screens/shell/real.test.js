// @ts-check
// The shell on the real box against a fake box shaped like the dev box's spaces.list and spaces.identity.status.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const S1 = { id: "spc_a", name: "harlowdev.vyre.run", label: "harlowdev", displayName: "Harlow Legal", status: "done", role: "owner" };
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

test("one space is the whole switcher; two get All spaces first; names and roles are the box's", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const { shellFrom } = await import("./real-model.ts");
  const load = async (/** @type {any} */ sp, /** @type {any} */ id) => { const r = await shellSource(/** @type {any} */ (box(sp, id))).load(); return shellFrom(r.spaces, r.identity); };
  const one = await load({ data: [S1] }, { data: ID });
  assert.deepEqual(one.spaces, [{ id: "spc_a", name: "Harlow Legal", sub: "Owner" }]);
  const two = await load({ data: [S1, S2] }, { data: ID });
  assert.deepEqual(two.spaces.map((s) => [s.id, s.name, s.sub]), [["all", "All spaces", "One list, everything"], ["spc_a", "Harlow Legal", "Owner"], ["spc_b", "mine", "Member"]]);
});

test("the person is their identity on this box, and a missing identity still shows the spaces", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const d = await load1({ data: [S1] }, { data: ID });
  assert.deepEqual(d.me, { name: "Devbox", sub: "devbox.vyre.run", vyreName: "devbox.vyre.run" });
  const none = await load1({ data: [S1] }, { error: { code: "not_found", message: "no identity" } });
  assert.deepEqual(none.me, { name: "You", sub: "", vyreName: "" });
  assert.equal(none.spaces.length, 1);
});

test("a space still being created says so, and an empty box has only All spaces", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const d = await load1({ data: [{ ...S2, status: "creating" }] }, { data: ID });
  assert.equal(d.spaces[0].sub, "Setting up");
  const dead = await load1({ data: [{ ...S2, status: "failed" }] }, { data: ID });
  assert.deepEqual(dead.spaces.map((s) => s.id), ["all"], "a space that never got its home is not listed");
  const e = await load1({ data: [] }, { data: ID });
  assert.deepEqual(e.spaces.map((s) => s.id), ["all"]);
  assert.equal(m.showingName(e, "all"), "Space");
  assert.equal(m.startSpace(e), "all");
});

test("the showing space's name is the one picked, else the only one", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const d = await load1({ data: [S1, S2] }, { data: ID });
  assert.deepEqual([m.showingName(d, "spc_b"), m.showingName(d, "all"), m.startSpace(d)], ["mine", "Harlow Legal", "all"]);
});

test("a box that cannot list spaces is an error with its code, not an empty shell", { skip: !strip }, async () => {
  const { shellSource } = await import("./real-source.ts");
  await assert.rejects(shellSource(/** @type {any} */ (box({ error: { code: "offline", message: "the box did not answer" } }, { data: ID }))).load(), (/** @type {any} */ e) => e.code === "offline");
});

import { spaceName as spaceNameOf } from "./real-model.ts";
test("a space is never called by its id: its name, its label, or Home", () => {
  assert.equal(spaceNameOf({ id: "spc_x1", name: "spc_x1" }), "Home");
  assert.equal(spaceNameOf({ id: "spc_x1", name: "spc_x1", label: "harlow" }), "harlow");
  assert.equal(spaceNameOf({ id: "spc_x1", name: "x", displayName: "Harlow Legal" }), "Harlow Legal");
});
