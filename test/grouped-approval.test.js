// @ts-check
// Grouped approval at the Gate (SPEC-0.3.0 11.3): an assistant's three outward calls are held as three cards in one group; the person reads each item's exact words, drops or edits any, and says yes once.
// The yes is one proof per approved item, each over that item's own exact request, so it cannot cover another item or a fourth. On the real registry with the real approvals queue.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../core/modules/index.js";
import { Events } from "../kernel/bus.js";
import { open } from "../core/store/index.js";
import { configureYes } from "../lib/one-yes.js";
import { tempHome, writeModule } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canon = (/** @type {any} */ o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
/** What the phone signs for a card: bound to the card's own request. */
const proofFor = (/** @type {any} */ card) => ({ ok: true, payload_hash: card.payload_hash, for: canon({ op: card.request.op, fields: canon(card.request.fields) }) });

async function world(/** @type {import("node:test").TestContext} */ t) {
  globalThis.__sent = [];
  t.after(() => { delete globalThis.__sent; configureYes({ verify: null }); });
  configureYes({ softwareOk: () => true, verify: async ({ op, fields, proof }) => (proof && proof.ok === true && proof.for === canon({ op, fields: canon(fields) }) ? null : "bad_signature") });
  const home = tempHome(t), root = path.join(home, "mods");
  writeModule(root, "mail", { version: "0.1.0", vyre: "1", description: "Sends mail.", does: { tools: [{ name: "mail.send", reach: "anyone", outward: true, summary: "send an email" }] } },
    `export default { async start(ctx) { ctx.tool("mail.send", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { (globalThis.__sent ||= []).push(i); return { sent: i.to }; } }); return {}; } };`);
  fs.mkdirSync(path.join(root, "approvals"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "core", "approvals", "module.json"), path.join(root, "approvals", "module.json"));
  fs.writeFileSync(path.join(root, "approvals", "index.js"), `export { default } from ${JSON.stringify(path.join(REPO, "core", "approvals", "index.js"))};`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, kernel: { proofFrom: (/** @type {any} */ m) => (m.proof ? { presence: m.proof } : undefined) } });
  reg.firstPartyRoots = [root];
  await reg.start(discover([root], { firstPartyRoots: [root] }), { role: "local" });
  t.after(() => db.close());
  assert.equal(reg.modules.get("approvals").state, "running", reg.modules.get("approvals").error);
  return reg;
}
const ASKER = "mcp:agent:kit";
const send = (/** @type {any} */ reg, /** @type {any} */ i, /** @type {any} */ meta = {}) => reg.call("mail.send", i, ASKER, meta);
const pending = async (/** @type {any} */ reg) => (await reg.call("approvals.pending", {}, "cli")).data;
const MAILS = [
  { to: "Northwind", subject: "Invoice 1042 is overdue", body: "Hello Northwind, invoice 1042 for the retainer is now 30 days overdue. Could you pay it this week? " + "Thank you. ".repeat(30) },
  { to: "Oakline", subject: "Invoice 1051 is overdue", body: "Hello Oakline, invoice 1051 is overdue." },
  { to: "Brightwell", subject: "Invoice 1060 is overdue", body: "Hello Brightwell, invoice 1060 is overdue." },
];

test("three outward calls from one assistant are three cards in one group, each with its exact words", async t => {
  const reg = await world(t);
  const held = [];
  for (const m of MAILS) { const r = await send(reg, m); assert.equal(r.error.code, "held_for_approval", JSON.stringify(r.error)); held.push(r.error); }
  assert.equal(new Set(held.map(h => h.group)).size, 1, "one group");
  assert.ok(held[0].group.startsWith("gp_"));
  const p = await pending(reg);
  assert.equal(p.approvals.length, 3);
  assert.deepEqual(p.groups.map((/** @type {any} */ g) => [g.id, g.size]), [[held[0].group, 3]]);
  assert.match(p.groups[0].line, /3 calls of mail\.send: Northwind, Oakline, Brightwell/);
  const first = p.approvals.find((/** @type {any} */ c) => c.request.fields.to === "Northwind");
  assert.deepEqual(first.words.map((/** @type {any} */ w) => w.field), ["to", "subject", "body"], "every text field, in order");
  assert.equal(first.words.find((/** @type {any} */ w) => w.field === "body").text, MAILS[0].body, "the whole long body, not the 200 characters the card's fields hold");
  // another assistant's call is another group
  const other = await reg.call("mail.send", MAILS[1], "mcp:agent:juno");
  assert.notEqual(other.error.group, held[0].group);
  // nothing ran
  assert.deepEqual(globalThis.__sent, []);
});

test("one yes: two approved with their own proofs, one dropped; only those two go out, once each, and a fourth call is in a group the yes cannot reach", async t => {
  const reg = await world(t);
  for (const m of MAILS) await send(reg, m);
  const cards = (await pending(reg)).approvals;
  const [a, b, c] = ["Northwind", "Oakline", "Brightwell"].map(n => cards.find((/** @type {any} */ x) => x.request.fields.to === n));
  const group = a.group;
  const res = await reg.call("approvals.answer-group", { group, decisions: [{ id: a.id, approve: true }, { id: b.id, approve: true }, { id: c.id, approve: false }], proofs: { [a.id]: proofFor(a), [b.id]: proofFor(b) } }, "cli");
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.data.results.map((/** @type {any} */ r) => r.answered), ["approved", "approved", "dropped"]);
  // the assistant retries each call with its card
  const ra = await send(reg, MAILS[0], { approval: a.id }); assert.equal(ra.data && ra.data.sent, "Northwind", JSON.stringify(ra));
  const rb = await send(reg, MAILS[1], { approval: b.id }); assert.equal(rb.data && rb.data.sent, "Oakline", JSON.stringify(rb));
  const rc = await send(reg, MAILS[2], { approval: c.id }); assert.equal(rc.error.code, "approval_refused", "the dropped one does not go");
  assert.equal((await send(reg, MAILS[0], { approval: a.id })).error.code, "approval_refused", "a yes is spent once");
  assert.deepEqual(globalThis.__sent.map((/** @type {any} */ s) => s.to), ["Northwind", "Oakline"]);
  // a fourth call after the group was answered is held in a group of its own, and the group's yes does not reach it
  const fourth = await send(reg, { to: "Eastgate", subject: "Invoice 1070 is overdue", body: "Hello Eastgate." });
  assert.equal(fourth.error.code, "held_for_approval");
  assert.notEqual(fourth.error.group, group, "an answered group never grows");
  const wrong = await reg.call("approvals.answer-group", { group, decisions: [{ id: fourth.error.approval, approve: true }], proofs: { [fourth.error.approval]: proofFor(a) } }, "cli");
  assert.equal(wrong.error && wrong.error.code, "bad_input", "an item of another group is not in this one");
  const f = (await pending(reg)).approvals.find((/** @type {any} */ x) => x.id === fourth.error.approval);
  const stretched = await reg.call("approvals.answer-group", { group: fourth.error.group, decisions: [{ id: f.id, approve: true }], proofs: { [f.id]: proofFor(a) } }, "cli");
  assert.equal(stretched.data.results[0].answered, "waiting", "another item's proof is not this item's yes");
  assert.equal((await send(reg, { to: "Eastgate", subject: "Invoice 1070 is overdue", body: "Hello Eastgate." }, { approval: f.id })).error.code, "approval_refused");
  assert.equal(globalThis.__sent.length, 2);
});

test("an item with no decision or no proof stays waiting; the asker cannot answer or edit its own cards", async t => {
  const reg = await world(t);
  for (const m of MAILS) await send(reg, m);
  const cards = (await pending(reg)).approvals;
  const [a, b, c] = cards;
  const group = a.group;
  const res = await reg.call("approvals.answer-group", { group, decisions: [{ id: a.id, approve: true }, { id: b.id, approve: true }], proofs: { [a.id]: proofFor(a) } }, "cli");
  assert.deepEqual(res.data.results.map((/** @type {any} */ r) => r.answered), ["approved", "waiting"], "no proof for b: b is not approved");
  const left = (await pending(reg)).approvals.map((/** @type {any} */ x) => x.id).sort();
  assert.deepEqual(left, [b.id, c.id].sort(), "b and c are still waiting; c had no decision at all");
  // the asker is not the person: the same label cannot answer or edit
  const asAsker = await reg.call("approvals.answer-group", { group, decisions: [{ id: b.id, approve: true }], proofs: { [b.id]: proofFor(b) } }, ASKER);
  assert.ok(asAsker.error, "an agent never reaches the person's tools");
  // a bad proof is not a yes
  const bad = await reg.call("approvals.answer-group", { group, decisions: [{ id: b.id, approve: true }], proofs: { [b.id]: { ok: true, payload_hash: b.payload_hash, for: "x" } } }, "cli");
  assert.equal(bad.data.results[0].answered, "waiting");
  assert.match(bad.data.results[0].why, /did not stand/);
  assert.equal(globalThis.__sent.length, 0);
});

test("editing one item: the card is made again over the new words, the old proof no longer fits, and the call that goes out is the edited one", async t => {
  const reg = await world(t);
  for (const m of MAILS) await send(reg, m);
  const cards = (await pending(reg)).approvals;
  const [a, b] = cards;
  const old = proofFor(b);
  const edit = await reg.call("approvals.edit-item", { id: b.id, edits: { body: "Hello Oakline, a friendly reminder about invoice 1051." } }, "cli");
  assert.equal(edit.error, undefined, JSON.stringify(edit.error));
  assert.notEqual(edit.data.payload_hash, b.payload_hash, "a new payload to sign");
  assert.equal(edit.data.words.find((/** @type {any} */ w) => w.field === "body").text, "Hello Oakline, a friendly reminder about invoice 1051.");
  assert.equal((await reg.call("approvals.edit-item", { id: b.id, edits: { nope: "x" } }, "cli")).error.code, "bad_input", "only a text field the call has");
  const now = (await pending(reg)).approvals.find((/** @type {any} */ x) => x.id === b.id);
  assert.equal(now.edited, true);
  const res = await reg.call("approvals.answer-group", { group: a.group, decisions: [{ id: a.id, approve: true }, { id: b.id, approve: true }], proofs: { [a.id]: proofFor(a), [b.id]: old } }, "cli");
  assert.deepEqual(res.data.results.map((/** @type {any} */ r) => r.answered), ["approved", "waiting"], "the proof for the old words is not a yes for the new");
  const res2 = await reg.call("approvals.answer-group", { group: a.group, decisions: [{ id: b.id, approve: true }], proofs: { [b.id]: proofFor(now) } }, "cli");
  assert.equal(res2.data.results[0].answered, "approved");
  // the assistant retries with the words it first wrote; what runs is what the person approved
  const r = await send(reg, MAILS[1], { approval: b.id });
  assert.equal(r.data && r.data.sent, "Oakline", JSON.stringify(r));
  assert.equal(globalThis.__sent.at(-1).body, "Hello Oakline, a friendly reminder about invoice 1051.");
  // an unedited card keeps the asker's own input, and another asker cannot read the edited call
  const ra = await send(reg, MAILS[0], { approval: a.id });
  assert.equal(globalThis.__sent.at(-1).body, MAILS[0].body);
  void ra;
  for (const who of ["cli", ASKER, "module:mail"]) assert.ok((await reg.call("approvals.card-input", { id: b.id, tool: "mail.send", from: ASKER }, who)).error, `${who} cannot read a card's call`);
});
