// @ts-check
// A Flow's AI step on a member's own Claude SUBSCRIPTION (a setup token in her own vault), end to end: real daemon, kernel on, the real dev sealing process and the real inference door, the Claude CLI a fake
// (core/sessions/testing/fake-signin.js) that notes a hash of the credential it was handed. Her classify step runs through the door's Claude driver as her chain, with HER token in that one child only,
// never the owner's; an extract answer that does not read is asked for once more; an expired sign-in stops the step with plain words and a card for her, and her OpenRouter key is never tried.
// Tokens here are fakes. Run on a test box, never on a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { start, callerFacts } from "../core/daemon/index.js";
import { homeIdentity } from "../kernel/home.js";
import { startSealer } from "../kernel/seal/client.js";
import { createMemberTools } from "../core/work/member-tools.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const FAKE = fileURLToPath(new URL("../core/sessions/testing/fake-signin.js", import.meta.url));
const sha = (/** @type {string} */ v) => crypto.createHash("sha256").update(v).digest("hex");
const until = async (/** @type {() => Promise<any>|any} */ f, /** @type {string} */ what, ms = 60_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const BEN = "per_" + "b".repeat(26);
const OWNER_TOKEN = "sk-ant-oat01-" + "a".repeat(60), BEN_TOKEN = "sk-ant-oat01-" + "b".repeat(60), BEN_KEY = "sk-or-v1-" + "b".repeat(40);
const PW = "a long master password for the test";
const firstPerson = (/** @type {any} */ chain) => { const h = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; };
const EXPIRED_WORDS = "Your Claude sign-in has expired. Sign in again in Settings, AI accounts.";

test("a Flow's AI step runs on a member's own Claude sign-in, with her token in its child only", { timeout: 300_000 }, async t => {
  /** What reached the fake OpenRouter: must stay empty, her key is never a fall back. @type {any[]} */ const keyCalls = [];
  const srv = http.createServer((req, res) => { keyCalls.push(req.url); res.writeHead(500); res.end("{}"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const root = tempHome(t);
  const logFile = path.join(root, "fake-signin.jsonl");
  const saved = { url: process.env.VYRE_OPENROUTER_URL, bin: process.env.VYRE_CLAUDE_BIN, log: process.env.FAKE_SIGNIN_LOG };
  // the door's driver hands its child an environment of its own making: the fake learns where to note its launches from a wrapper
  const bin = path.join(root, "fake-claude");
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SIGNIN_LOG='${logFile}' exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  Object.assign(process.env, { VYRE_OPENROUTER_URL: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`, VYRE_CLAUDE_BIN: bin, FAKE_SIGNIN_LOG: logFile });
  const launches = (/** @type {string} */ marker) => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []).filter(l => l.marker === marker);
  /** @type {{ person: string|null, text: string }[]} */ const scans = [];
  const real = startSealer({ dir: path.join(homeIdentity(root).dir, "seal"), dev: true, ...(process.env.VYRE_SEAL_SOFTWARE === "1" ? { software: true } : {}) });
  await real.health();
  const sealer = { ...real, detect: async (/** @type {any} */ i) => { scans.push({ person: firstPerson(i.chain), text: String(i.text) }); return real.detect(i); } };
  /** @type {string[]} */ const logs = [];
  const d = await start({ root, presence: present, log: (/** @type {any} */ m) => { logs.push(String(m)); if (logs.length > 80) logs.shift(); }, kernel: true, kernelPresence: { check: async () => null }, kernelSealer: sealer });
  t.after(async () => {
    await d.stop(); await sealer.close().catch(() => {});
    srv.closeAllConnections?.(); srv.close();
    for (const [k, v] of [["VYRE_OPENROUTER_URL", saved.url], ["VYRE_CLAUDE_BIN", saved.bin], ["FAKE_SIGNIN_LOG", saved.log]]) { if (v === undefined) delete process.env[String(k)]; else process.env[String(k)] = v; }
  });
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space;
  assert.ok(K.gateway.model, "this home has the inference door");
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const host = () => /** @type {any} */ (d.registry.deps).flowsHost.get(space);
  const svc = /** @type {any} */ (createMemberTools({ space, kernel: K, registry: d.registry }).flows);
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) });

  // the owner's own Claude subscription, a setup token in the home's vault, the home's default Claude account
  const put = await d.registry.call("vault.put", { name: "owner-claude-token", kind: "secret", description: "Claude subscription token", value: OWNER_TOKEN, grants: ["threads", "agents"] }, "module:sessions");
  assert.ok(put.data, JSON.stringify(put.error));
  const ownerAcct = await asOwner("sessions.accounts.add", { provider: "claude", label: "Owner's Claude", kind: "setup-token", vault_item: "owner-claude-token", is_default: true });
  assert.equal(ownerAcct.error, undefined, JSON.stringify(ownerAcct.error));

  // Ben, a member, with his own Claude setup token and an OpenRouter key, both in his own vault
  await K.gateway.grants.setRole(chain(OWNER), { person: BEN, role: "member" }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const benToken = (await K.surfaces.open(chain(BEN), {})).token;
  const asBen = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: benToken });
  assert.ok((await asBen("vault.me.account.create", { password: PW })).data, "Ben makes his own vault");
  for (const [name, value] of [["ben-claude", BEN_TOKEN], ["ben-openrouter", BEN_KEY]]) assert.ok((await asBen("vault.me.put", { name, kind: "api-key", fields: { value } })).data, `${name} is in his own vault`);
  const reg = /** @type {any} */ (d.registry), orig = reg.call.bind(reg);
  reg.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => orig(tool, input, caller, tool === "vault.me.has" && caller === "module:sessions" && !(meta && meta.token) ? { ...(meta || {}), token: benToken } : meta);
  let benClaude, benKey;
  try {
    benClaude = await asBen("sessions.accounts.add", { provider: "claude", label: "Ben's Claude", kind: "setup-token", vault_item: "ben-claude" });
    benKey = await asBen("sessions.accounts.add", { provider: "openrouter", label: "Ben's OpenRouter", kind: "api-key", vault_item: "ben-openrouter" });
  } finally { delete reg.call; }
  assert.equal(benClaude.error, undefined, JSON.stringify(benClaude.error));
  assert.equal(benKey.error, undefined, JSON.stringify(benKey.error));
  const BEN_CLAUDE = String(benClaude.data.id);

  const runOf = async (/** @type {() => Promise<any>} */ startIt, /** @type {string} */ flow) => {
    const s = await startIt();
    const id = String(s.id || s.run || "");
    assert.ok(id, `started: ${JSON.stringify(s)}`);
    return until(async () => { const r = await host().flows.store.getRun(id); return r && ["done", "failed", "cancelled"].includes(r.state) ? r : null; }, `the run of ${flow} to end\n${logs.slice(-20).join("\n")}`);
  };
  /** A Flow of Ben's that runs on his Claude sign-in, defined, approved and run. @param {string} name @param {any} step */
  const benRun = async (name, step) => {
    const df = await svc.define(chain(BEN), { flow: { format: 1, name, label: name, authorship: "human", trigger: { on: "manual" }, steps: [step], runs_on: { account: BEN_CLAUDE, provider: "claude" } } });
    assert.ok(df.ok, JSON.stringify(df));
    await svc.approve(chain(BEN), { id: df.id, version: df.version, hash: df.hash });
    return runOf(() => svc.start(chain(BEN), { id: df.id }), name);
  };

  await t.test("his classify step runs on HIS Claude sign-in, through the door as his chain, his token in its child only", async () => {
    const run = await benRun("bens_claude_triage", { id: "k", kind: "classify", input: "MARK-d1: a refund please", labels: ["refund", "other"] });
    assert.equal(run.state, "done", JSON.stringify(run.error));
    assert.equal(run.runs_as, BEN);
    assert.equal(run.steps.k.output.label, "refund");
    const l = launches("MARK-d1");
    assert.equal(l.length, 1, "one turn of the Claude CLI");
    assert.equal(l[0].got, sha(BEN_TOKEN), "his own token");
    assert.notEqual(l[0].got, sha(OWNER_TOKEN), "never the owner's");
    assert.equal(l[0].env_holds, false, "on descriptor 3: not even the child's environment holds it");
    assert.ok(l[0].no_tools && l[0].strict_mcp && l[0].no_persist);
    assert.ok(!JSON.stringify(process.env).includes(BEN_TOKEN) && !JSON.stringify(process.env).includes(OWNER_TOKEN), "vyred's environment never holds either");
    const sc = scans.filter(s => s.text.includes("MARK-d1"));
    assert.ok(sc.length >= 1, "the door scanned it");
    assert.deepEqual([...new Set(sc.map(s => s.person))], [BEN], "as his chain only");
    assert.deepEqual(keyCalls, [], "his OpenRouter key was not used");
  });

  await t.test("an extract answer that does not read is asked for once more, then read", async () => {
    const run = await benRun("bens_claude_extract", { id: "x", kind: "extract", input: "MARK-d2 BADJSON-ONCE Ada owes 42", fields: [{ name: "name", kind: "text" }, { name: "amount", kind: "number" }] });
    assert.equal(run.state, "done", JSON.stringify(run.error));
    assert.equal(run.steps.x.output.raw_ok, true);
    assert.deepEqual(run.steps.x.output.fields, { name: "Ada", amount: 42 });
    assert.equal(launches("MARK-d2").length, 2, "two turns: the first answer did not read");
  });

  await t.test("an expired sign-in stops the step in plain words, with a card for him, and nothing else is tried", async () => {
    const run = await benRun("bens_claude_expired", { id: "k", kind: "classify", input: "MARK-d3 EXPIRED", labels: ["refund", "other"] });
    assert.equal(run.state, "failed");
    assert.equal(run.error.message, EXPIRED_WORDS);
    assert.ok(launches("MARK-d3").length >= 1);
    assert.ok(launches("MARK-d3").every(l => l.got === sha(BEN_TOKEN)), "every try was on his own sign-in");
    assert.deepEqual(keyCalls, [], "no fall back to his OpenRouter key");
    // the card is the one every failing main account gets (kernel/flows/runs-as.js): "Your <account> for <Flow> is signed out or its key no longer works"; the step itself keeps the sign-in's own words
    const cards = await until(async () => { const l = await K.gateway.ask.list(chain(BEN), { state: ["waiting", "ready", "working", "needs_check"] }); const c = l.filter((/** @type {any} */ x) => /^Your .+ for .+ is signed out or its key no longer works$/.test(String(x.title))); return c.length ? c : null; }, "his card");
    assert.equal(cards[0].doer.id, BEN, "the card is his");
  });
});
