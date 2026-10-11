import "../../scripts/mac-test-guard.mjs";
// An agent's thread started on behalf of a member never runs on the owner's login: the internal threads.launch refuses it, with the next step, before a row or a process is made. The owner's request and a call with no
// person (the planner, a Flow, an automation) are unchanged. Real daemon, real kernel, the fake claude as the provider.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

async function world(t) {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const bobChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const tokenOf = async chain => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const db = d.registry.deps.db;
  const runs = () => db.prepare("SELECT COUNT(*) n FROM threads_runs WHERE agent = 'kit'").get().n;
  const launch = (meta, caller = "module:agents") => d.registry.call("threads.launch", { agent: "kit", agent_kind: "agent", auth: "ambient", cwd: work, prompt: "hello" }, caller, meta);
  return { d, ownerChain, bobChain, tokenOf, runs, launch, work };
}

test("a member's request for an agent's thread with no sign-in picked is refused with the next step, and nothing is made", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const r = await w.launch(await w.tokenOf(w.bobChain));
  assert.equal(r.error && r.error.code, "no_account", JSON.stringify(r));
  assert.match(r.error.message, /Ask the owner to pick one/);
  assert.equal(w.runs(), 0, "no thread row, so no process and nothing for the sandbox to give a login to");
});

test("the owner's request for the same agent starts it, as before", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const r = await w.launch(await w.tokenOf(w.ownerChain));
  assert.ok(r.data && !r.error, JSON.stringify(r.error));
  await until(() => w.runs() === 1, "the owner's agent thread");
});

test("a call with no person on it (the planner, a Flow, an automation) starts the agent, as before", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const r = await w.launch({}, "module:planner");
  assert.ok(r.data && !r.error, JSON.stringify(r.error));
  await until(() => w.runs() === 1, "the agent thread");
});

test("a member's request for an agent that HAS a credential picked for it is refused until the credential is delivered unreadable; the owner's request for it starts it", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const picked = (/** @type {any} */ meta) => w.d.registry.call("threads.launch", { agent: "kit", agent_kind: "agent", auth: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: "picked-for-kit" }, cwd: w.work, prompt: "hello" }, "module:agents", meta);
  const refused = await picked(await w.tokenOf(w.bobChain));
  assert.equal(refused.error && refused.error.code, "no_account", JSON.stringify(refused));
  assert.match(refused.error.message, /cannot be used for a teammate's request yet/);
  assert.equal(w.runs(), 0, "and nothing was made");
  const own = await picked(await w.tokenOf(w.ownerChain));
  assert.ok(own.data && !own.error, JSON.stringify(own.error));
  await until(() => w.runs() === 1, "the owner's agent thread on its picked credential");
});

test("the team pump launches with no person on the call: the person the request recorded (for_person) is judged; automation passes; a teammate launch with a picked credential and nobody recorded is refused", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const BEN = "per_" + "b".repeat(26);
  const picked = { CLAUDE_CODE_OAUTH_TOKEN: "picked-for-the-teammate" };
  const launch = (/** @type {any} */ extra) => w.d.registry.call("threads.launch", { agent: "kit", agent_kind: "teammate", auth: "subscription", env: picked, cwd: w.work, prompt: "hello", ...extra }, "module:team", { firstParty: true });
  const memberAsked = await launch({ for_person: BEN });
  assert.equal(memberAsked.error && memberAsked.error.code, "no_account", JSON.stringify(memberAsked));
  assert.match(memberAsked.error.message, /cannot be used for a teammate's request yet/);
  const nobody = await launch({});
  assert.equal(nobody.error && nobody.error.code, "no_account", "nobody recorded: " + JSON.stringify(nobody));
  assert.match(nobody.error.message, /nobody is recorded as having asked/);
  assert.equal(w.runs(), 0, "neither made a thread");
  const owner = await launch({ for_person: w.d.kernel.id.owner });
  assert.ok(owner.data && !owner.error, "the owner's request: " + JSON.stringify(owner.error));
  await until(() => w.runs() === 1, "the owner's teammate thread");
  // the check a module asks for before it queues work answers the same, and names who asked
  const check = await w.d.registry.call("threads.launch-check", { agent: "kit", agent_kind: "teammate", env: picked }, "module:team", await w.tokenOf(w.bobChain));
  assert.equal(check.error && check.error.code, "no_account", JSON.stringify(check));
  const auto = await w.d.registry.call("threads.launch-check", { agent: "kit", agent_kind: "teammate", env: picked, for_person: "automation" }, "module:team", { firstParty: true });
  assert.ok(auto.data && auto.data.asker === null, JSON.stringify(auto));
});

test("for_person is dropped from a call that is not a first-party module's: a member's own call cannot say its work is the owner's automation", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const picked = { CLAUDE_CODE_OAUTH_TOKEN: "picked-for-the-teammate" };
  const forged = await w.d.registry.call("threads.launch-check", { agent: "kit", agent_kind: "teammate", env: picked, for_person: "automation" }, "module:team", await w.tokenOf(w.bobChain));
  assert.equal(forged.error && forged.error.code, "no_account", "a call without firstParty: for_person is dropped and the member's chain is judged: " + JSON.stringify(forged));
});
