// @ts-check
// Release grants (core/vault/release.js): which module may be handed which item, on the one grant model, in both homes of it. On a server the grants are the kernel's (a real grants store behind
// core/vault/kernel-rig.js); in vyre-core they are the same grants in the vault's own table. The same questions get the same answers in both, and an older vault_grants row becomes the grant it always was.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { kernelRig } from "./kernel-rig.js";
import { rowMac } from "./crypto.js";
import { matchGrant } from "../../kernel/core/authorize.js";
import { SCRATCH } from "../../test/scratch.mjs";

/** A vault with two items, in a home with a kernel (`server`) or without (vyre-core's). */
async function mk(t, server) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-release-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = server ? await kernelRig() : null;
  const events = /** @type {any[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, ...(rig ? { clock: rig.clock } : {}) });
  if (rig) v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await v.put({ name: "stripe", kind: "api-key", fields: { value: "fixture-1" } }, "cli");
  await v.put({ name: "mailgun", kind: "api-key", fields: { value: "fixture-2" } }, "cli");
  return { v, db, rig, events };
}
const HOMES = [["a server (kernel grants)", true], ["vyre-core (its own table)", false]];

for (const [label, server] of HOMES) {
  test(`release, ${label}: a module holds exactly the item it was given; a watcher's grant is its own; a project narrows it`, async t => {
    const { v } = await mk(t, server);
    await v.grant({ name: "stripe", module: "billing" }, "cli");
    await v.grant({ name: "stripe", module: "watchers", watcher: "invoices" }, "cli");
    await v.grant({ name: "mailgun", module: "mail", project: "northwind" }, "cli");
    assert.equal(v.granted({ name: "stripe", module: "billing" }), true);
    assert.equal(v.granted({ name: "stripe", module: "mail" }), false, "another module");
    assert.equal(v.granted({ name: "mailgun", module: "billing" }), false, "another item");
    assert.equal(v.granted({ name: "stripe", module: "watchers" }), false, "a watcher's grant is not the module's");
    assert.equal(v.granted({ name: "stripe", module: "watchers", watcher: "invoices" }), true);
    assert.equal(v.granted({ name: "stripe", module: "watchers", watcher: "other" }), false, "exactly that watcher");
    assert.equal(v.granted({ name: "stripe", module: "billing", watcher: "invoices" }), false, "the module's grant is not a watcher's");
    assert.equal(v.granted({ name: "mailgun", module: "mail", project: "northwind" }), true);
    assert.equal(v.granted({ name: "mailgun", module: "mail", project: "harlow" }), false, "another project");
    assert.equal(v.granted({ name: "mailgun", module: "mail" }), true, "a caller with no project is not narrowed");
    assert.deepEqual(v.list().items.find(i => i.name === "stripe").grants.map(g => [g.module, g.watcher || ""]).sort(), [["billing", ""], ["watchers", "invoices"]]);
    // twice is once
    await v.grant({ name: "stripe", module: "billing" }, "cli");
    assert.equal(v.releases.views().filter(g => g.item === "stripe" && g.module === "billing").length, 1);
  });

  test(`release, ${label}: revoking takes it away, a request waits without authority until a person approves it, and deleting the item takes every grant with it`, async t => {
    const { v, db } = await mk(t, server);
    await v.grant({ name: "stripe", module: "billing" }, "cli");
    assert.deepEqual(await v.revoke({ name: "stripe", module: "billing" }, "cli"), { revoked: 1 });
    assert.equal(v.granted({ name: "stripe", module: "billing" }), false);
    const asked = (await v.grant({ name: "stripe", module: "mail" }, "mcp agent:kit")).grant;
    assert.equal(asked.status, "pending");
    assert.equal(v.granted({ name: "stripe", module: "mail" }), false, "a request is not a grant");
    assert.deepEqual(v.pending().grants.map(g => [g.id, g.module, g.status]), [[asked.id, "mail", "pending"]]);
    assert.deepEqual(await v.revoke({ name: "stripe", module: "mail" }, "mcp agent:juno", { onlyPendingBy: "mcp agent:juno" }), { revoked: 0 }, "not another's request");
    assert.equal((await v.approve({ id: asked.id }, "cli")).approved.status, "active");
    assert.equal(v.granted({ name: "stripe", module: "mail" }), true);
    assert.equal(v.pending().grants.length, 0);
    await v.grant({ name: "stripe", module: "watchers", watcher: "w" }, "cli");
    v.remove({ name: "stripe" }, "cli");
    await Promise.all(v.revoking);
    assert.equal(v.releases.views().filter(g => g.item === "stripe").length, 0);
    await v.put({ name: "stripe", kind: "api-key", fields: { value: "fixture-3" } }, "cli");
    assert.equal(v.granted({ name: "stripe", module: "mail" }), false, "an item made again under the name inherits nothing");
    assert.ok(db);
  });
}

test("release: on a server a release is a kernel grant in the kernel's shape, and the kernel's own authorizer says what the vault says", async t => {
  const { v, rig } = await mk(t, true);
  await v.grant({ name: "stripe", module: "billing" }, "cli");
  const g = (await rig.gw.grants.list(rig.owner(), {})).find((/** @type {any} */ x) => x.source === "install:billing:vault");
  assert.deepEqual([g.subject.actor.kind, g.subject.actor.id, g.actions], ["service", "billing", ["vault.release"]]);
  assert.match(g.resource.prefix, /\/vault\/vault_[^/]+\/item\/stripe$/);
  const module = (/** @type {string} */ m) => rig.chains.fromFacts({ kind: "module", module: m, first_party: true });
  assert.equal((await rig.gw.authorize({ chain: module("billing"), action: "vault.release", resource: g.resource.prefix })).effect, "allow");
  assert.notEqual((await rig.gw.authorize({ chain: module("mail"), action: "vault.release", resource: g.resource.prefix })).effect, "allow");
  assert.notEqual((await rig.gw.authorize({ chain: module("billing"), action: "vault.release", resource: g.resource.prefix.replace("/stripe", "/mailgun") })).effect, "allow");
});

test("release: the older table is converted in place: a row that passes its older check becomes its grant, one that fails goes, a waiting request becomes a request", async t => {
  for (const [, server] of HOMES) {
    const { v, db, rig } = await mk(t, server);
    await v.key();
    const legacy = (/** @type {string} */ id, /** @type {string} */ module, /** @type {string} */ status, /** @type {string} */ watcher = "") => {
      db.prepare("INSERT INTO vault_grants (id, item, module, watcher, status, by, at, project) VALUES (?,?,?,?,?,?,?,?)").run(id, "stripe", module, watcher, status, "cli", 5, "");
      db.prepare("UPDATE vault_grants SET mac = ? WHERE id = ?").run(rowMac(/** @type {any} */ (v.mkey), "vault_grants", { id, item: "stripe", module, watcher, status }), id);
    };
    legacy("g_one", "billing", "active");
    legacy("g_two", "watchers", "active", "invoices");
    legacy("g_ask", "mail", "pending");
    legacy("g_bad", "evil", "active");
    db.prepare("UPDATE vault_grants SET module = 'edited' WHERE id = 'g_bad'").run();
    assert.equal(await v.releases.convert(), 4);
    assert.equal(v.granted({ name: "stripe", module: "billing" }), true);
    assert.equal(v.granted({ name: "stripe", module: "watchers", watcher: "invoices" }), true);
    assert.equal(v.granted({ name: "stripe", module: "mail" }), false, "a request is not a grant");
    assert.equal(v.granted({ name: "stripe", module: "edited" }), false);
    assert.equal(v.granted({ name: "stripe", module: "evil" }), false);
    assert.deepEqual(v.pending().grants.map(g => g.module), ["mail"]);
    assert.equal(Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM vault_grants WHERE body IS NULL").get()).n), 0, "nothing is left in the older shape");
    if (rig) assert.equal((await rig.gw.grants.list(rig.owner(), {})).filter((/** @type {any} */ x) => /^install:.*:vault$/.test(x.source)).length, 2);
    assert.equal(await v.releases.convert(), 0, "once");
  }
});

test("release: both homes answer every question alike, and both ask the one matcher of kernel/core/authorize.js", async t => {
  const a = await mk(t, true), b = await mk(t, false);
  const cases = [];
  for (const module of ["billing", "mail"]) for (const watcher of ["", "w"]) for (const project of ["", "p", "q"]) cases.push({ module, watcher, project });
  for (const h of [a, b]) {
    await h.v.grant({ name: "stripe", module: "billing" }, "cli");
    await h.v.grant({ name: "stripe", module: "billing", watcher: "w" }, "cli");
    await h.v.grant({ name: "stripe", module: "mail", project: "p" }, "cli");
  }
  for (const c of cases) assert.equal(a.v.granted({ name: "stripe", ...c, project: c.project || undefined }), b.v.granted({ name: "stripe", ...c, project: c.project || undefined }), JSON.stringify(c));
  // the matcher itself: an expired or not-yet grant, or another action, matches nothing
  const g = b.v.releases.grants()[0];
  const res = g.resource.prefix;
  assert.equal(matchGrant(g, "vault.release", res, { now: 1, since: 0, risk: "write" }).ok, true);
  assert.equal(matchGrant({ ...g, conditions: { when: { expires: 5 } } }, "vault.release", res, { now: 9, since: 0, risk: "write" }).ok, false);
  assert.equal(matchGrant(g, "vault.reveal", res, { now: 1, since: 0, risk: "admin" }).ok, false);
});
