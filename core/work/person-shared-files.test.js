// @ts-check
// "You and <person>" lists the files of the chats you both are in, read through your own chain: a file of a chat you are not in is never listed, and the other person sees what they may open too.
// Real daemon, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("work.person.shared lists the files of the chats you share with that person, and no other", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner, grants = d.kernel.gateway.grants, drive = d.kernel.gateway.drive;
  const BOB = "per_" + "b".repeat(26), DAN = "per_" + "d".repeat(26), EVE = "per_" + "e".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  for (const p of [BOB, DAN, EVE]) await grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof("grants.role", { person: p, role: "member" }, `vyre://${space}/member/${p}`) });
  const who = (/** @type {string} */ p, /** @type {string} */ id) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: p, path: "direct", session: `s-${id}` });
  const bob = who(BOB, "b"), dan = who(DAN, "d"), eve = who(EVE, "e");
  const call = async (/** @type {any} */ c, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(c, {})).token });
  const put = async (/** @type {any} */ chain, /** @type {any} */ chat, /** @type {string} */ name) => {
    const rec = await until(async () => ((await d.kernel.gateway.records.query(d.kernel.gateway.serviceChain("work"), "chat-record", { filter: { field: "chat", op: "eq", value: chat.id }, page: { limit: 1 } })).rows || [])[0], "the chat record");
    await drive.put(chain, `${rec.data.drive}/made/${chat.id}/${name}`, new TextEncoder().encode(name));
  };
  const withDan = await grants.chats.create(bob, { people: [DAN] }), withEve = await grants.chats.create(bob, { people: [EVE] });
  await put(bob, withDan, "plan.txt"); await put(bob, withEve, "secret.txt");
  const names = (/** @type {any} */ r) => (r.data.files || []).map((/** @type {any} */ f) => f.name).sort();
  const b = await call(bob, "work.person.shared", { person: DAN });
  assert.ok(!b.error, JSON.stringify(b.error));
  assert.deepEqual(names(b), ["plan.txt"], "Bob sees the file of his chat with Dan, not the one in his chat with Eve");
  assert.equal(b.data.files[0].thread, withDan.id, "and which thread it is in");
  assert.deepEqual(names(await call(dan, "work.person.shared", { person: BOB })), ["plan.txt"], "Dan sees it too");
  assert.deepEqual(names(await call(eve, "work.person.shared", { person: DAN })), [], "Eve shares no chat with Dan, so no files");
  assert.deepEqual(names(await call(eve, "work.person.shared", { person: BOB })), ["secret.txt"]);
});
