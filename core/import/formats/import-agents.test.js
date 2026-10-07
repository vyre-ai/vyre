// @ts-check
// import.scan / plan / start with Codex and Gemini CLI sessions in a temp home: a source per agent,
// filed by folder, and what is sent is the converted Claude-shaped copy, staged and then removed.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../../store/index.js";
import { tempHome } from "../../../test/helpers.js";
import mod from "../index.js";
import { hashOf } from "./gemini.js";

test("import: Codex and Gemini CLI appear as sources, plan by folder, and send converted files", async t => {
  const root = tempHome(t);
  const cwd = "/home/alex/Work/northwind";
  const day = path.join(root, "codex", "sessions", "2026", "09", "12");
  fs.mkdirSync(day, { recursive: true });
  const id = "0198aaaa-bbbb-4ccc-8ddd-000000000009";
  fs.writeFileSync(path.join(day, `rollout-2026-09-12T10-00-00-${id}.jsonl`), [
    { timestamp: "2026-09-12T10:00:00.000Z", type: "session_meta", payload: { id, cwd } },
    { timestamp: "2026-09-12T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add opening hours" }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const chats = path.join(root, "gemini", "tmp", hashOf(cwd), "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "session-2026-09-13T09-00-cccc3333.json"), JSON.stringify({ sessionId: "g1", messages: [{ id: "a", timestamp: "2026-09-13T09:00:01.000Z", type: "user", content: "Hello juno" }] }));
  fs.writeFileSync(path.join(root, "codex", "auth.json"), "{\"OPENAI_API_KEY\":\"SECRET\"}");
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const tools = new Map(), sent = [];
  const ctx = {
    name: "import", config: { name: "alex", transcripts: [] }, paths: { root },
    store: { db, migrate: steps => migrate(db, "import", steps) }, log: () => {}, events: { on: () => () => {}, emit: () => {} },
    call: async (tool, input) => {
      if (tool === "projects.list") return { data: { projects: [{ slug: "northwind", name: "Northwind Bakery", folders: [cwd] }] } };
      if (tool === "sync.send") { for (const f of input.files) sent.push({ rel: f.rel, bytes: f.bytes, text: fs.readFileSync(f.path, "utf8"), path: f.path }); return { sent: input.files.length, failed: 0, quarantined: 0 }; }
      if (tool === "sync.consent" || tool === "memory.pace") return { data: {} };
      return { data: {} };
    },
    tool: (name, def) => tools.set(name, def),
  };
  const h = await mod.start(ctx);
  t.after(() => h.stop());
  const run = async (name, input) => tools.get(name).run(input, { caller: "deck" });
  const s = await run("import.scan", {});
  assert.deepEqual(s.sources.map(x => [x.agent, x.sessions]), [["codex", 1], ["gemini-cli", 1]]);
  assert.equal(s.sources[1].folders[0].project, "northwind", "filed by the hash of a known project's folder");
  assert.doesNotMatch(JSON.stringify(s), /SECRET/);
  const p = await run("import.plan", { include: [cwd] });
  assert.equal(p.sessions, 2);
  await run("import.start", { plan: p.plan, mode: "once", pace: "gentle" });
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 2);
  const folder = "-home-alex-Work-northwind";
  assert.deepEqual(sent.map(x => x.rel).sort(), [`${folder}/${id}.jsonl`, `${folder}/gemini-session-2026-09-13T09-00-cccc3333.jsonl`]);
  assert.ok(sent.every(x => x.bytes === Buffer.byteLength(x.text) && JSON.parse(x.text.split("\n")[0]).cwd === cwd));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(sent.every(x => !fs.existsSync(x.path)), "the staged copies are removed");
});
