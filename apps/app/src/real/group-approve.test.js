// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadHash } from "./payload-hash.js";
import { approveGroup, closingLine, editItem, readAll, groupsFrom, singlesFrom, wordLines, yesLabel } from "./group-approve.js";

const SPACE = "spc_abcdefghijkl";
const card = (/** @type {string} */ id, /** @type {string} */ to, extra = {}) => {
  const fields = { to, subject: `Invoice for ${to}`, body: `Hello ${to}` };
  return { id, group: "gp_1", moment: "outward", line: `Send an email to ${to}`, request: { op: "mail.send", fields }, sign: { op: "mail.send", space: SPACE, fields }, payload_hash: payloadHash("mail.send", SPACE, fields),
    words: [{ field: "to", text: to }, { field: "subject", text: fields.subject }, { field: "body", text: fields.body }], ...extra };
};
const PENDING = { approvals: [card("a1", "Northwind"), card("a2", "Oakline"), card("a3", "Brightwell"), { id: "s1", title: "Turn a rule off", op: "grant.rule_disable", space: SPACE, fields: { r: "1" }, payload_hash: payloadHash("grant.rule_disable", SPACE, { r: "1" }) }],
  groups: [{ id: "gp_1", size: 3, line: "An assistant (kit) wants to run 3 calls of mail.send: Northwind, Oakline, Brightwell" }] };

test("the groups come from the queue with their lines; a card with no group stays a single card", () => {
  const gs = groupsFrom(PENDING);
  assert.equal(gs.length, 1);
  assert.deepEqual([gs[0].id, gs[0].items.map((i) => i.id)], ["gp_1", ["a1", "a2", "a3"]]);
  assert.match(gs[0].line, /3 calls of mail\.send/);
  assert.deepEqual(singlesFrom(PENDING).map((c) => c.id), ["s1"]);
  assert.deepEqual(wordLines(gs[0].items[0]).map((w) => w.field), ["to", "subject", "body"]);
  assert.equal(yesLabel(gs[0], new Set()), "Approve all 3");
  assert.equal(yesLabel(gs[0], new Set(["a3"])), "Approve 2 of 3");
  assert.equal(yesLabel(gs[0], new Set(["a1", "a2", "a3"])), "Nothing to approve");
});

test("one yes: each approved item is signed over its own hash, the dropped one is sent as a no and signs nothing, and the proofs go together", async () => {
  const [g] = groupsFrom(PENDING);
  /** @type {any[]} */ const signed = [], calls = [];
  const signer = { signPresence: async (/** @type {any} */ r) => { signed.push(r); return { payload_hash: r.payload_hash, signature: "sig-" + r.fields.to }; } };
  const call = async (/** @type {string} */ t, /** @type {any} */ i) => { calls.push([t, i]); return { group: i.group, results: [{ id: "a1", answered: "approved" }, { id: "a2", answered: "approved" }, { id: "a3", answered: "dropped" }] }; };
  const out = await approveGroup({ group: g, dropped: new Set(["a3"]), signer, call, person: "per_a" });
  assert.deepEqual(signed.map((r) => r.fields.to), ["Northwind", "Oakline"], "nothing is signed for the dropped item");
  assert.deepEqual(signed.map((r) => r.payload_hash), [g.items[0].payload_hash, g.items[1].payload_hash]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].decisions, [{ id: "a1", approve: true }, { id: "a2", approve: true }, { id: "a3", approve: false }]);
  assert.deepEqual(Object.keys(calls[0][1].proofs), ["a1", "a2"]);
  assert.equal(out.results.length, 3);
});

test("a batch signer that answers null (Android) falls back to one signature at a time", async () => {
  const [g] = groupsFrom(PENDING);
  let one = 0;
  const signer = { signPresence: async (/** @type {any} */ r) => { one++; return { payload_hash: r.payload_hash }; }, signMany: async () => null };
  await approveGroup({ group: g, signer, call: async () => ({ results: [] }), person: "per_a" });
  assert.equal(one, 3);
});

test("a long item is read to its end through approvals.item-view, parts of one value joined", async () => {
  const [g] = groupsFrom(PENDING);
  const pages = [{ words: [{ field: "to", text: "Northwind" }, { field: "body", text: "AAA", part: "1/2" }], total: 3, offset: 0, next: 2 }, { words: [{ field: "body", text: "BBB", part: "2/2" }, { field: "subject", text: "S" }], total: 3, offset: 2, next: null }];
  /** @type {number[]} */ const asked = [];
  const read = await readAll({ ...g.items[0], partial: true }, async (_t, i) => { asked.push(/** @type {number} */ (i.offset)); return pages[asked.length - 1]; });
  assert.deepEqual(asked, [0, 2]);
  assert.deepEqual(read.words, [{ field: "to", text: "Northwind" }, { field: "body", text: "AAABBB" }, { field: "subject", text: "S" }]);
  assert.deepEqual([read.partial, read.readAll], [true, true], "read to the end, but still approved on its own");
  await assert.rejects(readAll(g.items[0], async () => ({})), (/** @type {any} */ e) => e.code === "bad_input");
});

test("a batch signer is used when the phone has one (one unlock), and a proof for another item sends nothing", async () => {
  const [g] = groupsFrom(PENDING);
  let many = 0;
  const call = async () => { throw new Error("must not be called"); };
  const signer = { signPresence: async () => { throw new Error("not used"); }, signMany: async (/** @type {any[]} */ reqs) => { many++; return reqs.map((r, i) => ({ payload_hash: i === 1 ? "other" : r.payload_hash })); } };
  await assert.rejects(approveGroup({ group: g, signer: /** @type {any} */ (signer), call, person: "per_a" }), (/** @type {any} */ e) => e.code === "needs_presence");
  assert.equal(many, 1);
});

test("a hash that is not the hash of the shown words, no signer, no person and a part-shown item stop before the key is asked or are left out", async () => {
  const [g] = groupsFrom(PENDING);
  let asked = 0;
  const signer = { signPresence: async (/** @type {any} */ r) => { asked++; return { payload_hash: r.payload_hash }; } };
  const call = async (/** @type {string} */ _t, /** @type {any} */ i) => ({ group: i.group, results: [] });
  const bad = { ...g, items: [{ ...g.items[0], fields: { ...g.items[0].fields, to: "Evil" } }, g.items[1], g.items[2]] };
  await assert.rejects(approveGroup({ group: bad, signer, call, person: "per_a" }), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(approveGroup({ group: g, signer: null, call, person: "per_a" }), (/** @type {any} */ e) => e.code === "no_signer");
  await assert.rejects(approveGroup({ group: g, signer, call, person: "" }), (/** @type {any} */ e) => e.code === "no_person");
  assert.equal(asked, 0);
  const partial = { ...g, items: [{ ...g.items[0], partial: true }, g.items[1]] };
  /** @type {any} */ let sent;
  await approveGroup({ group: partial, signer, call: async (_t, i) => { sent = i; return { results: [] }; }, person: "per_a" });
  assert.deepEqual(Object.keys(sent.proofs), ["a2"], "the item shown only in part is not in the yes");
  assert.equal(asked, 1);
});

test("editing one item makes the new hash and words the ones to sign", async () => {
  const [g] = groupsFrom(PENDING);
  const call = async (/** @type {string} */ t, /** @type {any} */ i) => { assert.equal(t, "approvals.edit-item"); assert.deepEqual(i, { id: "a1", edits: { body: "Hello again" } }); return { id: "a1", payload_hash: "newhash", words: [{ field: "body", text: "Hello again" }], line: "Send an email to Northwind" }; };
  const next = await editItem(g.items[0], { body: "Hello again" }, call);
  assert.deepEqual([next.payload_hash, next.edited, next.words?.[0].text], ["newhash", true, "Hello again"]);
  await assert.rejects(editItem(g.items[0], {}, async () => ({})), (/** @type {any} */ e) => e.code === "bad_input");
});

test("the closing line says what went out, and the log line only where the sent mail is filed", () => {
  const [g] = groupsFrom(PENDING);
  const three = [{ id: "a1", answered: "approved" }, { id: "a2", answered: "approved" }, { id: "a3", answered: "approved" }];
  assert.equal(closingLine(three, g, { logged: true }), "Sent 3 emails. Each is logged on its client.");
  assert.equal(closingLine(three, g), "Sent 3 emails.");
  assert.equal(closingLine([{ id: "a1", answered: "approved" }, { id: "a2", answered: "dropped" }, { id: "a3", answered: "waiting" }], g), "Sent 1 email; 1 dropped, 1 still waits.");
  assert.equal(closingLine([{ id: "a1", answered: "dropped" }], g), "Nothing was sent.");
  assert.equal(closingLine([{ id: "a1", answered: "waiting" }], g), "1 still waits for you.");
});

test("recipients show the client's name beside the address, from the matching record", async () => {
  const { addressesIn, namesFor, withNames, isAddressField, needsFold } = await import("./group-approve.js");
  assert.deepEqual(addressesIn("Accounts <Accounts@Northwind.example>, dana@oakline.example; accounts@northwind.example"), ["accounts@northwind.example", "dana@oakline.example"]);
  const calls = [];
  const call = async (/** @type {string} */ t, /** @type {any} */ i) => {
    calls.push([t, i.filter && i.filter.value]);
    if (t === "records.list" && i.type === "contact") return { rows: i.filter.value === "accounts@northwind.example" ? [{ data: { name: "Northwind Bakery" } }] : [] };
    if (t === "records.list") return { rows: i.filter.value === "dana@oakline.example" ? [{ data: { contact: { urn: "vyre://s/contact/c1" } } }] : [] };
    return { record: { data: { name: "Dana Oakline" } } };
  };
  const names = await namesFor(["accounts@northwind.example", "dana@oakline.example", "stranger@x.example"], call);
  assert.deepEqual([...names], [["accounts@northwind.example", "Northwind Bakery"], ["dana@oakline.example", "Dana Oakline"]]);
  assert.equal(withNames("accounts@northwind.example, stranger@x.example", names), "Northwind Bakery · accounts@northwind.example, stranger@x.example");
  assert.equal(withNames("Northwind Bakery · accounts@northwind.example", names), "Northwind Bakery · accounts@northwind.example", "not named twice");
  assert.deepEqual(["to", "Reply to", "cc", "subject", "body"].map(isAddressField), [true, true, true, false, false]);
  assert.deepEqual([needsFold("short"), needsFold("x".repeat(300)), needsFold("a\n\n\n\n\n\n\nb")], [false, true, true]);
  await assert.doesNotReject(namesFor(["a@b.example"], async () => { throw new Error("away"); }));
});
