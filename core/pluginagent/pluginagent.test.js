// @ts-check
// Claude Code on this computer, granted once (lead's ruling, 4 Oct), on a real daemon with the kernel on: a bare model files an ask and reads nothing; the person's grant registers the agent and writes a 0600 key;
// the plugin's calls then carry that agent (label + key) and vyred stamps its kernel token, so it reads personal memory and every project's sessions, never as the person; a wrong key, another agent's
// label and a revoked grant are refused.
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
/** The plugin's own MCP server (the real entry), spoken to over stdio until `want` replies arrive. */
async function mcp(/** @type {string} */ home, /** @type {any[]} */ msgs, /** @type {number} */ want) {
  const env = { ...process.env, VYRE_HOME: home }; delete env.VYRE_SOCKET; delete env.VYRE_AGENT;
  const p = spawn(process.execPath, [SERVER], { env });
  const replies = new Map(), waiting = new Map(); let buf = "";
  p.stdout.on("data", c => { buf += c; for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); waiting.get(m.id)?.(m); } });
  for (const m of msgs) { const a = "id" in m && new Promise(r => waiting.set(m.id, r)); p.stdin.write(JSON.stringify(m) + "\n"); if (a) await a; if (replies.size >= want) break; }
  p.kill();
  return replies;
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("grant once: ask, approve, then the plugin's calls are that agent's, with its token, never the person", { timeout: 180_000 }, async t => {
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
  const everywhere = [...new Set(((await call("recall.search", { q: "intake form" }, opts)).data || []).map((/** @type {any} */ h) => String(h.cwd).replace(root, "")))].sort();
  assert.ok(everywhere.length >= 1);

  // 1. A bare model: files an ask, is not granted, reads nothing of the person's memory.
  // The plugin's own server asks, once, by itself, the first time it runs here.
  await mcp(root, [INIT, LIST], 2);
  await new Promise(r => setTimeout(r, 500));
  const waiting = (await call("pluginagent.pending", {}, opts)).data || [];
  assert.equal(waiting.length, 1, "the plugin filed one ask: " + JSON.stringify(waiting));
  await mcp(root, [INIT, LIST], 2); await new Promise(r => setTimeout(r, 500));
  assert.equal(((await call("pluginagent.pending", {}, opts)).data || []).length, 1, "the same ask is not filed twice");
  const asked = { data: { id: waiting[0].id } };
  assert.equal((await call("pluginagent.status", {}, { root, caller: "mcp" })).data.granted, false);
  const bare = await call("memory.profile", {}, { root, caller: "mcp" });
  assert.ok(bare.error || !JSON.stringify(bare.data || "").includes("Jordan"), "a bare mcp reads no personal memory");
  assert.ok((await call("pluginagent.grant", { id: asked.data.id }, { root, caller: "mcp" })).error, "a model cannot grant");
  assert.ok(!fs.existsSync(path.join(root, "plugin-agent.json")));
  assert.equal(((await call("pluginagent.pending", {}, opts)).data || []).length, 1, "the person sees the ask");

  // 2. The person grants: the agent exists, the key file is the OS user's alone.
  const g = await call("pluginagent.grant", { id: asked.data.id }, proof);
  assert.ok(!g.error, JSON.stringify(g));
  const file = path.join(root, "plugin-agent.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { agent, key } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(agent, /^claude-code-/);
  assert.ok(((await call("agents.list", {}, opts)).data || []).some((/** @type {any} */ a) => a.name === agent && a.personal === true));
  assert.equal((await call("pluginagent.grant", { id: asked.data.id }, proof)).error.code, "conflict", "granted once");

  // 3. The plugin's calls: label + key. Reads personal memory and every project's sessions; its remember stays a pending note.
  const as = { root, caller: `mcp:agent:${agent}`, headers: { "x-vyre-agent-key": key } };
  const mine = await call("memory.profile", {}, as);
  assert.ok(!mine.error && JSON.stringify(mine.data).includes("Jordan"), "reads personal memory: " + JSON.stringify(mine).slice(0, 200));
  const hits = [...new Set(((await call("recall.search", { q: "intake form" }, as)).data || []).map((/** @type {any} */ h) => String(h.cwd).replace(root, "")))].sort();
  assert.deepEqual(hits, everywhere, "recalls across projects");
  const rem = await call("memory.remember", { text: "my wife is Mallory" }, as);
  assert.equal(rem.data && rem.data.pending, true, JSON.stringify(rem).slice(0, 200));
  assert.ok(!JSON.stringify((await call("memory.profile", {}, opts)).data).includes("Mallory"), "it never writes as the person");
  assert.ok((await call("memory.pin", { node: "Dana Reyes" }, as)).error, "it cannot steer the whole graph");

  // 3b. Through the plugin's actual MCP server: once granted it needs no prompt and no env, only the home's key file.
  const via = await mcp(root, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_profile", arguments: {} } }], 2);
  const reply = via.get(2).result;
  assert.ok(!reply.isError && JSON.stringify(reply).includes("Jordan"), "the plugin's own server reads personal memory as the granted agent: " + JSON.stringify(reply).slice(0, 200));

  // 4. Refusals: a wrong key, a label naming another agent with this key, a key with no label, a client-sent kernel token.
  assert.equal((await call("memory.profile", {}, { ...as, headers: { "x-vyre-agent-key": "nope" } })).error.code, "denied");
  assert.equal((await call("memory.profile", {}, { root, caller: "mcp:agent:other", headers: { "x-vyre-agent-key": key } })).error.code, "denied");
  assert.equal((await call("memory.profile", {}, { root, caller: "mcp", headers: { "x-vyre-agent-key": key } })).error.code, "denied");
  assert.ok((await call("memory.profile", {}, { ...as, headers: { ...as.headers, "x-vyre-kernel-session": "a.b" } })).data, "a token the client sends is replaced by the daemon's own");

  // 5. Revoked: the key is dead at once and the file is gone.
  assert.ok(!(await call("pluginagent.revoke", {}, proof)).error);
  assert.ok(!fs.existsSync(file));
  assert.equal((await call("memory.profile", {}, as)).error.code, "denied");
});
