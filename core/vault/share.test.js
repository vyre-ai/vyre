// @ts-check
// share tests: fingerprints and safety words, pinning people (and what a changed key blocks),
// signed tickets between two vaults in one process, agent requests waiting for a person, and the
// relay hardening on the owner's side. Every vault lives in a temp home with a file keystore.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { fingerprint, normalizeFingerprint, safetyWords, Share } from "./share.js";
import { newIdentity } from "./crypto.js";
import * as relay from "./relay.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A Vault in a temp home, with its events and logs captured. */
function mk(t, name, vault = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-share-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  /** @type {{ type: string, payload: any }[]} */
  const events = [];
  /** @type {string[]} */
  const logs = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file", ...vault } }, emit: (type, payload) => events.push({ type, payload }), log: m => logs.push(m) });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { v, db, events, logs, home };
}

/** Everything a vault wrote that is not a sealed file: audit rows, events, logs. */
const visible = x => JSON.stringify({ audit: x.db.prepare("SELECT * FROM vault_audit").all(), events: x.events, logs: x.logs });

test("fingerprints are five groups of four Crockford characters; typed forms normalise; safety words match both ways", () => {
  const a = newIdentity(), b = newIdentity();
  const fa = fingerprint({ sign: a.sign.public, box: a.box.public }), fb = fingerprint({ sign: b.sign.public, box: b.box.public });
  assert.match(fa, /^([0-9A-HJKMNP-TV-Z]{4} ){4}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(fa, fingerprint({ box: a.box.public, sign: a.sign.public }), "key order does not matter");
  assert.notEqual(fa, fb);
  assert.equal(normalizeFingerprint(fa.toLowerCase().replace(/ /g, "-")), fa);
  assert.equal(normalizeFingerprint("OOOO IIII LLLL 0000 1111"), "0000 1111 1111 0000 1111");
  assert.equal(normalizeFingerprint("too short"), null);
  const w = safetyWords(fa, fb);
  assert.equal(w.length, 4);
  for (const x of w) assert.match(x, /^([bdfghjklmnprstvz][aeiou]){3}$/);
  assert.deepEqual(safetyWords(fb, fa), w, "both people see the same words");
  assert.notDeepEqual(safetyWords(fa, fingerprint({ sign: newIdentity().sign.public, box: b.box.public })), w);
});

test("people: first card pinned, the same card again is quiet, a changed key blocks passes until verified", async t => {
  const o = mk(t, "owner-box");
  await o.v.put({ name: "api-token", kind: "api-key", fields: { value: fake("t") }, hosts: ["https://api.example.com"] }, "cli");
  o.v.relayUrl = "https://owner.example.com";
  const dana = newIdentity();
  const card = relay.encodeCard({ name: "dana", sign: dana.sign.public, box: dana.box.public, relay: "" }, dana.sign.private);
  const first = await o.v.share.addPerson({ card }, "cli");
  assert.equal(first.pinned, true);
  assert.equal(first.person.verified, false);
  assert.equal(first.person.blocked, false, "a signed first card is enough to share (trust on first use)");
  assert.equal((await o.v.share.addPerson({ card }, "cli")).pinned, false);
  assert.ok((await o.v.createPass({ holder: "dana", items: ["api-token"] }, "cli")).ticket);

  // A new key under the same name.
  const dana2 = newIdentity();
  const card2 = relay.encodeCard({ name: "dana", sign: dana2.sign.public, box: dana2.box.public, relay: "" }, dana2.sign.private);
  const changed = await o.v.share.addPerson({ card: card2 }, "cli");
  assert.equal(changed.changed, true);
  assert.equal(changed.person.blocked, true);
  assert.ok(o.events.some(e => e.type === "vault.card-changed" && e.payload.name === "dana"));
  await assert.rejects(o.v.createPass({ holder: "dana", items: ["api-token"] }, "cli"), /card changed .* vyre vault people verify dana/);
  // Presenting the new card on the pass itself does not get round it.
  await assert.rejects(o.v.createPass({ holder: "dana", card: card2, items: ["api-token"] }, "cli"), /card changed/);
  assert.throws(() => o.v.share.verifyPerson({ name: "dana", fingerprint: first.person.fingerprint }, "cli"), /does not match/);
  const fp2 = fingerprint({ sign: dana2.sign.public, box: dana2.box.public });
  const ok = o.v.share.verifyPerson({ name: "dana", fingerprint: fp2.toLowerCase() }, "cli");
  assert.equal(ok.person.verified, true);
  assert.ok(o.events.some(e => e.type === "vault.person-verified"));
  const p = await o.v.createPass({ holder: "dana", items: ["api-token"] }, "cli");
  assert.equal(relay.decodeTicket(p.ticket).holderSign, dana2.sign.public);

  // The listing carries names and public fingerprints only.
  const listed = JSON.stringify(o.v.share.people());
  assert.ok(!listed.includes(dana2.sign.private) && !listed.includes("vyre-card:"));
});

test("a v1 card is pinned but shares nothing until verified; from an agent a card waits for a person", async t => {
  const o = mk(t, "owner-box");
  await o.v.put({ name: "db-password", fields: { value: fake("db") } }, "cli");
  const alex = newIdentity();
  const v1 = "vyre-card:v1:" + Buffer.from(JSON.stringify({ name: "alex", sign: alex.sign.public, box: alex.box.public, relay: "" })).toString("base64url");
  const r = await o.v.share.addPerson({ card: v1 }, "cli");
  assert.equal(r.person.version, 1);
  assert.equal(r.person.blocked, true);
  await assert.rejects(o.v.createPass({ holder: "alex", items: ["db-password"], mode: "sealed" }, "cli"), /old unsigned one/);
  o.v.share.verifyPerson({ name: "alex", fingerprint: r.person.fingerprint }, "cli");
  assert.ok((await o.v.createPass({ holder: "alex", items: ["db-password"], mode: "sealed" }, "cli")).ticket);

  const sam = newIdentity();
  const card = relay.encodeCard({ name: "sam", sign: sam.sign.public, box: sam.box.public, relay: "" }, sam.sign.private);
  const asked = await o.v.share.addPerson({ card }, "mcp");
  assert.ok("pending" in asked);
  assert.equal(o.v.share.row("sam"), undefined, "nothing pinned yet");
  await assert.rejects(o.v.createPass({ holder: "sam", card, items: ["db-password"], mode: "sealed" }, "mcp"), /waits for a person to approve it/);
  // A pass that would be refused for another reason is refused before the card is queued or pinned: nothing is changed by a refused call.
  await assert.rejects(o.v.createPass({ holder: "sam", card, items: ["db-password"] }, "mcp"), /no hosts it may be sent to/);
  const pend = o.v.pending();
  assert.equal(pend.people.length, 2);
  const approved = await o.v.approve({ id: /** @type {any} */ (asked).pending.id }, "cli");
  assert.equal(approved.approved.name, "sam");
  assert.ok(o.v.share.row("sam"));
  assert.equal(o.v.pending().people.length, 1);
});

/** An owner and a holder who have each other's cards, and a relayed item on the owner. */
async function pair(t, { hosts = ["https://api.example.com"], ...item } = {}) {
  const o = mk(t, "owner-box"), h = mk(t, "teammate-box");
  o.v.relayUrl = "http://127.0.0.1:9";
  const token = fake("token");
  await o.v.put({ name: "api-token", kind: "api-key", fields: { value: token }, hosts, ...item }, "cli");
  const card = (await h.v.card()).card;
  return { o, h, token, card };
}

test("tickets: signed, for one holder, pinned owner; an agent's accept waits; another owner cannot take the pass id", async t => {
  const { o, h, card, token } = await pair(t);
  const made = await o.v.createPass({ holder: "teammate", card, items: ["api-token"] }, "cli");
  assert.ok(!made.ticket.includes(token));

  const asked = await h.v.accept({ ticket: made.ticket }, "mcp");
  assert.ok("pending" in asked);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM vault_held").get()?.n, 0);
  assert.equal(h.v.pending().accepts[0].owner, "owner-box");
  const ok = await h.v.approve({ id: /** @type {any} */ (asked).pending.id }, "cli");
  assert.deepEqual(ok.approved.items, ["api-token"]);
  assert.equal(h.v.share.people().people[0].name, "owner-box", "accepting pinned the owner");

  // Someone else, calling themselves owner-box, issues a ticket with the same pass id.
  const mallory = mk(t, "owner-box");
  mallory.v.relayUrl = "https://relay.acme.test";
  await mallory.v.put({ name: "api-token", kind: "api-key", fields: { value: fake("m") }, hosts: ["https://api.example.com"] }, "cli");
  await mallory.v.share.addPerson({ card, name: "teammate" }, "cli");
  const theirs = await mallory.v.createPass({ holder: "teammate", items: ["api-token"] }, "cli");
  mallory.db.prepare("UPDATE vault_passes SET id=? WHERE id=?").run(made.pass.id, theirs.pass.id);
  mallory.v.sign("vault_passes", made.pass.id); // mallory controls their own vyred, MAC key included
  const forged = await mallory.v.issue(made.pass.id);
  await assert.rejects(h.v.accept({ ticket: forged.ticket }, "cli"), /not the one pinned for owner-box/);
  const held = h.db.prepare("SELECT * FROM vault_held").all();
  assert.equal(held.length, 1);
  assert.equal(held[0].relay, "http://127.0.0.1:9", "the held pass still points at the real owner");

  // A ticket made for someone else is refused before anything is pinned.
  const other = mk(t, "other-box");
  await o.v.share.addPerson({ card: (await other.v.card()).card, name: "other" }, "cli");
  const notMine = await o.v.createPass({ holder: "other", items: ["api-token"] }, "cli");
  await assert.rejects(h.v.accept({ ticket: notMine.ticket }, "cli"), /made for another Vyre/);
  assert.ok(!visible(o).includes(token) && !visible(h).includes(token));
});

/** Sign a relay request as the holder and hand it to the owner's handler directly. */
async function relayAs(x, passId, request, item = "api-token") {
  const me = await x.h.v.identity();
  return x.o.v.onRelay(relay.envelope({ pass: passId, item, request, privDer: me.sign.private, aud: x.o.v.relayUrl }));
}

test("relay: headers only unless relay.body, method and path allowlists, https off loopback, audience", async t => {
  // A loopback upstream that echoes what it got, so a leak would show.
  const seen = [];
  const api = http.createServer((req, res) => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => { seen.push({ url: req.url, body: b }); res.end(JSON.stringify({ auth: req.headers.authorization, body: b })); }); });
  await new Promise(r => api.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => api.close());
  const up = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}`;
  const x = await pair(t, { hosts: [up, "http://api.example.com"] });
  const pass = (await x.o.v.createPass({ holder: "teammate", card: x.card, items: ["api-token"], methods: ["get", "POST"], paths: ["/v1/"] }, "cli")).pass;
  assert.deepEqual(pass.methods, ["GET", "POST"]);

  const hdr = await relayAs(x, pass.id, { url: `${up}/v1/charges`, headers: { authorization: "Bearer {{vault}}" } });
  assert.equal(hdr.status, 200, JSON.stringify(hdr.body));
  assert.equal(JSON.parse(hdr.body.data.body).auth, "Bearer <concealed by vyre>");

  const inBody = await relayAs(x, pass.id, { method: "POST", url: `${up}/v1/gists`, body: '{"content":"{{vault}}"}' });
  assert.equal(inBody.status, 403);
  assert.match(inBody.body.error.message, /headers only/);
  assert.ok(!seen.some(s => s.body.includes(x.token)), "the value never went out in a body");

  assert.match((await relayAs(x, pass.id, { method: "DELETE", url: `${up}/v1/charges` })).body.error.message, /only GET, POST/);
  assert.match((await relayAs(x, pass.id, { url: `${up}/v2/admin`, headers: { a: "{{vault}}" } })).body.error.message, /only paths under \/v1\//);
  assert.match((await relayAs(x, pass.id, { url: "http://api.example.com/v1/x", headers: { a: "{{vault}}" } })).body.error.message, /https only/);

  // Allowing the body is the item's choice, stored with its hosts.
  await x.o.v.share.setRelayRules("api-token", { body: true });
  const allowed = await relayAs(x, pass.id, { method: "POST", url: `${up}/v1/tokens`, body: '{"k":"{{vault}}"}' });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body.data.body).body, '{"k":"<concealed by vyre>"}');
  await assert.rejects(x.o.v.share.setRelayRules("api-token", { headers: false }), /the one rule is relay.body/);

  // Signed for another relay.
  const me = await x.h.v.identity();
  const elsewhere = await x.o.v.onRelay(relay.envelope({ pass: pass.id, item: "api-token", request: { url: `${up}/v1/x` }, privDer: me.sign.private, aud: "https://relay.acme.test" }));
  assert.match(elsewhere.body.error.message, /another relay/);

  // A replayed envelope is refused by a fresh Share over the same database (a restart).
  const env = relay.envelope({ pass: pass.id, item: "api-token", request: { url: `${up}/v1/x` }, privDer: me.sign.private, aud: x.o.v.relayUrl });
  assert.equal((await x.o.v.onRelay(env)).status, 200);
  x.o.v.share = new Share(x.o.v);
  assert.match((await x.o.v.onRelay(env)).body.error.message, /replayed nonce/);
  assert.ok(!visible(x.o).includes(x.token));
});

test("relay: an unreachable upstream says nothing specific; unknown passes write one audit row a minute", async t => {
  const x = await pair(t, { hosts: ["http://127.0.0.1:1"] });
  const pass = (await x.o.v.createPass({ holder: "teammate", card: x.card, items: ["api-token"] }, "cli")).pass;
  const down = await relayAs(x, pass.id, { url: "http://127.0.0.1:1/x", headers: { a: "{{vault}}" } });
  assert.equal(down.status, 502);
  assert.equal(down.body.error.message, "the request to the upstream failed");

  const before = x.o.db.prepare("SELECT COUNT(*) AS n FROM vault_audit").get()?.n;
  for (let i = 0; i < 50; i++) await x.o.v.onRelay({ pass: "p_nobody", item: "api-token" });
  for (let i = 0; i < 5; i++) await x.o.v.onRelay({ pass: "p_other" });
  await x.o.v.onRelay(null);
  const rows = x.o.db.prepare("SELECT * FROM vault_audit WHERE who LIKE 'pass:unknown%'").all();
  assert.equal(Number(x.o.db.prepare("SELECT COUNT(*) AS n FROM vault_audit").get()?.n) - Number(before), 3);
  assert.deepEqual(rows.map(r => r.who).sort(), ["pass:unknown:?", "pass:unknown:p_nobody", "pass:unknown:p_other"]);
});
