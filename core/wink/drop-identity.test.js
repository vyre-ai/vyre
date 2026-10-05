import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropIdentity, KEY_TEXT } from "./drop-identity.js";

const PUB = "A".repeat(44);
const make = () => {
  const signed = [];
  const id = dropIdentity({ sign: async m => { signed.push(m.toString()); return { eid: "E1", sig: "SIG" }; }, entry: async eid => (eid === "E1" ? { pub: "ENTRYPUB" } : null), verify: (pub, msg, sig) => pub === "ENTRYPUB" && sig === "SIG" && msg.toString() === KEY_TEXT(PUB) });
  return { id, signed };
};

test("the identity key signs exactly the drop-key text, built here from the key, and only for the files module", async () => {
  const { id, signed } = make();
  assert.deepEqual(await id.sign({ caller: "module:files" }, { pub: PUB }), { eid: "E1", sig: "SIG" });
  assert.deepEqual(signed, [`vyre-drop-key-v1\n${PUB}`]);
  for (const caller of ["module:spaces", "module:runner", "module:wink", "cli", "device:abc", "", undefined]) await assert.rejects(id.sign({ caller }, { pub: PUB }), { code: "denied" }, String(caller));
  // any other text is not signable: there is no message input, and the key must have a drop key's shape
  for (const bad of [{}, { pub: "short" }, { pub: "x y z".repeat(20) }, { pub: `${PUB}\nvyre-wink-pair-to-v1` }, { message: "anything" }]) await assert.rejects(id.sign({ caller: "module:files" }, /** @type {any} */ (bad)), { code: "bad_input" }, JSON.stringify(bad));
  assert.equal(signed.length, 1, "nothing else was signed");
});

test("the check is the files module's too, and answers only whether the drop key was signed by that device of the identity", async () => {
  const { id } = make();
  assert.deepEqual(await id.check({ caller: "module:files" }, { pub: PUB, eid: "E1", sig: "SIG" }), { ok: true });
  assert.deepEqual(await id.check({ caller: "module:files" }, { pub: PUB, eid: "E1", sig: "BAD" }), { ok: false });
  assert.deepEqual(await id.check({ caller: "module:files" }, { pub: PUB, eid: "E9", sig: "SIG" }), { ok: false }, "not on the list");
  assert.deepEqual(await id.check({ caller: "module:files" }, { pub: "B".repeat(44), eid: "E1", sig: "SIG" }), { ok: false }, "a different key");
  await assert.rejects(id.check({ caller: "module:spaces" }, { pub: PUB, eid: "E1", sig: "SIG" }), { code: "denied" });
});
