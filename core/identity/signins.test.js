// @ts-check
// The sign-ins that wait on each person: a device that rang the new-device notice is listed for the person it signed in as until they say it was them or sign it out, and the person is the call's, never an input.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerSignins } from "./signins.js";

const ALEX = "per_" + "a".repeat(26), BLAIR = "per_" + "b".repeat(26);

/** A context that records the tools, carries a tiny event bus, and whose kernel chain is the person the call's meta names. */
function ctxOf() {
  const tools = new Map(), listeners = [], said = [];
  const events = { emit: (type, payload) => { said.push([type, payload]); for (const [t, fn] of listeners) if (t === type) fn({ type, payload }); }, on: (type, fn) => { listeners.push([type, fn]); } };
  const kernel = { chain: async (meta) => (meta && meta.person ? { hops: [{ actor: { kind: meta.kind || "person", id: meta.person } }] } : { hops: [] }) };
  return { tools, said, events, ctx: { events, kernel, tool: (name, def) => tools.set(name, def) } };
}

/** A fake of the running service: sessions per person, the two calls by person id the real one has. */
function fakeService() {
  const sessions = [];
  return {
    sessions,
    sessionsOfPerson: (p) => sessions.filter((s) => s.person === p).sort((a, b) => b.at - a.at).map(({ device, label, at }) => ({ device, label, at })),
    revokeDeviceOfPerson: (p, d) => { const before = sessions.length; for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].person === p && sessions[i].device === d) sessions.splice(i, 1); return { revoked: before !== sessions.length, ended: before - sessions.length }; },
  };
}

const A = "abcd1234abcd1234", B = "bbbb2222bbbb2222";
const as = (person, extra = {}) => ({ person, ...extra });

test("each person is asked only about their own devices that rang the notice and are still signed in, once, newest first; vouching takes one off their list only", async () => {
  const { ctx, tools, events } = ctxOf(), svc = fakeService();
  registerSignins(ctx, { service: () => svc, now: () => 100 });
  const pending = async (person) => (await tools.get("identity.signins.pending").run({}, as(person))).devices.map((d) => [d.device, d.label]);
  svc.sessions.push({ person: ALEX, device: A, label: "Kit's laptop", at: 10 }, { person: ALEX, device: A, label: "Kit's laptop", at: 20 }, { person: ALEX, device: B, label: "The usual browser", at: 5 },
    { person: BLAIR, device: A, label: "Blair on the same browser", at: 30 });
  assert.deepEqual(await pending(ALEX), [], "no notice has rung: a sign-in nobody was told about is not asked about");
  events.emit("signin.new-device", { device: A, at: 10 });
  assert.deepEqual(await pending(ALEX), [[A, "Kit's laptop"]], "one row per device, for the caller's person only");
  assert.deepEqual(await pending(BLAIR), [[A, "Blair on the same browser"]], "another person sees their own");
  assert.deepEqual(await tools.get("identity.signin.ack").run({ device: A, person: BLAIR }, as(ALEX)), { acknowledged: true });
  assert.deepEqual(await pending(ALEX), [], "vouched for, for Alex");
  assert.deepEqual(await pending(BLAIR), [[A, "Blair on the same browser"]], "Alex's word is not Blair's");
});

test("signing a device out ends the caller's live sessions of it, whatever person an input names, and closes the card either way", async () => {
  const { ctx, tools, events, said } = ctxOf(), svc = fakeService();
  registerSignins(ctx, { service: () => svc, now: () => 500 });
  svc.sessions.push({ person: ALEX, device: A, label: "Kit's laptop", at: 10 }, { person: BLAIR, device: A, label: "Same id, another person", at: 11 });
  events.emit("signin.new-device", { device: A, at: 10 });
  const out = await tools.get("identity.signin.revoke").run({ device: A, person: BLAIR, username: "blair" }, as(ALEX));
  assert.deepEqual([out.revoked, out.ended], [true, 1]);
  assert.deepEqual(svc.sessions.map((s) => s.person), [BLAIR], "only the caller's session of that device ended");
  assert.deepEqual(said.at(-1), ["signin.revoked", { device: A, at: 500 }]);
  const again = await tools.get("identity.signin.revoke").run({ device: A }, as(ALEX));
  assert.deepEqual([again.revoked, again.ended], [false, 0]);
  assert.match(again.note, /already signed out/);
  assert.deepEqual(said.at(-1), ["signin.revoked", { device: A, at: 500 }], "a card that outlived its session still closes");
});

test("a bad device id, a call that is not a person, and no sign-in door are refused in plain words", async () => {
  const { ctx, tools } = ctxOf(), svc = fakeService();
  let up = true;
  registerSignins(ctx, { service: () => (up ? svc : null) });
  for (const tool of ["identity.signin.revoke", "identity.signin.ack"]) {
    for (const device of ["", "short", "../../etc/passwd", 7, undefined]) await assert.rejects(() => tools.get(tool).run({ device }, as(ALEX)), (e) => e.code === "bad_input", `${tool} ${String(device)}`);
    await assert.rejects(() => tools.get(tool).run({ device: A }, {}), (e) => e.code === "person_required", `${tool} with no person`);
    await assert.rejects(() => tools.get(tool).run({ device: A }, as(ALEX, { kind: "agent" })), (e) => e.code === "person_required", `${tool} by an agent`);
    await assert.rejects(() => tools.get(tool).run({ device: A }, as("not-a-person-id")), (e) => e.code === "person_required", `${tool} with a made-up id`);
  }
  await assert.rejects(() => tools.get("identity.signins.pending").run({}, {}), (e) => e.code === "person_required");
  up = false;
  await assert.rejects(() => tools.get("identity.signin.revoke").run({ device: A }, as(ALEX)), (e) => e.code === "unavailable");
  assert.deepEqual(await tools.get("identity.signins.pending").run({}, as(ALEX)), { devices: [] });
});

test("a build with no kernel falls back to the home's own person and to no one else", async () => {
  const { ctx, tools } = ctxOf(), svc = fakeService();
  delete ctx.kernel;
  let home = ALEX;
  registerSignins(ctx, { service: () => svc, fallbackPerson: () => home });
  svc.sessions.push({ person: ALEX, device: A, label: "x", at: 1 });
  assert.deepEqual(await tools.get("identity.signin.revoke").run({ device: A }, as(BLAIR)), { revoked: true, ended: 1 }, "the home's person, not whatever the meta says");
  home = null;
  await assert.rejects(() => tools.get("identity.signin.revoke").run({ device: A }, {}), (e) => e.code === "person_required");
});

test("a member signing out the owner's device id does nothing, and the owner's list never shows the member's device", async () => {
  const { ctx, tools, events, said } = ctxOf(), svc = fakeService();
  registerSignins(ctx, { service: () => svc, now: () => 7 });
  svc.sessions.push({ person: ALEX, device: A, label: "The owner's laptop", at: 10 }, { person: BLAIR, device: B, label: "The member's phone", at: 20 });
  events.emit("signin.new-device", { device: A, at: 10 });
  events.emit("signin.new-device", { device: B, at: 20 });
  const mine = async (person) => (await tools.get("identity.signins.pending").run({}, as(person))).devices.map((d) => d.device);
  assert.deepEqual(await mine(ALEX), [A], "the owner's list has the owner's device only");
  assert.deepEqual(await mine(BLAIR), [B], "the member's list has the member's device only");
  const guess = await tools.get("identity.signin.revoke").run({ device: A }, as(BLAIR));
  assert.deepEqual([guess.revoked, guess.ended], [false, 0], "a guessed id matches only inside the caller's own usernames");
  assert.deepEqual(svc.sessions.map((s) => s.device).sort(), [A, B].sort(), "no session of the owner's ended");
  assert.deepEqual(await mine(ALEX), [A]);
  assert.deepEqual(said.at(-1), ["signin.revoked", { device: A, at: 7 }]);
  await tools.get("identity.signin.ack").run({ device: A }, as(BLAIR));
  assert.deepEqual(await mine(ALEX), [A], "the member's word about a device id is not the owner's");
});

test("with no kernel the home's person answers only the owner's local surfaces; every network, agent or model caller is refused, on all three tools", async () => {
  const { ctx, tools } = ctxOf();
  delete ctx.kernel;
  const svc = fakeService();
  registerSignins(ctx, { service: () => svc, fallbackPerson: () => ALEX, now: () => 1 });
  const ask = (tool, caller, extra = {}) => tools.get(tool).run(tool === "identity.signins.pending" ? {} : { device: A }, { caller, ...extra });
  for (const tool of ["identity.signins.pending", "identity.signin.revoke", "identity.signin.ack"]) {
    for (const caller of ["device:aaaaaaaaaaaaaaaa", "web:x", "tailnet:alex", "space:bob@juniper", "mcp", "mcp:agent:kit", "cli:agent:kit", "cli:thread:x", "harness", "agent:kit", ""]) {
      await assert.rejects(ask(tool, caller), { code: "person_required" }, `${tool} for ${caller || "(none)"}`);
    }
    await assert.rejects(ask(tool, "cli", { person: BLAIR }), { code: "person_required" }, `${tool}: a person in the meta is not the local owner`);
    for (const caller of ["cli", "local", "deck", "capsule"]) await ask(tool, caller);
  }
  svc.sessions.push({ person: ALEX, device: A, label: "Home", at: 1 });
  assert.deepEqual(await tools.get("identity.signin.revoke").run({ device: A }, { caller: "cli" }).then((r) => r.revoked), true, "cli is the home's person");
});

test("with a kernel whose chain throws or answers nothing, no call falls back to the home's person", async () => {
  for (const chain of [async () => { throw new Error("no chain"); }, async () => null, async () => ({ hops: [] })]) {
    const { ctx, tools } = ctxOf();
    ctx.kernel = { chain };
    registerSignins(ctx, { service: () => fakeService(), fallbackPerson: () => ALEX, now: () => 1 });
    for (const tool of ["identity.signins.pending", "identity.signin.revoke", "identity.signin.ack"]) await assert.rejects(tools.get(tool).run({ device: A }, { caller: "cli" }), { code: "person_required" }, tool);
  }
});
