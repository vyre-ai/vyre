import "../scripts/mac-test-guard.mjs";
// @ts-check
// The sealing process's own verdicts through the gateway door, on a REAL daemon (not a stubbed verifier): an owner's software key is enrolled the way the walk does it (scripts/dev-enrol-software-key.mjs),
// the daemon runs with the dev switches, and tasks.decide is called over the socket with the proof in the x-vyre-kernel-proof header, as the app does. A proof that stands approves the task; a proof the
// verifier refuses for any reason (wrong_decision, wrong_payload, unknown_key, bad_signature) leaves the task waiting and the caller gets needs_presence with that reason as detail.reason; a proof that stood once does not approve another task.
// The verifier's reason rides beside needs_presence as error.detail.reason (a stable code the app maps to its own words); the message stays our own text.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { homeIdentity } from "../kernel/home.js";
import { tempHome } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (/** @type {string} */ script, /** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8" });

test("the sealing verifier's verdicts reach the caller through the gateway door on a real daemon: each bad proof is refused needs_presence and leaves the task waiting; the good one approves once", { timeout: 120_000 }, async t => {
  const saved = { dev: process.env.VYRE_SEAL_DEV, sw: process.env.VYRE_SEAL_SOFTWARE, path: process.env.VYRE_KERNEL_PATH_RULE };
  Object.assign(process.env, { VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1", VYRE_KERNEL_PATH_RULE: "1" });
  t.after(() => { for (const [k, v] of [["VYRE_SEAL_DEV", saved.dev], ["VYRE_SEAL_SOFTWARE", saved.sw], ["VYRE_KERNEL_PATH_RULE", saved.path]]) { if (v === undefined) delete process.env[/** @type {string} */ (k)]; else process.env[/** @type {string} */ (k)] = /** @type {string} */ (v); } });
  const root = tempHome(t);
  homeIdentity(root);
  const enrol = run("dev-enrol-software-key.mjs", ["--home", root]);
  assert.equal(enrol.status, 0, enrol.stderr);
  const key = JSON.parse(enrol.stdout);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  assert.equal(owner, key.person);
  await new Promise(r => setTimeout(r, 100)); // the sealing process takes no proof made before it started
  const person = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const made = await d.registry.call("agents.create", { name: "assistant", kind: "assistant", projects: "*" }, "cli");
  assert.ok(!made.error, JSON.stringify(made));
  const agent = d.kernel.chains.fromFacts({ kind: "agent_session", agent: "assistant", session: "s", thread: "t", vouched: true });
  const ask = d.kernel.gateway.ask;
  /** a task the assistant did and the owner has to check */
  const waiting = async () => {
    const task = await ask.request(person, { title: "Draft the letter", output: { kind: "decision" }, source: "manual", doer: { kind: "agent", id: "assistant", space }, checker: { kind: "person", id: owner, space } });
    await ask.start(agent, task.id);
    const sub = await ask.complete(agent, task.id, { answer: "yes", reason: "drafted" });
    assert.equal(sub.state, "needs_check");
    return sub;
  };
  /** @param {string[]} args @returns {any} */
  const sign = args => { const r = run("dev-sign-proof.mjs", ["--home", root, ...args]); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const header = (/** @type {any} */ proof) => ({ "x-vyre-kernel-proof": Buffer.from(JSON.stringify(proof)).toString("base64url") });
  const decide = (/** @type {string} */ id, /** @type {any} */ proof) => call("tasks.decide", { id, outcome: "approved" }, { root, caller: "cli", headers: header(proof) });
  const fieldsOf = (/** @type {any} */ task) => ({ task: task.id, payload_hash: task.payload.payload_hash, decision: task.payload.decision });
  const stateOf = async (/** @type {string} */ id) => (await ask.get(person, id)).state;

  const task = await waiting();
  const f = fieldsOf(task);
  const good = sign(["--op", "task.decide", "--fields", JSON.stringify(f)]);

  const bad = {
    "a proof for another act (wrong_decision)": sign(["--op", "task.unblock", "--fields", JSON.stringify({ task: task.id, reassign_to: null })]),
    "a proof over another payload (wrong_payload)": sign(["--op", "task.decide", "--fields", JSON.stringify({ ...f, payload_hash: "0".repeat(64) })]),
    "a proof from a key the process never enrolled (unknown_key)": { ...good, key_id: "dk_00000000", nonce: "unknownkeynonce" },
    "a proof with a damaged signature (bad_signature)": { ...good, nonce: "badsignonce", signature: Buffer.alloc(64, 7).toString("base64url") },
    "no proof at all": null,
  };
  const reasons = ["wrong_decision", "wrong_payload", "unknown_key", "bad_signature", "no_proof"];
  for (const [i, [name, proof]] of Object.entries(bad).entries()) {
    const r = proof ? await decide(task.id, proof) : await call("tasks.decide", { id: task.id, outcome: "approved" }, { root, caller: "cli" });
    assert.equal(r.error && r.error.code, "needs_presence", `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.error.detail && r.error.detail.reason, reasons[i], `${name}: the verifier's reason rides beside needs_presence as a stable code: ${JSON.stringify(r)}`);
    assert.doesNotMatch(r.error.message, /wrong_|unknown_key|bad_signature|dk_/, `${name}: the message stays our own text`);
    assert.equal(await stateOf(task.id), "needs_check", `${name}: the task is still waiting`);
  }
  // the same on a gated act (a standing rule): the grant path's verifier answers { ok, reason } too, so its refusal carries the reason beside needs_presence
  const rule = { kind: "never", binds: ["assistants"], covers: { actions: ["records.remove"] }, label: "Assistants never delete a record" };
  const define = (/** @type {any} */ proof, r = rule) => call("rules.define", { rule: r }, { root, caller: "cli", ...(proof ? { headers: header(proof) } : {}) });
  const forRule = sign(["--space", space, "--call", "ruleSet", "--args", JSON.stringify([rule])]);
  const wrongKey = await define({ ...forRule, key_id: "dk_00000000" });
  assert.equal(wrongKey.error && wrongKey.error.code, "needs_presence", JSON.stringify(wrongKey));
  assert.equal(wrongKey.error.detail && wrongKey.error.detail.reason, "unknown_key", JSON.stringify(wrongKey));
  const otherRule = await define(forRule, { ...rule, label: "Assistants never delete anything at all" });
  assert.equal(otherRule.error && otherRule.error.detail && otherRule.error.detail.reason, "wrong_payload", JSON.stringify(otherRule));
  // none of the refusals used up the good proof's nonce: it still stands, once
  const ok = await decide(task.id, good);
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.equal(await stateOf(task.id), "done");
  // a used proof carried to the next task is refused (it is bound to the first task's payload, so the verifier says wrong_payload before it reaches the nonce list; the replayed verdict itself is kernel/seal/seal.test.js's)
  const second = await waiting();
  const again = await decide(second.id, good);
  assert.equal(again.error && again.error.code, "needs_presence", JSON.stringify(again));
  assert.equal(again.error.detail && again.error.detail.reason, "wrong_payload");
  assert.equal(await stateOf(second.id), "needs_check");
  // and a fresh proof for that task approves it
  const fresh = await decide(second.id, sign(["--op", "task.decide", "--fields", JSON.stringify(fieldsOf(second))]));
  assert.ok(!fresh.error, JSON.stringify(fresh));
  assert.equal(await stateOf(second.id), "done");
});
