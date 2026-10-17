// @ts-check
// The sign-ins that wait on the person: a device that rang the new-device notice is listed until the person says it was them or signs it out; the username is the owner's, never an input.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerSignins } from "./signins.js";

/** A context that records the tools and carries a tiny event bus. */
function ctxOf() {
  const tools = new Map(), listeners = [], said = [];
  const events = { emit: (type, payload) => { said.push([type, payload]); for (const [t, fn] of listeners) if (t === type) fn({ type, payload }); }, on: (type, fn) => { listeners.push([type, fn]); } };
  return { tools, said, events, ctx: { events, tool: (name, def) => tools.set(name, def) } };
}

/** A fake of the running service: sessions per username, the same two calls the real one has. */
function fakeService() {
  const sessions = [];
  return {
    sessions,
    sessionsOf: (u) => sessions.filter((s) => s.username === u).sort((a, b) => b.at - a.at).map(({ device, label, at }) => ({ device, label, at })),
    revokeDevice: (u, d) => { const before = sessions.length; for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].username === u && sessions[i].device === d) sessions.splice(i, 1); return { revoked: before !== sessions.length, ended: before - sessions.length }; },
  };
}

const A = "abcd1234abcd1234", B = "bbbb2222bbbb2222";

test("only a device that rang the new-device notice and is still signed in is listed, once, newest first; vouching for it takes it off the list", async () => {
  const { ctx, tools, events } = ctxOf(), svc = fakeService();
  registerSignins(ctx, { username: () => "alex", service: () => svc, now: () => 100 });
  const pending = async () => (await tools.get("identity.signins.pending").run({}, {})).devices.map((d) => [d.device, d.label]);
  svc.sessions.push({ username: "alex", device: A, label: "Kit's laptop", at: 10 }, { username: "alex", device: A, label: "Kit's laptop", at: 20 }, { username: "alex", device: B, label: "The usual browser", at: 5 }, { username: "blair", device: "cccc3333cccc3333", label: "Someone else", at: 30 });
  assert.deepEqual(await pending(), [], "no notice has rung: a sign-in nobody was told about is not asked about");
  events.emit("signin.new-device", { device: A, at: 10 });
  events.emit("signin.new-device", { device: "cccc3333cccc3333", at: 30 });
  assert.deepEqual(await pending(), [[A, "Kit's laptop"]], "one row per device, for the owner's username only");
  const r = await tools.get("identity.signin.ack").run({ device: A }, {});
  assert.deepEqual(r, { acknowledged: true });
  assert.deepEqual(await pending(), []);
});

test("signing a device out ends its live sessions through the service for the owner's username, whatever an input says, and closes the card either way", async () => {
  const { ctx, tools, events, said } = ctxOf(), svc = fakeService();
  registerSignins(ctx, { username: () => "alex", service: () => svc, now: () => 500 });
  svc.sessions.push({ username: "alex", device: A, label: "Kit's laptop", at: 10 }, { username: "blair", device: A, label: "Same id, another person", at: 11 });
  events.emit("signin.new-device", { device: A, at: 10 });
  const out = await tools.get("identity.signin.revoke").run({ device: A, username: "blair" }, {});
  assert.deepEqual([out.revoked, out.ended], [true, 1]);
  assert.deepEqual(svc.sessions.map((s) => s.username), ["blair"], "only the owner's session of that device ended");
  assert.deepEqual(said.at(-1), ["signin.revoked", { device: A, at: 500 }]);
  const again = await tools.get("identity.signin.revoke").run({ device: A }, {});
  assert.deepEqual([again.revoked, again.ended], [false, 0]);
  assert.match(again.note, /already signed out/);
  assert.deepEqual(said.at(-1), ["signin.revoked", { device: A, at: 500 }], "a card that outlived its session still closes");
});

test("a bad device id, no username and no sign-in door are refused in plain words, and nothing is listed without one", async () => {
  const { ctx, tools } = ctxOf(), svc = fakeService();
  let user = "alex", up = true;
  registerSignins(ctx, { username: () => user, service: () => (up ? svc : null) });
  for (const tool of ["identity.signin.revoke", "identity.signin.ack"]) {
    for (const device of ["", "short", "../../etc/passwd", 7, undefined]) await assert.rejects(() => tools.get(tool).run({ device }, {}), (e) => e.code === "bad_input", `${tool} ${String(device)}`);
  }
  up = false;
  await assert.rejects(() => tools.get("identity.signin.revoke").run({ device: A }, {}), (e) => e.code === "unavailable");
  assert.deepEqual(await tools.get("identity.signins.pending").run({}, {}), { devices: [] });
  up = true; user = null;
  assert.deepEqual(await tools.get("identity.signins.pending").run({}, {}), { devices: [] });
  await assert.rejects(() => tools.get("identity.signin.revoke").run({ device: A }, {}), (e) => e.code === "no_identity");
  await assert.rejects(() => tools.get("identity.signin.ack").run({ device: A }, {}), (e) => e.code === "no_identity");
});
