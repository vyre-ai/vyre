// @ts-check
// Import from other agents, end to end: a real Mac and a real box on the simulated tailnet
// (test/link-harness.js). The Mac has Claude Code, Codex and Gemini CLI histories (and a Codex
// login file that must never move); the person scans, plans and starts through the Mac's own
// tools; the sessions land on the box in Claude Code's shape, and the box's own reader parses
// every one of them. Nothing here touches a real ~/.claude, ~/.codex or ~/.gemini.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pair, until } from "./link-harness.js";
import { hashOf } from "../core/import/formats/gemini.js";

const CWD = "/home/alex/Work/northwind";

test("import: Claude Code, Codex and Gemini CLI sessions go from the Mac to the box, each readable there, and no login file moves", { timeout: 60_000 }, async t => {
  const s = await pair(t, { router: true });
  const root = s.macRoot;
  // Claude Code: its own folder, which the Mac's config names as a transcripts folder.
  const claude = path.join(root, "claude", "projects", "-home-alex-Work-northwind");
  fs.mkdirSync(claude, { recursive: true });
  const cid = "11111111-0000-4000-8000-000000000001";
  fs.writeFileSync(path.join(claude, `${cid}.jsonl`), JSON.stringify({ type: "user", sessionId: cid, cwd: CWD, timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "Draft the Northwind opening hours page" } }) + "\n");
  // Codex.
  const day = path.join(root, "codex", "sessions", "2026", "09", "12");
  fs.mkdirSync(day, { recursive: true });
  const xid = "0198aaaa-bbbb-4ccc-8ddd-000000000009";
  fs.writeFileSync(path.join(day, `rollout-2026-09-12T10-00-00-${xid}.jsonl`), [
    { timestamp: "2026-09-12T10:00:00.000Z", type: "session_meta", payload: { id: xid, cwd: CWD } },
    { timestamp: "2026-09-12T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add opening hours to the Northwind footer" }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(root, "codex", "auth.json"), "{\"OPENAI_API_KEY\":\"SECRET-CODEX-KEY\"}");
  // Gemini CLI.
  const chats = path.join(root, "gemini", "tmp", hashOf(CWD), "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "session-2026-09-13T09-00-cccc3333.json"), JSON.stringify({ sessionId: "g1", messages: [{ id: "a", timestamp: "2026-09-13T09:00:01.000Z", type: "user", content: "Suggest a name for the Northwind loyalty card" }] }));
  fs.writeFileSync(path.join(root, "gemini", "oauth_creds.json"), "{\"refresh_token\":\"SECRET-GEMINI-TOKEN\"}");
  s.mac.config.transcripts = [path.join(root, "claude", "projects")];
  s.mac.config.name = "test-mac"; // the name the harness pairs the Mac under (a real Mac pairs under its hostname)

  const call = async (tool, input = {}) => { const r = await s.macCall(tool, input, "deck"); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const scan = await call("import.scan");
  assert.deepEqual(scan.sources.map(x => x.agent).sort(), ["claude-code", "codex", "gemini-cli"], JSON.stringify(scan.sources.map(x => [x.agent, x.sessions])));
  assert.ok(scan.sources.every(x => x.sessions === 1));
  assert.doesNotMatch(JSON.stringify(scan), /SECRET/, "a scan never carries a login");

  // Gemini names a session's folder only by a hash, so it is filed only when a project's folder matches: here none does, so it
  // is unticked, "the folder it ran in is unknown", and the person ticks it by its place instead.
  assert.equal(scan.sources.find(x => x.agent === "gemini-cli").folders[0].suggested, false);
  const plan = await call("import.plan", { include: [CWD, path.join(root, "gemini")] });
  assert.equal(plan.sessions, 3);
  await call("import.start", { plan: plan.plan, mode: "once", pace: "gentle" });
  const landed = path.join(s.boxRoot, "synced", "test-mac");
  const files = () => { const out = []; const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } }; walk(landed); return out; };
  await until(() => files().length >= 3);
  const got = files();
  assert.equal(got.length, 3, got.join("\n"));
  assert.ok(got.every(f => f.endsWith(".jsonl")), "all three are Claude Code's own shape");
  assert.ok(got.every(f => !/auth|oauth|creds/.test(path.basename(f))), "no login file");
  for (const f of got) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /SECRET/, "no secret inside a session either");

  // The box's own reader parses each one: a session with an id, the folder it ran in, and its first turn.
  const texts = got.map(f => fs.readFileSync(f, "utf8"));
  for (const want of ["Northwind opening hours page", "opening hours to the Northwind footer", "loyalty card"]) assert.ok(texts.some(x => x.includes(want)), want);
  assert.ok(texts.every(x => x.split("\n").filter(Boolean).every(l => { try { JSON.parse(l); return true; } catch { return false; } })), "every line is JSON");
  assert.equal(texts.filter(x => JSON.parse(x.split("\n")[0]).cwd === CWD).length, 2, "Claude Code's and Codex's keep the folder they ran in");
});

test("import: the onboarding page's caller (the loopback's own label) may scan, plan and read the status, but a model may not", { timeout: 30_000 }, async t => {
  const { start } = await import("../core/daemon/index.js");
  const { tempHome } = await import("./helpers.js");
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  for (const tool of ["import.scan", "import.status"]) {
    const r = await d.registry.call(tool, {}, "onboard");
    assert.notEqual(r.error && r.error.code, "denied", `${tool}: ${JSON.stringify(r.error)}`);
  }
  assert.equal((await d.registry.call("import.scan", {}, "mcp:agent:kit")).error.code, "denied");
  assert.equal((await d.registry.call("import.start", { plan: "x", mode: "once", pace: "gentle" }, "mcp")).error.code, "denied");
});
