// @ts-check
// agent grants tests (ADR 0028, decision 2, on the one grant model): one agent, one login, one origin, and the grant is a KERNEL grant (a real grants store behind core/vault/kernel-rig.js).
// A person's lending is active at once, Claude's waits for vault.approve, the origin must be exactly one of the login's hosts, expired and revoked grants are out of force, deleting the login
// revokes its grants, the older vault's own table is carried over once (a row that fails its check is not), and vault.uses reads every use back by agent and item. Nothing a tool, an event or an
// audit row carries holds the password or the username. Every vault lives under the checkout's scratch dir.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { register } from "./tools/agents.js";
import { day, exactOrigin } from "./agents.js";
import { recorded } from "./testing.js";
import { Access } from "./access.js";
import { kernelRig } from "./kernel-rig.js";
import { SCRATCH } from "../../test/scratch.mjs";

const APP = "https://app.northwind.test", SSO = "https://sso.northwind.test:8443";
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

/** A vault with one login lent-able to agents, one api key, a real kernel behind it, and the agent tools on a map. */
async function mk(t, clock = undefined) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-agent-grants-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig(clock ? { clock } : {});
  /** @type {{ type: string, p: any }[]} */
  const events = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const password = fake("password"), username = `alex.${crypto.randomBytes(6).toString("hex")}@harlow.test`;
  await v.put({ name: "harlow-drive", kind: "login", fields: { username, password }, url: `${APP}/login`, hosts: [APP, SSO] }, "cli");
  await v.put({ name: "northwind-api", kind: "api-key", fields: { value: fake("token") }, hosts: [APP] }, "cli");
  /** @type {Map<string, any>} */
  const tools = new Map();
  register({ vault: v, tool: (name, callers, description, input, run, needs) => tools.set(name, { callers, description, input, run, presence: needs }) });
  /** @type {any[]} */
  const seen = [];
  const run = async (name, input, caller = "cli") => { const r = await tools.get(name).run(input, { caller }); seen.push(r); return r; };
  const expiry = ms => rig.clock() + ms;
  return { v, db, events, tools, run, seen, password, username, rig, expiry };
}

test("exact origins and the summary's day", () => {
  assert.equal(exactOrigin(APP), APP);
  assert.equal(exactOrigin(APP + "/"), APP);
  for (const bad of [`${APP}/login`, `${APP}?x=1`, `${APP}#a`, "https://alex@app.northwind.test", "ftp://app.northwind.test", "app.northwind.test", "", null, 7]) assert.equal(exactOrigin(bad), null, String(bad));
  assert.equal(day(Date.UTC(2026, 9, 1, 12), Date.UTC(2026, 8, 27)), "1 Oct");
  assert.equal(day(Date.UTC(2027, 0, 5, 12), Date.UTC(2026, 8, 27)), "5 Jan 2027");
});

test("a person lends a login: a kernel grant at once, one agent, fill, one exact origin, audited and announced with names only", async t => {
  const { v, db, events, tools, run, rig, expiry } = await mk(t);
  const until = expiry(3 * 86400_000);
  const summary = await tools.get("vault.agent.grant").presence.summary({ agent: "kit", item: "harlow-drive", origin: APP, expires: until });
  assert.equal(summary, `Let kit sign in to ${APP} as harlow-drive until ${day(until)}`);
  assert.equal(tools.get("vault.agent.grant").presence.skip({ caller: "mcp agent:kit" }), true);
  assert.equal(tools.get("vault.agent.grant").presence.skip({ caller: "cli" }), false);
  assert.deepEqual(tools.get("vault.agent.grant").callers, ["cli", "local", "deck", "capsule", "mcp"]);
  for (const n of ["vault.agent.grants", "vault.agent.revoke", "vault.uses"]) assert.equal(tools.get(n).presence, undefined, `${n} needs no person`);

  const { grant } = await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: until });
  assert.match(grant.id, /^gr_/, "the id is the kernel grant's");
  assert.deepEqual({ ...grant, id: undefined }, { id: undefined, agent: "kit", item: "harlow-drive", origin: APP, expires: until, status: "active" });
  const kernel = (await rig.gw.grants.list(rig.owner(), {})).find(g => g.id === grant.id);
  assert.equal(kernel.source, "vault:agent");
  assert.deepEqual([kernel.subject.actor.kind, kernel.subject.actor.id, kernel.actions, kernel.conditions], ["agent", "agt_kit", ["vault.fill"], { where: { origins: [APP] }, when: { expires: until } }]);
  assert.match(kernel.resource.prefix, /\/vault\/vault_[^/]+\/item\/harlow-drive$/);
  assert.equal(Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM vault_agent_grants").get()).n), 0, "the vault keeps no table of it");
  assert.deepEqual(events.filter(e => e.type.startsWith("vault.agent")), [{ type: "vault.agent-granted", p: { agent: "kit", item: "harlow-drive", origin: APP } }]);
  const a = /** @type {any} */ (db.prepare("SELECT * FROM vault_audit WHERE action='agent-grant'").get());
  assert.deepEqual([a.name, a.who, a.origin, a.why], ["harlow-drive", "cli", APP, "agent:kit"]);
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), true);
  assert.equal(await v.access.allowed("juno", "harlow-drive", APP), false, "another agent has nothing");
  assert.equal(await v.access.allowed("kit", "harlow-drive", SSO), false, "another origin of the same login has nothing");
  assert.equal(await v.access.allowed("kit", "northwind-api", APP), false, "another item has nothing");
  // A second origin of the login is its own grant; the default expiry is 30 days.
  const sso = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: SSO + "/" })).grant;
  assert.notEqual(sso.id, grant.id);
  assert.equal(sso.origin, SSO);
  assert.ok(Math.abs(sso.expires - (Date.now() + 30 * 86400_000)) < 60_000);
  // Lending again from a person replaces it: one grant, the new expiry.
  const again = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: "7d" })).grant;
  assert.notEqual(again.id, grant.id);
  assert.notEqual(again.expires, until);
  assert.equal((await run("vault.agent.grants", { agent: "kit", item: "harlow-drive" })).grants.filter(g => g.origin === APP && g.status === "active").length, 1);
});

test("refused: a non-login, a missing item, a bad agent name, an unknown agent, a module, and any origin not exactly in the login's hosts", async t => {
  const { run, rig } = await mk(t);
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "northwind-api", origin: APP }), /is a api-key; an agent is lent only logins/);
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "no-such-login", origin: APP }), /no item named no-such-login/);
  await assert.rejects(run("vault.agent.grant", { agent: "Kit Agent", item: "harlow-drive", origin: APP }), /is not an agent name/);
  await assert.rejects(run("vault.agent.grant", { agent: "stranger", item: "harlow-drive", origin: APP }), /no agent named stranger/);
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP }, "module:mail"), /modules cannot lend logins/);
  for (const o of ["https://app.northwind.test.evil.test", "https://app-northwind.test", "https://northwind.test", `${APP}:8443`, "http://app.northwind.test", "https://sso.northwind.test"]) {
    await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: o }), /harlow-drive is not for /, o);
  }
  for (const o of [`${APP}/login`, `${APP}/?next=/`, "https://alex@app.northwind.test", "javascript:alert(1)"]) {
    await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: o }), /origin must be exactly a scheme, host and port/, o);
  }
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: Date.now() - 1000 }), /in the past/);
  assert.deepEqual((await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source === "vault:agent"), []);
});

test("from Claude a grant waits as pending; only vault.approve makes it a kernel grant", async t => {
  const { v, events, run, rig } = await mk(t);
  const { grant } = await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: "2d" }, "mcp agent:kit");
  assert.equal(grant.status, "pending");
  assert.match(grant.id, /^ag_/);
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), false, "a pending request is not in force");
  assert.deepEqual((await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source === "vault:agent"), [], "and the kernel has nothing yet");
  assert.deepEqual(events.filter(e => e.type === "grant.requested").map(e => e.p), [{ agent: "kit", item: "harlow-drive", origin: APP }]);
  assert.deepEqual(v.pending().agentGrants.map(g => [g.id, g.status, g.by]), [[grant.id, "pending", "mcp agent:kit"]]);
  assert.deepEqual((await run("vault.agent.grants", { agent: "kit" })).grants.map(g => g.status), ["pending"]);
  assert.deepEqual((await run("vault.agent.grants", {}, "mcp agent:kit")).grants, [], "a model sees what it may use, not what it asked for");

  const ok = await v.approve({ id: grant.id }, "cli");
  assert.equal(ok.approved.status, "active");
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), true);
  assert.equal(v.pending().agentGrants.length, 0);
  assert.deepEqual((await run("vault.agent.grants", {}, "mcp agent:kit")).grants, [{ item: "harlow-drive", origin: APP }]);
  assert.deepEqual(events.filter(e => e.type === "vault.agent-granted").map(e => e.p), [{ agent: "kit", item: "harlow-drive", origin: APP }]);
  await assert.rejects(v.approve({ id: grant.id }, "cli"), /nothing pending with id/);
  await assert.rejects(v.approve({ id: "ag_nothing" }, "cli"), /nothing pending with id/);
  // Claude asking again waits again (its request is a request; the grant in force is the person's).
  assert.equal((await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP }, "mcp agent:kit")).grant.status, "pending");
});

test("an expired grant is out of force and listed as expired; an expired request cannot be approved", async t => {
  let at = Date.now();
  const { v, run } = await mk(t, () => at);
  const { grant } = await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: at + 150 });
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), true);
  at += 250;
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), false);
  assert.deepEqual((await run("vault.agent.grants", {})).grants.map(g => [g.id, g.status]), [[grant.id, "expired"]]);
  const p = (await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: APP, expires: at + 150 }, "mcp agent:juno")).grant;
  at += 250;
  await assert.rejects(v.approve({ id: p.id }, "cli"), /expired before it was approved/);
});

test("revoke needs no one, from any caller; deleting the login revokes the rest", async t => {
  const { v, events, run } = await mk(t);
  const a = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant;
  await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: SSO });
  const r = await run("vault.agent.revoke", { id: a.id }, "mcp agent:kit");
  assert.equal(r.revoked, true);
  assert.equal(r.grant.status, "revoked");
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), false);
  await assert.rejects(run("vault.agent.revoke", { id: a.id }), /no agent grant/, "a grant already taken back is not there to take");
  await assert.rejects(run("vault.agent.revoke", { id: "ag_nothing" }), /no agent grant ag_nothing/);
  assert.deepEqual(events.filter(e => e.type === "vault.agent-revoked").map(e => e.p), [{ agent: "kit", item: "harlow-drive", origin: APP }]);
  // A revoked grant can be given again by a person.
  assert.equal((await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant.status, "active");

  v.remove({ name: "harlow-drive" }, "cli");
  await Promise.all(v.revoking);
  assert.equal((await run("vault.agent.grants", {})).grants.filter(g => g.status === "active").length, 0);
  assert.deepEqual(events.filter(e => e.type === "vault.agent-revoked").map(e => e.p.agent).sort(), ["juno", "kit", "kit"]);
  assert.equal(await v.access.allowed("juno", "harlow-drive", SSO), false);
  // and a login made again under that name inherits nothing
  await v.put({ name: "harlow-drive", kind: "login", fields: { username: "u", password: fake("pw") }, hosts: [APP, SSO] }, "cli");
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), false);
});

test("the older vault's own table is carried over once: a row that passes its check is the same grant, one that fails is dropped, and the table ends empty", async t => {
  const { v, db, rig, events, run, expiry } = await mk(t);
  await v.key();
  const until = expiry(5 * 86400_000);
  const put = (id, agent, origin, expires) => { db.prepare("INSERT INTO vault_agent_grants (id, item, agent, origin, expires, status, by, at) VALUES (?,?,?,?,?, 'active', 'cli', ?)").run(id, "harlow-drive", agent, origin, expires, 1); v.sign("vault_agent_grants", id); };
  put("ag_good", "kit", APP, until);
  put("ag_two", "juno", SSO, null);
  put("ag_tamper", "kit", SSO, until);
  db.prepare("UPDATE vault_agent_grants SET expires=expires + 86400000 WHERE id='ag_tamper'").run();
  db.prepare("INSERT INTO vault_agent_grants (id, item, agent, origin, expires, status, by, at) VALUES ('ag_planted','harlow-drive','kit',?,NULL,'active','cli',1)").run("https://planted.northwind.test");
  put("ag_unknown", "ghost", APP, until);
  await v.access.carry();
  const mine = (await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source === "vault:agent").map(g => [g.subject.actor.id, g.conditions.where.origins[0], g.conditions.when ? g.conditions.when.expires : null]).sort();
  assert.deepEqual(mine, [["agt_juno", SSO, null], ["agt_kit", APP, until]]);
  assert.equal(Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM vault_agent_grants").get()).n), 0);
  assert.equal(await v.access.allowed("kit", "harlow-drive", APP), true);
  assert.equal(await v.access.allowed("juno", "harlow-drive", SSO), true);
  assert.equal(await v.access.allowed("kit", "harlow-drive", SSO), false, "the row that failed its check gave nothing");
  assert.deepEqual(events.filter(e => e.type === "vault.agent-carried").map(e => e.p), [{ rows: 5, carried: 2 }]);
  // and again: nothing twice
  v.access.carried = false;
  await v.access.carry();
  assert.equal((await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source === "vault:agent").length, 2);
  // the old tool names answer as before
  assert.deepEqual((await run("vault.agent.grants", { agent: "kit" })).grants.map(g => [g.agent, g.item, g.origin, g.status]), [["kit", "harlow-drive", APP, "active"]]);
});

test("dual read: for every agent, origin and state a row could be in, the old rule and the kernel decide the same after the carry-over", async t => {
  const { v, db, rig } = await mk(t);
  await v.key();
  const now = rig.clock();
  // the old rule, written out: a row is in force when it passes its check, is active, not revoked, and unexpired; the origin is one of the login's hosts
  const oldRule = (/** @type {any} */ row, /** @type {boolean} */ good) => Boolean(row) && good && row.status === "active" && row.revoked == null && (row.expires == null || row.expires > now) && [APP, SSO].includes(row.origin);
  const states = [
    ["live", { status: "active", expires: now + 86400_000 }], ["no expiry", { status: "active", expires: null }], ["expired", { status: "active", expires: now - 1 }],
    ["revoked", { status: "revoked", expires: now + 86400_000, revoked: now - 5 }], ["pending", { status: "pending", expires: now + 86400_000 }], ["edited", { status: "active", expires: now + 86400_000, edit: true }], ["absent", null],
  ];
  /** @type {{ agent: string, origin: string, row: any, good: boolean }[]} */ const cases = [];
  let n = 0;
  for (const agent of ["kit", "juno"]) for (const origin of [APP, SSO]) for (const [name, st] of states) {
    if (!st) { cases.push({ agent, origin, row: null, good: false }); continue; }
    // one row per (item, agent, origin): give each state its own login so the cases are independent
    const item = `login-${n++}`;
    await v.put({ name: item, kind: "login", fields: { username: "u", password: fake("pw") }, hosts: [APP, SSO] }, "cli");
    const row = { id: `ag_${n}`, item, agent, origin, expires: st.expires, status: st.status, revoked: st.revoked ?? null };
    db.prepare("INSERT INTO vault_agent_grants (id, item, agent, origin, expires, status, by, at, revoked) VALUES (?,?,?,?,?,?,'cli',1,?)").run(row.id, item, agent, origin, row.expires, row.status, row.revoked);
    v.sign("vault_agent_grants", row.id);
    if (st.edit) db.prepare("UPDATE vault_agent_grants SET expires = expires + 1 WHERE id = ?").run(row.id);
    cases.push({ agent, origin, row: { ...row, name }, good: !st.edit });
  }
  await v.access.carry();
  for (const c of cases) {
    const item = c.row ? c.row.item : "harlow-drive";
    assert.equal(await v.access.allowed(c.agent, item, c.origin), oldRule(c.row, c.good), `${c.agent} ${c.origin} ${c.row ? c.row.name : "absent"}`);
  }
  assert.ok(cases.length >= 28);
  assert.ok(rig.K);
});

test("uses: counted per grant, and vault.uses filters by agent, item and time, with origin and surface", async t => {
  const { v, run } = await mk(t);
  await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP });
  await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: APP });
  const t0 = Date.now();
  v.recordUse({ action: "agent-fill", item: "harlow-drive", who: "agent:kit", origin: APP, surface: "computer" });
  v.recordUse({ action: "agent-fill", item: "harlow-drive", who: "agent:kit", origin: APP, surface: "computer" });
  v.recordUse({ action: "agent-fill", item: "harlow-drive", who: "agent:kit", origin: "https://evil.test", surface: "computer", ok: false, why: "the page was https://evil.test" });
  v.recordUse({ action: "agent-fill", item: "harlow-drive", who: "agent:juno", origin: APP, surface: "computer" });
  // What the browser fill and the Deck already write, before origin and surface had columns.
  v.audit("fill", "harlow-drive", "device:d_1:laptop chrome", true, APP);
  v.audit("copy", "northwind-api", "deck", true, "field value on deck via pasteboard");
  v.audit("release", "northwind-api", "module:mail", true, null);
  v.audit("add", "other-item", "cli", true, null);
  assert.throws(() => v.recordUse({ action: "add", item: "x", who: "cli" }), /is not a use/);
  assert.throws(() => v.recordUse({ action: "fill", item: "x", who: "cli", surface: "fax" }), /surface must be one of/);

  const grants = (await run("vault.agent.grants", { item: "harlow-drive" })).grants;
  const kit = grants.find(g => g.agent === "kit"), juno = grants.find(g => g.agent === "juno");
  assert.equal(kit.uses, 2, "only allowed fills count");
  assert.equal(juno.uses, 1);
  assert.ok(kit.lastUsed >= t0);
  assert.deepEqual(Object.keys(kit).sort(), ["agent", "expires", "id", "item", "lastUsed", "origin", "status", "uses"]);

  const byKit = (await run("vault.uses", { agent: "kit" })).uses;
  assert.deepEqual(byKit.map(u => [u.action, u.who, u.origin, u.surface, u.ok]), [
    ["agent-fill", "agent:kit", "https://evil.test", "computer", false],
    ["agent-fill", "agent:kit", APP, "computer", true],
    ["agent-fill", "agent:kit", APP, "computer", true],
  ]);
  const byItem = (await run("vault.uses", { item: "harlow-drive" })).uses;
  assert.equal(byItem.length, 5);
  const all = (await run("vault.uses", {})).uses;
  assert.deepEqual(all.map(u => u.action).slice(0, 3), ["release", "copy", "fill"]);
  assert.equal(all[1].surface, "deck");
  assert.equal((await run("vault.uses", { limit: 2 })).uses.length, 2);
  assert.equal((await run("vault.uses", { since: Date.now() + 60_000 })).uses.length, 0);
  await assert.rejects(run("vault.uses", { agent: "k%" }), /is not an agent name/);
  await assert.rejects(run("vault.uses", { since: "last tuesday" }), /is not a date/);
  assert.equal(v.auditTrail({ name: "harlow-drive" }).entries.find(e => e.action === "agent-fill")?.surface, "computer");
});

test("no password or username appears in any result, event, audit row or kernel grant", async t => {
  const { v, db, events, run, seen, password, username, rig } = await mk(t);
  const a = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant;
  const p = (await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: SSO }, "mcp agent:juno")).grant;
  seen.push(await v.approve({ id: p.id }, "cli"), v.pending());
  v.recordUse({ action: "agent-fill", item: "harlow-drive", who: "agent:kit", origin: APP, surface: "computer" });
  await run("vault.agent.grants", {});
  await run("vault.uses", {});
  await run("vault.agent.revoke", { id: a.id });
  for (const bad of [{ item: "northwind-api" }, { origin: "https://evil.test" }, { agent: "BAD" }]) {
    try { await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, ...bad }); } catch (e) { seen.push(/** @type {Error} */ (e).message); }
  }
  v.remove({ name: "harlow-drive" }, "cli");
  await Promise.all(v.revoking);
  const text = JSON.stringify([seen, events, db.prepare("SELECT * FROM vault_audit").all(), db.prepare("SELECT * FROM vault_access_requests").all(), await rig.gw.grants.list(rig.owner(), {}), v.auditTrail({})]);
  for (const s of [password, username, username.split("@")[0]]) assert.ok(!text.includes(s), "a login field leaked");
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  assert.ok(!text.includes(hash) && !text.includes(hash.slice(0, 16)));
});

test("the module registers the agent tools, and approve's summary names an agent grant", async t => {
  const { tools, run } = await recorded(t);
  for (const n of ["vault.agent.grant", "vault.agent.grants", "vault.agent.revoke", "vault.uses"]) assert.ok(tools.has(n), n);
  await run("vault.put", { name: "harlow-drive", kind: "login", fields: { username: "alex@harlow.test", password: fake("pw") }, hosts: [APP] });
  const p = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: Date.UTC(2031, 9, 1, 12) }, "mcp agent:kit")).grant;
  assert.equal(await tools.get("vault.approve").presence.summary({ id: p.id }), `Let kit sign in to ${APP} as harlow-drive until 1 Oct 2031`);
});
