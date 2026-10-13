// @ts-check
// The person's own AI, connected (core/mcpconn), on a real daemon with the kernel on. The person connects once with presence; from then on a call on the connection is the person's own: the
// person-only setup tools work for it as in the app, outward acts and the person's face-and-key tools do not, a revoke ends it at once, and nothing but the person's own call can make one.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("connect once, then the client is the person: setup tools work, the person's keys and outward acts do not, revoke ends it", { timeout: 240_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, presence: present, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  const proof = { root, headers: { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") } };
  const noted = /** @type {any[]} */ ([]);
  d.registry.deps.events?.on?.("mcpconn.did", (/** @type {any} */ e) => noted.push(e));

  // Not connected: a plain mcp caller has no setup tools; a forged key is refused outright.
  assert.ok((await call("projects.create", { name: "Harlow Legal", home: path.join(work, "harlow") }, { root, caller: "mcp" })).error, "a plain mcp caller has no setup tools");
  assert.equal((await call("projects.list", {}, { root, caller: "mcp", headers: { "x-vyre-mcp-id": "mcn_x", "x-vyre-mcp-key": "nope" } })).error.code, "denied");
  // Only the person connects, and a model cannot.
  assert.ok((await call("mcpconn.connect", {}, { root, caller: "mcp" })).error, "a model cannot connect itself");
  const made = await call("mcpconn.connect", { client: "Claude Code" }, proof);
  assert.ok(!made.error, JSON.stringify(made));
  assert.match(made.data.lines.codex, /codex mcp add vyre/);
  const file = path.join(root, "mcp-connection.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the secret is readable by this OS user only");
  const { id, key } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(id, made.data.id);
  assert.ok(!JSON.stringify((await call("mcpconn.list", {}, opts)).data).includes(key), "the list never holds the secret");
  const as = { root, caller: "mcp", headers: { "x-vyre-mcp-id": id, "x-vyre-mcp-key": key } };

  // As the person: the setup tools, including the ones the person alone does in the app.
  const proj = await call("projects.create", { name: "Harlow Legal", home: path.join(work, "harlow") }, as);
  assert.ok(!proj.error, JSON.stringify(proj));
  assert.ok(!(await call("agents.create", { name: "intake-bot", instructions: "Answer intake.", projects: [] }, as)).error, "an agent");
  const def = await call("records.define", { diff: { add_types: [{ name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name" }] }] } }, as);
  assert.ok(!def.error, "records.define as the person: " + JSON.stringify(def).slice(0, 300));
  const types = await call("records.types", {}, as);
  assert.ok((types.data.types || []).some((/** @type {any} */ x) => x.name === "client"), JSON.stringify(types).slice(0, 200));
  assert.ok(!(await call("import.sessions.list", {}, as)).error, "the sessions scan is the person's");
  assert.match((await call("mcpconn.guide", {}, as)).data.guide, /import_sessions_run/);

  // What stays the person's: connecting and revoking themselves, their keys, pairing, the vault, a face.
  for (const [tool, input] of [["mcpconn.connect", {}], ["mcpconn.revoke", { id }], ["pluginagent.grant", {}], ["vault.provider.set", { provider: "x" }], ["presence.keys", {}]]) {
    const r = await call(tool, input, as);
    assert.ok(r.error, `${tool} is not for a connected client: ${JSON.stringify(r).slice(0, 120)}`);
  }
  assert.ok(!(await request("GET", "/v1/tools", undefined, as)).error, "it lists tools");

  // An outward act is still held for it, like any model's: it does not run on the person's say-so alone.
  const sent = await call("mail.send", { to: ["x@example.com"], subject: "hi", body: "hi" }, as);
  assert.equal(sent.error && sent.error.code, "held_for_approval", "mail.send waits at the Gate: " + JSON.stringify(sent).slice(0, 200));

  // Each change is noted by tool name, never input.
  assert.ok(noted.some(n => n.payload.tool === "projects.create" && n.payload.ok === true && n.payload.says === "via your Claude Code"), JSON.stringify(noted));
  assert.ok(noted.every(n => !JSON.stringify(n).includes("Harlow")), "no input in the note");

  // Revoke: the same key is refused at once.
  const rv = await call("mcpconn.revoke", { id }, opts);
  assert.ok(!rv.error, JSON.stringify(rv));
  assert.equal((await call("projects.list", {}, as)).error.code, "denied");
  assert.ok(!fs.existsSync(file), "the file went with it");
  assert.equal((await call("mcpconn.list", {}, opts)).data[0].revoked, true);
});
