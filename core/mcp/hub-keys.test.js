// @ts-check
// A plugin's MCP server that needs keys (Vault-backed env): the row names Vault items and never values; each item is read with a grant made to this one server and variable; with no item or no grant the server
// waits (needs_key) and never starts; a grant taken back stops it, on the next call, at a sweep and by the timer; the value is only in the child's environment; a personal plugin's server answers only its person.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Credentials } from "../../lib/connectors/auth.js";
import { Hub, MIGRATIONS, normalize } from "./hub.js";

const VALUE = "fixture-notes-key-9f8e7d6c5b4a";
const bound = (/** @type {any} */ o = {}) => ({ plugin: "notes", level: "space", person: "per_owner", owner: true, needs: [{ var: "NOTES_API_KEY", label: "Notes API key" }], ...o });
const row = (/** @type {any} */ o = {}) => ({ name: "p-notes-notes", transport: "stdio", command: "npx", args: ["-y", "notes-mcp@1.2.3"], env: { NOTES_API_KEY: "notes-key" }, auth: { type: "env", bound: bound() }, ...o });

function rig({ granted = new Set(["notes-key|p-notes-notes.NOTES_API_KEY"]), keyCheckMs = 0 } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  /** @type {any[]} */ const events = [], opened = [];
  const creds = new Credentials({ fetchItem: async (item, _field, watcher) => {
    if (!granted.has(`${item}|${watcher || ""}`)) throw new Error(`${item} is not granted to mcp${watcher ? `/${watcher}` : ""} · vyre vault grant ${item} mcp`);
    return VALUE;
  } });
  const connect = async (/** @type {any} */ spec, /** @type {any} */ opts) => {
    const client = { transport: spec.transport, pid: 1, stderr: () => [], async initialize() { return {}; }, async listTools() { return [{ name: "list_notes", annotations: { readOnlyHint: true } }]; },
      async callTool() { return { content: [{ type: "text", text: "ok" }] }; }, closed: false, async close() { this.closed = true; } };
    opened.push({ spec, opts, client });
    return client;
  };
  const hub = new Hub({ db, creds, connect, emit: (type, payload) => events.push({ type, payload }), keyHeld: async (item, watcher) => granted.has(`${item}|${watcher}`), ...(keyCheckMs ? { keyCheckMs } : {}) });
  return { hub, db, events, opened, granted };
}
const person = { person: true, agent: null, thread: null, me: () => "" };
const everywhere = (/** @type {any} */ r) => JSON.stringify([r.hub.rows(), r.hub.servers(person), r.events, [...r.db.prepare("SELECT * FROM mcp_servers").all()]]);

test("normalize: a bound row names items and variables only, for a stdio server, and refuses what does not fit", () => {
  const ok = normalize(row());
  assert.deepEqual(ok.auth, { type: "env", bound: bound() });
  assert.deepEqual(ok.env, { NOTES_API_KEY: "notes-key" });
  assert.deepEqual(normalize(row({ env: {} })).env, {}, "no item chosen yet: the server waits");
  assert.throws(() => normalize(row({ transport: "http", command: undefined, args: undefined, url: "https://mcp.northwind.example/mcp", env: {} })), /stdio|http/);
  assert.throws(() => normalize(row({ env: { OTHER: "notes-key" } })), /not one of the variables/);
  assert.throws(() => normalize(row({ auth: { type: "env", bound: bound({ needs: [{ var: "VYRE_KEY", label: "x" }] }) } })), /needs/);
  assert.throws(() => normalize(row({ auth: { type: "env", bound: bound({ needs: Array.from({ length: 6 }, (_, i) => ({ var: `K${i}`, label: "k" })) }) } })), /1 to 5/);
  assert.throws(() => normalize(row({ env: { NOTES_API_KEY: "sk-" + "a1".repeat(14) } })), /vault/);
});

test("a server with no item chosen, or whose item is not granted to it, waits and is never started", async () => {
  const r = rig({ granted: new Set() });
  const view = await r.hub.add(row({ env: {} }));
  assert.equal(r.opened.length, 0);
  assert.equal(r.hub.servers(person).find((/** @type {any} */ s) => s.name === "p-notes-notes").state, "needs_key");
  await assert.rejects(r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person), (/** @type {any} */ e) => e.code === "needs_key");
  assert.ok(r.events.some(e => e.type === "mcp.needs-key"), "said once as an event");
  // an item is named but nobody granted it to this server and variable
  await r.hub.update({ name: "p-notes-notes", env: { NOTES_API_KEY: "notes-key" } });
  await assert.rejects(r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person), (/** @type {any} */ e) => e.code === "needs_key");
  assert.equal(r.opened.length, 0, "a child is not started without the grant");
  assert.ok(view);
});

test("with the grant the child gets the value in its environment and nowhere else", async () => {
  const r = rig();
  await r.hub.add(row());
  const out = await r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person);
  assert.equal(out.content[0].text, "ok");
  assert.equal(r.opened.length, 1);
  assert.equal(r.opened[0].opts.env.NOTES_API_KEY, VALUE, "the child's environment holds it");
  assert.ok(!JSON.stringify(r.opened[0].spec).includes(VALUE), "not in the command or arguments");
  assert.ok(!everywhere(r).includes(VALUE), "not in a row, the stored table, a listing or an event");
});

test("a grant taken back stops the server: on the next call, at a sweep, and by the timer; a grant given again starts it", async () => {
  const r = rig({ keyCheckMs: 20 });
  await r.hub.add(row());
  await r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person);
  const c1 = r.opened[0].client;
  r.granted.delete("notes-key|p-notes-notes.NOTES_API_KEY");
  await assert.rejects(r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person), (/** @type {any} */ e) => e.code === "needs_key");
  assert.equal(c1.closed, true, "the running child was stopped");
  assert.equal(r.hub.servers(person).find((/** @type {any} */ s) => s.name === "p-notes-notes").state, "needs_key");
  r.granted.add("notes-key|p-notes-notes.NOTES_API_KEY");
  await r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person);
  assert.equal(r.opened.length, 2, "started again once the key is granted");
  // a sweep after an unshare
  const c2 = r.opened[1].client;
  r.granted.delete("notes-key|p-notes-notes.NOTES_API_KEY");
  await r.hub.sweep("p-notes-notes");
  assert.equal(c2.closed, true);
  // the timer, with no call at all
  r.granted.add("notes-key|p-notes-notes.NOTES_API_KEY");
  await r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person);
  const c3 = r.opened[2].client;
  r.granted.delete("notes-key|p-notes-notes.NOTES_API_KEY");
  for (let i = 0; i < 50 && !c3.closed; i++) await new Promise(res => setTimeout(res, 20));
  assert.equal(c3.closed, true, "stopped by the timer without a call");
  await r.hub.stop();
});

test("a grant for another server or variable does not serve this one", async () => {
  const r = rig({ granted: new Set(["notes-key|p-other-other.NOTES_API_KEY", "notes-key|p-notes-notes.OTHER_VAR", "notes-key|"]) });
  await r.hub.add(row());
  await assert.rejects(r.hub.call({ server: "p-notes-notes", tool: "list_notes" }, person), (/** @type {any} */ e) => e.code === "needs_key");
  assert.equal(r.opened.length, 0);
});

test("a personal plugin's server answers only its person's calls; the owner's own, only the owner's", async () => {
  const mine = rig();
  await mine.hub.add(row({ name: "p-notes-mine", auth: { type: "env", bound: bound({ level: "personal", person: "per_ana", owner: undefined }) } }));
  const as = (/** @type {string} */ me) => ({ person: false, agent: null, thread: null, me: () => me });
  const memo = () => ({});
  const r1 = /** @type {any} */ (mine.hub.row("p-notes-mine"));
  assert.equal(await mine.hub.inScope(r1, as("per_ana"), memo()), true, "her own chain");
  assert.equal(await mine.hub.inScope(r1, as("per_ben"), memo()), false, "another member");
  assert.equal(await mine.hub.inScope(r1, as(""), memo()), false, "the owner is not her");
  assert.equal(await mine.hub.inScope(r1, { ...as("per_ana"), me: () => Promise.reject(new Error("lookup failed")) }, memo()), false, "a failed lookup is no");
  const own = rig();
  await own.hub.add(row({ name: "p-notes-own", auth: { type: "env", bound: bound({ level: "personal" }) } }));
  const r2 = /** @type {any} */ (own.hub.row("p-notes-own"));
  assert.equal(await own.hub.inScope(r2, { ...person }, memo()), true, "the owner's own personal plugin, called as the owner");
  assert.equal(await own.hub.inScope(r2, as("per_ana"), memo()), false, "a member cannot use the owner's personal one");
});
