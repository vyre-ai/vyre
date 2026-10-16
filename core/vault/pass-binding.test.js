// @ts-check
// A relayed pass binds to its holder's identity key and the signed, single-use, audience-bound request, and to nothing on a network: no VPN login, no policy grant (the Tailscale binding was removed).
// A request from anyone else, with any meta a listener might once have attached, gets nothing; a revoked, expired or unlisted pass stays refused. Every vault lives under the checkout's scratch dir.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as relay from "./relay.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

function mk(t, name, vault = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-pass-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file", ...vault } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { v, db };
}

/** A loopback upstream, an owner (alex's box) with two items, and Dana's card. */
async function world(t) {
  const api = http.createServer((req, res) => res.end(JSON.stringify({ auth: req.headers.authorization || null })));
  await new Promise(r => api.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => api.close());
  const up = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}`;
  const o = mk(t, "alex-box"), h = mk(t, "dana-box"), stranger = mk(t, "mallory-box");
  o.v.relayUrl = "http://127.0.0.1:9";
  const token = fake("token");
  for (const name of ["northwind-api", "harlow-portal"]) await o.v.put({ name, kind: "api-key", fields: { value: token }, hosts: [up] }, "cli");
  const card = (await h.v.card()).card;
  const pass = async (items = ["northwind-api", "harlow-portal"], more = {}) => (await o.v.createPass({ holder: "Dana", card, items, ...more }, "cli"));
  /** A signed request by `from`'s identity (Dana's by default), with whatever meta the listener hands over. */
  const ask = async (id, item, meta = {}, from = h) => {
    const me = await from.v.identity();
    const env = relay.envelope({ pass: id, item, request: { url: `${up}/v1/x`, headers: { authorization: "Bearer {{vault}}" } }, privDer: me.sign.private, aud: o.v.relayUrl });
    return o.v.onRelay(env, meta);
  };
  const audits = () => /** @type {any[]} */ (o.db.prepare("SELECT * FROM vault_audit WHERE action='relay' ORDER BY rowid").all());
  return { o, h, stranger, token, card, pass, ask, audits };
}

test("a relayed pass works for its holder, and the value never comes back", async t => {
  const x = await world(t);
  const made = await x.pass();
  assert.equal(made.warning, undefined, "there is no network policy to warn about");
  const r = await x.ask(made.pass.id, "northwind-api");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.parse(r.body.data.body).auth, "Bearer <concealed by vyre>");
  assert.ok(!JSON.stringify(r.body).includes(x.token));
});

test("a pass binds to the holder's key: another identity's signed request is refused, whatever meta rides with it", async t => {
  const x = await world(t);
  const { pass } = await x.pass();
  // the shapes a VPN-aware listener used to attach: a login and a peer with capabilities. They decide nothing now, for the holder or for anyone.
  const vpn = { login: "dana@northwind.example", peer: { login: "dana@northwind.example", node: "dana-mac", caps: { "vyre.run/cap/vault": [{ items: ["*"], mode: "any" }] } } };
  assert.equal((await x.ask(pass.id, "northwind-api", vpn)).status, 200, "the holder, with or without a login in the meta");
  const r = await x.ask(pass.id, "northwind-api", vpn, x.stranger);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  const row = x.audits().at(-1);
  assert.equal(row.ok, 0);
  assert.ok(!JSON.stringify(r.body).includes(x.token));
  // a grant that used to widen anything is not there: no capability helper is exported
  assert.equal(typeof /** @type {any} */ (relay).grantCovers, "undefined");
  assert.equal(typeof /** @type {any} */ (relay).checkBind, "undefined");
});

test("a revoked, expired or unlisted pass stays refused for its holder", async t => {
  const x = await world(t);
  const revoked = (await x.pass()).pass;
  x.o.v.revokePass({ id: revoked.id }, "cli");
  assert.equal((await x.ask(revoked.id, "northwind-api")).body.error.message, "this pass was revoked");
  const expired = (await x.pass()).pass;
  x.o.db.prepare("UPDATE vault_passes SET expires=? WHERE id=?").run(Date.now() - 1000, expired.id);
  x.o.v.sign("vault_passes", expired.id);
  assert.equal((await x.ask(expired.id, "northwind-api")).body.error.message, "this pass has expired");
  const narrow = (await x.pass(["northwind-api"])).pass;
  assert.equal((await x.ask(narrow.id, "harlow-portal")).body.error.message, "harlow-portal is not in this pass");
  assert.equal((await x.ask(narrow.id, "northwind-api")).status, 200, "the same pass, the right holder");
});

test("vault.grants.status names who holds a live pass and for what, with no login or capability", async t => {
  const x = await world(t);
  const { pass } = await x.pass(["northwind-api"]);
  const s = await x.o.v.grantsStatus();
  assert.deepEqual(s, { people: [{ holder: "Dana", passes: [{ id: pass.id, items: ["northwind-api"], mode: "relayed" }] }] });
  assert.ok(!JSON.stringify(s).includes(x.token));
  x.o.v.revokePass({ id: pass.id }, "cli");
  assert.deepEqual((await x.o.v.grantsStatus()).people, []);
});
