// @ts-check
// A shared chat in a TEAM Space on a real vyred (kernel on, the fake claude as a real child process): a member says something through the member door (core/work/chat-service.js) and the assistant answers in
// that chat. The chat's record and its people are the team Space's kernel's; the turn is asked for the member who spoke and its session is opened by the team's kernel; and nothing of it is written into the
// home's own chats, or the home's personal recall and memory. Stand-in, labelled: SHIM(presence) `kernelPresence` accepts any proof for the owner's grants acts, as the other real-daemon suites do (a headless
// test has no hardware signer).
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
  const d = w.d;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await firm.gateway.grants.setRole(owner, { person, role: "member" }, { presence: proof() });
  await firm.gateway.grants.addActor(owner, { kind: "agent", id: "assistant", space: firm.space }, { presence: proof() }).catch(() => {});
  const svc = /** @type {any} */ (d.registry.modules.get("work")).handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => firm.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  return { w, d, firm, lines, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
}

test("a member speaks in a team chat with an assistant and the assistant answers there: in the team's chat, with the team's session, and nothing of it in the home's chats, recall or memory", { timeout: 150_000 }, async t => {
  const { w, d, firm, lines, as } = await world(t);
  const made = await as(ANA, "create", { title: "Team huddle", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  await as(ANA, "send", { chat: made.chat, text: "hello team, please answer" });
  let seen = "";
  await until(async () => { seen = JSON.stringify(await as(BEN, "catchup", { chat: made.chat })); return /echo: hello team/.test(seen) ? seen : null; }, "the assistant's answer in the team's chat")
    .catch(e => { throw new Error(`${e.message} :: ${seen.slice(0, 500)} :: ${lines.filter(l => /stream|threads/.test(l)).slice(-6).join(" | ")}`); });
  assert.match(seen, /per_bcdefghijklmnopqrstuvwxyza/, "the words are Ana's");
  assert.deepEqual(lines.filter(l => /no kernel session/.test(l)), [], "the turn's kernel session opened");

  // the chat is the team Space's: the home's own Chats never list it, and the home's runtime knows which Space the run belongs to
  const home = JSON.stringify((await w.tool("work.chat.list", {})).data);
  assert.ok(!home.includes(String(made.chat)), `the home's own chats never list the team's chat: ${home.slice(0, 300)}`);
  const db = d.registry.deps.db;
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM threads_team WHERE space = ?").get(firm.space).n), 1, "the Switchboard keeps which Space the run belongs to");
  assert.equal(db.prepare("SELECT space FROM stream_groups_space WHERE grp = ?").get(made.chat).space, firm.space, "and the stream, which Space the chat belongs to");

  // recall and memory: what the team said is not filed into the home's own (the owner's personal) recall or memory
  await w.tool("recall.index", {}).catch(() => null);
  const filed = Number(db.prepare("SELECT COUNT(*) n FROM memory_engine_lines WHERE text LIKE ?").get("%hello team, please answer%").n);
  assert.equal(filed, 0, "nothing the team said is in the home's personal memory");
  const recalled = (() => { try { return Number(db.prepare("SELECT COUNT(*) n FROM recall_turns WHERE text LIKE ?").get("%hello team, please answer%").n); } catch { return 0; } })();
  assert.equal(recalled, 0, "nor in the home's personal recall");
});
