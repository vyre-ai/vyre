// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantWhenReady, WAITING } from "./assistant-ready.js";

function world(o = {}) {
  const calls = [];
  let st = o.state || null;
  const agents = o.agents || [];
  return {
    calls, get state() { return st; },
    run: () => assistantWhenReady({
      call: async tool => { if (tool === "agents.list") return agents; throw new Error("no " + tool); },
      tryCall: async tool => (tool === "spaces.identity.id" ? (o.id === undefined ? { id: "per_x" } : o.id) : tool === "providers.list" ? (o.providers === undefined ? [] : o.providers) : { __error: "no" }),
      signedInOutside: () => Boolean(o.outside),
      ensure: async x => { calls.push(["ensure", x]); return { made: o.made !== false }; },
      state: () => st, setState: s => { st = s; },
    }),
  };
}
const signed = [{ id: "claude", accounts: [{ id: "a", signed_in: true }] }];
const unsigned = [{ id: "claude", accounts: [{ id: "a", signed_in: false }] }, { id: "codex", accounts: [] }];

test("an assistant that exists is left alone", async () => {
  const w = world({ agents: [{ name: "juno", kind: "assistant" }], providers: signed });
  assert.equal(await w.run(), "exists");
  assert.deepEqual(w.calls, []);
});
test("no owner yet: nothing is made and nothing is said", async () => {
  const w = world({ id: { id: null }, providers: signed });
  assert.equal(await w.run(), "no_owner");
  assert.deepEqual(w.calls, []);
  assert.equal(w.state, null);
});
test("an owner and no signed-in AI account: Now says to connect one, once, and the assistant is not made", async () => {
  const w = world({ providers: unsigned });
  assert.equal(await w.run(), "waiting");
  assert.equal(w.state.why, WAITING);
  const first = w.state.at;
  assert.equal(await w.run(), "waiting");
  assert.equal(w.state.at, first, "the state is written once, not every minute");
  assert.deepEqual(w.calls, []);
});
test("an owner and a signed-in AI account: the assistant is made, named Juno unless it was named", async () => {
  const w = world({ providers: signed });
  assert.equal(await w.run(), "made");
  assert.deepEqual(w.calls, [["ensure", { fallbackName: true }]]);
  assert.equal(await world({ providers: unsigned, outside: true }).run(), "made", "the machine's own Claude sign-in counts");
  assert.equal(await world({ providers: signed, made: false }).run(), "failed");
});
