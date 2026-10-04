// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSpace, resume, cancel, submitCode, status, addServer, submitServerCode, assessThisComputer, planMoveHome, serverInstall,
  createSpaceFlow, STEPS, INSTALL_COMMAND, PAIR_PROMPT, HomesError,
} from "./homes.js";
import { verifyUnit, sharedBetween, homeUnit } from "./home-unit.js";
import { VpsError } from "./vps.js";

const SP = "spc_harlow00001", SP2 = "spc_northwind002";
const PRIV = "PRIVATE-KEY-SECRET-aaaa1111", PUB = "PUBLIC-KEY-bbbb2222", TOKEN = "dop_v1_faketoken0123456789", CODE = "483920";
const DEVICE = { id: "dev_alex_laptop", name: "Alex's laptop", alwaysOn: true };

/** Everything fake. `fails` maps "<dep>.<fn>" to a number of times it throws before working. */
function world(/** @type {{ fails?: Record<string, number>, ttlMs?: number, maxTries?: number, check?: any }} */ o = {}) {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (/** @type {number} */ ms) => { t += ms; } };
  const kv = new Map();
  const events = /** @type {any[]} */ ([]);
  const calls = /** @type {string[]} */ ([]);
  const applied = /** @type {any[]} */ ([]);
  const fails = { ...(o.fails ?? {}) };
  const hit = (/** @type {string} */ name) => { calls.push(name); if ((fails[name] ?? 0) > 0) { fails[name]--; throw new Error(`boom ${name} ${PRIV} ${TOKEN}`); } };
  let ctr = 3;
  let codeNo = 0;
  const droplets = /** @type {any[]} */ ([]);
  const deps = /** @type {any} */ ({
    clock,
    emit: (/** @type {string} */ type, /** @type {any} */ payload) => events.push({ type, payload: JSON.parse(JSON.stringify(payload)) }),
    random: (/** @type {number} */ n) => Uint8Array.from({ length: n }, () => (ctr = (ctr * 1103515245 + 12345) & 0xff)),
    store: {
      get: async (/** @type {string} */ k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => { kv.set(k, JSON.stringify(v)); },
    },
    keys: {
      generate: async () => { hit("keys.generate"); return { publicKey: PUB, privateKey: PRIV }; },
      hold: async (/** @type {string} */ id, /** @type {string} */ priv) => { hit("keys.hold"); assert.equal(priv, PRIV); },
      discard: async () => { hit("keys.discard"); },
    },
    names: {
      check: async (/** @type {string} */ label) => { hit("names.check"); return o.check ? o.check(label) : { ok: true }; },
      claimSpace: async (/** @type {any} */ a) => { hit("names.claimSpace"); assert.equal(a.rootPublic, PUB); return { ok: true }; },
      releaseSpace: async () => { hit("names.releaseSpace"); return { ok: true }; },
      pointHome: async () => { hit("names.pointHome"); },
    },
    members: { bootstrapOwner: async () => { hit("members.bootstrapOwner"); } },
    records: { provisionWorkspace: async (/** @type {any} */ a) => { hit("records.provisionWorkspace"); return { workspaceId: `ws_${a.spaceId}` }; }, deleteWorkspace: async () => { hit("records.deleteWorkspace"); } },
    pairing: {
      startCode: async () => { hit("pairing.startCode"); codeNo++; return { code: CODE }; },
      verifyCode: async (/** @type {string} */ _id, /** @type {string} */ code) => { hit("pairing.verifyCode"); return code === CODE; },
    },
    homeHost: {
      apply: async (/** @type {any} */ a) => { hit("homeHost.apply"); applied.push(a); },
      join: async () => { hit("homeHost.join"); },
    },
    vps: {
      createDroplet: async (/** @type {any} */ a) => { hit("vps.createDroplet"); assert.equal(a.token, TOKEN); droplets.push("d1"); return { dropletId: "d1", firewallId: "f1" }; },
      waitActive: async () => { hit("vps.waitActive"); return { address: "203.0.113.9" }; },
      destroy: async (/** @type {string} */ tok, /** @type {any} */ ids) => { hit("vps.destroy"); droplets.splice(0); return { removed: [ids.dropletId] }; },
    },
    pairingOptions: { ttlMs: o.ttlMs ?? 600000, maxTries: o.maxTries ?? 3 },
  });
  const count = (/** @type {string} */ n) => calls.filter(c => c === n).length;
  return { deps, clock, kv, events, calls, applied, count, droplets };
}

const serverPlan = (/** @type {any} */ x = {}) => ({ spaceId: SP, name: "Harlow", personId: "alex", home: { kind: "server" }, ...x });
const computerPlan = (/** @type {any} */ x = {}) => ({ spaceId: SP, name: "harlow", personId: "alex", home: { kind: "this-computer", device: DEVICE, confirmed: true }, ...x });
const vpsPlan = (/** @type {any} */ x = {}) => ({ spaceId: SP, name: "harlow", personId: "alex", home: { kind: "vps", provider: "digitalocean", region: "nyc3", size: "s-2vcpu-4gb", token: TOKEN }, ...x });

/** The fake secrets and every generated unit secret must be nowhere an observer can see. */
function assertNoSecrets(/** @type {ReturnType<typeof world>} */ w, /** @type {any[]} */ outputs = []) {
  const secrets = [PRIV, TOKEN, ...w.applied.flatMap(a => Object.values(/** @type {Record<string,string>} */ (Object.fromEntries(a.unit.files.find((/** @type {any} */ f) => f.path === ".env").content.trim().split("\n").map((/** @type {string} */ l) => l.split("="))))))];
  const hay = [JSON.stringify(w.events), JSON.stringify(outputs), JSON.stringify([...w.kv.values()])];
  for (const s of secrets) for (const h of hay) assert.ok(!h.includes(String(s)), `secret leaked: ${String(s).slice(0, 8)}`);
  for (const e of w.events) assert.ok(!JSON.stringify(e).includes(CODE), "the pairing code is in an event");
}

const stepsOf = (/** @type {any} */ w) => w.events.filter((/** @type {any} */ e) => e.type === "space.create.step" && e.payload.state === "done").map((/** @type {any} */ e) => e.payload.step);

// ---------- every step, server ----------

test("server: the one command, the code prompt, then every step runs in order", async () => {
  const w = world();
  const r = await createSpace(serverPlan(), w.deps);
  assert.equal(r.status, "waiting");
  assert.equal(r.step, "home");
  assert.equal(r.waiting?.installCommand, "curl -fsSL vyre.run/i | sh");
  assert.equal(r.waiting?.installCommand, INSTALL_COMMAND);
  assert.equal(r.waiting?.prompt, "Enter the code from your phone or computer:");
  assert.equal(r.waiting?.prompt, PAIR_PROMPT);
  assert.equal(r.waiting?.code, CODE);
  assert.equal(r.domain, "harlow.vyre.run");
  // nothing past the home has run, and the server is not the home yet
  assert.equal(w.count("homeHost.apply"), 0);
  assert.equal(w.count("records.provisionWorkspace"), 0);
  const s = await submitCode(SP, CODE, w.deps);
  assert.equal(s.pairing, "matched");
  assert.equal(s.status, "done");
  assert.deepEqual(stepsOf(w), [...STEPS]);
  assert.equal(s.workspaceId, `ws_${SP}`);
  assert.deepEqual(w.calls.filter(c => !/pairing|names.check/.test(c)), ["keys.generate", "keys.hold", "names.claimSpace", "members.bootstrapOwner", "homeHost.apply", "names.pointHome", "records.provisionWorkspace"]);
  assert.equal(verifyUnit(JSON.parse(w.applied[0].unit.files[0].content)).ok, true);
  assert.equal(w.applied[0].unit.files.find((/** @type {any} */ f) => f.path === ".env").mode, 0o600);
  assertNoSecrets(w, [r, s]);
});

test("each step emits running then done, and nothing else", async () => {
  const w = world();
  await createSpace(computerPlan(), w.deps);
  const seq = w.events.filter(e => e.type === "space.create.step").map(e => `${e.payload.step}:${e.payload.state}`);
  assert.deepEqual(seq, STEPS.flatMap(s => [`${s}:running`, `${s}:done`]));
  assert.equal(w.events.at(-1).type, "space.create.done");
  for (const e of w.events.filter(e => e.type === "space.create.step")) assert.deepEqual(Object.keys(e.payload).filter(k => !["spaceId", "step", "state", "reason", "code"].includes(k)), []);
});

test("createSpace is idempotent: the same space id never repeats a done step", async () => {
  const w = world();
  await createSpace(computerPlan(), w.deps);
  const again = await createSpace(computerPlan(), w.deps);
  assert.equal(again.status, "done");
  assert.equal(w.count("names.claimSpace"), 1);
  assert.equal(w.count("keys.generate"), 1);
  assert.equal(w.count("homeHost.apply"), 1);
});

test("the bound flow exposes the same calls", async () => {
  const w = world();
  const f = createSpaceFlow(w.deps);
  const r = await f.createSpace(computerPlan());
  assert.equal(r.status, "done");
  assert.equal((await f.status(SP)).status, "done");
});

// ---------- validate ----------

test("validate: plain-words errors", async () => {
  const bad = /** @type {[any, RegExp][]} */ ([
    [{ name: "" }, /Give the space a name/],
    [{ personId: "" }, /Sign in/],
    [{ home: { kind: "cloud" } }, /Pick where the space will live/],
    [{ home: { kind: "vps", provider: "linode", token: TOKEN } }, /Only DigitalOcean/],
    [{ home: { kind: "vps", provider: "digitalocean", size: "huge", token: TOKEN } }, /size is not offered/],
    [{ home: { kind: "vps", provider: "digitalocean", region: "nyc3", size: "s-2vcpu-4gb" } }, /Paste your DigitalOcean token/],
  ]);
  for (const [patch, re] of bad) {
    const w = world();
    const r = await createSpace(serverPlan(patch), w.deps);
    assert.equal(r.status, "failed", JSON.stringify(patch));
    assert.equal(r.failed?.step, "validate");
    assert.match(r.failed?.reason ?? "", re);
    assert.equal(w.count("keys.generate"), 0, "nothing was made before validation passed");
  }
});

test("validate: the name rules come from names.check", async () => {
  const w = world({ check: () => ({ ok: false, message: "Names start with a letter." }) });
  const r = await createSpace(serverPlan({ name: "9lives" }), w.deps);
  assert.equal(r.failed?.reason, "Names start with a letter.");
});

test("name taken at check: plain words, then a new name resumes cleanly", async () => {
  const w = world({ check: (/** @type {string} */ l) => (l === "harlow" ? { ok: false, reason: "taken" } : { ok: true }) });
  const r = await createSpace(computerPlan(), w.deps);
  assert.equal(r.status, "failed");
  assert.equal(r.failed?.reason, "That name is taken. Pick another.");
  const r2 = await resume(SP, w.deps, { name: "harlow-legal" });
  assert.equal(r2.status, "done");
  assert.equal(r2.domain, "harlow-legal.vyre.run");
});

test("name taken at claim (lost a race): fails with a plain reason, key is kept, a new name continues without a second key", async () => {
  const w = world();
  let first = true;
  const claim = w.deps.names.claimSpace;
  w.deps.names.claimSpace = async (/** @type {any} */ a) => { if (first) { first = false; return { ok: false, code: "taken" }; } return claim(a); };
  const r = await createSpace(computerPlan(), w.deps);
  assert.equal(r.failed?.step, "claim");
  assert.match(r.failed?.reason ?? "", /just taken/);
  const r2 = await resume(SP, w.deps, { name: "harlow-law" });
  assert.equal(r2.status, "done");
  assert.equal(w.count("keys.generate"), 1);
});

test("this computer: nothing happens until the person confirms the sleep warning", async () => {
  const w = world();
  const r = await createSpace(computerPlan({ home: { kind: "this-computer", device: DEVICE } }), w.deps);
  assert.equal(r.status, "waiting");
  assert.equal(r.waiting?.for, "confirm");
  assert.match(r.waiting?.assessment.warning, /unreachable while Alex's laptop sleeps/);
  assert.equal(w.count("keys.generate"), 0);
  const r2 = await resume(SP, w.deps, { confirmThisComputer: true });
  assert.equal(r2.status, "done");
  assert.equal(w.applied[0].home.kind, "this-computer");
});

test("assessThisComputer: the warning, the caller's alwaysOn flag, and the move note", () => {
  const a = assessThisComputer({ name: "Kit's desktop", alwaysOn: false });
  assert.equal(a.alwaysOn, false);
  assert.match(a.warning, /unreachable while Kit's desktop sleeps/);
  assert.match(a.moveToServerLater, /one action/);
  assert.equal(a.needsConfirmation, true);
  assert.equal(assessThisComputer({ alwaysOn: true }).alwaysOn, true);
});

// ---------- resume after a failure at each step ----------

const firstTimeFailures = /** @type {[string, string, string][]} */ ([
  ["validate", "names.check", "validate"],
  ["rootkey-generate", "keys.generate", "rootkey"],
  ["rootkey-hold", "keys.hold", "rootkey"],
  ["claim", "names.claimSpace", "claim"],
  ["owner", "members.bootstrapOwner", "owner"],
  ["unit-apply", "homeHost.apply", "unit"],
  ["unit-point", "names.pointHome", "unit"],
  ["workspace", "records.provisionWorkspace", "workspace"],
]);
for (const [label, dep, step] of firstTimeFailures) {
  test(`resume after a failure at ${label}: plain reason, then continues without repeating a done step`, async () => {
    const w = world({ fails: { [dep]: 1 } });
    const r = await createSpace(computerPlan(), w.deps);
    assert.equal(r.status, "failed");
    assert.equal(r.failed?.step, step);
    assert.ok(r.failed?.reason && !r.failed.reason.includes("boom") && !r.failed.reason.includes(PRIV) && !r.failed.reason.includes(TOKEN), r.failed?.reason);
    const doneBefore = STEPS.slice(0, STEPS.indexOf(/** @type {any} */ (step)));
    const callsBefore = new Map(["keys.generate", "names.claimSpace", "members.bootstrapOwner"].map(n => [n, w.count(n)]));
    const r2 = await resume(SP, w.deps);
    assert.equal(r2.status, "done", JSON.stringify(r2.failed));
    // a step that finished before the failure ran exactly once
    if (doneBefore.includes("rootkey")) assert.equal(w.count("keys.generate"), callsBefore.get("keys.generate"));
    if (doneBefore.includes("claim")) assert.equal(w.count("names.claimSpace"), callsBefore.get("names.claimSpace"));
    if (doneBefore.includes("owner")) assert.equal(w.count("members.bootstrapOwner"), callsBefore.get("members.bootstrapOwner"));
    assert.equal(w.count("records.provisionWorkspace"), step === "workspace" ? 2 : 1);
    assert.equal(w.count("names.claimSpace"), step === "claim" ? 2 : 1);
    assert.equal(w.count("keys.generate"), step === "rootkey" && dep === "keys.generate" ? 2 : step === "rootkey" ? 2 : 1);
    assertNoSecrets(w, [r, r2]);
  });
}

test("a failure leaves the stored state resumable by a fresh process (state is in the store, not memory)", async () => {
  const w = world({ fails: { "members.bootstrapOwner": 1 } });
  await createSpace(computerPlan(), w.deps);
  const stored = JSON.parse(/** @type {string} */ (w.kv.get(`space-create/${SP}`)));
  assert.equal(stored.steps.owner.state, "failed");
  assert.equal(stored.steps.claim.state, "done");
  assert.equal((await status(SP, w.deps)).failed?.step, "owner");
  assert.equal((await resume(SP, w.deps)).status, "done");
});

test("resume of an unknown space is plain words", async () => {
  await assert.rejects(resume(SP, world().deps), (/** @type {any} */ e) => e instanceof HomesError && /No space is being created/.test(e.message));
  await assert.rejects(resume("nope", world().deps), /not valid/);
});

// ---------- pairing state machine ----------

test("pairing: a wrong code costs a try, then the right one matches and the home is ready", async () => {
  const w = world();
  const r = await createSpace(serverPlan(), w.deps);
  assert.equal(r.waiting?.triesLeft, 3);
  const bad = await submitCode(SP, "111111", w.deps);
  assert.equal(bad.pairing, "wrong_code");
  assert.equal(bad.status, "waiting");
  assert.equal(bad.waiting?.triesLeft, 2);
  assert.match(bad.message, /does not match/);
  assert.equal(w.count("homeHost.apply"), 0);
  const ok = await submitCode(SP, CODE, w.deps);
  assert.equal(ok.pairing, "matched");
  assert.equal(ok.status, "done");
  const states = w.events.filter(e => e.type === "space.pairing.state").map(e => e.payload.state);
  assert.deepEqual(states, ["waiting_for_code", "waiting_for_code", "matched", "home_ready"]);
});

test("pairing: too many wrong tries lock it, nothing becomes the home, resume gives a new code", async () => {
  const w = world({ maxTries: 3 });
  await createSpace(serverPlan(), w.deps);
  await submitCode(SP, "000001", w.deps);
  await submitCode(SP, "000002", w.deps);
  const locked = await submitCode(SP, "000003", w.deps);
  assert.equal(locked.pairing, "locked");
  assert.equal(locked.status, "failed");
  assert.match(locked.failed?.reason ?? "", /Too many wrong codes/);
  await assert.rejects(submitCode(SP, CODE, w.deps), /not waiting for a code/);
  assert.equal(w.count("homeHost.apply"), 0);
  const again = await resume(SP, w.deps);
  assert.equal(again.status, "waiting");
  assert.equal(again.waiting?.triesLeft, 3);
  assert.equal(w.count("pairing.startCode"), 2);
  assert.equal((await submitCode(SP, CODE, w.deps)).status, "done");
});

test("pairing: a badly shaped code counts as a try without asking the pairing service", async () => {
  const w = world();
  await createSpace(serverPlan(), w.deps);
  const r = await submitCode(SP, "abc", w.deps);
  assert.equal(r.pairing, "wrong_code");
  assert.equal(w.count("pairing.verifyCode"), 0);
});

test("pairing: a code that times out fails in plain words and resume starts a new one", async () => {
  const w = world({ ttlMs: 60_000 });
  await createSpace(serverPlan(), w.deps);
  w.clock.advance(61_000);
  const r = await submitCode(SP, CODE, w.deps);
  assert.equal(r.pairing, "timed_out");
  assert.equal(r.status, "failed");
  assert.match(r.failed?.reason ?? "", /ran out of time/);
  assert.equal(w.count("pairing.verifyCode"), 0, "an expired code is never verified");
  const again = await resume(SP, w.deps);
  assert.equal(again.status, "waiting");
  assert.equal((await submitCode(SP, CODE, w.deps)).status, "done");
});

test("pairing: resume while waiting keeps the same code, and an expired wait gets a fresh one", async () => {
  const w = world({ ttlMs: 60_000 });
  await createSpace(serverPlan(), w.deps);
  await resume(SP, w.deps);
  assert.equal(w.count("pairing.startCode"), 1);
  w.clock.advance(120_000);
  const r = await resume(SP, w.deps);
  assert.equal(r.status, "waiting");
  assert.equal(w.count("pairing.startCode"), 2);
});

test("serverInstall returns the command, the prompt and a code to show", async () => {
  const w = world();
  const r = await serverInstall({ spaceId: SP }, w.deps);
  assert.equal(r.installCommand, "curl -fsSL vyre.run/i | sh");
  assert.equal(r.prompt, "Enter the code from your phone or computer:");
  assert.equal(r.state, "waiting_for_code");
  assert.equal(r.code, CODE);
});

// ---------- add a server to an existing space ----------

test("add server: joins as compute by default", async () => {
  const w = world();
  const a = await addServer({ spaceId: SP }, w.deps);
  assert.equal(a.role, "compute");
  assert.equal(a.installCommand, INSTALL_COMMAND);
  const bad = await submitServerCode(SP, a.joinId, "999999", w.deps);
  assert.equal(bad.state, "wrong_code");
  assert.equal(bad.triesLeft, 2);
  const ok = await submitServerCode(SP, a.joinId, CODE, w.deps);
  assert.deepEqual(ok, { state: "joined", role: "compute" });
  await assert.rejects(submitServerCode(SP, a.joinId, CODE, w.deps), /not waiting for a code/);
  assert.equal(w.count("homeHost.join"), 1);
});

test("add server with moveHome joins as the new home and returns the move plan", async () => {
  const w = world();
  const space = { id: SP, name: "Harlow Legal", home: { kind: "this-computer", device: { id: "dev_alex_laptop" } } };
  const a = await addServer({ spaceId: SP, moveHome: true, space, newHome: { kind: "server", id: "srv_1" } }, w.deps);
  assert.equal(a.role, "home");
  const ok = await submitServerCode(SP, a.joinId, CODE, w.deps);
  assert.equal(ok.role, "home");
  assert.equal(ok.movePlan?.oneAction, true);
});

test("add server: lock and timeout end the attempt", async () => {
  const w = world({ maxTries: 2, ttlMs: 1000 });
  const a = await addServer({ spaceId: SP }, w.deps);
  await submitServerCode(SP, a.joinId, "000001", w.deps);
  assert.equal((await submitServerCode(SP, a.joinId, "000002", w.deps)).state, "locked");
  const b = await addServer({ spaceId: SP }, w.deps);
  w.clock.advance(5000);
  assert.equal((await submitServerCode(SP, b.joinId, CODE, w.deps)).state, "timed_out");
  await assert.rejects(submitServerCode(SP, "join_nope", CODE, w.deps), /No server is waiting/);
});

// ---------- vps ----------

test("vps: creates the server, waits, pairs, and the token is never stored", async () => {
  const w = world();
  const r = await createSpace(vpsPlan(), w.deps);
  assert.equal(r.status, "waiting");
  assert.equal(r.address, "203.0.113.9");
  assert.equal(r.estimate?.usdPerMonth, 24);
  assert.equal(w.count("vps.createDroplet"), 1);
  const s = await submitCode(SP, CODE, w.deps);
  assert.equal(s.status, "done");
  assertNoSecrets(w, [r, s]);
});

test("vps: a failure after the droplet exists never creates a second one; resume needs the token again", async () => {
  const w = world({ fails: { "vps.waitActive": 1 } });
  const r = await createSpace(vpsPlan(), w.deps);
  assert.equal(r.failed?.step, "home");
  assert.equal(w.count("vps.createDroplet"), 1);
  const noToken = await resume(SP, w.deps);
  assert.match(noToken.failed?.reason ?? "", /Paste your DigitalOcean token again/);
  const r2 = await resume(SP, w.deps, { vpsToken: TOKEN });
  assert.equal(r2.status, "waiting");
  assert.equal(w.count("vps.createDroplet"), 1);
  assert.equal((await submitCode(SP, CODE, w.deps)).status, "done");
  assertNoSecrets(w, [r, noToken, r2]);
});

test("vps: the driver's own plain-words reason reaches the person, redacted", async () => {
  const w = world();
  w.deps.vps.createDroplet = async () => { throw new VpsError("bad_token", "DigitalOcean did not accept the token. Make a token with read and write access and try again."); };
  const r = await createSpace(vpsPlan(), w.deps);
  assert.match(r.failed?.reason ?? "", /did not accept the token/);
});

test("vps with the real driver and a fake fetch: the token never reaches an event, error or the store", async () => {
  const w = world();
  delete w.deps.vps;
  const sent = /** @type {string[]} */ ([]);
  const ok = (/** @type {number} */ s, /** @type {any} */ b = {}) => ({ status: s, headers: { get: () => null }, json: async () => b });
  w.deps.vpsDeps = { sleep: async () => {}, fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
    sent.push(`${init.method} ${url}`);
    if (init.method === "POST" && url.endsWith("/firewalls")) return ok(202, { firewall: { id: "fw9" } });
    if (init.method === "POST") return ok(202, { droplet: { id: 9 } });
    if (init.method === "GET") return ok(200, { droplet: { status: "active", networks: { v4: [{ type: "public", ip_address: "203.0.113.20" }] } } });
    return ok(204);
  } };
  const r = await createSpace(vpsPlan(), w.deps);
  assert.equal(r.address, "203.0.113.20");
  const c = await cancel(SP, w.deps, { vpsToken: TOKEN });
  assert.ok(c.rolledBack.includes("the new server"));
  assert.ok(sent.includes("DELETE https://api.digitalocean.com/v2/droplets/9"));
  assertNoSecrets(w, [r, c]);
});

// ---------- cancel ----------

test("cancel: releases the name, discards the key, destroys the droplet it made, and says what it could not", async () => {
  const w = world();
  await createSpace(vpsPlan(), w.deps);
  const c = await cancel(SP, w.deps, { vpsToken: TOKEN });
  assert.equal(c.cancelled, true);
  assert.deepEqual(c.rolledBack.sort(), ["the name", "the new server", "the space's key"].sort());
  assert.equal(w.count("vps.destroy"), 1);
  assert.equal(w.count("names.releaseSpace"), 1);
  assert.deepEqual(c.couldNot, []);
  assert.equal((await status(SP, w.deps)).status, "cancelled");
  assert.equal((await cancel(SP, w.deps)).cancelled, true);
  assert.equal(w.count("vps.destroy"), 1, "a second cancel does not repeat");
  await assert.rejects(submitCode(SP, CODE, w.deps), /not waiting for a code/);
});

test("cancel without the token says the droplet stays and tells the person how to stop the cost", async () => {
  const w = world();
  await createSpace(vpsPlan(), w.deps);
  const c = await cancel(SP, w.deps);
  assert.equal(w.count("vps.destroy"), 0);
  assert.ok(c.couldNot.some(x => x.what === "the new server" && /stops costing money/.test(x.why)));
});

test("cancel after a failed destroy reports it", async () => {
  const w = world({ fails: { "vps.destroy": 1 } });
  await createSpace(vpsPlan(), w.deps);
  const c = await cancel(SP, w.deps, { vpsToken: TOKEN });
  assert.ok(c.couldNot.some(x => x.what === "the new server"));
  assert.ok(!JSON.stringify(c).includes(TOKEN));
});

test("cancel: a name that cannot be released and a server install are reported, not hidden", async () => {
  const w = world({ fails: { "names.releaseSpace": 1 } });
  await createSpace(serverPlan(), w.deps);
  const c = await cancel(SP, w.deps);
  const what = c.couldNot.map(x => x.what);
  assert.ok(what.includes("the name"));
  assert.ok(what.includes("Vyre on your server"));
  assert.ok(c.rolledBack.includes("the space's key"));
});

test("cancel after a failed step rolls back only what exists", async () => {
  const w = world({ fails: { "members.bootstrapOwner": 1 } });
  await createSpace(computerPlan(), w.deps);
  const c = await cancel(SP, w.deps);
  assert.deepEqual(c.rolledBack.sort(), ["the name", "the space's key"]);
  assert.deepEqual(c.couldNot, []);
});

test("cancel with everything installed removes the workspace and lists the services it cannot remove", async () => {
  const w = world({ fails: {} });
  // finish everything, then force the record back to unfinished to model a late cancel
  await createSpace(computerPlan(), w.deps);
  const rec = JSON.parse(/** @type {string} */ (w.kv.get(`space-create/${SP}`)));
  rec.status = "failed"; rec.steps.workspace = { state: "failed" };
  w.kv.set(`space-create/${SP}`, JSON.stringify(rec));
  const c = await cancel(SP, w.deps);
  assert.ok(c.rolledBack.includes("the records workspace"));
  assert.ok(c.couldNot.some(x => x.what === "the services on the home"));
});

test("a finished space cannot be cancelled here", async () => {
  const w = world();
  await createSpace(computerPlan(), w.deps);
  const c = await cancel(SP, w.deps);
  assert.equal(c.cancelled, false);
  assert.match(c.couldNot[0].why, /Remove it from the space's settings/);
  assert.equal(w.count("names.releaseSpace"), 0);
});

// ---------- two homes ----------

test("two spaces created on one host share nothing", async () => {
  const w = world();
  await createSpace(computerPlan(), w.deps);
  await createSpace(computerPlan({ spaceId: SP2, name: "northwind" }), w.deps);
  assert.equal(w.applied.length, 2);
  const [a, b] = w.applied.map(x => {
    const env = Object.fromEntries(x.unit.files.find((/** @type {any} */ f) => f.path === ".env").content.trim().split("\n").map((/** @type {string} */ l) => l.split("=")));
    return { project: x.unit.manifest.project, compose: JSON.parse(x.unit.files[0].content), manifest: x.unit.manifest, env };
  });
  assert.deepEqual(sharedBetween(/** @type {any} */ (a), /** @type {any} */ (b)), { project: [], volumes: [], networks: [], ports: [], containers: [], secrets: [] });
  assert.notEqual(a.project, b.project);
});

// ---------- move ----------

test("planMoveHome: one action, ordered steps, a snapshot per volume, hashes verified before the name switches", () => {
  const space = { id: SP, name: "Harlow Legal", home: { kind: "this-computer", device: { id: "dev_alex_laptop" } } };
  const p = planMoveHome(space, { kind: "server", id: "srv_1" });
  assert.equal(p.oneAction, true);
  assert.equal(p.requires, "owner");
  const ids = p.steps.map(s => s.id);
  assert.equal(ids[0], "quiesce");
  assert.deepEqual(ids.slice(-4), ["transfer", "verify", "switch", "release"]);
  const snaps = ids.filter(i => i.startsWith("snapshot:"));
  assert.deepEqual(snaps.map(s => s.slice(9)).sort(), p.volumes.slice().sort());
  assert.ok(ids.indexOf("verify") < ids.indexOf("switch") && ids.indexOf("switch") < ids.indexOf("release"));
  assert.ok(p.steps.find(s => s.id === "verify")?.checks.some(c => /sha256/.test(c)));
  assert.ok(p.steps.find(s => s.id === "switch")?.checks.some(c => /sealed record/.test(c)));
  assert.ok(p.steps.every(s => s.checks.length > 0));
  assert.equal(p.volumes.length, homeUnit({ id: SP }, { random: w0().random }).manifest.volumes.length);
});
const w0 = () => world().deps;

test("planMoveHome uses the unit's own manifest when given, and refuses a no-op or a nonsense home", () => {
  const space = { id: SP, home: { kind: "server", id: "srv_1" }, manifest: { volumes: [`vyre-${SP}-db`, `vyre-${SP}-log`] } };
  assert.deepEqual(planMoveHome(space, { kind: "vps", id: "d1" }).volumes, [`vyre-${SP}-db`, `vyre-${SP}-log`]);
  assert.throws(() => planMoveHome(space, { kind: "server", id: "srv_1" }), /already lives there/);
  assert.throws(() => planMoveHome(space, { kind: "cloud" }), /Pick where/);
  assert.throws(() => planMoveHome({ id: "x" }, { kind: "server" }), /no usable id/);
});

// ---------- secrets, overall ----------

test("secrets never appear in events, errors, views or the store, across failures and cancels", async () => {
  const w = world({ fails: { "keys.hold": 1, "names.claimSpace": 1, "homeHost.apply": 1, "vps.waitActive": 1, "records.provisionWorkspace": 1 } });
  const out = /** @type {any[]} */ ([]);
  out.push(await createSpace(vpsPlan(), w.deps));
  for (let i = 0; i < 8; i++) {
    const r = await resume(SP, w.deps, { vpsToken: TOKEN });
    out.push(r);
    if (r.status === "waiting") out.push(await submitCode(SP, "000000", w.deps), await submitCode(SP, CODE, w.deps));
    if (r.status === "done") break;
  }
  assert.equal((await status(SP, w.deps)).status, "done");
  out.push(await cancel(SP, w.deps, { vpsToken: TOKEN }));
  assertNoSecrets(w, out);
  assert.ok(w.events.length > 10);
});

test("a server already paired to this person is the home with no typed code; one that is not still waits for the code", async () => {
  const w = world();
  /** @type {string[]} */ const asked = [];
  w.deps.pairing.alreadyPaired = async (/** @type {string} */ id) => { asked.push(id); return id === "srv_paired"; };
  const done = await createSpace(serverPlan({ home: { kind: "server", device: { id: "srv_paired", name: "walker server", alwaysOn: true }, confirmed: true } }), w.deps);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(done.waiting ?? null, null, "no code was asked for");
  assert.equal(w.count("pairing.startCode"), 0, "no code was even made");
  assert.equal(w.count("homeHost.apply"), 1);
  assert.deepEqual(asked, ["srv_paired"]);
  const w2 = world();
  w2.deps.pairing.alreadyPaired = async () => false;
  const waiting = await createSpace(serverPlan({ spaceId: SP, home: { kind: "server", device: { id: "srv_other", name: "x", alwaysOn: true }, confirmed: true } }), w2.deps);
  assert.equal(waiting.status, "waiting");
  assert.equal(w2.count("pairing.startCode"), 1);
  const w3 = world();
  w3.deps.pairing.alreadyPaired = async () => { throw new Error("whois unavailable"); };
  assert.equal((await createSpace(serverPlan({ home: { kind: "server", device: { id: "srv_x", name: "x", alwaysOn: true } } }), w3.deps)).status, "waiting", "an unanswered check never skips the code");
});
