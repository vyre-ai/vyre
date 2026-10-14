import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO, SCREENS, addressOf, afterSpace, apiKeyStatus, inviteStatus, knownName, masterStatus, nameStatus, reach, recoveryStatus, resumeAt, route, spaceCodeStatus, stepLabels, unreachableSay, NO_SERVER_SAY, NO_BOX_SAY, wordsMatch } from "./flow-model.js";

test("every screen is reachable from the start and every target exists", () => {
  const seen = reach("start");
  for (const id of Object.keys(SCREENS)) assert.ok(seen.has(id), `${id} is not reachable`);
  for (const [id, s] of Object.entries(SCREENS)) for (const t of s.to) assert.ok(SCREENS[t], `${id} leads to ${t}, which is not a screen`);
});
test("no dead end: every screen can still reach Ready, and Ready can start again", () => {
  for (const id of Object.keys(SCREENS)) assert.ok(reach(id).has("ready"), `${id} cannot reach ready`);
  assert.ok(reach("ready").has("start"));
});
test("a failure has a way forward: each screen that can fail leads on or back", () => {
  for (const id of ["id.approve", "id.recover", "master.enter", "create.confirm"]) assert.ok(SCREENS[id].to.length >= 2, `${id} needs a second way`);
});
test("steps follow the device and the space", () => {
  assert.deepEqual(stepLabels({ device: "computer", allowed: true }), ["Identity", "Vault", "Inference", "Space", "Compute", "Ready"]);
  assert.deepEqual(stepLabels({ device: "phone", allowed: true }), ["Identity", "Vault", "Inference", "Space", "Ready"]);
  assert.deepEqual(stepLabels({ device: "computer", allowed: true, later: true }), ["Space", "Compute", "Ready"]);
  assert.equal(afterSpace({ device: "computer", allowed: false }), "ready");
  assert.equal(afterSpace({ device: "computer", allowed: true }), "compute");
});
test("Compute is skipped when the space does not allow it, and asked only on a computer", () => {
  assert.ok(!stepLabels({ device: "computer", allowed: false }).includes("Compute"));
  assert.equal(afterSpace({ device: "computer", allowed: false }), "ready");
  assert.equal(afterSpace({ device: "phone", allowed: true }), "ready");
  assert.ok(reach("create.name").has("create.members"));
});
test("the pretend answers", () => {
  assert.equal(nameStatus("alex"), "taken");
  assert.equal(nameStatus("ab"), "invalid");
  assert.equal(nameStatus("morgan"), "free");
  assert.equal(knownName(" Alex "), true);
  assert.equal(recoveryStatus(DEMO.recoveryCode), "ok");
  assert.equal(recoveryStatus("KIT-0000-0000-0000"), "wrong");
  assert.equal(masterStatus(DEMO.master), "ok");
  assert.equal(masterStatus("nope"), "wrong");
  assert.equal(masterStatus("mine", "mine"), "ok");
  assert.equal(apiKeyStatus("sk-ant-abcdefgh12"), "ok");
  assert.equal(apiKeyStatus("hello"), "bad");
  assert.equal(spaceCodeStatus(DEMO.spaceCode), "ok");
  assert.equal(spaceCodeStatus("WINK-0000-0000"), "expired");
  assert.equal(spaceCodeStatus("WINK-1111-2222"), "wrong");
  assert.equal(inviteStatus("https://web.vyre.run/join/abc"), "ok");
  assert.equal(inviteStatus("my expired invite"), "expired");
  assert.equal(inviteStatus("abc"), "short");
  assert.equal(wordsMatch("River amber, stone quiet"), true);
  assert.equal(wordsMatch("river amber stone"), false);
  assert.equal(addressOf("Harlow Legal"), "harlow-legal");
});

test("Continue with GitHub: a linked id goes to the master password, a new one picks a name, a login becomes a valid name or nothing", async () => {
  const { GITHUB_MOCK, afterGithub, nameFromLogin } = await import("./flow-model.js");
  assert.equal(afterGithub(GITHUB_MOCK.linked), "master.enter");
  assert.equal(afterGithub(GITHUB_MOCK.fresh), "id.new");
  assert.ok(reach("id.choice").has("master.enter") && reach("id.choice").has("id.new"));
  assert.equal(nameFromLogin("Sam_Builds"), "sam-builds");
  assert.equal(nameFromLogin("12345"), "");
  assert.equal(nameFromLogin("ab"), "");
  assert.equal(nameFromLogin("x".repeat(40)).length, 20);
});

/** Drive route() the way OnboardFlow does: each move goes through it and its patch joins the context. Returns the screens shown. */
function drive(ctx, moves) {
  const shown = [];
  let c = { ...ctx };
  for (const want of moves) { const r = route(c, want); c = { ...c, ...r.patch }; shown.push(r.to); }
  return shown;
}

test("a device with a server keeps the order Identity, Vault, Inference, Space, and is never redirected", () => {
  for (const paired of [true, undefined]) {
    const ctx = { device: "computer", allowed: true, paired };
    assert.deepEqual(stepLabels(ctx), ["Identity", "Vault", "Inference", "Space", "Compute", "Ready"]);
    assert.deepEqual(drive(ctx, ["vault.intro", "master.set", "inf.pick", "space.choice", "create.setup", "compute", "ready"]), ["vault.intro", "master.set", "inf.pick", "space.choice", "create.setup", "compute", "ready"]);
  }
});

test("a device with no server goes Identity, Space, Vault, Inference, then on; the labels say so", () => {
  const ctx = { device: "computer", allowed: true, paired: false };
  assert.deepEqual(stepLabels(ctx), ["Identity", "Space", "Vault", "Inference", "Compute", "Ready"]);
  assert.deepEqual(stepLabels({ ...ctx, device: "phone" }), ["Identity", "Space", "Vault", "Inference", "Ready"]);
  assert.deepEqual(stepLabels({ ...ctx, allowed: false }), ["Identity", "Space", "Vault", "Inference", "Ready"], "Compute stays asked only where it applies");
  // a new person: the identity kit leads to the Vault, which is held; the Space step comes first, then the held Vault screen, then Inference, then Compute
  assert.deepEqual(drive(ctx, ["vault.intro", "create.name", "create.setup", "compute"]), ["space.choice", "create.name", "create.setup", "vault.intro"]);
  assert.deepEqual(drive(ctx, ["vault.intro", "create.setup", "compute", "master.set", "inf.pick", "space.choice"]), ["space.choice", "create.setup", "vault.intro", "master.set", "inf.pick", "compute"], "after Inference it goes on to Compute, not back to the Space step");
  // a returning person (master.enter) and a recovery (master.set) are held the same way
  assert.deepEqual(drive(ctx, ["master.enter", "join.sealing", "ready"]), ["space.choice", "join.sealing", "master.enter"]);
  assert.deepEqual(drive(ctx, ["master.set", "join.sealing", "ready"]), ["space.choice", "join.sealing", "master.set"]);
  // phone: Ready after Inference
  assert.deepEqual(drive({ ...ctx, device: "phone" }, ["vault.intro", "join.sealing", "ready", "inf.pick", "space.choice"]), ["space.choice", "join.sealing", "vault.intro", "inf.pick", "ready"]);
  // adding a space later is never rerouted
  assert.deepEqual(drive({ ...ctx, later: true }, ["compute", "ready"]), ["compute", "ready"]);
});

test("the Vault step tells a device with no server so, and keeps check your connection for one that has a server", () => {
  assert.equal(unreachableSay(false), NO_SERVER_SAY);
  assert.equal(unreachableSay(true), NO_BOX_SAY);
  assert.match(NO_SERVER_SAY, /Add a server first/);
  assert.doesNotMatch(NO_SERVER_SAY, /connection/);
  assert.match(NO_BOX_SAY, /Check your connection/);
});

test("setup reopened on a device that keeps a name but has no server opens on the Space step, with the Vault held for after it", () => {
  const r = resumeAt({ hasServer: false, identityName: "harper" });
  assert.deepEqual(r && r.stack, ["space.choice"]);
  assert.deepEqual(r && r.patch, { paired: false, name: "harper", vaultEntry: "vault.intro" });
  // from there the flow runs Space, then the held Vault screen, then Inference, then on
  const ctx = { device: "computer", allowed: true, ...(r ? r.patch : {}) };
  assert.deepEqual(drive(ctx, ["create.setup", "compute"]), ["create.setup", "vault.intro"]);
  assert.deepEqual(drive(ctx, ["join.sealing", "compute", "master.set", "inf.pick", "space.choice"]), ["join.sealing", "vault.intro", "master.set", "inf.pick", "compute"]);
  assert.deepEqual(stepLabels(ctx), ["Identity", "Space", "Vault", "Inference", "Compute", "Ready"]);
  // not resumed: a server exists, no name is kept (a first run opens on Identity), or a join or create link chose the entry
  assert.equal(resumeAt({ hasServer: true, identityName: "harper" }), null);
  assert.equal(resumeAt({ hasServer: false, identityName: "" }), null);
  assert.equal(resumeAt({ hasServer: false, identityName: "harper", entry: "join" }), null);
});
