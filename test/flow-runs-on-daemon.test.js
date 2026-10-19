// @ts-check
// A Flow's AI step runs through the inference door as the person the Flow runs as, on THAT person's own account. Real daemon, kernel on, the real dev sealing process, a fake OpenRouter on this machine.
// The owner's Flow with a classify step goes through the door as the owner, with the owner's key. The same Flow made by a member runs on the member's own key, lent from her own vault, never the owner's,
// and the door scans it as her chain. A member cannot set Runs on to the owner's account, and can set it to a second account of her own. A member with no account: the step stops with the plain words,
// nothing is sent, and she gets a card. A webhook-started run carries the Flow's runs-as person. Which chain the door was called as is read from the sealing process's detect calls. Run on a test box, never on a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { start, callerFacts } from "../core/daemon/index.js";
import { homeIdentity } from "../kernel/home.js";
import { startSealer } from "../kernel/seal/client.js";
import { createMemberTools } from "../core/work/member-tools.js";
import { NO_ACCOUNT } from "../kernel/flows/runs-as.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const until = async (/** @type {() => Promise<any>|any} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const BEN = "per_" + "b".repeat(26), CAROL = "per_" + "c".repeat(26);
const OWNER_KEY = "sk-or-v1-" + "a".repeat(40), BEN_KEY = "sk-or-v1-" + "b".repeat(40), BEN_KEY2 = "sk-or-v1-" + "d".repeat(40);
const PW = "a long master password for the test";
const firstPerson = (/** @type {any} */ chain) => { const h = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; };
const triage = (/** @type {string} */ name, /** @type {string} */ marker, /** @type {any} */ extra = {}) => ({ format: 1, name, label: name, authorship: "human", trigger: { on: "manual" }, steps: [{ id: "k", kind: "classify", input: `${marker}: a refund please`, labels: ["refund", "other"] }], ...extra });

test("a Flow's AI step runs through the door as the person it runs as, on that person's own account", { timeout: 300_000 }, async t => {
  /** What the fake OpenRouter was sent. @type {any[]} */ const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}"); seen.push({ auth: req.headers.authorization, ...body });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "refund" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const saved = { url: process.env.VYRE_OPENROUTER_URL };
  process.env.VYRE_OPENROUTER_URL = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  const root = tempHome(t);
  /** Every text the door handed the sealing process, with the person on the chain it was called as. @type {{ person: string|null, text: string }[]} */ const scans = [];
  const real = startSealer({ dir: path.join(homeIdentity(root).dir, "seal"), dev: true, ...(process.env.VYRE_SEAL_SOFTWARE === "1" ? { software: true } : {}) });
  await real.health();
  const sealer = { ...real, detect: async (/** @type {any} */ i) => { scans.push({ person: firstPerson(i.chain), text: String(i.text) }); return real.detect(i); } };
  /** @type {string[]} */ const logs = [];
  const d = await start({ root, presence: present, log: (/** @type {any} */ m) => { logs.push(String(m)); if (logs.length > 80) logs.shift(); }, kernel: true, kernelPresence: { check: async () => null }, kernelSealer: sealer });
  t.after(async () => {
    await d.stop(); await sealer.close().catch(() => {});
    srv.closeAllConnections?.(); srv.close();
    if (saved.url === undefined) delete process.env.VYRE_OPENROUTER_URL; else process.env.VYRE_OPENROUTER_URL = saved.url;
  });
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space;
  assert.ok(K.gateway.model, "this home has the inference door");
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const host = () => /** @type {any} */ (d.registry.deps).flowsHost.get(space);
  const tools = () => host().flows.tools;
  const svc = /** @type {any} */ (createMemberTools({ space, kernel: K, registry: d.registry }).flows);
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) });

  // the owner's OpenRouter key, kept the way first run keeps it, and the api-key account naming it
  const item = "ai-key-openrouter-" + "0a1b2c3d4e5f";
  const put = await d.registry.call("vault.put", { name: item, kind: "api-key", description: "OpenRouter API key for openrouter.ai", value: OWNER_KEY, hosts: ["https://openrouter.ai"], grants: ["threads", "agents"] }, "module:sessions");
  assert.ok(put.data, JSON.stringify(put.error));
  const ownerAcct = await asOwner("sessions.accounts.add", { provider: "openrouter", label: "OpenRouter (openrouter.ai)", kind: "api-key", vault_item: item });
  assert.equal(ownerAcct.error, undefined, JSON.stringify(ownerAcct.error));

  // Ben and Carol, members; Ben with two keys of his own in his own vault, each an account of his; Carol with none
  for (const p of [BEN, CAROL]) await K.gateway.grants.setRole(chain(OWNER), { person: p, role: "member" }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const benToken = (await K.surfaces.open(chain(BEN), {})).token;
  const asBen = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: benToken });
  assert.ok((await asBen("vault.me.account.create", { password: PW })).data, "Ben makes his own vault");
  for (const [name, value] of [["ben-openrouter", BEN_KEY], ["ben-second", BEN_KEY2]]) assert.ok((await asBen("vault.me.put", { name, kind: "api-key", fields: { value } })).data, `${name} is in his own vault`);
  // (the nested vault.me.has check is handed Ben's token, as in test/door-wire-daemon.test.js: a module's nested call does not carry the outer call's token)
  const reg = /** @type {any} */ (d.registry), orig = reg.call.bind(reg);
  reg.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => orig(tool, input, caller, tool === "vault.me.has" && caller === "module:sessions" && !(meta && meta.token) ? { ...(meta || {}), token: benToken } : meta);
  let benAcct, benAcct2;
  try {
    benAcct = await asBen("sessions.accounts.add", { provider: "openrouter", label: "Ben's OpenRouter", kind: "api-key", vault_item: "ben-openrouter" });
    benAcct2 = await asBen("sessions.accounts.add", { provider: "openrouter", label: "Ben's second key", kind: "api-key", vault_item: "ben-second" });
  } finally { delete reg.call; }
  assert.equal(benAcct.error, undefined, JSON.stringify(benAcct.error));
  assert.equal(benAcct2.error, undefined, JSON.stringify(benAcct2.error));
  const BEN_ACCT = String(benAcct.data.id), BEN_ACCT2 = String(benAcct2.data.id), OWNER_ACCT = String(ownerAcct.data.id);

  /** Start a Flow and wait for its run to end. @param {any} startIt @param {string} flow */
  const runOf = async (/** @type {() => Promise<any>} */ startIt, /** @type {string} */ flow) => {
    const s = await startIt();
    const id = String(s.id || s.run || "");
    assert.ok(id, `started: ${JSON.stringify(s)}`);
    return until(async () => { const r = await host().flows.store.getRun(id); return r && ["done", "failed", "cancelled"].includes(r.state) ? r : null; }, `the run of ${flow} to end\n${logs.slice(-20).join("\n")}`);
  };

  await t.test("a member holds two accounts of her own, each hers alone", async () => {
    const mine = (await asBen("sessions.accounts.list", {})).data;
    const ids = mine.filter((/** @type {any} */ a) => a.person === BEN).map((/** @type {any} */ a) => a.id);
    assert.ok(ids.includes(BEN_ACCT) && ids.includes(BEN_ACCT2), JSON.stringify(mine));
    const owners = (await asOwner("sessions.accounts.list", {})).data;
    assert.ok(!owners.some((/** @type {any} */ a) => a.id === BEN_ACCT || a.id === BEN_ACCT2), "the owner's list never shows them");
  });

  await t.test("the owner's Flow with a classify step goes through the door as the owner, on the owner's account", async () => {
    const before = seen.length;
    const df = await tools()["flows.define"](chain(OWNER), { flow: triage("owners_triage", "case one") });
    assert.ok(df.ok, JSON.stringify(df));
    await tools()["flows.approve"](chain(OWNER), { id: df.id, version: df.version, hash: df.hash });
    const run = await runOf(() => tools()["flows.start"](chain(OWNER), { id: df.id }), "owners_triage");
    assert.equal(run.state, "done", JSON.stringify(run.error));
    assert.equal(run.runs_as, OWNER, "it runs as the owner");
    assert.equal(run.steps.k.output.label, "refund");
    const sent = seen.slice(before);
    assert.equal(sent.length, 1, "one request reached the model");
    assert.equal(sent[0].auth, `Bearer ${OWNER_KEY}`, "the owner's own key");
    assert.equal(sent[0].stream, false, "through the door's driver");
    const sc = scans.filter(s => s.text.includes("case one"));
    assert.ok(sc.length >= 1, "the door scanned it");
    assert.deepEqual([...new Set(sc.map(s => s.person))], [OWNER], "as the owner's chain");
  });

  await t.test("the same Flow made by a member runs on HER account, never the owner's", async () => {
    const before = seen.length;
    const df = await svc.define(chain(BEN), { flow: triage("bens_triage", "case two") });
    assert.ok(df.ok, JSON.stringify(df));
    await svc.approve(chain(BEN), { id: df.id, version: df.version, hash: df.hash });
    const run = await runOf(() => svc.start(chain(BEN), { id: df.id }), "bens_triage");
    assert.equal(run.state, "done", JSON.stringify(run.error));
    assert.equal(run.runs_as, BEN);
    const sent = seen.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${BEN_KEY}`, "her own default key, lent from her own vault");
    assert.ok(!sent.some(x => x.auth === `Bearer ${OWNER_KEY}`), "never the owner's key");
    const sc = scans.filter(s => s.text.includes("case two"));
    assert.ok(sc.length >= 1);
    assert.deepEqual([...new Set(sc.map(s => s.person))], [BEN], "scanned as her chain only");

    // she cannot set Runs on to the owner's account, nor name the owner as the person; she can pick her own second key
    const theirs = await svc.define(chain(BEN), { id: df.id, flow: triage("bens_triage", "case two", { runs_on: { account: OWNER_ACCT, provider: "openrouter" } }) });
    assert.equal(theirs.ok, false, JSON.stringify(theirs)); assert.match(JSON.stringify(theirs.errors), /not one of your own AI accounts/);
    const named = await svc.define(chain(BEN), { id: df.id, flow: triage("bens_triage", "case two", { runs_on: { person: OWNER, account: BEN_ACCT2 } }) });
    assert.equal(named.ok, false); assert.match(JSON.stringify(named.errors), /someone else's/);
    const second = await svc.define(chain(BEN), { id: df.id, flow: triage("bens_triage", "case two b", { runs_on: { account: BEN_ACCT2, provider: "openrouter" } }) });
    assert.ok(second.ok, JSON.stringify(second));
    await svc.approve(chain(BEN), { id: df.id, version: second.version, hash: second.hash });
    const b2 = seen.length;
    const run2 = await runOf(() => svc.start(chain(BEN), { id: df.id }), "bens_triage v2");
    assert.equal(run2.state, "done", JSON.stringify(run2.error));
    assert.equal(seen.slice(b2)[0].auth, `Bearer ${BEN_KEY2}`, "the account she picked under Runs on");
  });

  await t.test("a member with no account: the plain words, nothing sent, and a card for her", async () => {
    const before = seen.length;
    const df = await svc.define(chain(CAROL), { flow: triage("carols_triage", "case three") });
    assert.ok(df.ok, JSON.stringify(df));
    await svc.approve(chain(CAROL), { id: df.id, version: df.version, hash: df.hash });
    const run = await runOf(() => svc.start(chain(CAROL), { id: df.id }), "carols_triage");
    assert.equal(run.state, "failed");
    assert.equal(run.error.message, NO_ACCOUNT);
    assert.equal(seen.length, before, "nothing was sent");
    assert.equal(scans.filter(s => s.text.includes("case three")).length, 0, "the door was never asked");
    const cards = await until(async () => { const l = await K.gateway.ask.list(chain(CAROL), { state: ["waiting", "ready", "working", "needs_check"] }); const c = l.filter((/** @type {any} */ x) => String(x.title).includes(NO_ACCOUNT)); return c.length ? c : null; }, "her card");
    assert.equal(cards[0].doer.id, CAROL, "the card is hers");
  });

  await t.test("a webhook-started run carries the Flow's runs-as person", async () => {
    const df = await svc.define(chain(BEN), { flow: { ...triage("bens_hook", "case four"), trigger: { on: "web", path: "hook-bens" } } });
    assert.ok(df.ok, JSON.stringify(df));
    const ap = await svc.approve(chain(BEN), { id: df.id, version: df.version, hash: df.hash }).catch((/** @type {any} */ e) => ({ refused: e.message }));
    if (ap && ap.refused) { await tools()["flows.approve"](chain(OWNER), { id: df.id, version: df.version, hash: df.hash }); }
    const r = await host().flows.runner.handleWeb("hook-bens", { body: { a: 1 }, trust: "untrusted", key: "w1" });
    const run = await until(async () => { const x = await host().flows.store.getRun(String(r.run || r.id)); return x && x.state !== "running" ? x : null; }, "the webhook run");
    assert.equal(run.runs_as, BEN, "a webhook carries the maker, whoever delivered it");
  });
});
