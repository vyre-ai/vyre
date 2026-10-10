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
  const w = await boot(t, { driver: "cli", kernel: true });
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
  const { w, as } = await world(t);
  const made = await as(ANA, "create", { title: "Team huddle", people: [BEN], agents: ["assistant"] });
  await as(ANA, "reply-mode", { chat: made.chat, mode: "every" });
  await as(ANA, "send", { chat: made.chat, text: "hello team, please answer" });
  let lastSeen = "";
  const got = await until(async () => { const c = lastSeen = JSON.stringify(await as(BEN, "catchup", { chat: made.chat })); return /hello team/.test(c) && /echo|hello/i.test(c.replace(/hello team, please answer/g, "")) ? c : null; }, "the assistant's answer in the team's chat").catch(async e => { const th = await w.tool("threads.list", {}).catch((/** @type {any} */ x) => ({ error: x.message })); const db = w.d.registry.deps.db; const rows = (/** @type {string} */ q) => { try { return JSON.stringify(db.prepare(q).all()).slice(0, 700); } catch (x) { return String(x); } }; throw new Error(`${e.message} :: ${lastSeen.slice(0, 600)} :: threads ${JSON.stringify(th.data || th.error).slice(0, 500)} :: members ${rows("SELECT grp, who, thread, asker, answer, kind FROM stream_groups_members")} :: outbox ${rows("SELECT uuid, grp, who, done FROM stream_groups_outbox")}`); });
  assert.match(got, /hello team/);
  const home = JSON.stringify((await w.tool("work.chat.list", {})).data);
  assert.ok(!home.includes(String(made.chat)), "the home's own chats never list the team's chat");
});
