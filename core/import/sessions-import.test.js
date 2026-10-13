// @ts-check
// sessions.import.*: the person's own Claude Code brings old sessions in while Set up mode is on. Same scan and sender as import.*,
// as session lines, filed into the projects the person confirmed. Fake session files only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import mod from "./index.js";

/** The daemon vouched the person's own connection (core/mcpconn) and says so in meta. */
const CONN = { viaMcp: "mcn_1" };
const ID = i => `33333333-0000-4000-8000-${String(i).padStart(12, "0")}`;
function sessions(root) {
  const mk = (folder, cwd, ids, extra = {}) => {
    const dir = path.join(root, "claude", "projects", folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const i of ids) fs.writeFileSync(path.join(dir, `${ID(i)}.jsonl`), JSON.stringify({ type: "user", cwd, message: { content: `turn ${i}` }, ...extra }) + "\n");
  };
  mk("-home-alex-Work-harlow", "/home/alex/Work/harlow", [1, 2, 3]);
  mk("-home-alex-Work-northwind", "/home/alex/Work/northwind", [4, 5]);
  mk("-tmp-scratch", "/tmp/scratch", [6]);
  // a credential file beside the transcripts is never listed
  fs.writeFileSync(path.join(root, "claude", "projects", "-home-alex-Work-harlow", ".credentials.json"), "{\"token\":\"secret\"}");
}

async function world(t) {
  const root = tempHome(t);
  sessions(root);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const tools = new Map(), calls = [];
  const fake = {
    "sync.consent": i => ({ ok: true, ...i }),
    "sync.send": i => ({ sent: i.files.length, failed: 0, quarantined: 0, of: i.files.length, skipped: 0 }),
    "memory.pace": i => i,
    "projects.list": () => ({ projects: [{ slug: "harlow", name: "Harlow Legal", folders: ["/home/alex/Work/harlow"] }] }),
    "projects.add-threads": i => ({ project: i.project, added: i.threads }),
    "recall.status": () => ({ sessions: 0, turns: 0 }), "memory.stats": () => ({}),
  };
  const ctx = {
    name: "import", config: { name: "Alex MacBook", transcripts: [path.join(root, "claude", "projects")] }, paths: { root },
    store: { db, migrate: steps => migrate(db, "import", steps) }, log: () => {},
    events: { on: () => () => {}, emit: () => {} },
    call: async (tool, input, opts) => { calls.push({ tool, input, opts }); const f = fake[tool]; return f ? { data: f(input) } : { error: { code: "no_such_tool", message: tool } }; },
    tool: (name, def) => tools.set(name, def),
  };
  const h = await mod.start(ctx);
  t.after(() => h.stop());
  const call = async (name, input, caller = "deck", meta = {}) => { try { return { data: await tools.get(name).run(input, { ...meta, caller }) }; } catch (e) { return { error: { code: /** @type {any} */ (e).code, message: /** @type {Error} */ (e).message } }; } };
  return { call, calls, tools };
}

test("import.sessions.list: one line per session with its folder and project, nothing from temp folders suggested, no credential file", async t => {
  const { call } = await world(t);
  const r = (await call("import.sessions.list", {}, "mcp", CONN)).data;
  assert.equal(r.total, 6);
  const by = new Map(r.sessions.map(s => [s.id, s]));
  assert.equal(by.get(ID(1)).project, "harlow");
  assert.equal(by.get(ID(1)).cwd, "/home/alex/Work/harlow");
  assert.equal(by.get(ID(4)).project, undefined);
  assert.equal(by.get(ID(6)).suggested, false);
  assert.deepEqual(r.unsupported, ["grok"]);
  assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes(".credentials"));
  assert.ok(!JSON.stringify(r).includes("turn 1"), "what was said is never read");
});

test("import.sessions.*: the person's own connected client, and nothing else that is not the person", async t => {
  const { call } = await world(t);
  assert.equal((await call("import.sessions.list", {}, "mcp")).error.code, "denied", "an mcp caller the daemon did not vouch");
  assert.ok((await call("import.sessions.list", {}, "mcp", CONN)).data, "vouched");
  assert.equal((await call("import.sessions.list", {}, "mcp:agent:kit", { agent: "kit", thread: "t", viaMcp: "mcn_1" })).error.code, "denied", "a Vyre session's agent is not the person's connection");
  assert.equal((await call("import.sessions.list", {}, "tailnet:alex@example.com")).error.code, "denied");
  assert.equal((await call("import.sessions.run", { sessions: [{ id: ID(1) }]}, "mcp")).error.code, "denied");
  assert.ok((await call("import.sessions.list", {})).data, "the person's own surface needs no connection");
});

test("import.sessions.run: needs the scan, the person's yes, real ids and projects; then sends and files each session in its project", async t => {
  const { call, calls } = await world(t);
  assert.equal((await call("import.sessions.run", { sessions: [{ id: ID(1) }]}, "mcp", CONN)).error.code, "bad_input", "scan first");
  await call("import.sessions.list", {}, "mcp", CONN);
  assert.equal((await call("import.sessions.run", { sessions: [{ id: "nope" }]}, "mcp", CONN)).error.code, "not_found");
  assert.equal((await call("import.sessions.run", { sessions: [{ id: ID(1), project: "ghost" }]}, "mcp", CONN)).error.code, "not_found");
  assert.equal(calls.filter(c => c.tool === "sync.send").length, 0, "nothing was sent by the refusals");
  const r = await call("import.sessions.run", { sessions: [{ id: ID(1), project: "Harlow Legal" }, { id: ID(2), project: "harlow" }, { id: ID(4) }]}, "mcp", CONN);
  assert.equal(r.data.sessions, 3, JSON.stringify(r));
  assert.deepEqual(r.data.filed, { harlow: 2 });
  for (let i = 0; i < 50 && !calls.some(c => c.tool === "sync.send"); i++) await new Promise(res => setTimeout(res, 20));
  const sent = calls.filter(c => c.tool === "sync.send").flatMap(c => c.input.files.map(f => f.rel)).sort();
  assert.deepEqual(sent, [`-home-alex-Work-harlow/${ID(1)}.jsonl`, `-home-alex-Work-harlow/${ID(2)}.jsonl`, `-home-alex-Work-northwind/${ID(4)}.jsonl`]);
  assert.ok(!sent.some(p => /credentials/.test(p)));
  const pick = calls.find(c => c.tool === "projects.add-threads");
  assert.deepEqual(pick.input, { project: "harlow", threads: [ID(1), ID(2)] });
  assert.deepEqual(pick.opts, { relay: true }, "filed as the person, not as a module");
});
