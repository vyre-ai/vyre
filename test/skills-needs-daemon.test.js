// @ts-check
// A plugin's MCP server that needs keys, on a REAL vyred: the plugin names variables and nothing else; an unpinned command or a variable that changes how a program loads is refused at the draft; the approval
// stores only the name of the Vault item chosen; the hub row waits for its grant (never starts); the key is in no file written for an AI; a change to a need is a new ack and updates the row. Run it on a test box.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";

const VALUE = "fixture-notes-key-9f8e7d6c5b4a-do-not-print";
const skill = (/** @type {string} */ name) => `---\nname: ${name}\ndescription: Use this when the team needs the ${name} routine done the same way each time.\n---\nDo the careful thing first.\n`;
const plugin = (/** @type {any} */ over = {}) => ({
  name: "notes", description: "Notes helpers: a skill and an MCP server that needs an API key.",
  skills: [{ name: "note-taking", body: skill("note-taking") }],
  mcp: [{ name: "notes", transport: "stdio", command: "npx", args: ["-y", "notes-mcp@1.2.3"], needs: [{ var: "NOTES_API_KEY", label: "Notes API key" }], ...over }],
});

test("a plugin server with needs: refused when unpinned or when a variable is unsafe; approved with item names only; waiting for its grant; in no file written for an AI; a changed need is a new ack", { timeout: 120_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {}, presence: present, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => { const r = await d.registry.call(tool, input, caller); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code, error: r.error }); return r.data; };
  const draft = (/** @type {any} */ p, name = "notes") => call("skills.draft", { name, level: "personal", kind: "plugin", body: JSON.stringify(p) });
  const refused = async (/** @type {Promise<any>} */ p) => p.then(() => assert.fail("was not refused"), (/** @type {Error} */ e) => e.message);

  // refused at the draft
  assert.match(await refused(draft(plugin({ args: ["-y", "notes-mcp"] }))), /pinned/);
  assert.match(await refused(draft(plugin({ args: ["-y", "notes-mcp@latest"] }))), /pinned/);
  assert.match(await refused(draft(plugin({ command: "/usr/local/bin/notes", args: [] }))), /pinned/);
  assert.match(await refused(draft(plugin({ command: "docker", args: ["run", "--rm", "-i", "--privileged", "notes@sha256:" + "a".repeat(64)] }))), /pinned/);
  for (const v of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "HTTPS_PROXY", "VYRE_AGENT_KEY", "SSL_CERT_FILE", "PYTHONPATH"]) assert.match(await refused(draft(plugin({ needs: [{ var: v, label: "x" }] }))), /cannot ask for it/, v);
  assert.match(await refused(draft(plugin({ needs: Array.from({ length: 6 }, (_, i) => ({ var: `K${i}`, label: "key" })) }))), /1 to 5/);
  assert.match(await refused(draft(plugin({ needs: [{ var: "NOTES_API_KEY", label: "Notes API key", value: VALUE }] }))), /nothing else/);
  assert.match(await refused(draft(plugin({ transport: "http", command: undefined, args: undefined, url: "https://mcp.example.com/notes" }))), /stdio/);

  // a pinned npx, and a pinned container, are accepted
  const dr = await draft(plugin());
  assert.deepEqual(dr.declares.mcp[0].needs, [{ var: "NOTES_API_KEY", label: "Notes API key" }]);
  assert.ok((await draft({ ...plugin({ command: "docker", args: ["run", "--rm", "-i", "-e", "NOTES_API_KEY", "ghcr.io/example/notes-mcp@sha256:" + "b".repeat(64)] }), name: "box-notes" }, "box-notes")).ack);

  // the card says whose key it is
  const gate = await call("skills.approve", { name: "notes", level: "personal", version: 1 }).catch(e => e);
  assert.equal(gate.code, "needs_ack");
  assert.match(gate.error.message, /Only your own calls use this key\./);

  // the item exists in the Vault; its value must appear nowhere below
  await call("vault.put", { name: "notes-key", kind: "secret", value: VALUE });
  const approved = await call("skills.approve", { name: "notes", level: "personal", version: 1, ack: dr.ack, items: { "notes.NOTES_API_KEY": "notes-key" } });
  assert.equal(approved.state, "approved");
  assert.deepEqual(approved.connections, ["p-notes-notes"]);
  const servers = await call("mcp.servers", {});
  const sv = (Array.isArray(servers) ? servers : servers.servers || []).find((/** @type {any} */ s) => s.name === "p-notes-notes");
  assert.ok(sv, JSON.stringify(servers).slice(0, 300));
  assert.equal(sv.state, "needs_key", "no grant to this one server and variable: it waits and was never started");
  assert.deepEqual(sv.env, { NOTES_API_KEY: "notes-key" }, "the row names the item");

  // the Needs-you queue shows the waiting key as one card per variable, in plain words
  const keys = await call("mcp.keys.waiting", {});
  assert.deepEqual(keys.servers.map((/** @type {any} */ x) => [x.name, x.plugin, x.waiting.map((/** @type {any} */ w) => w.var)]), [["p-notes-notes", "notes", ["NOTES_API_KEY"]]]);
  const queue = await call("approvals.items", {}).catch(() => null);
  if (queue) assert.ok(queue.items.some((/** @type {any} */ c) => c.id === "mcp:p-notes-notes:NOTES_API_KEY" && c.title === "notes needs a key: NOTES_API_KEY"), "and it is a card");
  assert.ok(!JSON.stringify([keys, queue]).includes(VALUE));

  // the value is nowhere a record, a version, a listing or a file could hold it
  const everything = JSON.stringify([await call("skills.versions", { name: "notes", level: "personal" }), await call("skills.list", {}), servers, await call("mcp.tools", {}).catch(() => null)]);
  assert.ok(!everything.includes(VALUE));

  // a server with needs is in no file written for an AI, and no environment is
  for (const ai of ["claude", "codex", "grok"]) {
    const m = await call("skills.materialise", { ai }, "module:vyred");
    assert.ok(m.dir, ai);
    const files = /** @type {string[]} */ (fs.readdirSync(m.dir, { recursive: true }).map(String));
    assert.ok(!files.some(f => /(^|\/)\.?mcp\.json$/.test(f)), `${ai}: no MCP file for a server that needs a key: ${files.join(", ")}`);
    for (const f of files) { const full = path.join(m.dir, f); if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, "utf8").includes(VALUE), `${ai}/${f}`); }
  }

  // a changed need is a new ack, and approving it updates the row (a new choice of item)
  const v2 = await draft(plugin({ needs: [{ var: "NOTES_API_KEY", label: "Notes API key" }, { var: "NOTES_WORKSPACE", label: "Notes workspace id" }] }));
  assert.notEqual(v2.ack, dr.ack, "adding a need changes what the card says yes to");
  assert.equal((await call("skills.approve", { name: "notes", level: "personal", version: 2, ack: dr.ack }).catch(e => e)).code, "needs_ack");
  await call("skills.approve", { name: "notes", level: "personal", version: 2, ack: v2.ack, items: { "notes.NOTES_API_KEY": "notes-key-2" } });
  const probe = await call("mcp.test", { name: "p-notes-notes" });
  assert.equal(probe.ok, false, "tried again with the new choice: still no grant, so it waits");
  const after = await call("mcp.servers", {});
  const sv2 = (Array.isArray(after) ? after : after.servers || []).find((/** @type {any} */ s) => s.name === "p-notes-notes");
  assert.deepEqual(sv2.env, { NOTES_API_KEY: "notes-key-2" }, "the new choice replaced the old one; NOTES_WORKSPACE has no item yet");
  assert.equal(sv2.state, "needs_key");
});
