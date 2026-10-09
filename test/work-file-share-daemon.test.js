// @ts-check
// Share to project (R031-41) on a REAL vyred: a participant shares one file of a chat with work.file.share, a project member who is not in the chat reads that file and no other, and work.file.unshare
// takes it back at once.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("work.file.share opens one chat file to a project member and work.file.unshare takes it back", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner, grants = d.kernel.gateway.grants;
  const BOB = "per_" + "b".repeat(26), DAN = "per_" + "d".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  for (const p of [BOB, DAN]) await grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof("grants.role", { person: p, role: "member" }, `vyre://${space}/member/${p}`) });
  const who = (/** @type {string} */ p, /** @type {string} */ id) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: p, path: "direct", session: `s-${id}` });
  const bob = who(BOB, "b"), dan = who(DAN, "d");
  const as = async (/** @type {any} */ c) => ({ token: (await d.kernel.surfaces.open(c, {})).token });
  const call = async (/** @type {any} */ c, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await as(c));
  const chat = await grants.chats.create(bob, {});
  // the work module files every chat in its creator's Personal project: the chat's folders are under that record's drive root
  const rec = await until(async () => ((await d.kernel.gateway.records.query(bob, "chat-record", { filter: { field: "chat", op: "eq", value: chat.id }, page: { limit: 1 } })).rows || [])[0], "the chat record");
  const dir = `${rec.data.drive}/chat/${chat.id}`, drive = d.kernel.gateway.drive;
  await drive.put(bob, `${dir}/shared.txt`, new TextEncoder().encode("for the project"));
  await drive.put(bob, `${dir}/private.txt`, new TextEncoder().encode("not shared"));
  await assert.rejects(() => drive.get(dan, `${dir}/shared.txt`), { code: "not_found" });
  assert.ok((await call(dan, "work.file.share", { path: `${dir}/shared.txt` })).error, "someone outside the chat cannot share its file");
  await assert.rejects(() => drive.get(dan, `${dir}/shared.txt`), { code: "not_found" });
  const listed = async () => ((await call(bob, "work.file.list", { chat: chat.id })).data || {}).files || [];
  assert.deepEqual((await listed()).map((/** @type {any} */ f) => [f.name, f.shared]).sort(), [["private.txt", false], ["shared.txt", false]], "the chat's files by name, none shared yet");
  assert.deepEqual((await call(dan, "work.file.list", { chat: chat.id })).data.files, [], "someone outside the chat sees none");
  const made = await call(bob, "work.file.share", { path: `${dir}/shared.txt` });
  assert.equal(made.data && made.data.shared, true, JSON.stringify(made.error));
  assert.equal(new TextDecoder().decode(await drive.get(dan, `${dir}/shared.txt`)), "for the project");
  await assert.rejects(() => drive.get(dan, `${dir}/private.txt`), { code: "not_found" });
  assert.deepEqual((await listed()).map((/** @type {any} */ f) => [f.name, f.shared]).sort(), [["private.txt", false], ["shared.txt", true]], "shared.txt is marked");
  const back = await call(bob, "work.file.unshare", { path: `${dir}/shared.txt` });
  assert.ok(back.data && back.data.unshared >= 1, JSON.stringify(back));
  await assert.rejects(() => drive.get(dan, `${dir}/shared.txt`), { code: "not_found" });
});
