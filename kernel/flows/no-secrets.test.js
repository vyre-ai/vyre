// A Flow holds references, never values (R031-72): saving one with a key, a password or a token written into a step is refused, in words that say where and never repeat the value.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./testing/world.js";
import { compileFlow } from "./compile.js";
import { catalog } from "./testing/fixtures.js";
import { secretsIn } from "./no-secrets.js";

const KEY = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8i9J0".repeat(4);
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const flowOf = steps => ({ format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps });

test("no secrets: a key written into a step is refused where it sits, and the refusal never repeats it", () => {
  const f = flowOf([
    { id: "a", kind: "create", type: "payment", set: { client: "x", amount: 1 } },
    { id: "c", kind: "call", action: "email.send", resource: "vyre://spc_harlow000001/mail/*", input: { to: "a@example.com", body: `token ${KEY}` } },
    { id: "s", kind: "service", connector: "practice", method: "POST", path: "/matters", body: { note: { expr: `"${GH}"` } } },
  ]);
  const found = secretsIn(f);
  assert.deepEqual(found.map(x => x.path).sort(), ["steps[1].input.body", "steps[2].body.note.expr"]);
  const c = compileFlow(f, catalog());
  assert.equal(c.ok, false);
  const text = JSON.stringify(c.errors);
  assert.match(text, /a Flow never holds a key, a password or a token/);
  assert.match(text, /steps\[1\]\.input\.body/);
  assert.ok(!text.includes(KEY) && !text.includes(GH), "the refusal does not carry the value");
});

test("no secrets: ordinary text, ids and addresses are not mistaken for keys, and a Connection by name is the way", () => {
  const f = flowOf([
    { id: "a", kind: "create", type: "payment", set: { client: "Rivera Family Trust 2026-10-09", amount: 5 } },
    { id: "s", kind: "service", connector: "practice", method: "GET", path: "/matters/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" },
  ]);
  assert.deepEqual(secretsIn(f), []);
  assert.equal(compileFlow(f, catalog()).ok, true);
});

test("no secrets: through the runner's define a Flow with a key is not stored, so no stored Flow holds one", async () => {
  const w = await world();
  const bad = await w.runner.define(null, flowOf([{ id: "c", kind: "call", action: "email.send", resource: "vyre://spc_harlow000001/mail/*", input: { body: KEY } }]), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  assert.equal(bad.ok, false);
  assert.deepEqual(await w.store.list(), []);
  assert.ok(!JSON.stringify(await w.store.list()).includes(KEY));
});
