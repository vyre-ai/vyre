// @ts-check
// connections (ADR 0028, decision 9b): the pure parts (surfaces, the tool-name patterns, uses,
// the needs_credential shape), then the table inside a real vyred in a temp home, with fake
// module callers that register a Google service account, two Gmail-like MCP servers and an IMAP
// account. Every value is made at run time; none may appear in any reply, event or log line.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { surfaceOf, words, toolCapabilities, usesOf, checkUse, Connections, moduleOf } from "./connections.js";
import { needsCredential, needsCredentialError, isNeedsCredential } from "../modules/needs-credential.js";
import { validate } from "../modules/index.js";
import { PROVIDERS, checkProviderFields } from "./providers.js";

const hex = n => crypto.randomBytes(n).toString("hex");
const ID = /^cn_[A-Za-z0-9_-]+$/;

test("connections: each caller is one surface", () => {
  const cases = [
    ["cli", "person"], ["local", "person"], ["deck", "person"], ["tailnet:alex@harlowlegal.test", "person"],
    ["capsule", "capsule"], ["mobile", "phone"], ["mcp", "chat"], ["mcp:thread:t-1", "chat"],
    ["mcp:agent:kit", "agents"], ["tailnet:agent:juno", "agents"], ["harness:agent:kit", "agents"],
    ["module:mail", "module"], ["tailnet-guest:dana@northwind.test", null], ["anonymous", null], ["", null],
  ];
  for (const [c, want] of cases) assert.equal(surfaceOf(c).surface, want, c);
  assert.equal(surfaceOf("mcp:thread:t-9").thread, "t-9");
});

test("connections: a thread the Capsule started is the capsule surface; any other thread is chat", async () => {
  const asked = [];
  const fake = { db: null, key: async () => {}, list: () => ({ items: [] }) };
  const c = new Connections(/** @type {any} */ (fake), { call: async (tool, input) => {
    asked.push([tool, input]);
    return { data: { thread: { id: input.thread, purpose: input.thread === "t-cap" ? "capsule" : "chat" } } };
  } });
  assert.equal(await c.surface("mcp:thread:t-cap"), "capsule");
  assert.equal(await c.surface("mcp:thread:t-chat"), "chat");
  assert.deepEqual(asked, [["threads.get", { thread: "t-cap", limit: 1 }], ["threads.get", { thread: "t-chat", limit: 1 }]]);
  const none = new Connections(/** @type {any} */ (fake), { call: async () => ({ error: { code: "no_such_tool", message: "no" } }) });
  assert.equal(await none.surface("mcp:thread:t-cap"), "chat", "with no switchboard a thread is chat");
});

test("connections: capabilities from tool names, by a small pattern table", () => {
  assert.deepEqual(words("gmail_send"), ["gmail", "send"]);
  assert.deepEqual(words("sendEmail"), ["send", "email"]);
  assert.deepEqual(words("calendar.list-events"), ["calendar", "list", "events"]);
  const caps = (tools, name) => Object.keys(toolCapabilities(tools, name)).sort();
  assert.deepEqual(toolCapabilities(["send_email"]), { send_mail: "send_email" });
  assert.deepEqual(toolCapabilities(["gmail_send", "gmail_search"]), { send_mail: "gmail_send", read_mail: "gmail_search" });
  // In a mail server, messages and threads are mail.
  assert.deepEqual(toolCapabilities(["search_threads", "get_thread", "send_message", "list_labels"], "gmail"),
    { read_mail: "search_threads", send_mail: "send_message" });
  assert.deepEqual(toolCapabilities(["get_message", "send_message", "list_drafts", "create_draft_email"]).send_mail, "send_message", "one mail tool makes the server a mail server");
  // Anywhere else a message is a chat message.
  assert.deepEqual(caps(["post_message", "list_channels"]), ["send_message"]);
  assert.deepEqual(caps(["slack_send_message"]), ["send_message"]);
  assert.deepEqual(caps(["send_message"], "tracker"), ["send_message"]);
  assert.deepEqual(caps(["list_events", "create_event"]), ["calendar"]);
  assert.deepEqual(caps(["search_files", "read_file_content"]), ["files"]);
  assert.deepEqual(caps(["drive_list"]), ["files"]);
  assert.deepEqual(caps(["web_search"]), ["search"]);
  assert.deepEqual(caps(["get_issue", "create_issue"]), []);
  assert.deepEqual(caps([]), []);
});

test("connections: uses default mail capabilities to the mail module, and a use map is checked", () => {
  const row = { id: "cn_abc" };
  assert.deepEqual(usesOf(row, ["send_mail", "read_mail", "calendar", "speech"], null), {
    send_mail: { tool: "mail.send", input: { account: "cn_abc" } }, read_mail: { tool: "mail.search", input: { account: "cn_abc" } } });
  const own = { send_mail: { tool: "google.mail.send", input: { account: "northwind" } }, calendar: { tool: "google.calendar.list", input: { account: "northwind" } } };
  assert.deepEqual(usesOf(row, ["send_mail", "read_mail", "calendar"], own), { ...own, read_mail: { tool: "mail.search", input: { account: "cn_abc" } } });
  assert.deepEqual(checkUse({ send_mail: { tool: "mcp.call", input: { server: "gmail-harlow", tool: "send_message" } } }),
    { send_mail: { tool: "mcp.call", input: { server: "gmail-harlow", tool: "send_message" } } });
  assert.equal(checkUse(undefined), null);
  assert.equal(checkUse({}), null);
  assert.deepEqual(checkUse({ read_mail: { tool: "mail.search" } }), { read_mail: { tool: "mail.search", input: {} } });
  assert.throws(() => checkUse({ tool: "mail.send", input: {} }), /not a capability/, "a bare {tool, input} is not a map");
  assert.throws(() => checkUse({ send_mail: { tool: "Not A Tool" } }), /map of capability/);
  assert.throws(() => checkUse({ send_mail: { tool: "mail.send", input: [] } }), /map of capability/);
  assert.throws(() => checkUse([]), /map of capability/);
});

test("connections: the needs_credential shape, as an object and as an error", () => {
  const n = needsCredential({ module: "mail", need: "account", account: "kit@northwind.test" });
  assert.equal(n.code, "needs_credential");
  assert.deepEqual(n.detail, { module: "mail", need: "account", account: "kit@northwind.test" });
  assert.match(n.message, /mail needs account for kit@northwind\.test .*vyre vault connect mail account/);
  assert.deepEqual(needsCredential({ module: "voice", need: "deepgram" }, "Connect a speech key").detail, { module: "voice", need: "deepgram" });
  const e = needsCredentialError({ module: "voice", need: "deepgram" });
  assert.ok(e instanceof Error);
  assert.equal(/** @type {any} */ (e).code, "needs_credential");
  assert.ok(isNeedsCredential(e) && isNeedsCredential(n) && !isNeedsCredential({ code: "needs_credential" }));
});

test("connections: an Apps Script web app can send and read mail, at either URL shape", () => {
  const p = PROVIDERS["google-apps-script"];
  assert.deepEqual(p.capabilities, ["send_mail", "read_mail"]);
  const token = hex(16);
  for (const url of [`https://script.google.com/macros/s/AKfy${hex(12)}/exec`, `https://script.google.com/a/macros/northwind.test/s/AKfy${hex(12)}/exec`])
    assert.equal(checkProviderFields(p, { url, token }).url, url);
  for (const url of ["https://script.google.com/home", "https://script.google.com/macros/s/short/exec", "https://evil.test/macros/s/AKfyabcdefghijk/exec", `https://script.google.com/macros/s/AKfy${hex(12)}/dev`])
    assert.throws(() => checkProviderFields(p, { url, token }), /url does not look like/, url);
});

test("connections: only a module registers, and never as the vault", () => {
  assert.equal(moduleOf("module:google"), "google");
  for (const c of ["cli", "capsule", "mcp", "mcp:agent:kit", "module:vault", "module:Bad Name"]) assert.throws(() => moduleOf(c), /only a module|keeps its own/, c);
});

test("modules: needs.credentials takes multiple, and then no item", () => {
  const good = { name: "postbox", version: "0.1.0", does: { tools: [] } };
  const need = { id: "account", kind: "env-set", provider: "imap-smtp", purpose: "a mailbox", multiple: true };
  assert.deepEqual(validate({ ...good, needs: { credentials: [need] } }), []);
  assert.match(validate({ ...good, needs: { credentials: [{ ...need, multiple: "yes" }] } }).join(";"), /multiple must be true or false/);
  assert.match(validate({ ...good, needs: { credentials: [{ ...need, item: "postbox-one" }] } }).join(";"), /item cannot be set with multiple/);
});

// A module that declares a multiple IMAP need and fetches what it was granted.
const POSTBOX = `export default { async start(ctx) {
  ctx.tool("postbox.use", { input: { type: "object", properties: { name: { type: "string" } } },
    run: async ({ name }) => { const v = await ctx.vault.fetch(name, { field: "password" });
      const c = await import("node:crypto"); return { sha: c.createHash("sha256").update(String(v)).digest("hex") }; } });
  return { async stop() {} };
} };`;

async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file", reminders: false },
    modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  writeModule(path.join(root, "modules"), "postbox", { does: { tools: ["postbox.use"] },
    needs: { credentials: [{ id: "account", kind: "env-set", provider: "imap-smtp", purpose: "a mailbox", multiple: true }] } }, POSTBOX);
  const pres = { deny: false,
    required: (_tool, def) => Boolean(def && def.presence),
    verify: async () => (pres.deny ? { ok: false, code: "presence_required", message: "prove presence" } : { ok: true, method: "test" }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenge in this test" } }) };
  const lines = [];
  const d = await start({ root, presence: pres, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  /** A caller over the socket. */
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  /** A module, or an agent vyred verified, in-process (the socket never lets a client claim these). */
  const inproc = caller => (tool, input = {}) => d.registry.call(tool, input, caller);
  return { root, d, pres, lines, as, inproc, events: type => d.registry.deps.events.since(0, { type, limit: 1000 }) };
}

const imapFields = pw => ({ imap_host: "imap.northwind.test", imap_port: "993", smtp_host: "smtp.northwind.test", smtp_port: "465", username: "kit", password: pw, security: "tls" });

test("connections: several email accounts, one list, granted per surface", async t => {
  const { d, pres, lines, as, inproc, events } = await boot(t);
  const cli = as("cli"), capsule = as("capsule"), mcp = as("mcp");
  const kit = inproc("mcp:agent:kit");
  const google = inproc("module:google"), hub = inproc("module:mcp"), postbox = inproc("module:postbox"), other = inproc("module:planner");
  const outs = [], values = [];
  const v = s => (values.push(s), s);
  const ok = r => { outs.push(r); assert.ok(!r.error, JSON.stringify(r.error)); return r.data; };

  // A multiple need: each account is <module>-<label>, and a label is required.
  const pw = v(hex(12));
  assert.match((await cli("vault.connect", { module: "postbox", need: "account", fields: imapFields(pw) })).error.message, /give each a label/);
  const con = ok(await cli("vault.connect", { module: "postbox", need: "account", label: "northwind", fields: imapFields(pw) }));
  assert.equal(con.item, "postbox-northwind");
  assert.equal(ok(await cli("postbox.use", { name: "postbox-northwind" })).sha, crypto.createHash("sha256").update(pw).digest("hex"), "a multiple need's item is fetchable");
  const need = ok(await cli("vault.need", { module: "postbox" })).needs[0];
  assert.equal(need.multiple, true); assert.equal(need.state, "ready");
  assert.deepEqual(need.items, [{ name: "postbox-northwind", state: "ready" }]);

  // The vault's own row follows the item, with the catalog's capabilities and the mail use.
  let all = ok(await cli("vault.connections.list")).connections;
  assert.equal(all.length, 1);
  const vaultRow = all[0];
  assert.match(vaultRow.id, ID);
  assert.deepEqual({ source: vaultRow.source, ref: vaultRow.ref, provider: vaultRow.provider, auth: vaultRow.auth, surfaces: vaultRow.surfaces, state: vaultRow.state },
    { source: "vault", ref: "postbox-northwind", provider: "imap-smtp", auth: "password", surfaces: ["capsule", "chat"], state: "ready" });
  assert.deepEqual(vaultRow.capabilities, ["send_mail", "read_mail"]);
  assert.deepEqual(vaultRow.uses.send_mail, { tool: "mail.send", input: { account: vaultRow.id } });

  // Fake module callers register the rest: a DWD Google account, two Gmail-like MCP servers,
  // and the IMAP login, which claims the vault's row for that item.
  await cli("vault.put", { name: "google-northwind-sa", kind: "api-key", fields: { value: v(hex(20)) } });
  await cli("vault.grant", { name: "google-northwind-sa", module: "google" });
  const g = ok(await google("vault.connections.register", { ref: "northwind", provider: "google-dwd", account: "kit@northwind.test", auth: "service-account",
    capabilities: ["send_mail", "read_mail", "calendar"], items: ["google-northwind-sa"], source: "vault",
    use: { send_mail: { tool: "google.mail.send", input: { account: "northwind" } }, calendar: { tool: "google.calendar.list", input: { account: "northwind" } } } }));
  assert.match(g.id, ID);
  assert.equal(g.source, "google", "the source is the caller's module, never the input");
  const m1 = ok(await hub("vault.connections.register", { ref: "gmail-harlow", provider: "mcp", account: "alex@harlowlegal.test", auth: "oauth",
    tools: ["search_threads", "get_thread", "send_message", "list_labels"],
    use: { send_mail: { tool: "mcp.call", input: { server: "gmail-harlow", tool: "send_message" } } } }));
  assert.deepEqual(m1.capabilities, ["send_mail", "read_mail"], "inferred from the tool names");
  const m2 = ok(await hub("vault.connections.register", { ref: "gmail-juno", provider: "mcp", account: "juno@harlowlegal.test", auth: "bearer", tools: ["gmail_send", "gmail_search"] }));
  const im = ok(await postbox("vault.connections.register", { ref: "northwind", provider: "imap-smtp", account: "kit@northwind.test", auth: "password",
    capabilities: ["send_mail", "read_mail"], items: ["postbox-northwind"] }));
  all = ok(await cli("vault.connections.list")).connections;
  assert.equal(all.length, 4, "the IMAP item is one connection, the module's");
  assert.ok(!all.some(r => r.source === "vault"));

  // From the Capsule, every account that can send.
  const send = ok(await capsule("vault.connections.list", { capability: "send_mail" }));
  assert.equal(send.surface, "capsule");
  assert.deepEqual(send.connections.map(r => r.id).sort(), [g.id, m1.id, m2.id, im.id].sort());
  const byId = Object.fromEntries(send.connections.map(r => [r.id, r]));
  assert.deepEqual(byId[g.id].use, { tool: "google.mail.send", input: { account: "northwind" } });
  assert.deepEqual(byId[m1.id].use, { tool: "mcp.call", input: { server: "gmail-harlow", tool: "send_message" } });
  assert.deepEqual(byId[m2.id].use, { tool: "mail.send", input: { account: m2.id } }, "no use of its own: the mail module, by connection id");
  assert.deepEqual(byId[im.id].use, { tool: "mail.send", input: { account: im.id } });
  assert.deepEqual(byId[g.id].uses.read_mail, { tool: "mail.search", input: { account: g.id } });
  assert.equal(byId[g.id].surfaces, undefined, "only a person sees surfaces");
  // Claude in chat sees the same four; an agent sees none until one is granted.
  assert.equal(ok(await mcp("vault.connections.list", { capability: "send_mail" })).connections.length, 4);
  assert.equal(ok(await kit("vault.connections.list", { capability: "send_mail" })).connections.length, 0);
  assert.equal((await kit("vault.connections.list", { surface: "capsule" })).error.code, "denied", "an agent cannot look through the Capsule");
  assert.equal(ok(await capsule("vault.connections.list", { capability: "calendar" })).connections.length, 1);

  // A module lists for the surface it acts for: by name or by the caller it was given.
  assert.match((await other("vault.connections.list", {})).error.message, /pass surface .* or caller/);
  assert.equal(ok(await other("vault.connections.list", { surface: "agents" })).connections.length, 0);
  assert.equal(ok(await other("vault.connections.list", { caller: "capsule", capability: "send_mail" })).connections.length, 4);
  assert.equal(ok(await other("vault.connections.list", { caller: "mcp:agent:kit" })).surface, "agents");

  // Grant needs a person; revoke never does.
  pres.deny = true;
  assert.equal((await cli("vault.connections.grant", { id: m2.id, surface: "agents" })).error.code, "presence_required");
  pres.deny = false;
  assert.equal((await mcp("vault.connections.grant", { id: m2.id, surface: "agents" })).error.code, "denied", "Claude never grants");
  assert.deepEqual(ok(await cli("vault.connections.grant", { id: m2.id, surface: "agents" })).connection.surfaces, ["capsule", "chat", "agents"]);
  const agentSees = ok(await kit("vault.connections.list", { capability: "send_mail" })).connections;
  assert.deepEqual(agentSees.map(r => r.id), [m2.id]);
  assert.deepEqual(ok(await kit("vault.connections.get", { id: m2.id })).connection.account, "juno@harlowlegal.test");
  assert.equal((await kit("vault.connections.get", { id: g.id })).error.code, "not_found");

  // allowed: by id or by source and ref; people always; a module is not a surface.
  const ask = async input => ok(await other("vault.connections.allowed", input));
  assert.deepEqual(await ask({ id: m2.id, caller: "mcp:agent:kit" }), { allowed: true, surface: "agents" });
  assert.deepEqual(await ask({ source: "mcp", ref: "gmail-juno", caller: "tailnet:agent:kit" }), { allowed: true, surface: "agents" });
  assert.equal((await ask({ id: g.id, caller: "mcp:agent:kit" })).allowed, false);
  assert.match((await ask({ id: g.id, caller: "mcp:agent:kit" })).reason, /not granted to agents/);
  assert.deepEqual(await ask({ id: g.id, caller: "cli" }), { allowed: true, surface: "person" });
  assert.equal((await ask({ id: g.id, caller: "module:planner" })).allowed, false);
  assert.equal((await ask({ id: g.id, caller: "tailnet-guest:dana@northwind.test" })).allowed, false);
  assert.equal((await ask({ id: "cn_nothere", caller: "capsule" })).reason, "no such connection");
  assert.equal((await ask({ id: g.id, caller: "capsule" })).allowed, true);
  assert.equal((await cli("vault.connections.allowed", { id: g.id, caller: "capsule" })).error.code, "denied", "allowed is for modules");

  // Revoke without a person.
  pres.deny = true;
  assert.deepEqual(ok(await mcp("vault.connections.revoke", { id: m2.id, surface: "agents" })).connection.surfaces, ["capsule", "chat"]);
  pres.deny = false;
  assert.equal((await ask({ id: m2.id, caller: "mcp:agent:kit" })).allowed, false);

  // Edits survive a re-register: label, capabilities and surfaces.
  ok(await cli("vault.connections.grant", { id: g.id, surface: "agents" }));
  ok(await cli("vault.connections.revoke", { id: g.id, surface: "chat" }));
  ok(await cli("vault.connections.update", { id: g.id, label: "Northwind orders", capabilities: ["send_mail", "calendar"] }));
  const again = ok(await google("vault.connections.register", { ref: "northwind", provider: "google-dwd", account: "kit@northwind.test", auth: "service-account",
    capabilities: ["send_mail", "read_mail", "calendar"], items: ["google-northwind-sa"] }));
  assert.equal(again.id, g.id, "the id is stable across upserts");
  let row = ok(await cli("vault.connections.get", { id: g.id })).connection;
  assert.equal(row.label, "Northwind orders");
  assert.deepEqual(row.capabilities, ["send_mail", "calendar"]);
  assert.deepEqual(row.surfaces, ["capsule", "agents"]);
  assert.equal(row.state, "ready");
  // And a resync of the vault's own rows leaves them too.
  ok(await cli("vault.connections.sync"));
  assert.equal(ok(await cli("vault.connections.get", { id: g.id })).connection.label, "Northwind orders");
  assert.equal((await mcp("vault.connections.sync")).error.code, "denied");

  // A missing credential: the row says which need fills it.
  const lost = ok(await postbox("vault.connections.register", { ref: "harlow", provider: "imap-smtp", account: "alex@harlowlegal.test", auth: "password",
    capabilities: ["send_mail"], items: ["postbox-harlow"] }));
  row = ok(await cli("vault.connections.get", { id: lost.id })).connection;
  assert.equal(row.state, "needs_credential");
  assert.deepEqual(row.needs, [{ module: "postbox", need: "account" }]);
  await cli("vault.revoke", { name: "google-northwind-sa", module: "google" });
  assert.equal(ok(await cli("vault.connections.get", { id: g.id })).connection.state, "needs_credential", "an item not granted to its module");
  await cli("vault.grant", { name: "google-northwind-sa", module: "google" });

  // unregister is scoped to the caller's own source.
  assert.deepEqual(ok(await other("vault.connections.unregister", { ref: "harlow" })), { removed: false });
  assert.deepEqual(ok(await postbox("vault.connections.unregister", { ref: "harlow" })), { removed: true, id: lost.id });
  assert.equal((await cli("vault.connections.register", { ref: "x", provider: "mcp", account: "x", auth: "none" })).error.code, "denied");
  assert.match((await hub("vault.connections.register", { ref: "x", provider: "mcp", account: "x", auth: "magic" })).error.message, /auth must be one of/);

  // A tampered row is granted to nothing; a re-register signs it with no surfaces.
  const db = d.registry.deps.db;
  db.prepare("UPDATE vault_connections SET surfaces = ? WHERE id = ?").run(JSON.stringify(["capsule", "chat", "agents"]), m1.id);
  assert.equal((await ask({ id: m1.id, caller: "mcp:agent:kit" })).allowed, false);
  assert.match((await ask({ id: m1.id, caller: "capsule" })).reason, /failed its check/);
  assert.ok(!ok(await capsule("vault.connections.list")).connections.some(r => r.id === m1.id));
  const seen = ok(await cli("vault.connections.list")).connections.find(r => r.id === m1.id);
  assert.equal(seen.tampered, true); assert.deepEqual(seen.surfaces, []);
  assert.equal((await cli("vault.connections.update", { id: m1.id, label: "x" })).error.code, "tampered");
  ok(await hub("vault.connections.register", { ref: "gmail-harlow", provider: "mcp", account: "alex@harlowlegal.test", auth: "oauth", tools: ["search_threads", "send_message"] }));
  const reset = ok(await cli("vault.connections.get", { id: m1.id })).connection;
  assert.deepEqual(reset.surfaces, []); assert.equal(reset.tampered, undefined);
  assert.equal((await ask({ id: m1.id, caller: "capsule" })).allowed, false, "still granted to nobody");
  ok(await cli("vault.connections.grant", { id: m1.id, surface: "capsule" }));
  assert.equal((await ask({ id: m1.id, caller: "capsule" })).allowed, true);

  // The vault's own rows follow deletes; a released claim brings the item's row back.
  ok(await postbox("vault.connections.unregister", { ref: "northwind" }));
  assert.ok(ok(await cli("vault.connections.list")).connections.some(r => r.source === "vault" && r.ref === "postbox-northwind"));
  ok(await cli("vault.delete", { name: "postbox-northwind" }));
  await d.registry.call("vault.connections.sync", {}, "cli");
  assert.ok(!ok(await cli("vault.connections.list")).connections.some(r => r.ref === "postbox-northwind"));

  // Events carry ids and names only.
  assert.ok(events("vault.connection-added").length >= 5);
  assert.ok(events("vault.connection-removed").some(e => e.payload.id === lost.id));
  assert.ok(events("vault.connection-changed").some(e => e.payload.id === g.id && e.payload.fields.includes("label")));
  const added = events("vault.connection-added").find(e => e.payload.id === g.id);
  assert.deepEqual(added.payload, { id: g.id, source: "google", provider: "google-dwd", account: "kit@northwind.test" });

  // No value in any reply, event or log line, and no secret field name in a listing.
  const text = JSON.stringify(outs) + JSON.stringify(d.registry.deps.events.since(0, { limit: 5000 })) + lines.join("\n");
  for (const x of values) assert.ok(!text.includes(x), "a value leaked");
  const listing = JSON.stringify(ok(await cli("vault.connections.list")));
  for (const f of ["imap_host", "smtp_port", "username", "\"value\""]) assert.ok(!listing.includes(f), `a field name (${f}) in a listing`);
});

const FAKE_MCP = path.join(import.meta.dirname, "..", "mcp", "testing", "fake-mcp.js");
const stdio = (name, log) => ({ name, transport: "stdio", command: process.execPath, args: [FAKE_MCP, "--stdio"], vars: { FAKE_MCP_LOG: log } });

test("connections: google.accounts and mcp.servers are read on their events; registered rows are left alone", async t => {
  const { root, d, as, inproc, events } = await boot(t);
  const cli = as("cli"), capsule = as("capsule");
  const google = inproc("module:google"), mail = inproc("module:mail");
  const ok = r => { assert.ok(!r.error, JSON.stringify(r.error)); return r.data; };
  const rows = async (caller = cli) => ok(await caller("vault.connections.list")).connections;
  const find = async (source, ref) => (await rows()).find(r => r.source === source && r.ref === ref);

  // A Google account whose service-account item is the account's, not a vault row of its own.
  ok(await cli("vault.put", { name: "google-northwind-sa", kind: "api-key", fields: { value: hex(20) }, details: { provider: "google-dwd" } }));
  assert.ok(await find("vault", "google-northwind-sa"));
  ok(await cli("vault.grant", { name: "google-northwind-sa", module: "google" }));
  ok(await cli("google.add", { name: "northwind", email: "kit@northwind.test", auth: { type: "service-account", item: "google-northwind-sa" } }));
  let g = await find("google", "northwind");
  assert.ok(g, "google.added resynced the google rows");
  assert.match(g.id, ID);
  assert.deepEqual({ provider: g.provider, account: g.account, auth: g.auth, state: g.state, surfaces: g.surfaces },
    { provider: "google-dwd", account: "kit@northwind.test", auth: "service-account", state: "ready", surfaces: ["capsule", "chat"] });
  assert.deepEqual(g.capabilities, ["send_mail", "read_mail", "calendar"]);
  assert.deepEqual(g.uses, { send_mail: { tool: "mail.send", input: { account: g.id } }, read_mail: { tool: "mail.search", input: { account: g.id } },
    calendar: { tool: "google.calendar.list", input: { account: "northwind" } } });
  assert.equal(await find("vault", "google-northwind-sa"), undefined, "the item is claimed by the account");

  // MCP servers: capabilities from the cached tools. A mail server's send_message sends mail.
  ok(await cli("mcp.add", stdio("gmail-kit", path.join(root, "gmail.log"))));
  ok(await cli("mcp.add", stdio("tracker", path.join(root, "tracker.log"))));
  const gm = await find("mcp", "gmail-kit"), tr = await find("mcp", "tracker");
  assert.deepEqual(gm.capabilities, ["send_mail"]);
  assert.deepEqual(gm.uses.send_mail, { tool: "mail.send", input: { account: gm.id } });
  assert.deepEqual(tr.capabilities, ["send_message"]);
  assert.deepEqual(tr.uses.send_message, { tool: "mcp.call", input: { server: "tracker", tool: "send_message" } });
  assert.deepEqual((ok(await capsule("vault.connections.list", { capability: "send_mail" })).connections).map(r => r.ref).sort(), ["gmail-kit", "northwind"]);

  // A person's grant and label survive a resync; the id stays.
  ok(await cli("vault.connections.grant", { id: g.id, surface: "agents" }));
  ok(await cli("vault.connections.update", { id: g.id, label: "Northwind orders" }));
  ok(await cli("google.add", { name: "northwind", email: "kit@northwind.test", auth: { type: "service-account", item: "google-northwind-sa" } }));
  ok(await cli("vault.connections.sync"));
  g = await find("google", "northwind");
  assert.equal(g.label, "Northwind orders");
  assert.deepEqual(g.surfaces, ["capsule", "chat", "agents"]);

  // A row a module registered under the same source is its own: a sync leaves it.
  const reg = ok(await google("vault.connections.register", { ref: "harlow", provider: "google-oauth", account: "alex@harlowlegal.test", auth: "oauth", capabilities: ["send_mail"] }));
  ok(await cli("vault.connections.sync"));
  assert.equal((await find("google", "harlow")).id, reg.id);

  // A module (mail.release, after the Gate) reads a row by id with no surface attached.
  const got = ok(await mail("vault.connections.get", { id: gm.id })).connection;
  assert.equal(got.ref, "gmail-kit"); assert.deepEqual(got.uses.send_mail, { tool: "mail.send", input: { account: gm.id } });

  // Gone from the source, gone from the table.
  ok(await cli("google.remove", { name: "northwind" }));
  ok(await cli("mcp.remove", { name: "tracker" }));
  assert.equal(await find("google", "northwind"), undefined);
  assert.equal(await find("mcp", "tracker"), undefined);
  assert.ok(await find("vault", "google-northwind-sa"), "the item is a vault row again");
  assert.ok(await find("google", "harlow"), "the registered row stays");
  assert.ok(events("vault.connection-removed").some(e => e.payload.id === g.id));
  void d;
});
