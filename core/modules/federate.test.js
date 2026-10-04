// @ts-check
// Who a federated read reaches, and how the rows come back: core/modules/federate.js without a
// link. test/federation-reads.test.js runs it through a paired box and Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsMacs, askMacs, mergeRows, sourcesOf } from "./federate.js";

const box = { config: { role: "box", name: "juno" } };

test("federate: only the person, or a module that asks, on the box", async () => {
  for (const caller of ["deck", "cli", "local", "capsule", "tailnet:alex@example.com"]) {
    assert.equal(await wantsMacs(box, {}, caller), true, caller);
    assert.equal(await wantsMacs(box, { machines: "all" }, caller), true, caller);
    assert.equal(await wantsMacs(box, { machines: "local" }, caller), false, caller);
    assert.equal(await wantsMacs({ config: { role: "local" } }, {}, caller), false, `${caller} on a Mac`);
  }
  for (const caller of ["mcp", "mcp:agent:kit", "harness:agent:kit", "tailnet:agent:kit", "tailnet:alex@example.com agent:kit",
    "tailnet-guest:sam@harlow.example", "hook", "unknown", "", undefined]) {
    assert.equal(await wantsMacs(box, {}, caller), false, String(caller));
    assert.equal(await wantsMacs(box, { machines: "all" }, caller), false, String(caller));
  }
  assert.equal(await wantsMacs(box, {}, "module:onboard"), false, "a module stays local unless it asks");
  assert.equal(await wantsMacs(box, { machines: "all" }, "module:onboard"), true);
  assert.equal(await wantsMacs({}, {}, "deck"), false, "no config, no federation");
});

test("federate: askMacs asks as a local read, and never throws", async () => {
  /** @type {any[]} */ const calls = [];
  const ok = { ...box, call: async (tool, input) => { calls.push([tool, input]); return { data: [{ mac: "m1", name: "kit", ok: true, data: [1] }] }; } };
  assert.deepEqual(await askMacs(ok, "recall.sessions", { limit: 3, machines: "all" }), [{ mac: "m1", name: "kit", ok: true, data: [1] }]);
  assert.deepEqual(calls, [["link.macs.call", { tool: "recall.sessions", input: { limit: 3, machines: "local" } }]]);
  assert.deepEqual(await askMacs({ ...box, call: async () => ({ error: { code: "no_such_tool", message: "no tool" } }) }, "recall.sessions", {}), []);
  assert.deepEqual(await askMacs({ ...box, call: async () => { throw new Error("boom"); } }, "recall.sessions", {}), []);
});

test("federate: rows are labelled, merged stably and capped; sources put the box first", async () => {
  const answers = [{ mac: "m1", name: "kit", ok: true, data: [{ id: "a", n: 3 }, { id: "b", n: 1 }] },
    { mac: "m2", name: "alex-air", ok: false, error: { code: "mac_offline", message: "offline" } }];
  const rows = mergeRows(box, [{ id: "x", n: 3 }, { id: "y", n: 2 }], answers, { compare: (p, q) => q.n - p.n, limit: 3 });
  assert.deepEqual(rows, [{ id: "x", n: 3, source: "box", machine: "juno" }, { id: "a", n: 3, source: "mac", machine: "kit" }, { id: "y", n: 2, source: "box", machine: "juno" }]);
  assert.deepEqual(sourcesOf(box, answers), [{ source: "box", machine: "juno", ok: true }, { source: "mac", machine: "kit", ok: true },
    { source: "mac", machine: "alex-air", ok: false, error: "mac_offline" }]);
  assert.equal(mergeRows({ config: { role: "box" } }, [{ id: "x" }], [])[0].machine, "box", "an unnamed box is called box");
});

test("with a kernel the person is the chain, never the label: a model sending `deck` is refused, a person under any label is not", async () => {
  const hops = kind => ({ hops: [{ actor: { kind, id: "x" } }] });
  const withChain = chain => ({ config: { role: "box" }, kernel: { chain: async () => chain() } });
  for (const label of ["deck", "cli", "local", "capsule", "tailnet:alex@example.com"]) {
    assert.equal(await wantsMacs(withChain(() => hops("agent")), {}, label, { caller: label }), false, `${label}: a model under that label`);
    assert.equal(await wantsMacs(withChain(() => ({ hops: [{ actor: { kind: "person", id: "p" } }, { actor: { kind: "agent", id: "a" } }] })), {}, label, { caller: label }), false, `${label}: a person with an agent hop behind`);
    assert.equal(await wantsMacs(withChain(() => { throw new Error("no chain"); }), {}, label, { caller: label }), false, `${label}: a chain that cannot be built`);
    assert.equal(await wantsMacs(withChain(() => hops("person")), {}, label, { caller: label }), true, `${label}: the person`);
  }
  assert.equal(await wantsMacs(withChain(() => hops("person")), {}, "anything", { caller: "anything" }), true, "the chain decides, not the label");
});
