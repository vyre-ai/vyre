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
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, log: (/** @type {any} */ m) => { logs.push(String(m)); }, kernel: true, kernelPresence: { check: async () => null } });
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
  d.registry.deps.kernelSession = async (/** @type {any} */ q) => {
    const out = await real(q);
    // what the session's own token says (its signed body, read as the kernel reads it)
    const facts = out && typeof out.token === "string" ? (() => { try { return JSON.parse(Buffer.from(out.token.split(".")[0], "base64url").toString()); } catch { return null; } })() : null;
    seen.push({ thread: q.thread, runas: q.runas, asker: q.asker, ...(facts ? { person: facts.person, agent: facts.agent, chat: facts.chat } : {}) });
    return out;
  };
  assert.equal((await asBen("agents.flow-say", { agent: "juno", flow: open, text: "hi" })).error?.code, "denied", "an agent not shared with him");
  assert.ok(!(await asOwner("agents.access.set", { agent: "juno", kind: "person", subject: BEN, level: "use" })).error);
  assert.ok((await asBen("agents.flow-say", { agent: "juno", flow: hidden, text: "hi" })).error, "a Flow he may not read");
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(seen, [], "nothing woke for a refused write");

  // with no AI sign-in of his own the owner's is never used for him (core/switchboard/asker-account.js): the refusal says so and nothing wakes
  assert.ok(!(await asOwner("flows.access.set", { id: open, subject: BEN, level: "use" })).error);
  const noAccount = await asBen("agents.flow-say", { agent: "juno", flow: open, text: "hi" });
  assert.match(String(noAccount.error && noAccount.error.message), /no AI sign-in picked/, JSON.stringify(noAccount.error));
  assert.deepEqual(seen, [], "nothing woke without his own sign-in");
  const added = await asBen("sessions.accounts.add", { provider: "claude", label: "Ben's Claude", kind: "login" });
  assert.equal(added.error, undefined, JSON.stringify(added.error));

  // shared with him: the agent wakes, and the job's kernel session is Ben's, never the owner's
  const ok = await asBen("agents.flow-say", { agent: "juno", flow: open, text: "Why did run 8 fail?" });
  assert.ok(ok.data && ok.data.thread, JSON.stringify(ok.error));
  const s = await until(() => seen.find(q => q.thread === ok.data.thread), "the woken job's kernel session").catch(async (/** @type {any} */ e) => {
    const th = (await asOwner("threads.get", { thread: ok.data.thread, limit: 30 })).data || {};
    const flat = (/** @type {any} */ o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => !["cwd", "name", "id", "chat", "agent", "project"].includes(k) && (v === null || ["string", "number", "boolean"].includes(typeof v))).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : v]));
    const g = JSON.stringify({ thread: flat(th.thread), last: ((th.turns || th.items || th.messages || []).slice(-3)).map((/** @type {any} */ x) => flat(x)) });
    throw new Error(`${e.message}; seen ${JSON.stringify(seen)}; the thread: ${g}; the daemon log (threads, sessions, switchboard, launch): ${logs.filter((l) => /threads|session|launch|account|switchboard|refus|spawn/i.test(l)).slice(-25).join(" || ")}`);
  });
  assert.equal(s.runas, BEN, `the job acts as the member who wrote (the call: ${JSON.stringify(s)}; all calls: ${JSON.stringify(seen)}; launch lines: ${logs.filter((l) => /launch input|launch keeps|kernel session/.test(l)).join(" || ")})`);
  // the job's token: the member is the person, the agent hop is the agent's, and it is in no chat (the thread's own chat is the home's)
  assert.equal(s.person, BEN, "the token's person is the member");
  assert.ok(typeof s.agent === "string" && s.agent, "the token carries the agent hop");
  assert.ok(!s.chat, "the job's session is in no chat");
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
  const inJob = await asBen("agents.flow-say", { agent: "juno", flow: open, text: `vyre records.list {"type":"contact","limit":3}\nvyre records.get {"urn":"vyre://${K.space}/skill/${secret.id}"}` });
  assert.ok(inJob.data && inJob.data.thread, JSON.stringify(inJob.error));
  const said = await until(async () => { const g = JSON.stringify((await asOwner("threads.get", { thread: inJob.data.thread, limit: 80 })).data || {}); return g.includes("rows") ? g : null; }, "the job's own read to answer").catch(async (/** @type {any} */ e) => {
    const out = (/** @type {string} */ k, /** @type {string} */ v) => console.log(`DIAG ${k}: ${String(v).replace(/\s+/g, " ").slice(0, 1800)}`);
    const th = (await asOwner("threads.get", { thread: inJob.data.thread, limit: 40 })).data || {};
    out("thread", JSON.stringify({ status: th.thread && th.thread.status, reason: th.thread && th.thread.stopped_reason, turns: th.thread && th.thread.turns, account: th.thread && th.thread.account, driver: th.thread && th.thread.driver }));
    out("keys", Object.keys(th).join(","));
    out("types", (th.events || []).map((/** @type {any} */ x) => x.type).join(","));
    out("texts", (th.events || []).filter((/** @type {any} */ x) => /text|message|tool|notice/.test(String(x.type))).map((/** @type {any} */ x) => `${x.type}: ${JSON.stringify(x.payload).slice(0, 400)}`).slice(-6).join(" ## "));
    out("log", logs.filter((l) => /threads|session|spawn|socket|account|sandbox/i.test(l)).slice(-12).join(" || "));
    out("fake", (() => { try { return fs.readFileSync(path.join(root, "claude.log"), "utf8").split("\n").filter((l) => /error|denied|EACCES|ENOENT|forbidden|not_found|rows|socket|VYRE_HOME/i.test(l.replace(/"append":"[^"]*"/, ""))).map((l) => l.replace(/"append":"[^"]*"/, "").slice(-600)).slice(-4).join(" ## "); } catch { return "none"; } })());
    throw e;
  });
  assert.ok(said.includes("rows"), "an ordinary read in the job answers");
  assert.ok(!said.includes("OWNER-PRIVATE-TEXT"), "the owner's private skill never reaches the member's job");

  // the Flow Ben may not read stays refused even now that he has used another
  assert.ok((await asBen("agents.flow-say", { agent: "juno", flow: hidden, text: "and this one" })).error);
  assert.equal(seen.filter(q => q.runas !== BEN).length, 0, "no job ran as anyone else");
});
