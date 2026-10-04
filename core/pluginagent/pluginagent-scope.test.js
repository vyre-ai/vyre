// @ts-check
// Claude Code on this computer on a real daemon with the kernel on, in the two cases the grant must not widen:
// (1) not granted yet: the plugin reads only the project of the session it runs in, never personal memory and never another project;
// (2) another OS user: the key file and the daemon's socket are the owner's alone, and a plugin that has no key (its own home, or a copied agent label) gets nothing, even pointed at this daemon.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome, present } from "../../test/helpers.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "mcp", "server.js");
/** The plugin's own MCP server (the real entry) with the given env, spoken to over stdio until `want` replies arrive. */
async function mcp(/** @type {Record<string, string>} */ env, /** @type {any[]} */ msgs, /** @type {number} */ want) {
  const e = { ...process.env, ...env }; delete e.VYRE_AGENT; if (!env.VYRE_SOCKET) delete e.VYRE_SOCKET;
  const p = spawn(process.execPath, [SERVER], { env: e });
  const replies = new Map(), waiting = new Map(); let buf = "";
  p.stdout.on("data", c => { buf += c; for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); waiting.get(m.id)?.(m); } });
  for (const m of msgs) { const a = "id" in m && new Promise(r => waiting.set(m.id, r)); p.stdin.write(JSON.stringify(m) + "\n"); if (a) await a; if (replies.size >= want) break; }
  p.kill();
  return replies;
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const PROFILE = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_profile", arguments: {} } };

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("not granted: the plugin reads only its own session's project; another OS user's plugin, or a copied label, gets nothing", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir, SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) })));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, presence: present, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  const proof = { root, headers: { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") } };
  await call("recall.index", {}, opts);
  for (const [name, home, ws] of [["Northwind", "northwind", []], ["Harlow", "harlow-site", [path.join(work, "harlow-intake")]]]) assert.ok(!(await call("projects.create", { name, home: path.join(work, home), workspaces: ws }, opts)).error);
  assert.ok(!(await call("memory.remember", { text: "my wife is Jordan" }, opts)).error);
  await call("memory.curate", {}, opts);
  const folders = (/** @type {any} */ r) => [...new Set((r.data || []).map((/** @type {any} */ h) => String(h.cwd).replace(root, "")))];
  const everywhere = folders(await call("recall.search", { q: "intake form" }, opts));
  assert.ok(everywhere.length >= 2, "the corpus spans projects: " + JSON.stringify(everywhere));

  // 1. Not granted. The plugin runs in a session bound to its claude process (meta.thread, vouched by the daemon): that session's project, nothing else.
  const own = await d.registry.call("recall.search", { q: "intake form" }, "mcp", { thread: "11111111-aaaa-4000-8000-000000000001" });
  const ownFolders = folders(own);
  assert.ok(!own.error && ownFolders.length > 0 && ownFolders.every(f => /harlow/.test(f)), "its own project only: " + JSON.stringify(ownFolders));
  const other = await d.registry.call("recall.search", { q: "intake form" }, "mcp", { thread: "11111111-aaaa-4000-8000-000000000003" });
  assert.ok(!other.error && !folders(other).some(f => /harlow/.test(f)), "a Northwind session finds nothing of Harlow");
  assert.equal((await call("pluginagent.status", {}, { root, caller: "mcp" })).data.granted, false);
  const unsaid = await d.registry.call("memory.profile", {}, "mcp", { thread: "11111111-aaaa-4000-8000-000000000001" });
  assert.ok(unsaid.error || !JSON.stringify(unsaid.data || "").includes("Jordan"), "no personal memory without the grant");
  const via = await mcp({ VYRE_HOME: root }, [INIT, PROFILE], 2);
  assert.ok(!JSON.stringify(via.get(2)).includes("Jordan"), "the plugin's own server, not granted, reads no personal memory");

  // 2. Granted, then another OS user. Their plugin has its own home (no key file); the key file and the daemon's socket are the owner's alone.
  const asked = (await call("pluginagent.ask", {}, { root, caller: "mcp" })).data;
  const g = await call("pluginagent.grant", { id: asked.id }, proof);
  assert.ok(!g.error, JSON.stringify(g));
  const file = path.join(root, "plugin-agent.json");
  assert.equal(fs.statSync(file).mode & 0o077, 0, "the key file is the OS user's alone");
  assert.equal(fs.statSync(d.socket || path.join(root, "vyred.sock")).mode & 0o077, 0, "the daemon's socket is the OS user's alone");
  const { agent, key } = JSON.parse(fs.readFileSync(file, "utf8"));
  const theirHome = fs.realpathSync(tempHome(t));
  const asThem = await mcp({ VYRE_HOME: theirHome }, [INIT, PROFILE], 2);
  assert.ok(!JSON.stringify(asThem.get(2)).includes("Jordan"), "another OS user's plugin reads nothing of this person's memory");
  assert.equal((await call("memory.profile", {}, { root, caller: `mcp:agent:${agent}` })).error.code, "denied", "the copied label with no key");
  assert.equal((await call("memory.profile", {}, { root, caller: `mcp:agent:${agent}`, headers: { "x-vyre-agent-key": "x".repeat(key.length) } })).error.code, "denied", "the copied label with a guessed key");
});
