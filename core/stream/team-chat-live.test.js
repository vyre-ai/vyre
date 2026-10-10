// @ts-check
// A shared chat in a TEAM Space on a real vyred (kernel on, fake claude as a real child process): a member says something through the member door (core/work/chat-service.js) and the assistant answers in
// that chat, as a turn that belongs to the team's chat: the chat's record and its people are the team Space's kernel's, the turn is asked for the member who spoke, and nothing of it is written into the
// home's own chats. Stand-in, labelled: SHIM(presence) `kernelPresence` accepts any proof for the owner's grants acts, as the other real-daemon suites do.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "../sessions/testing/boot.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
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
  for (const person of [ANA, BEN]) await firm.gateway.grants.setRole(owner, { person, role: "member" }, { presence: proof() });
  const assistant = { kind: "agent", id: "assistant", space: firm.space };
  await firm.gateway.grants.addActor(owner, assistant, { presence: proof() }).catch(() => {});
  const svc = /** @type {any} */ (d.registry.modules.get("work")).handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => firm.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  return { w, d, firm, svc, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
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
  const tGet = tid ? JSON.stringify(await w.internal("threads.get", { thread: tid, limit: 1 })).slice(0, 300) : "";
  const tOrigin = tGet + " ## " + (tid ? JSON.stringify((await w.internal("threads.origin", { session: tid })).data) : "nothread");
  const klog = /** @type {any} */ (w).lines.filter((/** @type {string} */ l) => /no kernel session/i.test(l)).join(" | ");
  assert.ok(!klog, `a team turn's kernel session opened: ${klog}`);
  const tt = (() => { try { return JSON.stringify(db.prepare("SELECT * FROM threads_team").all()); } catch (e) { return String(e); } })();
  const orig = "threads_team " + tt + " :: " + runs + " :: tOrigin " + tOrigin + " :: " + (sess ? JSON.stringify((await w.internal("threads.origin", { session: sess })).data) : "none");
  const which = (() => { try { return JSON.stringify(db.prepare("SELECT * FROM memory_engine_lines WHERE text LIKE ?").all("%hello team, please answer%")).slice(0, 700); } catch { return ""; } })();
  assert.equal(Number(lines.n), 0, `nothing the team said is in the home's personal memory (home ${homeSpace}, team ${firm.space}): ${which} :: origin ${orig}`);
});
