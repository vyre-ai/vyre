// @ts-check
// agent grants tests (ADR 0028, decision 2): one agent, one login, one origin. A person's grant is
// active at once, Claude's waits for vault.approve, the origin must be exactly one of the login's
// hosts, expired and revoked grants are out of force, a row edited in vyre.db is ignored, deleting
// the login revokes its grants, and vault.uses reads every use back by agent and item. Nothing a
// tool, an event or an audit row carries holds the password or the username. Every vault lives
// under the checkout's scratch dir.

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
import { SCRATCH } from "../../test/scratch.mjs";

const APP = "https://app.northwind.test", SSO = "https://sso.northwind.test:8443";
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

/** A vault with one login lent-able to agents, one api key, and the agent tools on a map. */
async function mk(t, clock = undefined) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-agent-grants-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  /** @type {{ type: string, p: any }[]} */
  const events = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, ...(clock ? { clock } : {}) });
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
  return { v, db, events, tools, run, seen, password, username };
}

test("exact origins and the summary's day", () => {
  assert.equal(exactOrigin(APP), APP);
  assert.equal(exactOrigin(APP + "/"), APP);
  for (const bad of [`${APP}/login`, `${APP}?x=1`, `${APP}#a`, "https://alex@app.northwind.test", "ftp://app.northwind.test", "app.northwind.test", "", null, 7]) assert.equal(exactOrigin(bad), null, String(bad));
  assert.equal(day(Date.UTC(2026, 9, 1, 12), Date.UTC(2026, 8, 27)), "1 Oct");
  assert.equal(day(Date.UTC(2027, 0, 5, 12), Date.UTC(2026, 8, 27)), "5 Jan 2027");
});

test("a person lends a login: active at once, MACed, audited and announced with names only", async t => {
  const { v, db, events, tools, run } = await mk(t);
  const until = Date.now() + 3 * 86400_000;
  const summary = await tools.get("vault.agent.grant").presence.summary({ agent: "kit", item: "harlow-drive", origin: APP, expires: until });
  assert.equal(summary, `Let kit sign in to ${APP} as harlow-drive until ${day(until)}`);
  assert.equal(tools.get("vault.agent.grant").presence.skip({ caller: "mcp agent:kit" }), true);
  assert.equal(tools.get("vault.agent.grant").presence.skip({ caller: "cli" }), false);
  assert.deepEqual(tools.get("vault.agent.grant").callers, ["cli", "local", "deck", "capsule", "mcp"]);
  for (const n of ["vault.agent.grants", "vault.agent.revoke", "vault.uses"]) assert.equal(tools.get(n).presence, undefined, `${n} needs no person`);

  const { grant } = await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: until });
  assert.match(grant.id, /^ag_/);
  assert.deepEqual({ ...grant, id: undefined }, { id: undefined, agent: "kit", item: "harlow-drive", origin: APP, expires: until, status: "active" });
  const row = /** @type {any} */ (db.prepare("SELECT * FROM vault_agent_grants WHERE id=?").get(grant.id));
  assert.ok(row.mac, "the row is signed");
  assert.equal(row.by, "cli");
  assert.deepEqual(events.filter(e => e.type.startsWith("vault.agent")), [{ type: "vault.agent-granted", p: { agent: "kit", item: "harlow-drive", origin: APP } }]);
  const a = /** @type {any} */ (db.prepare("SELECT * FROM vault_audit WHERE action='agent-grant'").get());
  assert.deepEqual([a.name, a.who, a.origin, a.why], ["harlow-drive", "cli", APP, "agent:kit"]);
  assert.deepEqual(await v.agentGrantFor("kit", "harlow-drive", APP), grant);
  assert.equal(await v.agentGrantFor("juno", "harlow-drive", APP), null, "another agent has nothing");
  assert.equal(await v.agentGrantFor("kit", "harlow-drive", SSO), null, "another origin of the same login has nothing");
  // A second origin of the login is its own grant; the default expiry is 30 days.
  const sso = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: SSO + "/" })).grant;
  assert.notEqual(sso.id, grant.id);
  assert.equal(sso.origin, SSO);
  assert.ok(Math.abs(sso.expires - (Date.now() + 30 * 86400_000)) < 60_000);
  // Granting again from a person keeps the id and takes the new expiry.
  const again = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: "7d" })).grant;
  assert.equal(again.id, grant.id);
  assert.notEqual(again.expires, until);
});

test("refused: a non-login, a missing item, a bad agent name, a module, and any origin not exactly in the login's hosts", async t => {
  const { run, db } = await mk(t);
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "northwind-api", origin: APP }), /is a api-key; an agent is lent only logins/);
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "no-such-login", origin: APP }), /no item named no-such-login/);
  await assert.rejects(run("vault.agent.grant", { agent: "Kit Agent", item: "harlow-drive", origin: APP }), /is not an agent name/);
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP }, "module:mail"), /modules cannot lend logins/);
  for (const o of ["https://app.northwind.test.evil.test", "https://app-northwind.test", "https://northwind.test", `${APP}:8443`, "http://app.northwind.test", "https://sso.northwind.test"]) {
    await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: o }), /harlow-drive is not for /, o);
  }
  for (const o of [`${APP}/login`, `${APP}/?next=/`, "https://alex@app.northwind.test", "javascript:alert(1)"]) {
    await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: o }), /origin must be exactly a scheme, host and port/, o);
  }
  await assert.rejects(run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: Date.now() - 1000 }), /in the past/);
  assert.equal(Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM vault_agent_grants").get()).n), 0);
});

test("from Claude a grant waits as pending; only vault.approve makes it active", async t => {
  const { v, events, run } = await mk(t);
  const { grant } = await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: "2d" }, "mcp agent:kit");
  assert.equal(grant.status, "pending");
  assert.equal(await v.agentGrantFor("kit", "harlow-drive", APP), null, "a pending grant is not in force");
  assert.deepEqual(events.filter(e => e.type === "grant.requested").map(e => e.p), [{ agent: "kit", item: "harlow-drive", origin: APP }]);
  assert.deepEqual(v.pending().agentGrants.map(g => [g.id, g.status, g.by]), [[grant.id, "pending", "mcp agent:kit"]]);
  const listed = (await run("vault.agent.grants", { agent: "kit" }, "mcp agent:kit")).grants;
  assert.deepEqual(listed.map(g => g.status), ["pending"]);

  const ok = await v.approve({ id: grant.id }, "cli");
  assert.equal(ok.approved.status, "active");
  assert.equal((await v.agentGrantFor("kit", "harlow-drive", APP))?.id, grant.id);
  assert.equal(v.pending().agentGrants.length, 0);
  assert.deepEqual(events.filter(e => e.type === "vault.agent-granted").map(e => e.p), [{ agent: "kit", item: "harlow-drive", origin: APP }]);
  await assert.rejects(v.approve({ id: grant.id }, "cli"), /nothing pending with id/);
  await assert.rejects(v.approve({ id: "ag_nothing" }, "cli"), /nothing pending with id/);
  // Claude asking again for what is in force changes nothing.
  const again = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP }, "mcp agent:kit")).grant;
  assert.deepEqual(again, ok.approved);
});

test("an expired grant is out of force and listed as expired", async t => {
  let at = Date.now();
  const { v, run } = await mk(t, () => at);
  const { grant } = await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, expires: at + 150 });
  assert.equal((await v.agentGrantFor("kit", "harlow-drive", APP))?.id, grant.id);
  at += 250;
  assert.equal(await v.agentGrantFor("kit", "harlow-drive", APP), null);
  assert.deepEqual((await run("vault.agent.grants", {})).grants.map(g => [g.id, g.status]), [[grant.id, "expired"]]);
  // An expired pending grant cannot be approved into force.
  const p = (await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: APP, expires: at + 150 }, "mcp agent:juno")).grant;
  at += 250;
  await assert.rejects(v.approve({ id: p.id }, "cli"), /expired before it was approved/);
});

test("revoke needs no one, from any caller; deleting the login revokes the rest", async t => {
  const { v, events, run } = await mk(t);
  const a = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant;
  const b = (await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: SSO })).grant;
  const r = await run("vault.agent.revoke", { id: a.id }, "mcp agent:kit");
  assert.equal(r.revoked, true);
  assert.equal(r.grant.status, "revoked");
  assert.equal(await v.agentGrantFor("kit", "harlow-drive", APP), null);
  assert.deepEqual((await run("vault.agent.revoke", { id: a.id })).revoked, false);
  await assert.rejects(run("vault.agent.revoke", { id: "ag_nothing" }), /no agent grant ag_nothing/);
  assert.deepEqual(events.filter(e => e.type === "vault.agent-revoked").map(e => e.p), [{ agent: "kit", item: "harlow-drive", origin: APP }]);
  // A revoked grant can be given again by a person, under the same id.
  assert.equal((await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant.id, a.id);

  v.remove({ name: "harlow-drive" }, "cli");
  const all = (await run("vault.agent.grants", {})).grants;
  assert.deepEqual(all.map(g => g.status).sort(), ["revoked", "revoked"]);
  assert.deepEqual(events.filter(e => e.type === "vault.agent-revoked").map(e => e.p.agent).sort(), ["juno", "kit", "kit"]);
  assert.equal(await v.agentGrantFor("juno", "harlow-drive", SSO), null);
  assert.ok(b.id);
});

test("a row edited in vyre.db is ignored, listed nowhere and audited as tamper", async t => {
  const { v, db, run } = await mk(t);
  const a = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant;
  const b = (await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: APP, expires: Date.now() + 100 })).grant;
  const c = (await run("vault.agent.revoke", { id: (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: SSO })).grant.id })).grant;
  // Point kit's grant at another agent; stretch juno's expiry; bring a revoked grant back.
  db.prepare("UPDATE vault_agent_grants SET agent='juno-two' WHERE id=?").run(a.id);
  db.prepare("UPDATE vault_agent_grants SET expires=? WHERE id=?").run(Date.now() + 86400_000, b.id);
  db.prepare("UPDATE vault_agent_grants SET status='active', revoked=NULL WHERE id=?").run(c.id);
  // A row planted with no mac at all.
  db.prepare("INSERT INTO vault_agent_grants (id, item, agent, origin, expires, status, by, at) VALUES ('ag_planted','harlow-drive','kit',?,NULL,'active','cli',?)").run(APP, Date.now());
  for (const [agent, o] of [["kit", APP], ["juno-two", APP], ["juno", APP], ["kit", SSO]]) assert.equal(await v.agentGrantFor(agent, "harlow-drive", o), null, `${agent} ${o}`);
  assert.deepEqual((await run("vault.agent.grants", {})).grants, []);
  assert.deepEqual(v.pending().agentGrants, []);
  const tamper = /** @type {any[]} */ (db.prepare("SELECT * FROM vault_audit WHERE action='tamper'").all());
  assert.ok(tamper.some(r => /vault_agent_grants row/.test(r.why)));
  // Revoking a tampered row is still allowed.
  assert.equal((await run("vault.agent.revoke", { id: b.id })).revoked, true);
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
  assert.deepEqual(Object.keys(kit).sort(), ["agent", "at", "by", "expires", "id", "item", "lastUsed", "origin", "status", "uses"]);

  const byKit = (await run("vault.uses", { agent: "kit" })).uses;
  assert.deepEqual(byKit.map(u => [u.action, u.who, u.origin, u.surface, u.ok]), [
    ["agent-fill", "agent:kit", "https://evil.test", "computer", false],
    ["agent-fill", "agent:kit", APP, "computer", true],
    ["agent-fill", "agent:kit", APP, "computer", true],
  ]);
  const byItem = (await run("vault.uses", { item: "harlow-drive" })).uses;
  assert.equal(byItem.length, 5);
  assert.deepEqual(byItem[0], { at: byItem[0].at, action: "fill", item: "harlow-drive", who: "device:d_1:laptop chrome", origin: APP, ok: true });
  const all = (await run("vault.uses", {})).uses;
  assert.deepEqual(all.map(u => u.action), ["release", "copy", "fill", "agent-fill", "agent-fill", "agent-fill", "agent-fill"]);
  assert.equal(all[1].surface, "deck");
  assert.equal((await run("vault.uses", { limit: 2 })).uses.length, 2);
  assert.equal((await run("vault.uses", { since: Date.now() + 60_000 })).uses.length, 0);
  assert.equal((await run("vault.uses", { since: new Date(t0 - 1000).toISOString() })).uses.length, 7);
  await assert.rejects(run("vault.uses", { agent: "k%" }), /is not an agent name/);
  await assert.rejects(run("vault.uses", { since: "last tuesday" }), /is not a date/);
  // vault.audit shows the new columns too.
  assert.equal(v.auditTrail({ name: "harlow-drive" }).entries.find(e => e.action === "agent-fill")?.surface, "computer");
});

test("no password or username appears in any result, event, audit row or grant row", async t => {
  const { v, db, events, run, seen, password, username } = await mk(t);
  const a = (await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP })).grant;
  const p = (await run("vault.agent.grant", { agent: "juno", item: "harlow-drive", origin: SSO }, "mcp agent:juno")).grant;
  seen.push(await v.approve({ id: p.id }, "cli"), v.pending(), await v.agentGrantFor("kit", "harlow-drive", APP));
  v.recordUse({ action: "agent-fill", item: "harlow-drive", who: "agent:kit", origin: APP, surface: "computer" });
  await run("vault.agent.grants", {});
  await run("vault.uses", {});
  await run("vault.agent.revoke", { id: a.id });
  for (const bad of [{ item: "northwind-api" }, { origin: "https://evil.test" }, { agent: "BAD" }]) {
    try { await run("vault.agent.grant", { agent: "kit", item: "harlow-drive", origin: APP, ...bad }); } catch (e) { seen.push(/** @type {Error} */ (e).message); }
  }
  v.remove({ name: "harlow-drive" }, "cli");
  const text = JSON.stringify([seen, events, db.prepare("SELECT * FROM vault_audit").all(), db.prepare("SELECT * FROM vault_agent_grants").all(), v.auditTrail({})]);
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
  assert.equal((await run("vault.approve", { id: p.id })).approved.status, "active");
  assert.equal((await run("vault.agent.grants", {}, "mcp agent:kit")).grants[0].status, "active");
});
