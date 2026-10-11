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
  return { d, ownerChain, bobChain, tokenOf, runs, launch };
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

test("a member's request for an agent that HAS a credential picked for it runs on that credential; the same agent with nothing picked is refused", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const meta = await w.tokenOf(w.bobChain);
  const picked = await w.d.registry.call("threads.launch", { agent: "kit", agent_kind: "agent", auth: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: "picked-for-kit" }, cwd: w.work, prompt: "hello" }, "module:agents", meta);
  assert.ok(picked.data && !picked.error, JSON.stringify(picked.error));
  await until(() => w.runs() === 1, "the agent thread on its picked credential");
  const bare = await w.launch(meta);
  assert.equal(bare.error && bare.error.code, "no_account", JSON.stringify(bare));
  assert.equal(w.runs(), 1, "and the one with nothing picked made no thread");
});
