// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, createGatewayStore, parseUrn, readableActors, storeError } from "./gateway-adapter.js";

/** A fake vyred: records every call and answers from a table. */
function fake(answers = {}) {
  /** @type {any[]} */ const calls = [];
  /** @type {null | ((e: any) => void)} */ let on = null;
  return {
    calls, emit: (e) => on?.(e),
    rpc: {
      read: async (tool, input) => { calls.push({ kind: "read", tool, input }); return typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; },
      write: async (tool, input, o) => { calls.push({ kind: "write", tool, input, o }); return typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; },
      events: (f) => { on = f; return () => { on = null; }; },
    },
  };
}

test("a record urn is parsed, and anything else is refused in plain words", () => {
  assert.deepEqual(parseUrn("vyre://juniper/matter/m1"), { space: "juniper", type: "matter", id: "m1" });
  assert.throws(() => parseUrn("nope"), (e) => e.code === "invalid");
});

test("list follows the cursor and sends no actor, chain or proof in the body", async () => {
  let n = 0;
  const f = fake({ [TOOLS.list]: () => (n++ ? { rows: [{ id: "b" }] } : { rows: [{ id: "a" }], next_cursor: "c1" }) });
  const s = createGatewayStore({ rpc: f.rpc });
  const rows = await s.list("matter", { space: "juniper" });
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.equal(f.calls[1].input.cursor, "c1");
  for (const c of f.calls) assert.ok(!("actor" in c.input) && !("chain" in c.input) && !("proof" in c.input));
});

test("decide and reveal pass the proof as the call's presence, not in the body", async () => {
  const f = fake({ [TOOLS.decide]: { task: { id: "t1", state: "done" } }, [TOOLS.reveal]: { value: "x", expires_in_ms: 1000 } });
  const s = createGatewayStore({ rpc: f.rpc });
  const proof = /** @type {any} */ ({ sig: "p" });
  const t = await s.decide("t1", { outcome: "approved", reason: "ok", proof });
  assert.equal(t.state, "done");
  assert.deepEqual(f.calls[0].input, { id: "t1", outcome: "approved", reason: "ok" });
  assert.equal(f.calls[0].o.proof, proof);
  await s.reveal("vyre://h/m/1", "ssn", "check", proof);
  assert.deepEqual(f.calls[1].input, { urn: "vyre://h/m/1", field: "ssn", purpose: "check" });
  assert.equal(f.calls[1].o.proof, proof);
});

test("a write redraws the screens, an event from the vyred does too, and subscribe stops the stream when the last screen leaves", async () => {
  const f = fake({ [TOOLS.update]: { record: { urn: "vyre://h/m/1", version: 2 } }, [TOOLS.me]: { person: "per_x", spaces: [{ id: "h" }] } });
  const s = createGatewayStore({ rpc: f.rpc });
  let n = 0;
  const off = s.subscribe(() => { n++; });
  await s.update("vyre://h/m/1", { title: "x" }, 1);
  assert.equal(n, 1);
  f.emit({ type: "record.updated" });
  assert.equal(n, 2);
  off();
  f.emit({ type: "record.updated" });
  assert.equal(n, 2);
});

test("a create names no space unless the screen did, and me reads the person", async () => {
  const f = fake({ [TOOLS.me]: { person: "per_x", spaces: [{ id: "mine" }] }, [TOOLS.create]: { record: { urn: "vyre://mine/contact/1" } } });
  const s = createGatewayStore({ rpc: f.rpc });
  await s.create("contact", { name: "Jane" });
  assert.ok(!("space" in f.calls.find((c) => c.tool === TOOLS.create).input));
  assert.equal(await s.me(), "per_x");
});

test("adding a field and sealing one are definition changes on the type", async () => {
  const f = fake({ [TOOLS.types]: [{ name: "matter", fields: [{ name: "title", label: "Title", kind: "text" }] }], [TOOLS.define]: { applied: true, changes: [] } });
  const s = createGatewayStore({ rpc: f.rpc });
  const made = await s.addField?.("matter", { label: "Plan year", kind: "text" });
  assert.equal(made.name, "plan_year");
  const d = f.calls.find((c) => c.tool === TOOLS.define).input.diff;
  assert.deepEqual(d.change_types[0].fields.map((x) => x.name), ["title", "plan_year"]);
  const sealed = await s.sealField?.("matter", "title");
  assert.equal(sealed.seal.level, "ai");
});

test("an error answer becomes a StoreError code the screens know", () => {
  assert.equal(storeError({ code: "version_conflict", message: "Someone changed it." }).code, "version_conflict");
  assert.equal(storeError({ code: "weird", message: "x" }).code, "invalid");
});

test("spaces are named by spaces.list, with the home's own space added when it is missing", async () => {
  const f = fake({ [TOOLS.me]: { person: "per_x", space: "spc_home" }, [TOOLS.spaceList]: [{ id: "spc_a", displayName: "Juniper Studio", status: "done", role: "owner" }, { id: "spc_b", label: "x", status: "creating" }] });
  const s = createGatewayStore({ rpc: f.rpc });
  assert.deepEqual((await s.spaces()).map((x) => [x.id, x.name]), [["spc_home", "Home"], ["spc_a", "Juniper Studio"]]);
});

test("an actor known only by its id reads as a word, never as the id", () => {
  const actors = readableActors([
    { id: "per_l47gpa4r2zy6cn6jmyzi5rh", name: "per_l47gpa4r2zy6cn6jmyzi5rh", family: "person" },
    { id: "per_other0000000000000000", name: "", family: "person" },
    { id: "agt_0000000000", name: "agt_0000000000", family: "assistant" },
    { id: "agt_1111111111", name: "agt_1111111111", family: "agent" },
    { id: "per_named", name: "Dana Smith", family: "person" },
  ], "per_l47gpa4r2zy6cn6jmyzi5rh");
  assert.deepEqual(actors.map((a) => a.name), ["You", "Someone", "An assistant", "An agent", "Dana Smith"]);
  assert.deepEqual(readableActors([], "x"), []);
});

test("the store's actors are the readable ones, with the signed-in person as You", async () => {
  const f = fake({ [TOOLS.me]: { person: "per_me" }, [TOOLS.actors]: [{ id: "per_me", name: "per_me", family: "person" }] });
  const s = createGatewayStore({ rpc: f.rpc });
  assert.deepEqual((await s.actors()).map((a) => a.name), ["You"]);
});

test("handing in a task that is still ready starts it first, so Mark done works on a card the person has not opened", async () => {
  const f = fake({ [TOOLS.task]: { task: { id: "t1", state: "ready" } }, [TOOLS.move]: { task: { id: "t1", state: "working" } }, [TOOLS.submit]: { task: { id: "t1", state: "done" } } });
  const s = createGatewayStore({ rpc: f.rpc });
  const done = await s.submit("t1", { note: { text: "done" } });
  assert.equal(done.state, "done");
  assert.deepEqual(f.calls.filter((c) => c.kind === "write").map((c) => [c.tool, c.input.to ?? null]), [[TOOLS.move, "working"], [TOOLS.submit, null]]);
  const g = fake({ [TOOLS.task]: { task: { id: "t2", state: "working" } }, [TOOLS.submit]: { task: { id: "t2", state: "done" } } });
  await createGatewayStore({ rpc: g.rpc }).submit("t2", {});
  assert.deepEqual(g.calls.filter((c) => c.kind === "write").map((c) => c.tool), [TOOLS.submit], "a task already started is not started again");
});
