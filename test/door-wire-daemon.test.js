// @ts-check
// The API-key chat drivers go through the kernel's inference door when the home has one, called as the PERSON the turn is for. Real daemon, kernel on, the real dev sealing process, a fake OpenRouter on this machine.
// On a home with the door: the owner's chat turn is scanned (one request, with the account's own key, and a door event); a sealed value reaches the model only as its placeholder; a launch with no person is refused in
// words and sends nothing; a member's turn on her own account is scanned as HER chain; an agent job with run_as as that person's chain. On a home with no door (no sealing process): the owner's direct path still
// answers, and a member is refused with the door's words. Which chain the door was called as is read from the sealing process's detect calls (the door hands every text it scans to it with the chain): the
// sealer is the real one, started by the test so that it can be watched, and the door is the one the home builds over it. Run on a test box, never on a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { start, callerFacts } from "../core/daemon/index.js";
import { homeIdentity } from "../kernel/home.js";
import { startSealer } from "../kernel/seal/client.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const until = async (/** @type {() => Promise<any>|any} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const BEN = "per_" + "b".repeat(26);
const OWNER_KEY = "sk-or-v1-" + "a".repeat(40), BEN_KEY = "sk-or-v1-" + "b".repeat(40);
const PW = "a long master password for the test";
const firstPerson = (/** @type {any} */ chain) => { const h = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; };

/** A home, its fake OpenRouter, the owner's OpenRouter account set up the way first run sets it up, and Ben as a member with an OpenRouter account of his own. @param {any} t @param {{ door: boolean }} o */
async function boot(t, { door }) {
  /** What the fake OpenRouter was sent. @type {any[]} */ const seen = [];
  // The door's driver asks for a whole answer (stream: false); the direct path streams.
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}"); seen.push({ auth: req.headers.authorization, ...body });
    if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answered" } }] })}\n\ndata: [DONE]\n\n`); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "answered" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const saved = { url: process.env.VYRE_OPENROUTER_URL, legacy: process.env.VYRE_LEGACY_DIRECT_MODEL, fileKey: process.env.VYRE_KERNEL_FILE_KEY };
  process.env.VYRE_OPENROUTER_URL = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  delete process.env.VYRE_LEGACY_DIRECT_MODEL;
  const root = tempHome(t);
  /** Every text the door handed the sealing process to scan, with the person on the chain it was called as. @type {{ person: string|null, session: string, text: string }[]} */ const scans = [];
  /** @type {any} */ let sealer = null;
  if (door) {
    // The sealing process the home would start for itself (kernel/home.js), started here so its detect calls can be watched; the home builds its door over it.
    const real = startSealer({ dir: path.join(homeIdentity(root).dir, "seal"), dev: true, ...(process.env.VYRE_SEAL_SOFTWARE === "1" ? { software: true } : {}) });
    await real.health();
    sealer = { ...real, detect: async (/** @type {any} */ i) => { scans.push({ person: firstPerson(i.chain), session: String(i.session), text: String(i.text) }); return real.detect(i); } };
  } else process.env.VYRE_KERNEL_FILE_KEY = "1";   // a development home with no sealing process: no door
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, ...(sealer ? { kernelSealer: sealer } : {}) });
  t.after(async () => {
    await d.stop();
    if (sealer) await sealer.close().catch(() => {});
    srv.closeAllConnections?.(); srv.close();
    for (const [k, v] of [["VYRE_OPENROUTER_URL", saved.url], ["VYRE_LEGACY_DIRECT_MODEL", saved.legacy], ["VYRE_KERNEL_FILE_KEY", saved.fileKey]]) { if (v === undefined) delete process.env[/** @type {string} */ (k)]; else process.env[/** @type {string} */ (k)] = v; }
  });
  const K = d.kernel, OWNER = K.id.owner;
  /** What the daemon's bus heard: the door's events and each turn's end. */
  /** @type {any[]} */ const doorEvents = []; /** @type {Map<string, any>} */ const finished = new Map();
  d.events.on("model.*", (/** @type {any} */ e) => doorEvents.push(e));
  d.events.on("thread.finished", (/** @type {any} */ e) => { if (e.thread) finished.set(String(e.thread), e.payload); });
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const owner = { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) };
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", owner);

  // The owner's key, stored the way first run stores it (host-core onboard.agent.key -> sessions.accounts.key): a Vault item ai-key-openrouter-<id> put by the sessions module, granted to the chat modules,
  // then the api-key account naming that item. (sessions.accounts.key itself checks the key with openrouter.ai first, which a test cannot reach.)
  const item = "ai-key-openrouter-" + "0a1b2c3d4e5f";
  const put = await d.registry.call("vault.put", { name: item, kind: "api-key", description: "OpenRouter API key for openrouter.ai", value: OWNER_KEY, hosts: ["https://openrouter.ai"], grants: ["threads", "agents"] }, "module:sessions");
  assert.ok(put.data, `the key is in the Vault: ${JSON.stringify(put.error)}`);
  const listed = ((await asOwner("vault.list", {})).data || { items: [] }).items.find((/** @type {any} */ x) => x.name === item);
  assert.ok(listed && JSON.stringify(listed.grants || []).includes("threads"), `the item is granted to the chat module: ${JSON.stringify(listed)}`);
  const acct = await asOwner("sessions.accounts.add", { provider: "openrouter", label: "OpenRouter (openrouter.ai)", kind: "api-key", vault_item: item });
  assert.equal(acct.error, undefined, JSON.stringify(acct.error));

  // Ben, a member, with his own key in his own vault and an OpenRouter account naming it
  await K.gateway.grants.setRole(chain(OWNER), { person: BEN, role: "member" }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const benToken = (await K.surfaces.open(chain(BEN), {})).token;
  const asBen = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: benToken });
  const made = await asBen("vault.me.account.create", { password: PW });
  assert.ok(made.data, `Ben makes his own vault: ${JSON.stringify(made.error)}`);
  const benPut = await asBen("vault.me.put", { name: "ben-openrouter", kind: "api-key", fields: { value: BEN_KEY } });
  assert.ok(benPut.data, `Ben's key is in his own vault: ${JSON.stringify(benPut.error)}`);
  // sessions.accounts.add checks the item is in his own vault with a nested vault.me.has, which reads the person from the call's chain; a module's nested call does not carry the outer call's token in its
  // meta (core/modules/index.js runInTurn passes the call's own meta to the tool), so on this daemon that check sees no person. This one nested call is handed Ben's token; the check itself is the real one.
  const reg = /** @type {any} */ (d.registry), orig = reg.call.bind(reg);
  reg.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => orig(tool, input, caller, tool === "vault.me.has" && caller === "module:sessions" && !(meta && meta.token) ? { ...(meta || {}), token: benToken } : meta);
  let benAcct;
  try { benAcct = await asBen("sessions.accounts.add", { provider: "openrouter", label: "Ben's OpenRouter", kind: "api-key", vault_item: "ben-openrouter" }); } finally { delete reg.call; }
  assert.equal(benAcct.error, undefined, JSON.stringify(benAcct.error));

  /** A chat turn, as the stream starts one (chat and asker come only from module:stream). Resolves with the thread id and how its turn ended. @param {string} person @param {string} prompt */
  const chatTurn = async (person, prompt) => {
    const c = await K.gateway.grants.chats.create(chain(person), {});
    const th = await d.registry.call("threads.start", { cwd: process.cwd(), provider: "openrouter", model: "x/y", prompt, chat: c.id, asker: person, surface: "deck" }, "module:stream");
    assert.equal(th.error, undefined, JSON.stringify(th.error));
    const id = String(th.data.id);
    return { id, end: await until(() => finished.get(id), `the turn on ${id} to end`) };
  };
  /** A launch by the agents module (a job), and how it ended; or its refusal. @param {any} input */
  const launch = async (input) => {
    const r = await d.registry.call("threads.launch", { cwd: process.cwd(), provider: "openrouter", model: "x/y", surface: "deck", ...input }, "module:agents");
    if (r.error) return { refused: r.error };
    const id = String(r.data.id);
    return { id, end: await until(() => finished.get(id), `the launch ${id} to end`) };
  };
  return { d, K, OWNER, seen, scans, doorEvents, chatTurn, launch };
}

test("on a home with the inference door, every API-key chat turn goes through it as the person the turn is for", { timeout: 300_000 }, async t => {
  const w = await boot(t, { door: true });
  assert.ok(w.K.gateway.model, "this home has the inference door");

  await t.test("the owner's chat turn goes through the door: one request with the account's key, and a door event", async () => {
    const before = w.seen.length, events = w.doorEvents.length;
    const { end } = await w.chatTurn(w.OWNER, "case one: our EIN is 12-3456789, say ok");
    assert.equal(end.ok, true, `the turn answered: ${JSON.stringify(end)}`);
    const sent = w.seen.slice(before);
    assert.equal(sent.length, 1, "exactly one request reached the model");
    assert.equal(sent[0].auth, `Bearer ${OWNER_KEY}`, "the account's own key");
    assert.equal(sent[0].stream, false, "the door's driver made the call (the direct path streams)");
    const scan = w.scans.find(s => s.text.includes("case one"));
    assert.ok(scan, "the door scanned the prompt");
    assert.equal(scan.person, w.OWNER, "as the owner");
    const ev = w.doorEvents.slice(events).find(e => e.type === "model.sanitized" && e.payload && e.payload.session === scan.session);
    assert.ok(ev, `the door recorded what it replaced: ${JSON.stringify(w.doorEvents.slice(events))}`);
    assert.deepEqual(ev.payload.found, [{ class: "us-ein", n: 1 }]);
  });

  await t.test("a sealed value in the prompt reaches the model only as its placeholder", async () => {
    const before = w.seen.length;
    const SSN = "123-45-6789";   // grouped 3-2-4, a valid area, group and serial: the sealer's us-ssn detector (kernel/seal/classes.js)
    const { end } = await w.chatTurn(w.OWNER, `case two: my number is ${SSN}, say ok`);
    assert.equal(end.ok, true, JSON.stringify(end));
    const sent = w.seen.slice(before);
    assert.equal(sent.length, 1);
    const text = JSON.stringify(sent[0].messages);
    assert.ok(!text.includes(SSN) && !text.includes("123456789"), `the value did not reach the model: ${text.slice(0, 300)}`);
    assert.ok(text.includes("[sealed: US SSN #1]"), `its placeholder did: ${text.slice(0, 300)}`);
  });

  await t.test("a launch with no person to act for is refused in words and nothing is sent", async () => {
    const before = w.seen.length;
    const r = await w.launch({ prompt: "case three: hello" });
    if ("refused" in r) assert.match(String(r.refused.message), /no person to act for/);
    else { assert.equal(r.end.ok, false); assert.match(String(r.end.error), /no person to act for, so nothing was sent/); }
    assert.equal(w.seen.length, before, "nothing was sent");
    assert.equal(w.scans.filter(s => s.text.includes("case three")).length, 0, "the door was never asked");
  });

  await t.test("a member's turn on her own account goes through the door as HER chain, never the owner's", async () => {
    const before = w.seen.length;
    const { end } = await w.chatTurn(BEN, "case four: say ok");
    assert.equal(end.ok, true, JSON.stringify(end));
    const sent = w.seen.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${BEN_KEY}`, "her own key, lent from her own vault");
    assert.equal(sent[0].stream, false, "through the door");
    const scans = w.scans.filter(s => s.text.includes("case four"));
    assert.ok(scans.length >= 1, "the door scanned her prompt");
    assert.deepEqual([...new Set(scans.map(s => s.person))], [BEN], "every scan was on her chain");
  });

  await t.test("an agent job with run_as goes through the door as the run_as person's chain", async () => {
    const before = w.seen.length;
    const r = await w.launch({ prompt: "case five: say ok", run_as: BEN, purpose: "job" });
    assert.ok(!("refused" in r), JSON.stringify(/** @type {any} */ (r).refused));
    assert.equal(/** @type {any} */ (r).end.ok, true, JSON.stringify(/** @type {any} */ (r).end));
    const sent = w.seen.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].stream, false, "through the door");
    const scans = w.scans.filter(s => s.text.includes("case five"));
    assert.ok(scans.length >= 1, "the door scanned the job's prompt");
    assert.deepEqual([...new Set(scans.map(s => s.person))], [BEN], "as the person the job runs as, never the owner");
  });
});

test("on a home with no inference door, the owner's own turn still goes direct and a member is refused with the door's words", { timeout: 300_000 }, async t => {
  const w = await boot(t, { door: false });
  assert.equal(w.K.gateway.model, undefined, "this home has no door");

  await t.test("the owner's chat turn on the owner's own account answers on the direct path", async () => {
    const before = w.seen.length;
    const { end } = await w.chatTurn(w.OWNER, "case six: say ok");
    assert.equal(end.ok, true, JSON.stringify(end));
    const sent = w.seen.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${OWNER_KEY}`);
    assert.equal(sent[0].stream, true, "the direct path");
  });

  await t.test("a member's turn is refused with the door's words and nothing is sent", async () => {
    const before = w.seen.length;
    const { end } = await w.chatTurn(BEN, "case seven: say ok");
    assert.equal(end.ok, false, JSON.stringify(end));
    assert.match(String(end.error), /must go through Vyre's inference door and none is connected, so this was not sent/);
    assert.equal(w.seen.length, before, "nothing was sent");
  });
});
