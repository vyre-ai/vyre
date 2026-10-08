// @ts-check
// A sent email is logged on the client it went to.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../../kernel/gateway/index.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createEventLog } from "../../kernel/core/events.js";
import { createChainBuilder } from "../../kernel/core/chain.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { recipientsOf, logSent, watchSentMail, parseRaw, emailOf } from "../../core/daemon/sent-mail-log.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock, is_person: p => p === OWNER || p === "per_bob" });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const grant = { id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: { kind: "person", id: OWNER, space: SPACE } }, actions: ["records.*", "records.define", "events.read"], action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: { kind: "person", id: OWNER, space: SPACE }, source: "test", status: "active", created_at: 0 };

async function rig() {
  const log = createEventLog({ space: SPACE, clock });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, hasPresenceSession: () => true,
    grants: { forSubject: a => (a.kind === "person" && a.id === OWNER ? [grant] : []), get: id => (id === grant.id ? grant : undefined) }, members: { has: a => a.id === OWNER } });
  await gw.records.define(owner(), { add_types: [...CORE_TYPES] });
  return { kernel: gw };
}


const sentItem = (over = {}) => ({ data: { state: "sent", via: "google:work", to: ["jane@harlow.test", "Dana <dana@oakline.test>"], final: { subject: "Invoice 1042 is overdue", body: "Hi Jane,\n\nOur records show invoice 1042 is 30 days overdue.   Please pay.", cc: "billing@harlow.test" }, ...over } });

test("recipients: the approved addresses first, then cc and bcc as written, each once, names stripped", () => {
  assert.deepEqual(recipientsOf(["Jane <Jane@Harlow.test>", "jane@harlow.test"], { cc: "a@b.test; c@d.test", bcc: ["e@f.test", "not an address"] }),
    [{ address: "jane@harlow.test", how: "to" }, { address: "a@b.test", how: "cc" }, { address: "c@d.test", how: "cc" }, { address: "e@f.test", how: "bcc" }]);
});

test("a sent email becomes a Communication on the matching client, and a repeat files nothing new", async () => {
  const { kernel } = await rig(), R = kernel.records;
  const jane = await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test" });
  const dana = await R.create(owner(), "contact", { name: "Dana", email: "dana@main.test" });
  await R.create(owner(), "contact_point", { contact: { urn: dana.urn }, kind: "email", address: "dana@oakline.test" });
  const calls = [];
  const d = { kernel, chain: owner, call: async (tool, input) => { calls.push([tool, input]); return sentItem(); }, now: () => 1_800_000_500_000 };
  const out = await logSent(d, { id: "gi_1", kind: "send", via: "google:work" });
  assert.deepEqual([out.logged, out.of], [2, 3], "two of the three addresses belong to a client");
  assert.deepEqual(calls, [["gate.get", { id: "gi_1" }]]);
  const rows = (await R.query(owner(), "communication", { page: { limit: 10 } })).rows;
  assert.equal(rows.length, 1);
  const c = rows[0].data;
  assert.deepEqual([c.kind, c.direction, c.subject, c.source_key, c.mailbox], ["email", "outbound", "Invoice 1042 is overdue", "gate:gi_1", "google:work"]);
  assert.equal(c.excerpt, "Hi Jane, Our records show invoice 1042 is 30 days overdue. Please pay.", "a short excerpt, whitespace folded");
  assert.equal(c.body, undefined, "the body is not copied");
  assert.deepEqual(c.contacts.map(x => x.urn).sort(), [dana.urn, jane.urn].sort());
  assert.equal(c.to, "jane@harlow.test, dana@oakline.test");
  await logSent(d, { id: "gi_1", kind: "send" });
  assert.equal((await R.query(owner(), "communication", { page: { limit: 10 } })).rows.length, 1, "the same item is filed once");
  // the activity shows on the client
  const linked = await R.get(owner(), "contact", jane.id);
  assert.ok(linked);
});

test("only a sent email is logged: not a held one, not a payment, not a send with nobody to write to", async () => {
  const { kernel } = await rig(), R = kernel.records;
  await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test" });
  const run = (item, released = { id: "gi_x", kind: "send" }) => logSent({ kernel, chain: owner, call: async () => item }, released);
  assert.equal(await run(sentItem({ state: "held" })), null);
  assert.equal(await run(sentItem({ final: { amount: "40" } })), null, "no subject and body: not an email");
  assert.equal(await run(sentItem({ to: ["+15550100"], final: { subject: "S", body: "B" } })), null, "no address");
  assert.equal(await run(sentItem(), { id: "gi_x", kind: "spend" }), null);
  assert.equal((await R.query(owner(), "communication", { page: { limit: 10 } })).rows.length, 0);
});

test("the listener files on gate.released and a failure is a log line, never a throw", async () => {
  const { kernel } = await rig(), R = kernel.records;
  await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test" });
  const subs = []; const lines = [];
  const events = { on: (t, f) => { subs.push([t, f]); } };
  watchSentMail({ events, kernel, chain: owner, call: async () => sentItem(), log: m => lines.push(m) });
  assert.equal(subs[0][0], "gate.released");
  subs[0][1]({ payload: { id: "gi_9", kind: "send", via: "google:work", to: ["jane@harlow.test"] } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await R.query(owner(), "communication", { page: { limit: 10 } })).rows.length, 1);
  watchSentMail({ events, kernel, chain: owner, call: async () => { throw new Error("gate away"); }, log: m => lines.push(m) });
  subs[1][1]({ payload: { id: "gi_10", kind: "send" } });
  await new Promise(r => setTimeout(r, 50));
  assert.match(lines.join(), /sent-mail log: gate away/);
});

const rawOf = (text) => Buffer.from(text).toString("base64url");

test("a Gmail send made through a Connection is read from its raw message", async () => {
  const raw = rawOf("To: Jane Doe <jane@harlow.test>, dana@oakline.test\r\nCc: billing@harlow.test\r\nSubject: Invoice 1042\r\nContent-Type: text/plain\r\n\r\nHi Jane,\r\n\r\nPlease pay.");
  assert.deepEqual(parseRaw(raw), { subject: "Invoice 1042", body: "Hi Jane,\r\n\r\nPlease pay.", to: "Jane Doe <jane@harlow.test>, dana@oakline.test", cc: "billing@harlow.test", bcc: "" });
  assert.equal(parseRaw("%%%"), null);
  assert.equal(parseRaw(rawOf("not a message")), null);
  const { kernel } = await rig(), R = kernel.records;
  const jane = await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test" });
  const item = { data: { state: "sent", via: "vault-api", to: ["gmail.googleapis.com"], final: { credential: "conn-gmail", method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", request: { body: { raw } } } } };
  const out = await logSent({ kernel, chain: owner, call: async () => item, now: () => 1_800_000_900_000 }, { id: "gi_7", kind: "send", via: "vault-api" });
  assert.deepEqual([out.logged, out.of], [1, 3], "jane, dana and the cc; only jane is a client here");
  const c = (await R.query(owner(), "communication", { page: { limit: 5 } })).rows[0].data;
  assert.deepEqual([c.subject, c.direction, c.source_key, c.cc, c.contacts.map(x => x.urn)], ["Invoice 1042", "outbound", "gate:gi_7", "billing@harlow.test", [jane.urn]]);
  // another call to the same host is not an email
  assert.equal(emailOf({ final: { url: "https://gmail.googleapis.com/gmail/v1/users/me/labels", request: { body: { raw } } } }, []), null);
});
