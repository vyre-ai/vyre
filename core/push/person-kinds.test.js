// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePersonKinds, PERSON_KINDS } from "./person-kinds.js";

const KIT = "per_" + "k".repeat(26), JUNO = "per_" + "j".repeat(26);

/** A settings module's two tools over a map, as the real one answers them. */
function fake(o = {}) {
  /** @type {Map<string, any>} */ const rows = new Map();
  const calls = /** @type {any[]} */ ([]);
  const ctx = {
    kernel: o.kernel === undefined ? { chain: async (/** @type {any} */ meta) => ({ hops: meta && meta.who ? [{ actor: { kind: "person", id: meta.who } }] : [] }) } : o.kernel,
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      calls.push([tool, input]);
      if (o.missing) return { error: { code: "no_such_tool", message: "no tool" } };
      if (tool === "settings.person.set") { rows.set(`${input.person}/${input.key}`, input.value); return { data: { ok: true } }; }
      if (input.holds) return { data: { holds: [...rows].some(([k, v]) => k.endsWith("/" + input.holds.key) && v === input.holds.value) } };
      const values = {}; for (const k of input.keys) if (rows.has(`${input.person}/${k}`)) values[k] = rows.get(`${input.person}/${k}`);
      return { data: { values } };
    },
  };
  return { ctx, rows, calls, pk: makePersonKinds(ctx) };
}

test("push per person: the person is the one on the kernel's chain, never anything the caller sends", async () => {
  const { pk } = fake();
  assert.equal(await pk.person({ who: KIT }), KIT);
  assert.equal(await pk.person({ person: JUNO }), null, "a field of the call is not the person");
  assert.equal(await pk.person(undefined), null);
  const noKernel = fake({ kernel: null }).pk;
  assert.equal(await noKernel.person({ person: { id: JUNO } }), JUNO, "with no kernel, the person the daemon put on the call");
  assert.equal(await noKernel.person({ person: JUNO }), null);
});

test("push per person: a switch is kept for one person; the server-wide value stands for a person with no row; a kind off server-wide still reaches whoever turned it on", async () => {
  const { pk, rows } = fake();
  assert.equal(await pk.write(KIT, { lesson: true, ask: false, proactive: false }), true);
  assert.deepEqual([...rows.keys()].sort(), [`${KIT}/push.ask`, `${KIT}/push.lesson`], "only the kinds that have a per-person switch");
  assert.deepEqual(await pk.read(KIT), { ask: false, lesson: true });
  assert.deepEqual(await pk.read(JUNO), {}, "another person holds nothing");
  assert.equal(await pk.off(KIT, "ask", true), true, "Kit turned ask off");
  assert.equal(await pk.off(JUNO, "ask", true), false, "Juno follows the server-wide value");
  assert.equal(await pk.off(JUNO, "lesson", false), true, "and the server-wide off");
  assert.equal(await pk.off(KIT, "lesson", false), false, "Kit turned it on");
  assert.equal(await pk.off(KIT, "proactive", false), false, "a kind with no per-person switch is not judged here");
  assert.equal(await pk.off(null, "ask", false), false, "a device with no person is not judged here");
  assert.equal(await pk.anyOn("lesson"), true);
  assert.equal(await pk.anyOn("goal"), false);
  assert.equal(await pk.anyOn("proactive"), false);
  assert.ok(PERSON_KINDS.includes("planner") && !PERSON_KINDS.includes("notice"));
});

test("push per person: with no settings module, nothing is kept per person and the switch stays server-wide", async () => {
  const { pk } = fake({ missing: true });
  assert.equal(await pk.write(KIT, { ask: false }), false);
  assert.deepEqual(await pk.read(KIT), {});
  assert.equal(await pk.anyOn("ask"), false);
  assert.equal(await pk.off(KIT, "ask", true), false);
});
