// @ts-check
// A member writes in a Flow's chat (agents.flow-say, roadmap 0.6 item 1) on a real vyred with the kernel on: the agent only wakes for a Flow the member may read and an agent shared with them, and the woken
// job's kernel session is the MEMBER's (the daemon builds a Flow job's session from `runas`), never the owner's. SHIM(presence) `kernelPresence` accepts any proof, as the other real-daemon suites do.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";
import { testHooks, OPEN_WALL } from "../../lib/sandbox/index.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
testHooks.wall = OPEN_WALL;
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const until = async (/** @type {() => any} */ fn, /** @type {string} */ what, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 40)); } };

test("a member's words in a Flow chat wake the agent as that member, and only for an agent and a Flow they may use", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSION_SANDBOX_OFF: "1", FAKE_CLAUDE_LOG: path.join(root, "claude.log") });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const benChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "relay" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tokenOf(ownerChain));
  const asBen = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "deck", await tokenOf(benChain));

  assert.ok(!(await asOwner("agents.create", { name: "juno", kind: "agent" })).error);
  const mk = async (/** @type {string} */ name) => { const f = await asOwner("flows.define", { flow: { format: 1, name, label: name, authorship: "human", trigger: { on: "manual" }, steps: [] } }); assert.ok(f.data && f.data.ok, JSON.stringify(f.error || f.data)); await asOwner("flows.approve", { id: f.data.id, version: f.data.version, hash: f.data.hash }); return f.data.id; };
  const open = await mk("refunds"), hidden = await mk("owner_only");

  // an agent not shared with Ben, and a Flow not shared with Ben: refused, and nothing wakes
  const seen = /** @type {any[]} */ ([]);
  const real = d.registry.deps.kernelSession;
  d.registry.deps.kernelSession = async (/** @type {any} */ q) => { seen.push({ thread: q.thread, runas: q.runas, asker: q.asker }); return real(q); };
  assert.equal((await asBen("agents.flow-say", { agent: "juno", flow: open, text: "hi" })).error?.code, "denied", "an agent not shared with him");
  assert.ok(!(await asOwner("agents.access.set", { agent: "juno", kind: "person", subject: BEN, level: "use" })).error);
  assert.ok((await asBen("agents.flow-say", { agent: "juno", flow: hidden, text: "hi" })).error, "a Flow he may not read");
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(seen, [], "nothing woke for a refused write");

  // shared with him: the agent wakes, and the job's kernel session is Ben's, never the owner's
  assert.ok(!(await asOwner("flows.access.set", { id: open, subject: BEN, level: "use" })).error);
  const ok = await asBen("agents.flow-say", { agent: "juno", flow: open, text: "Why did run 8 fail?" });
  assert.ok(ok.data && ok.data.thread, JSON.stringify(ok.error));
  const s = await until(() => seen.find(q => q.thread === ok.data.thread), "the woken job's kernel session");
  assert.equal(s.runas, BEN, "the job acts as the member who wrote");
  assert.notEqual(s.runas, OWNER, "never as the owner");
  const row = (await asOwner("threads.get", { thread: ok.data.thread, limit: 1 })).data?.thread;
  assert.equal(row?.flow_origin?.flow, open, "the thread joins that Flow's chat");

  // inside the job: the agent (the fake claude, scripted by the member's own words) reads through the job's own session. An ordinary read answers, so the path is live; the owner's private skill,
  // which a member never reads, is refused or empty, and none of its words come back.
  const skillBody = "---\nname: owner-secret\ndescription: Use this when the person asks about owner-secret, which is OWNER-PRIVATE-TEXT\n---\nOWNER-PRIVATE-TEXT\n";
  const dr = await asOwner("skills.draft", { name: "owner-secret", level: "personal", body: skillBody });
  assert.ok(!dr.error, JSON.stringify(dr.error));
  assert.ok(!(await asOwner("skills.approve", { name: "owner-secret", level: "personal", version: dr.data.version })).error);
  const kept = (await K.gateway.records.query(K.gateway.serviceChain("skills"), "skill", { page: { limit: 50 } })).rows;
  const secret = kept.find((/** @type {any} */ x) => x.data.name === "owner-secret");
  assert.ok(secret, "the owner's skill exists");
  const inJob = await asBen("agents.flow-say", { agent: "juno", flow: open, text: `vyre records.query {"type":"contact","page":{"limit":3}}\nvyre records.get {"type":"skill","id":"${secret.id}"}` });
  assert.ok(inJob.data && inJob.data.thread, JSON.stringify(inJob.error));
  const said = await until(async () => { const g = JSON.stringify((await asOwner("threads.get", { thread: inJob.data.thread, limit: 80 })).data || {}); return g.includes("rows") ? g : null; }, "the job's own read to answer");
  assert.ok(said.includes("rows"), "an ordinary read in the job answers");
  assert.ok(!said.includes("OWNER-PRIVATE-TEXT"), "the owner's private skill never reaches the member's job");

  // the Flow Ben may not read stays refused even now that he has used another
  assert.ok((await asBen("agents.flow-say", { agent: "juno", flow: hidden, text: "and this one" })).error);
  assert.equal(seen.filter(q => q.runas !== BEN).length, 0, "no job ran as anyone else");
});
