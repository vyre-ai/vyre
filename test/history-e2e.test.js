// @ts-check
// "Build history from my sessions", end to end (the user's real use, #26): a real box with its own sessions, a real Mac paired to it
// with Claude Code, Codex and Grok history, on the simulated tailnet (test/link-harness.js). The person imports through the Mac's own tools,
// then presses "Index your history" on the box (recall.index): the box's own sessions AND the Mac's imported ones are read, and memory
// (curated from them) shows what it learned from both. Runs where the link tests run (a runner or the test box). Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pair, until } from "./link-harness.js";

const BOX_CWD = "/home/alex/Work/harlow-site", MAC_CWD = "/home/alex/Work/northwind";
const T = Date.parse("2026-09-10T10:00:00Z");

test("history: the box's own sessions and a paired Mac's imported ones are indexed and memory shows what it learned from both", { timeout: 120_000 }, async t => {
  const s = await pair(t, { router: true, boxSynced: true, boxTranscripts: [
    { id: "22222222-0000-4000-8000-000000000001", cwd: BOX_CWD, start: T, turns: [
      { role: "user", text: "Dana Reyes at Harlow Legal wants the intake form hosted on Netlify, and the staging host is kestrel-stage.example" },
      { role: "assistant", text: "Noted: Dana Reyes owns the Harlow Legal intake site, hosted on Netlify." }] },
  ] });
  const root = s.macRoot;
  const claude = path.join(root, "claude", "projects", "-home-alex-Work-northwind");
  fs.mkdirSync(claude, { recursive: true });
  const cid = "11111111-0000-4000-8000-000000000001";
  fs.writeFileSync(path.join(claude, `${cid}.jsonl`), [
    { type: "user", sessionId: cid, cwd: MAC_CWD, timestamp: "2026-09-11T10:00:00.000Z", message: { role: "user", content: "Sam Okafor at Northwind Bakery wants the opening hours page and the loyalty card" } },
    { type: "assistant", sessionId: cid, cwd: MAC_CWD, timestamp: "2026-09-11T10:00:05.000Z", message: { role: "assistant", content: "Sam Okafor asked for the Northwind opening hours page, payments through Square." } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const day = path.join(root, "codex", "sessions", "2026", "09", "12");
  fs.mkdirSync(day, { recursive: true });
  const xid = "0198aaaa-bbbb-4ccc-8ddd-000000000009";
  fs.writeFileSync(path.join(day, `rollout-2026-09-12T10-00-00-${xid}.jsonl`), [
    { timestamp: "2026-09-12T10:00:00.000Z", type: "session_meta", payload: { id: xid, cwd: MAC_CWD } },
    { timestamp: "2026-09-12T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add the Northwind footer with the bakery phone number for Sam Okafor" }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  // Grok Build: sessions/<folder, percent-encoded>/<uuid>/{summary.json, chat_history.jsonl}.
  const gid = "01a0f5b1-e161-7e03-b226-4355ecb027eb";
  const gdir = path.join(root, "grok", "sessions", encodeURIComponent(MAC_CWD), gid);
  fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, "summary.json"), JSON.stringify({ info: { id: gid, cwd: MAC_CWD }, created_at: "2026-09-13T10:00:00Z", updated_at: "2026-09-13T10:05:00Z" }));
  fs.writeFileSync(path.join(gdir, "chat_history.jsonl"), [
    { type: "system", content: "You are Grok Build." },
    { type: "user", content: [{ type: "text", text: "Sam Okafor wants the Northwind marzipan seasonal page on the bakery site" }] },
    { type: "assistant", content: "Added the marzipan seasonal page for Sam Okafor at Northwind Bakery." },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  s.mac.config.transcripts = [path.join(root, "claude", "projects")];
  s.mac.config.name = "test-mac";

  const mac = async (tool, input = {}) => { const r = await s.macCall(tool, input, "deck"); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const box = async (tool, input = {}) => { const r = await s.boxCall(tool, input, "deck"); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };

  // Before anything is imported: the box reads only its own session, and says so.
  await box("recall.index");
  assert.equal((await box("recall.status")).sessions, 1, "only the server's own session before the import");

  // The person imports through the Mac's own tools (Lumen and the Windows app call these).
  const scan = await mac("import.scan");
  assert.deepEqual(scan.sources.map((/** @type {any} */ x) => x.agent).sort(), ["claude-code", "codex", "grok"]);
  const plan = await mac("import.plan", { include: [MAC_CWD] });
  assert.equal(plan.sessions, 3);
  await mac("import.start", { plan: plan.plan, mode: "once", pace: "gentle" });
  const landed = path.join(s.boxRoot, "synced", "test-mac");
  const count = () => { let n = 0; const walk = (/** @type {string} */ d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".jsonl") && n++; }; walk(landed); return n; };
  await until(() => count() >= 3);

  // "Index your history" on the box: both the server's session and the Mac's two imported ones.
  await box("recall.index");
  assert.equal((await box("recall.status")).sessions, 4, "the server's session plus the Mac's three imported sessions");
  const hit = async (/** @type {string} */ q) => JSON.stringify(await box("recall.search", { q, limit: 5 }));
  assert.match(await hit("Dana Reyes Netlify"), /Dana Reyes/, "the server's own session is searchable");
  assert.match(await hit("Sam Okafor opening hours"), /Sam Okafor/, "the Mac's imported session is searchable");
  assert.match(await hit("marzipan seasonal page"), /marzipan/i, "and so is its Grok session");

  // Memory learns from what was read: its graph holds both worlds.
  // Nobody presses a second button: memory curates when the index says a session was read.
  await until(async () => (await box("memory.stats")).nodes > 0);
  const stats = await box("memory.stats");
  assert.ok(stats.nodes > 0, `memory has learned something: ${JSON.stringify(stats).slice(0, 200)}`);
  await until(async () => /Sam Okafor/.test(JSON.stringify(await box("memory.graph", { limit: 200 }))));
  const graph = JSON.stringify(await box("memory.graph", { limit: 200 }));
  assert.match(graph, /Dana Reyes/, "memory knows what the server's session said");
  assert.match(graph, /Sam Okafor/, "and what the Mac's imported sessions said");
});
