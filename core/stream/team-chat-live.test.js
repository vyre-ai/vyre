// @ts-check
// A shared chat in a TEAM Space on a real vyred (kernel on, fake claude as a real child process): a member says something through the member door (core/work/chat-service.js) and the assistant answers in
// that chat, as a turn that belongs to the team's chat: the chat's record and its people are the team Space's kernel's, the turn is asked for the member who spoke, and nothing of it is written into the
// home's own chats. Stand-in, labelled: SHIM(presence) `kernelPresence` accepts any proof for the owner's grants acts, as the other real-daemon suites do.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { boot } from "../sessions/testing/boot.js";
import { createRing, holdersOf } from "../../lib/chat-keys.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
// the roles the Space gives: Ada an admin (reads the Drive), Tom a temp (reads no memory), Ana and Ben members (read memory, not the Drive)
const ADA = "per_" + "defghijklmnopqrstuvwxyzabc", TOM = "per_" + "efghijklmnopqrstuvwxyzabcd";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await f(); if (last) return last; } catch (e) { last = e; } await sleep(100); } throw new Error(`timed out waiting for ${what}: ${last && /** @type {any} */ (last).message || ""}`); };

/** @param {any} t */
async function world(t) {
  /** @type {string[]} */ const lines = [];
  const w = await boot(t, { driver: "cli", kernel: true, log: (/** @type {any} */ m) => { lines.push(String(m)); } });
  /** @type {any} */ (w).lines = lines;
  const d = w.d;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const [person, role] of [[ANA, "member"], [BEN, "member"], [ADA, "admin"], [TOM, "temp"]]) {
    const m = role === "temp" ? { person, role, scope: [`vyre://${firm.space}/chat-record/*`], expires: Date.now() + 3600_000 } : { person, role };
    await firm.gateway.grants.setRole(owner, m, { presence: proof() });
  }
  const assistant = { kind: "agent", id: "assistant", space: firm.space };
  await firm.gateway.grants.addActor(owner, assistant, { presence: proof() }).catch(() => {});
  const svc = /** @type {any} */ (d.registry.modules.get("work")).handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => firm.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  return { w, d, firm, svc, lines, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
}

test("a member speaks in a team chat with an assistant and the assistant answers there, in the team's chat and not the home's", { timeout: 150_000 }, async t => {
  const { w, as, firm } = await world(t);
  const homeSpace = w.d.kernel.id.space;
  const made = await as(ANA, "create", { title: "Team huddle", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  await as(ANA, "send", { chat: made.chat, text: "hello team, please answer" });
  let lastSeen = "", probe = "";
  try { await w.d.registry.deps.kernelSession({ thread: "t-probe", agent: null, chat: made.chat, asker: ANA, space: (await as(ANA, "get", { chat: made.chat })).space || firm.space, probe: true }); probe = "probe ok"; } catch (e) { probe = `probe failed: ${/** @type {any} */ (e).code} ${/** @type {any} */ (e).message}`; }
  const got = await until(async () => { const c = lastSeen = JSON.stringify(await as(BEN, "catchup", { chat: made.chat })); return /hello team/.test(c) && /echo|hello/i.test(c.replace(/hello team, please answer/g, "")) ? c : null; }, "the assistant's answer in the team's chat").catch(async e => { const th = await w.tool("threads.list", {}).catch((/** @type {any} */ x) => ({ error: x.message })); const db = w.d.registry.deps.db; const rows = (/** @type {string} */ q) => { try { return JSON.stringify(db.prepare(q).all()).slice(0, 700); } catch (x) { return String(x); } }; throw new Error(`${e.message} :: ${probe} :: LOG ${/** @type {any} */ (w).lines.filter((/** @type {string} */ l) => /stream|thread|chat|kernel|session/i.test(l)).slice(-12).join(" | ").slice(0, 1800)} :: ${lastSeen.slice(0, 600)} :: threads ${JSON.stringify(th.data || th.error).slice(0, 500)} :: members ${rows("SELECT grp, who, thread, asker, answer, kind FROM stream_groups_members")} :: spaces ${rows("SELECT * FROM stream_groups_space")} :: outbox ${rows("SELECT uuid, grp, who, done FROM stream_groups_outbox")}`); });
  assert.match(got, /hello team/);
  const home = JSON.stringify((await w.tool("work.chat.list", {})).data);
  assert.ok(!home.includes(String(made.chat)), `the home's own chats never list the team's chat ${made.chat}: ${home.slice(0, 500)}`);
  // memory: what a team chat's turn said is not filed into the home's own memory (the home's recall is the owner's personal one)
  await w.tool("recall.index", {}).catch(() => null);
  const db = w.d.registry.deps.db;
  const lines = (() => { try { return db.prepare("SELECT COUNT(*) n FROM memory_engine_lines WHERE text LIKE ?").get("%hello team, please answer%"); } catch { return { n: 0 }; } })();
  const sess = (() => { try { return String(db.prepare("SELECT session FROM memory_engine_lines WHERE text LIKE ? LIMIT 1").get("%hello team, please answer%").session); } catch { return ""; } })();
  const runs = (() => { try { return JSON.stringify(db.prepare("SELECT who, thread FROM stream_groups_members").all()); } catch (e) { return String(e); } })();
  const tid = (() => { try { return String(db.prepare("SELECT thread FROM stream_groups_members WHERE thread IS NOT NULL").get().thread); } catch { return ""; } })();
  const tList = JSON.stringify((await w.internal("threads.list", {})).data || []).slice(0, 400);
  const tGet = "LIST " + tList + " GET " + (tid ? JSON.stringify(await w.internal("threads.get", { thread: tid, limit: 1 })).slice(0, 300) : "");
  const tOrigin = tGet + " ## " + (tid ? JSON.stringify((await w.internal("threads.origin", { session: tid })).data) : "nothread");
  const klog = /** @type {any} */ (w).lines.filter((/** @type {string} */ l) => /no kernel session/i.test(l)).join(" | ");
  assert.ok(!klog, `a team turn's kernel session opened: ${klog}`);
  const tt = (() => { try { return JSON.stringify(db.prepare("SELECT * FROM threads_team").all()); } catch (e) { return String(e); } })();
  const orig = "threads_team " + tt + " :: " + runs + " :: tOrigin " + tOrigin + " :: " + (sess ? JSON.stringify((await w.internal("threads.origin", { session: sess })).data) : "none");
  const which = (() => { try { return JSON.stringify(db.prepare("SELECT * FROM memory_engine_lines WHERE text LIKE ?").all("%hello team, please answer%")).slice(0, 700); } catch { return ""; } })();
  assert.equal(Number(lines.n), 0, `nothing the team said is in the home's personal memory (home ${homeSpace}, team ${firm.space}): ${which} :: origin ${orig}`);
});

test("the model's own tools in a team turn act in the team Space, as the member who spoke", { timeout: 150_000 }, async t => {
  const { firm, as, lines } = await world(t);
  const made = await as(ANA, "create", { title: "Team tools", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  await as(ANA, "send", { chat: made.chat, text: "vyre records.me {}" });
  let seen = "";
  await until(async () => { seen = JSON.stringify(await as(BEN, "catchup", { chat: made.chat })); return seen.includes(firm.space) ? seen : null; }, "the model's tool answer, from the team Space")
    .catch(e => { throw new Error(`${e.message} :: ${seen.slice(0, 700)} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-6).join(" | ")}`); });
  assert.match(seen, /per_bcdefghijklmnopqrstuvwxyza/, "as Ana, the member who spoke");
});

test("a team chat's open turn is reopened after a restart, in the team Space's own engine, for the member who asked", { timeout: 200_000 }, async t => {
  process.env.FAKE_CLAUDE_DELTA_MS = "400";
  t.after(() => { delete process.env.FAKE_CLAUDE_DELTA_MS; });
  const { w, firm, as, lines } = await world(t);
  const made = await as(ANA, "create", { title: "Long turn", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  await as(ANA, "send", { chat: made.chat, text: `go ${"slowly ".repeat(60)}` });
  await until(() => w.d.registry.deps.kernelSessionCount() > 0, "the team turn's session to open");
  const open = JSON.stringify(w.d.registry.deps.db.prepare("SELECT body FROM kernel_turns").all());
  assert.match(open, new RegExp(firm.space), "the stored turn says which Space it belongs to");
  await w.d.stop();
  /** @type {string[]} */ const after = [];
  const { start } = await import("../daemon/index.js");
  const { present } = await import("../../test/helpers.js");
  const path = await import("node:path");
  const d2 = await start({ root: w.root, presence: present, log: (/** @type {any} */ m) => { after.push(String(m)); }, firstPartyRoots: [path.join(w.root, "modules")], kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d2.stop());
  await until(() => d2.registry.deps.kernelSessionCount() > 0 || after.some(l => /could not resume/.test(l)), "the restart to reopen or give up the turn", 30_000);
  assert.deepEqual(after.filter(l => /could not resume/.test(l)), [], "the turn was reopened, not given up");
  assert.ok(d2.registry.deps.kernelSessionCount() > 0, "the team turn's session is open again");
  void lines;
});

test("a model's tool with no `space` in a team turn lands in the chat's Space, never the home's; a tool that does not declare it may is refused in words", { timeout: 150_000 }, async t => {
  const { w, as, lines, firm } = await world(t);
  const made = await as(ANA, "create", { title: "Team default space", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  /** The assistant's words in the chat so far. */
  const assistantSaid = async () => ((await as(BEN, "catchup", { chat: made.chat })).messages || []).filter((/** @type {any} */ m) => /^assistant:/.test(String(m.author))).map((/** @type {any} */ m) => String(m.text));
  const waitFor = async (/** @type {RegExp} */ re, /** @type {string} */ what) => { let said = /** @type {string[]} */ ([]); await until(async () => { said = await assistantSaid(); return said.some(x => re.test(x)); }, what).catch(e => { throw new Error(`${e.message} :: ${said.join(" || ").slice(0, 900)} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-5).join(" | ")}`); }); return said.find(x => re.test(x)) || ""; };
  await as(ANA, "send", { chat: made.chat, text: "vyre work.chat.list {}" });
  const listed = await waitFor(/chats|error/, "the model's work.chat.list answer");
  assert.ok(listed.includes(`vyre://${firm.space}/chat-record/`), `the chat records the model's work.chat.list returned are the team Space's, not the home's: ${listed.slice(0, 300)}`);
  assert.ok(!JSON.stringify((await w.tool("work.chat.list", {})).data).includes(String(made.chat)), "and the home's own list does not have it");
  await as(ANA, "send", { chat: made.chat, text: "vyre threads.list {}" });
  await waitFor(/not_in_team_space/, "the refusal in words");
});

test("a member's model has the member's authority and no more: Ana's model reads the Space's memory, Tom's (a temp, who may not) reads none of it", { timeout: 150_000 }, async t => {
  const { firm, as, lines } = await world(t);
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const base = await as(ANA, "create", { title: "Where the fact comes from", people: [], agents: [] });
  const filed = await firm.gateway.memory.file(owner, { text: "The Okafor settlement figure is confidential", source: `chat:${base.chat}`, kind: "fact" }).catch((/** @type {any} */ e) => ({ error: String(e && e.message) }));
  assert.ok(!filed.error, `a fact filed in the team Space's memory: ${JSON.stringify(filed).slice(0, 200)}`);
  const ask = async (/** @type {string} */ who, /** @type {string} */ title) => {
    const c = await as(who, "create", { title, people: [], agents: ["assistant"] });
    await as(who, "send", { chat: c.chat, text: "vyre memory.space.recall {}" });
    let said = "";
    await until(async () => { said = ((await as(who, "catchup", { chat: c.chat })).messages || []).filter((/** @type {any} */ m) => /^assistant:/.test(String(m.author))).map((/** @type {any} */ m) => String(m.text)).join(" || "); return said.includes('"facts":') || said.includes('"error"'); }, `${title}: the model's recall`)
      .catch(e => { throw new Error(`${e.message} :: ${said.slice(0, 400)} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-4).join(" | ")}`); });
    return said;
  };
  // the stream shows each answer cut short, so what matters is whether the facts list has anything in it
  assert.ok((await ask(ANA, "Ana asks")).includes('"facts":[{'), "Ana's model reads the fact");
  // a temp member may not even start a chat in the Space now (the tip's room rules), so there is no model of theirs to ask: refused in the kernel's words, which is the "no more" half
  await assert.rejects(() => as(TOM, "create", { title: "Tom asks", people: [], agents: ["assistant"] }), /no right to do that/, "Tom starts no chat, so no model of his reads the memory");
});

test("the Drive's read tools are open to a model, but a model in a HOME chat (a home session token) reads none of a team Space's files, even when it names the Space", { timeout: 150_000 }, async t => {
  const { w, firm, lines } = await world(t);
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.drive.put(owner, "Clients/Harlow/retainer.txt", new Uint8Array(Buffer.from("retainer terms")));
  // a chat as the app starts it: its device makes the chat's key ring
  const dev = crypto.createECDH("prime256v1"); dev.generateKeys();
  const id = `chat_${crypto.randomUUID()}`;
  const ring = createRing(id, holdersOf([{ device: "dev_test", agree: dev.getPublicKey().toString("base64url") }]));
  const made = await w.tool("work.chat.create", { title: "Home chat", id, ring: ring.doc, people: [], agents: [] });
  assert.ok(!made.error, JSON.stringify(made.error));
  const chat = String(made.data.chat || id);
  const sent = await w.tool("stream.send", { chat, text: `vyre files.drive.space.list {"space":"${firm.space}"}` });
  assert.ok(!sent.error, JSON.stringify(sent.error));
  let said = "";
  await until(async () => { said = ((await w.tool("stream.catchup", { chat })).data.messages || []).filter((/** @type {any} */ m) => /^(assistant|model):/.test(String(m.author))).map((/** @type {any} */ m) => String(m.text)).join(" || "); return said.length > 0; }, "the home model's answer")
    .catch(e => { throw new Error(`${e.message} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-5).join(" | ")}`); });
  assert.ok(!said.includes("retainer.txt"), `a home session names the team's Space and reads none of its Drive: ${said.slice(0, 300)}`);
});

test("a model's memory.space.recall in a team turn reads the TEAM Space's memory, as the member, and never the home's", { timeout: 150_000 }, async t => {
  const { w, firm, as, lines } = await world(t);
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const made = await as(ANA, "create", { title: "Team memory", people: [BEN], agents: ["assistant"] });
  const filed = await firm.gateway.memory.file(owner, { text: "The Harlow retainer is billed monthly", source: `chat:${made.chat}`, kind: "fact" }).catch((/** @type {any} */ e) => ({ error: String(e && e.message) }));
  assert.ok(!filed.error, `a fact filed in the team Space's memory: ${JSON.stringify(filed).slice(0, 200)}`);
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  await as(ANA, "send", { chat: made.chat, text: "vyre memory.space.recall {}" });
  let said = "";
  await until(async () => { said = ((await as(BEN, "catchup", { chat: made.chat })).messages || []).filter((/** @type {any} */ m) => /^assistant:/.test(String(m.author))).map((/** @type {any} */ m) => String(m.text)).join(" || "); return said.includes('"facts":[{'); }, "the model's recall of the team's memory")
    .catch(e => { throw new Error(`${e.message} :: ${said.slice(0, 600)} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-4).join(" | ")}`); });
  assert.deepEqual(((await w.tool("memory.space.recall", {})).data || { facts: [] }).facts.filter((/** @type {any} */ f) => /retainer/.test(String(f.text))), [], "the home's own Space memory does not have it");
});

test("a model's files.drive.space.list in a team turn reads the TEAM Space's Drive, as the person who spoke, who holds the Drive right; the model cannot write to it, and a plain member's model lists none of it (the member holds no Drive right unless the owner gives one)", { timeout: 150_000 }, async t => {
  const { w, firm, as, lines } = await world(t);
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const made = await as(ADA, "create", { title: "Team files", people: [BEN], agents: ["assistant"] });
  await firm.gateway.drive.put(owner, "Clients/Harlow/retainer.txt", new Uint8Array(Buffer.from("retainer terms")));
  // the owner gives Ada the Drive (a member holds none unless the owner gives it): her model then reads it as her
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: ADA, space: firm.space } }, actions: ["drive.read"], resource: { prefix: `vyre://${firm.space}/file/*` }, conditions: {}, source: "test" };
  await firm.gateway.grants.create(owner, gi, { presence: proof() });
  await as(ADA, "reply-mode", { chat: made.chat, mode: "every" });
  const said = async () => ((await as(BEN, "catchup", { chat: made.chat })).messages || []).filter((/** @type {any} */ m) => /^assistant:/.test(String(m.author))).map((/** @type {any} */ m) => String(m.text)).join(" || ");
  await as(ADA, "send", { chat: made.chat, text: "vyre files.drive.space.list {}" });
  let got = "";
  await until(async () => { got = await said(); return got.includes("retainer.txt"); }, "the model's listing of the team's Drive")
    .catch(e => { throw new Error(`${e.message} :: ${got.slice(0, 600)} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-4).join(" | ")}`); });
  assert.ok(!JSON.stringify((await w.tool("files.drive.space.list", {})).data || {}).includes("retainer.txt"), "the home's own Drive does not have it");
  await as(ADA, "send", { chat: made.chat, text: `vyre files.drive.upload {"path":"x.txt","base64":"eA=="}` });
  await until(async () => { got = await said(); return /denied|not available|not_in_team_space|held_for_approval/i.test(got.split("retainer.txt").pop() || ""); }, "the write refused or held for the person's yes").catch(e => { throw new Error(`${e.message} :: ${got.slice(-500)}`); });
  await assert.rejects(() => firm.gateway.drive.get(owner, "x.txt"), "the model's write did not land in the team's Drive");
  // a plain member's model does not see it: the member holds no Drive read
  const m = await as(ANA, "create", { title: "Member files", people: [], agents: ["assistant"] });
  await as(ANA, "send", { chat: m.chat, text: "vyre files.drive.space.list {}" });
  let mine = "";
  await until(async () => { mine = ((await as(ANA, "catchup", { chat: m.chat })).messages || []).filter((/** @type {any} */ x) => /^assistant:/.test(String(x.author))).map((/** @type {any} */ x) => String(x.text)).join(" || "); return mine.length > 0; }, "the member's model's answer");
  assert.ok(!mine.includes("retainer.txt"), `a member's model lists none of the Drive: ${mine.slice(0, 200)}`);
});
