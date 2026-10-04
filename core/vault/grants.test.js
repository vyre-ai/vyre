// @ts-check
// grants tests: vault.relay.grants (ADR 0014, part 7). With "require", a relayed request also
// needs the tailnet policy to grant the calling peer vyre.run/cap/vault for the item, and the
// grant only ever narrows: a revoked, expired or another person's pass stays refused whatever
// the policy says. Also the warning on a new pass, the whois meta, and vault.grants.status
// against a fake tailscale binary. Every vault lives under the checkout's scratch dir.

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
import { whoisMeta } from "./index.js";
import { recorded } from "./testing.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { tempHome } from "../../test/helpers.js";

const DANA = "dana@northwind.example";
const CAP = "vyre.run/cap/vault";
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
/** A whois answer for Dana's shared-in node carrying these vault grants. */
const peer = grants => ({ login: DANA, node: "dana-mac.tail0000.ts.net", stableId: "nDANA", tags: [], caps: grants ? { [CAP]: grants } : {} });

function mk(t, name, vault = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-grants-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file", ...vault } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { v, db };
}

/** A loopback upstream, an owner (alex's box) with two items, and Dana's card carrying her login. */
async function world(t, grants = "require") {
  const api = http.createServer((req, res) => res.end(JSON.stringify({ auth: req.headers.authorization || null })));
  await new Promise(r => api.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => api.close());
  const up = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}`;
  const o = mk(t, "alex-box", { relay: { identity: "whois", grants } }), h = mk(t, "dana-box", { login: DANA });
  o.v.relayUrl = "http://127.0.0.1:9";
  const token = fake("token");
  for (const name of ["northwind-api", "harlow-portal"]) await o.v.put({ name, kind: "api-key", fields: { value: token }, hosts: [up] }, "cli");
  const card = (await h.v.card()).card;
  const pass = async (items = ["northwind-api", "harlow-portal"], more = {}) => (await o.v.createPass({ holder: "Dana", card, items, ...more }, "cli"));
  /** Dana's signed request, arriving with the meta the whois listener would give it. */
  const ask = async (id, item, who) => {
    const me = await h.v.identity();
    const env = relay.envelope({ pass: id, item, request: { url: `${up}/v1/x`, headers: { authorization: "Bearer {{vault}}" } }, privDer: me.sign.private, aud: o.v.relayUrl });
    return o.v.onRelay(env, who === undefined ? { login: DANA, peer: peer(null) } : who ? { login: who.login, peer: who } : { login: DANA });
  };
  const audits = () => /** @type {any[]} */ (o.db.prepare("SELECT * FROM vault_audit WHERE action='relay' ORDER BY rowid").all());
  return { o, h, token, card, pass, ask, audits };
}

test("grantCovers: exact names and trailing-* prefixes in the matching mode or any; junk grants nothing", () => {
  const who = g => ({ caps: { [CAP]: g } });
  assert.ok(relay.grantCovers(who([{ items: ["harlow-portal"], mode: "relayed" }]), "harlow-portal", "relayed"));
  assert.ok(relay.grantCovers(who([{ items: ["northwind-*"], mode: "relayed" }]), "northwind-api", "relayed"));
  assert.ok(relay.grantCovers(who([{ items: ["northwind-*"], mode: "any" }]), "northwind-api", "relayed"));
  assert.ok(!relay.grantCovers(who([{ items: ["northwind-*"], mode: "sealed" }]), "northwind-api", "relayed"));
  assert.ok(!relay.grantCovers(who([{ items: ["northwind"], mode: "any" }]), "northwind-api", "relayed"), "no star, no prefix");
  assert.ok(!relay.grantCovers(who([{ items: ["north*wind"], mode: "any" }]), "northXwind", "relayed"), "a star is only trailing");
  assert.ok(!relay.grantCovers(who([{ items: ["northwind-*"] }, { mode: "any" }, { items: "northwind-api", mode: "any" }, { items: [""], mode: "any" }, null, "x"]), "northwind-api", "relayed"));
  assert.ok(!relay.grantCovers(null, "northwind-api", "relayed"));
  assert.ok(!relay.grantCovers({ caps: { "vyre.run/cap/guest": [{ items: ["*"], mode: "any" }] } }, "northwind-api", "relayed"), "another capability grants nothing here");
});

test("whois meta: login and peer come from whois alone; a tagged node has no login; no answer, no peer", () => {
  const forged = { remoteAddress: "100.64.0.9", login: "alex@example.com" };
  const m = whoisMeta(forged, { login: DANA, node: "dana-mac.tail0000.ts.net", stableId: "nDANA", tagged: false, tags: [], caps: { [CAP]: [{ items: ["northwind-*"], mode: "relayed" }] } });
  assert.equal(m.login, DANA);
  assert.deepEqual(m.peer, { login: DANA, node: "dana-mac.tail0000.ts.net", stableId: "nDANA", tags: [], caps: { [CAP]: [{ items: ["northwind-*"], mode: "relayed" }] } });
  const tagged = whoisMeta(forged, { login: null, node: "box.tail0000.ts.net", stableId: "nBOX", tagged: true, tags: ["tag:vyre"], caps: {} });
  assert.equal(tagged.login, null);
  assert.deepEqual(tagged.peer.tags, ["tag:vyre"]);
  const none = whoisMeta(forged, null);
  assert.equal(none.login, null);
  assert.ok(!("peer" in none));
});

test("grants off: relaying is unchanged, with no caps at all", async t => {
  const x = await world(t, "off");
  assert.equal(x.o.v.relayGrants, "off");
  const { pass, warning } = await x.pass();
  assert.equal(warning, undefined, "no warning while grants are off");
  const r = await x.ask(pass.id, "northwind-api");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.parse(r.body.data.body).auth, "Bearer <concealed by vyre>");
  // Without whois (no peer at all) and no grants config key, the same.
  assert.equal((await x.ask(pass.id, "harlow-portal", null)).status, 200);
});

test("grants require: a matching grant (exact or prefix) passes; no cap, another item or another mode is refused and audited", async t => {
  const x = await world(t);
  const { pass } = await x.pass();
  const ok = await x.ask(pass.id, "northwind-api", peer([{ items: ["northwind-*"], mode: "relayed" }]));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await x.ask(pass.id, "harlow-portal", peer([{ items: ["harlow-portal"], mode: "any" }]))).status, 200);

  const cases = [
    [peer(null), "northwind-api"],
    [peer([{ items: ["harlow-*"], mode: "relayed" }]), "northwind-api"],
    [peer([{ items: ["northwind-*"], mode: "sealed" }]), "northwind-api"],
    [peer([{ items: ["northwind-*"], mode: "relayed" }]), "harlow-portal"],
  ];
  for (const [who, item] of cases) {
    const r = await x.ask(pass.id, item, who);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error.message, `the tailnet policy does not grant ${DANA} ${CAP} for ${item} (relayed)`);
    const row = x.audits().at(-1);
    assert.equal(row.ok, 0);
    assert.equal(row.name, item);
    assert.equal(row.why, r.body.error.message);
    assert.ok(!JSON.stringify(r.body).includes(x.token));
  }
  // No whois answer at all (another identity mode): nothing carries caps, so nothing passes.
  assert.match((await x.ask(pass.id, "northwind-api", null)).body.error.message, /does not grant dana@northwind.example/);
});

test("grants require: a grant never makes a revoked, expired, unlisted or another person's pass work", async t => {
  const x = await world(t);
  const all = peer([{ items: ["*"], mode: "any" }]);
  const revoked = (await x.pass()).pass;
  x.o.v.revokePass({ id: revoked.id }, "cli");
  assert.equal((await x.ask(revoked.id, "northwind-api", all)).body.error.message, "this pass was revoked");

  const expired = (await x.pass()).pass;
  x.o.db.prepare("UPDATE vault_passes SET expires=? WHERE id=?").run(Date.now() - 1000, expired.id);
  x.o.v.sign("vault_passes", expired.id);
  assert.equal((await x.ask(expired.id, "northwind-api", all)).body.error.message, "this pass has expired");

  const narrow = (await x.pass(["northwind-api"])).pass;
  assert.equal((await x.ask(narrow.id, "harlow-portal", all)).body.error.message, "harlow-portal is not in this pass");

  const other = { ...all, login: "someone@harlow.example" };
  assert.equal((await x.ask(narrow.id, "northwind-api", other)).body.error.message, "this pass belongs to another Tailscale user");
  assert.equal((await x.ask(narrow.id, "northwind-api", all)).status, 200, "the same pass, the right person and a grant");
});

test("a new pass with grants required warns when the policy does not cover it yet, and is made anyway", async t => {
  const x = await world(t);
  const first = await x.pass(["northwind-api"]);
  assert.ok(first.ticket && first.pass.status === "active", "the pass is made");
  assert.equal(first.warning, `the tailnet policy does not grant ${DANA} ${CAP} for northwind-api yet; relayed requests will be refused until it does`);
  // A sealed pass never meets the relay, so there is nothing to warn about.
  assert.equal((await x.pass(["northwind-api"], { mode: "sealed" })).warning, undefined);

  // Dana's next request arrives carrying a grant for northwind-* only: that is what is remembered.
  await x.ask(first.pass.id, "northwind-api", peer([{ items: ["northwind-*"], mode: "relayed" }]));
  assert.equal((await x.pass(["northwind-api"])).warning, undefined);
  assert.match(String((await x.pass(["northwind-api", "harlow-portal"])).warning), /for harlow-portal yet;/);
});

/** A fake tailscale: Dana's shared-in node is online, and whois of it carries `caps`. */
function fakeTailscale(t, caps) {
  const home = tempHome(t);
  const bin = path.join(home, "tailscale");
  const status = { BackendState: "Running", Self: { ID: "nBOX", HostName: "box", DNSName: "box.tail0000.ts.net.", TailscaleIPs: ["100.64.0.5"], UserID: 1 },
    User: { 1: { LoginName: "alex@example.com" }, 7: { LoginName: DANA } },
    Peer: { k1: { ID: "nDANA", HostName: "dana-mac", DNSName: "dana-mac.tail0000.ts.net.", TailscaleIPs: ["100.64.0.9"], Online: true, UserID: 7 } } };
  const whoisOut = { Node: { StableID: "nDANA", Name: "dana-mac.tail0000.ts.net." }, UserProfile: { LoginName: DANA }, CapMap: caps };
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "status") process.stdout.write(${JSON.stringify(JSON.stringify(status))});
else if (a[0] === "whois" && a.at(-1) === "100.64.0.9") process.stdout.write(${JSON.stringify(JSON.stringify(whoisOut))});
else process.exit(1);
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
}

test("vault.grants.status: the mode, and per holder whether their caps cover their passes, by whois now", async t => {
  fakeTailscale(t, { [CAP]: [{ items: ["northwind-*"], mode: "relayed" }] });
  const { run } = await recorded(t, { relay: { host: "127.0.0.1", port: 0, identity: "whois", grants: "require" } });
  const h = mk(t, "dana-box", { login: DANA });
  const card = (await h.v.card()).card;
  for (const name of ["northwind-api", "harlow-portal"]) await run("vault.put", { name, kind: "api-key", value: fake("v"), hosts: ["https://api.example.com"] });

  // Dana is online now, so the warning comes from whois: covered for northwind-api, not harlow-portal.
  const covered = await run("vault.pass.create", { holder: "Dana", card, items: ["northwind-api"] });
  assert.equal(covered.warning, undefined);
  const gap = await run("vault.pass.create", { holder: "Dana", items: ["harlow-portal"] });
  assert.match(gap.warning, /does not grant dana@northwind.example vyre.run\/cap\/vault for harlow-portal yet/);

  const s = await run("vault.grants.status", {});
  assert.equal(s.mode, "require");
  assert.equal(s.people.length, 1);
  const dana = s.people[0];
  assert.equal(dana.login, DANA);
  assert.equal(dana.seen, "whois");
  assert.deepEqual(dana.grants, [{ items: ["northwind-*"], mode: "relayed" }]);
  assert.equal(dana.covered, false);
  assert.deepEqual(dana.passes.map(p => [p.items, p.covered, p.missing]), [[["northwind-api"], true, undefined], [["harlow-portal"], false, ["harlow-portal"]]]);

  // Revoked passes drop out; an agent caller is not the owner.
  await run("vault.pass.revoke", { id: gap.pass.id });
  assert.equal((await run("vault.grants.status", {})).people[0].covered, true);
  await assert.rejects(run("vault.grants.status", {}, "mcp agent:kit"), /for the owner, not an agent/);
});

test("vault.grants.status with grants off and no one online: the mode, and nothing known about caps", async t => {
  const { run } = await recorded(t);
  const s = await run("vault.grants.status", {});
  assert.deepEqual(s, { mode: "off", identity: null, people: [] });
});
