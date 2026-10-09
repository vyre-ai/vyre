// @ts-check
// One timeline per record (R031-46) and a chat's link to a record (R031-41), on a REAL vyred: the permission matrix. A chat on the timeline is its people's until they share it; a person who cannot read the
// record sees no timeline of it.
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

test("a record's timeline shows a linked chat only to its people until they share it, and then only its title", { timeout: 180_000 }, async t => {
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
  const client = await d.kernel.gateway.records.create(ownerChain, "organization", { name: "Northwind Bakery" });
  const chat = await grants.chats.create(bob, {});
  await until(async () => ((await d.kernel.gateway.records.query(bob, "chat-record", { filter: { field: "chat", op: "eq", value: chat.id }, page: { limit: 1 } })).rows || [])[0], "the chat record");
  const titles = async (/** @type {any} */ c) => { const r = await call(c, "work.timeline", { record: client.urn }); assert.ok(r.data, JSON.stringify(r.error)); return r.data.entries.map((/** @type {any} */ e) => [e.type, e.title, e.mine === true]); };
  assert.deepEqual(await titles(ownerChain), [], "nothing is linked yet");
  assert.ok((await call(dan, "work.chat.link", { chat: chat.id, record: client.urn })).error, "someone outside the chat cannot link it");
  const sug = await call(bob, "work.link.suggest", { text: "Can you draft a note to northwind bakery about the lease?" });
  assert.deepEqual((sug.data.suggestions || []).map((/** @type {any} */ x) => [x.type, x.title]), [["organization", "Northwind Bakery"]], "a name in the text is offered");
  assert.deepEqual((await call(bob, "work.link.suggest", { text: "nothing named here at all" })).data.suggestions, []);
  const linked = await call(bob, "work.chat.link", { chat: chat.id, record: client.urn });
  assert.equal(linked.data && linked.data.about, client.urn, JSON.stringify(linked.error));
  assert.deepEqual((await titles(bob)).map(e => [e[0], e[2]]), [["chat", true]], "its person sees it, as theirs");
  assert.deepEqual(await titles(ownerChain), [], "private until shared: the owner is not in the chat");
  assert.deepEqual(await titles(dan), [], "and neither is anyone else");
  await call(bob, "work.chat.link", { chat: chat.id, shared: true });
  assert.deepEqual((await titles(ownerChain)).map(e => [e[0], e[2]]), [["chat", false]], "shared: others see that it exists");
  assert.equal(JSON.stringify((await call(dan, "work.timeline", { record: client.urn })).data).includes("transcript"), false, "never more than the title");
  await call(bob, "work.chat.link", { chat: chat.id, shared: false });
  assert.deepEqual(await titles(ownerChain), [], "unshared again");
  const off = await call(bob, "work.chat.link", { chat: chat.id, record: null });
  assert.equal(off.data && off.data.about, null);
  assert.deepEqual(await titles(bob), [], "unlinked");
  // the story reads in plain lines, with the kind that picks its icon
  await d.kernel.gateway.records.create(ownerChain, "communication", { kind: "email", direction: "outbound", at: new Date().toISOString(), subject: "Engagement letter", to: "dana@example.com", record: { urn: client.urn } });
  await d.kernel.gateway.records.create(ownerChain, "task", { title: "Collect the signed letter", status: "done", record: { urn: client.urn } }).catch(() => null);
  const story = (await call(ownerChain, "work.timeline", { record: client.urn })).data.entries;
  const mail = story.find((/** @type {any} */ e) => e.kind === "email");
  assert.equal(mail && mail.line, "Email sent to dana@example.com: Engagement letter");
  assert.ok(story.every((/** @type {any} */ e) => typeof e.line === "string" && e.line && typeof e.at === "number"), "every entry has a plain line and a time");
});
