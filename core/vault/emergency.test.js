// @ts-check
// emergency tests: alex (the owner) keeps emergency access for juno (the contact). Two vaults in
// one process, each with a relay listener on 127.0.0.1, and one clock both share so the wait can
// pass. Every vault lives in a temp home with a file keystore.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { fingerprint } from "./share.js";
import { newIdentity, openFrom, openItemV2 } from "./crypto.js";
import { openEscrow, DAY } from "./emergency.js";
import { readSealed } from "./store.js";
import { TEST_KDF, recorded } from "./testing.js";
import * as relay from "./relay.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A vault with a relay listener, its events, its planner todos, on a shared clock. */
async function side(t, name, clock) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-emergency-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  /** @type {{ type: string, payload: any }[]} */
  const events = [];
  /** @type {any[]} */
  const planner = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file" } }, emit: (type, payload) => events.push({ type, payload }), testKdf: TEST_KDF });
  v.emergency.now = () => clock.t;
  v.emergency.call = async (tool, input) => { planner.push({ tool, input }); return { data: {} }; };
  const listener = await relay.serve({ host: "127.0.0.1", port: 0, onRelay: (e, m) => v.onRelay(e, m), onEmergency: e => v.emergency.onRequest(e) });
  v.relayUrl = listener.url;
  t.after(async () => { await listener.close(); await v.stop(); db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { v, db, events, planner, home, url: listener.url };
}

/** Each pins the other's card and verifies it by fingerprint. */
async function meet(a, b, bName) {
  const card = (await b.v.card()).card;
  const c = relay.decodeCard(card);
  await a.v.share.addPerson({ card, name: bName }, "cli");
  a.v.share.verifyPerson({ name: bName, fingerprint: fingerprint(c) }, "cli");
}

/** alex with three items (one an ssh key), juno, both verified to each other. */
async function world(t) {
  const clock = { t: Date.now() };
  const alex = await side(t, "alex", clock), juno = await side(t, "juno", clock);
  const values = { mail: fake("mail"), billing: fake("billing"), ssh: fake("ssh") };
  await alex.v.put({ name: "mail-login", kind: "login", fields: { username: "alex@example.com", password: values.mail } }, "cli");
  await alex.v.put({ name: "billing-key", kind: "api-key", fields: { value: values.billing } }, "cli");
  await alex.v.put({ name: "deploy-ssh", kind: "ssh-key", fields: { private_key: values.ssh } }, "cli");
  await meet(alex, juno, "juno");
  await meet(juno, alex, "alex");
  return { clock, alex, juno, values };
}

/** Everything that is not a sealed file: audit rows, events, planner todos. */
const visible = x => JSON.stringify({ audit: x.db.prepare("SELECT * FROM vault_audit").all(), events: x.events, planner: x.planner });

test("emergency: add, request, wait, then status releases and the items land in juno's vault", async t => {
  const { clock, alex, juno, values } = await world(t);
  const added = await alex.v.emergency.add({ person: "juno" }, "cli");
  assert.deepEqual(added.escrowed, ["billing-key", "mail-login"], "every item but the ssh key");
  assert.equal(added.emergency.wait, "7d");
  const bin = path.join(alex.home, "vault", "emergency");
  const files = fs.readdirSync(bin);
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(bin, files[0])).mode & 0o777, 0o600);
  assert.ok(!alex.v.list().items.some(i => i.name.startsWith("emk_")), "the escrow key is not a listable item");

  // Before any request there is nothing to collect.
  assert.equal((await juno.v.emergency.status({ owner: "alex" }, "cli")).state, "standby");

  const asked = await juno.v.emergency.request({ owner: "alex" }, "cli");
  assert.equal(asked.state, "waiting");
  assert.equal(asked.opens, clock.t + 7 * DAY);
  const ev = alex.events.find(e => e.type === "vault.emergency-requested");
  assert.deepEqual(ev?.payload, { person: "juno", opens: clock.t + 7 * DAY });
  assert.equal(alex.planner.length, 1);
  assert.equal(alex.planner[0].tool, "planner.add");
  assert.match(alex.planner[0].input.title, /^juno asked for emergency access: it opens on \d{4}-\d\d-\d\d unless you deny it$/);
  assert.deepEqual(alex.planner[0].input.tags, ["vault", "emergency"]);
  // Asking again does not restart the wait or add a second todo.
  clock.t += DAY;
  assert.equal((await juno.v.emergency.request({ owner: "alex" }, "cli")).opens, asked.opens);
  assert.equal(alex.planner.length, 1);

  const waiting = await juno.v.emergency.status({ owner: "alex" }, "cli");
  assert.deepEqual([waiting.state, waiting.opens], ["waiting", asked.opens]);
  assert.equal(juno.v.list().items.length, 0);

  clock.t = asked.opens + 1;
  const out = await juno.v.emergency.status({ owner: "alex" }, "cli");
  assert.equal(out.state, "released");
  assert.deepEqual(out.items, ["billing-key", "mail-login"]);
  assert.ok(!("ticket" in out), "the contact's tool never returns the ticket");
  assert.deepEqual(juno.v.list().items.map(i => i.name).sort(), ["billing-key", "mail-login"]);
  assert.equal((await juno.v.fields(juno.v.row("billing-key"))).value, values.billing);
  assert.equal(alex.v.emergency.list().contacts[0].state, "released");
  assert.ok(alex.events.some(e => e.type === "vault.emergency-released" && e.payload.person === "juno"));
  // Asking for status again is quiet: nothing is put twice.
  assert.equal((await juno.v.emergency.status({ owner: "alex" }, "cli")).already, true);
});

test("emergency: a deny before the wait keeps the items closed, even after the wait", async t => {
  const { clock, alex, juno } = await world(t);
  await alex.v.emergency.add({ person: "juno", wait: "2d" }, "cli");
  const asked = await juno.v.emergency.request({ owner: "alex" }, "cli");
  assert.equal(asked.opens, clock.t + 2 * DAY);
  clock.t += DAY;
  const d = alex.v.emergency.deny({ person: "juno" }, "mcp");
  assert.equal(d.emergency.state, "denied");
  clock.t += 5 * DAY;
  assert.equal((await juno.v.emergency.status({ owner: "alex" }, "cli")).state, "denied");
  assert.equal(juno.v.list().items.length, 0);
  // Asking again starts a new wait from now.
  const again = await juno.v.emergency.request({ owner: "alex" }, "cli");
  assert.deepEqual([again.state, again.opens], ["waiting", clock.t + 2 * DAY]);
  assert.throws(() => alex.v.emergency.deny({ person: "sam" }, "cli"), /no emergency access/);
});

test("emergency: an unverified or changed card is refused at add; waits and items are checked", async t => {
  const { alex } = await world(t);
  const sam = newIdentity();
  await alex.v.share.addPerson({ card: relay.encodeCard({ name: "sam", sign: sam.sign.public, box: sam.box.public, relay: "" }, sam.sign.private) }, "cli");
  await assert.rejects(alex.v.emergency.add({ person: "sam" }, "cli"), /not verified/);
  // juno's key changes: the pin is blocked until verified again.
  const juno2 = newIdentity();
  await alex.v.share.addPerson({ card: relay.encodeCard({ name: "juno", sign: juno2.sign.public, box: juno2.box.public, relay: "" }, juno2.sign.private) }, "cli");
  await assert.rejects(alex.v.emergency.add({ person: "juno" }, "cli"), /card changed/);
  await assert.rejects(alex.v.emergency.add({ person: "nobody" }, "cli"), /no card for nobody/);
  alex.v.share.verifyPerson({ name: "juno", fingerprint: fingerprint({ sign: juno2.sign.public, box: juno2.box.public }) }, "cli");
  await assert.rejects(alex.v.emergency.add({ person: "juno", wait: "45d" }, "cli"), /1d to 30d/);
  await assert.rejects(alex.v.emergency.add({ person: "juno", wait: "12h" }, "cli"), /1d to 30d/);
  await assert.rejects(alex.v.emergency.add({ person: "juno", items: ["deploy-ssh"] }, "cli"), /never handed out/);
  const ok = await alex.v.emergency.add({ person: "juno", items: ["billing-key"], wait: "30d" }, "cli");
  assert.deepEqual(ok.escrowed, ["billing-key"]);
  await assert.rejects(alex.v.emergency.add({ person: "juno" }, "cli"), /already has emergency access/);
  assert.equal(alex.db.prepare("SELECT COUNT(*) AS n FROM vault_emergency").get()?.n, 1, "the refused adds left no row");
});

test("emergency: a third person's envelope, a forged one and a replay get the generic refusal", async t => {
  const { alex, juno } = await world(t);
  await alex.v.emergency.add({ person: "juno" }, "cli");
  const post = env => fetch(new URL("/v1/emergency", alex.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) }).then(r => r.json());

  // sam is pinned and verified on alex's side, but was never named a contact.
  const sam = await side(t, "sam", { t: Date.now() });
  await meet(alex, sam, "sam");
  const samId = await sam.v.identity();
  const fromSam = await post(relay.emergencyEnvelope({ op: "status", from: samId.sign.public, privDer: samId.sign.private, aud: alex.url }));
  assert.deepEqual(fromSam, { error: { code: "denied", message: "no such pass" } });
  // A stranger signing with their own key while claiming juno's.
  const jid = await juno.v.identity();
  const forged = await post(relay.emergencyEnvelope({ op: "status", from: jid.sign.public, privDer: samId.sign.private, aud: alex.url }));
  assert.deepEqual(forged, { error: { code: "denied", message: "no such pass" } });
  assert.deepEqual(await post({ nothing: true }), { error: { code: "denied", message: "no such pass" } });
  // juno's own envelope, signed for another relay, and replayed.
  const other = await post(relay.emergencyEnvelope({ op: "request", from: jid.sign.public, privDer: jid.sign.private, aud: "https://relay.acme.test" }));
  assert.match(other.error.message, /another relay/);
  const env = relay.emergencyEnvelope({ op: "status", from: jid.sign.public, privDer: jid.sign.private, aud: alex.url });
  assert.equal((await post(env)).data.state, "standby");
  assert.match((await post(env)).error.message, /replayed nonce/);
  // Unknown senders write at most one audit row a minute.
  const rows = alex.db.prepare("SELECT * FROM vault_audit WHERE who LIKE 'pass:unknown%'").all();
  assert.equal(rows.length, 1);
  assert.equal(alex.v.emergency.list().contacts[0].state, "standby", "nothing a stranger sent opened a request");
});

test("emergency: remove deletes the escrow file and key record; offboard does the same", async t => {
  const { alex, juno } = await world(t);
  const made = await alex.v.emergency.add({ person: "juno" }, "cli");
  const id = alex.db.prepare("SELECT id FROM vault_emergency").get()?.id;
  const bin = path.join(alex.home, "vault", "emergency", `${id}.bin`);
  const rec = path.join(alex.home, "vault", "items", `emk_${id}.json`);
  assert.ok(fs.existsSync(bin) && fs.existsSync(rec) && made);
  assert.deepEqual(alex.v.emergency.remove({ person: "juno" }, "mcp"), { removed: "juno" });
  assert.ok(!fs.existsSync(bin) && !fs.existsSync(rec));
  assert.deepEqual(alex.v.emergency.list().contacts, []);
  await assert.rejects(juno.v.emergency.request({ owner: "alex" }, "cli"), /no such pass/);
  assert.throws(() => alex.v.emergency.remove({ person: "juno" }, "cli"), /no emergency access/);

  await alex.v.emergency.add({ person: "juno" }, "cli");
  const out = await alex.v.offboard({ person: "juno" }, "cli");
  assert.equal(out.emergency, true);
  assert.deepEqual(fs.readdirSync(path.join(alex.home, "vault", "emergency")), []);
});

test("emergency: the box alone cannot open an item, and neither can the escrow file alone", async t => {
  const { alex, values } = await world(t);
  await alex.v.emergency.add({ person: "juno" }, "cli");
  const r = alex.db.prepare("SELECT * FROM vault_emergency").get();
  const blob = fs.readFileSync(path.join(alex.home, "vault", "emergency", `${r.id}.bin`));
  for (const v of Object.values(values)) assert.ok(!blob.includes(Buffer.from(v)));
  assert.throws(() => openEscrow(crypto.randomBytes(32), blob, r.id), "the file alone does not open");
  // Everything alex's side holds: the escrow key and the ticket. The items are sealed to juno.
  const ticket = relay.decodeTicket(await alex.v.emergency.release(r));
  assert.deepEqual(ticket.items, ["billing-key", "mail-login"]);
  const me = await alex.v.identity();
  for (const n of ticket.items) assert.throws(() => openFrom(me.box.private, ticket.sealed?.[n], `vyre:pass:v1:${ticket.pass}:${n}`, "pass"));
  // The key is bound to the escrow id: another grant's file does not open with it.
  const vk = await alex.v.key();
  const key = Buffer.from(openItemV2(vk, alex.v.emergency.keyAt(r), readSealed(path.join(alex.home, "vault"), `emk_${r.id}`)).fields.key, "base64");
  assert.throws(() => openEscrow(key, blob, "e_someoneelse00"));
});

test("emergency: an unlock refreshes the snapshot at most once a day; a refresh keeps the request", async t => {
  const { clock, alex, juno } = await world(t);
  const pw = fake("pw");
  await alex.v.createAccount({ password: pw }, "cli");
  await alex.v.emergency.add({ person: "juno" }, "cli");
  await juno.v.emergency.request({ owner: "alex" }, "cli");
  alex.v.lockAccount("cli");
  await alex.v.put({ name: "later-key", kind: "api-key", fields: { value: fake("later") } }, "cli");
  const before = alex.db.prepare("SELECT * FROM vault_emergency").get();
  await alex.v.unlockAccount({ password: pw }, "cli");
  assert.equal(alex.db.prepare("SELECT refreshed FROM vault_emergency").get()?.refreshed, before.refreshed, "not a day yet");
  alex.v.lockAccount("cli");
  clock.t += 2 * DAY;
  await alex.v.unlockAccount({ password: pw }, "cli");
  const after = alex.db.prepare("SELECT * FROM vault_emergency").get();
  assert.ok(after.refreshed > before.refreshed);
  assert.equal(after.requested, before.requested, "the refresh left the request alone");
  assert.deepEqual(relay.decodeTicket(await alex.v.emergency.release(after)).items, ["billing-key", "later-key", "mail-login"]);
  assert.deepEqual((await alex.v.emergency.refresh({}, "cli")).refreshed, [{ person: "juno", items: 3 }]);
  clock.t += 6 * DAY;
  const out = await juno.v.emergency.status({ owner: "alex" }, "cli");
  assert.equal(out.state, "released");
  assert.ok(juno.v.row("later-key"));
});

test("emergency: no value, escrow key or ticket reaches an audit row, an event or a todo", async t => {
  const { clock, alex, juno, values } = await world(t);
  await alex.v.emergency.add({ person: "juno", wait: "1d" }, "cli");
  await juno.v.emergency.request({ owner: "alex" }, "cli");
  clock.t += DAY + 1;
  await juno.v.emergency.status({ owner: "alex" }, "cli");
  const r = alex.db.prepare("SELECT * FROM vault_emergency").get();
  const ticket = await alex.v.emergency.release(r);
  const key = openItemV2(await alex.v.key(), alex.v.emergency.keyAt(r), readSealed(path.join(alex.home, "vault"), `emk_${r.id}`)).fields.key;
  const sealedPart = Object.values(relay.decodeTicket(ticket).sealed || {}).map(s => s.ct || JSON.stringify(s));
  for (const x of [alex, juno]) {
    const seen = visible(x);
    for (const s of [...Object.values(values), key, ticket, ticket.slice(13, 80), ...sealedPart]) assert.ok(!seen.includes(s), `${x === alex ? "alex" : "juno"} leaked`);
  }
  assert.ok(alex.db.prepare("SELECT * FROM vault_audit WHERE action = 'emergency-release' AND ok = 1").get());
});

test("emergency: through the module, the relay listener answers /v1/emergency and the owner gets a planner todo", async t => {
  const todos = [];
  const alex = await recorded(t, { relay: { host: "127.0.0.1", port: 0 } }, { call: async (tool, input) => { if (tool !== "gate.offer") todos.push({ tool, input }); return { data: {} }; } });
  const juno = await recorded(t);
  const pin = async (x, y, name) => {
    const card = (await y.run("vault.identity", {})).card;
    await x.run("vault.person.add", { card, name });
    await x.run("vault.people.verify", { name, fingerprint: fingerprint(relay.decodeCard(card)) });
  };
  await pin(alex, juno, "juno");
  await pin(juno, alex, "alex");
  await alex.run("vault.put", { name: "billing-key", kind: "api-key", value: fake("billing") });
  const added = await alex.run("vault.emergency.add", { person: "juno", wait: "3d" });
  assert.deepEqual(added.escrowed, ["billing-key"]);
  const asked = await juno.run("vault.emergency.request", { owner: "alex" });
  assert.equal(asked.state, "waiting");
  assert.ok(asked.opens > Date.now() + 2 * DAY);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].input.list, "Vault");
  assert.equal((await juno.run("vault.emergency.status", { owner: "alex" })).state, "waiting");
  const listed = (await alex.run("vault.emergency.list", {}, "mcp")).contacts;
  assert.deepEqual(listed.map(c => [c.person, c.wait, c.state]), [["juno", "3d", "waiting"]]);
  assert.equal((await alex.run("vault.emergency.deny", { person: "juno" }, "mcp")).emergency.state, "denied");
  assert.deepEqual(await alex.run("vault.emergency.remove", { person: "juno" }, "mcp"), { removed: "juno" });
});
