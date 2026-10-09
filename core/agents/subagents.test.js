// @ts-check
// Subagents (R031-07): a short-lived helper a session starts for one job. It runs as its parent, so it holds nothing the parent does not; its tools can only be fewer; it starts no helpers of its own;
// and its row nests under the parent's conversation (the same hand-off row teammates use). On a real vyred with the fake session driver, temp home.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { open as openStore } from "../store/index.js";
import { paths } from "../config/index.js";
import { call } from "../daemon/client.js";
import { boot, until, realSession } from "../team/team-fixture.js";

const framesOf = (/** @type {string} */ root, /** @type {string} */ session) => {
  const db = openStore(paths(root).db);
  try { return db.prepare("SELECT json FROM stream_frames WHERE session = ? ORDER BY cur").all(session).map((/** @type {any} */ r) => JSON.parse(r.json)); } finally { db.close(); }
};

test("a helper cannot hold more than its parent: its tool list is inside the parent's, it starts no helpers, and the daemon narrows its thread", { timeout: 120_000 }, async t => {
  const { d, tool, root, project, launches } = await boot(t);
  await tool("agents.create", { name: "kit", kind: "agent", projects: [] });
  const { thread } = await realSession(root, tool, launches, project.slug);
  const spawn = (/** @type {any} */ input, /** @type {any} */ meta) => d.registry.call("agents.spawn", input, "mcp:agent:kit", { agent: "kit", thread, ...meta });

  // held to a short list itself: a helper may ask for less, never for more
  const parentOnly = ["agents.spawn", "recall.search", "memory.space.recall"];   // the parent is held to a short list, and spawning is on it
  const over = await spawn({ task: "look things up", tools: ["recall.search", "vault.reveal"] }, { agentOnly: parentOnly });
  assert.equal(over.error.code, "denied"); assert.match(over.error.message, /vault\.reveal/);
  const ok = await spawn({ task: "look things up", label: "researcher", tools: ["recall.search"] }, { agentOnly: parentOnly });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual(ok.data.tools, ["recall.search"]);
  // with no list of its own, it inherits the parent's list
  const inherit = await spawn({ task: "again" }, { agentOnly: parentOnly });
  assert.deepEqual(inherit.data.tools, ["recall.search", "memory.space.recall"], "its parent's list less the power to spawn");

  // the daemon holds the helper's thread to its list and the parent's thread to none (agents.scope is what vyred puts on the meta of the helper's calls)
  const scope = (/** @type {string} */ th) => d.registry.call("agents.scope", { name: "kit", thread: th }, "module:vyred");
  assert.deepEqual((await scope(ok.data.thread)).data.only, ["recall.search"]);
  assert.equal((await scope(thread)).data.only, undefined, "the parent's own thread is not narrowed");
  assert.equal((await scope(ok.data.thread)).data.subagent, true);

  // a helper starts no helpers, and only an agent from its own thread starts one
  const nested = await d.registry.call("agents.spawn", { task: "go deeper" }, "mcp:agent:kit", { agent: "kit", thread: ok.data.thread });
  assert.equal(nested.error.code, "denied"); assert.match(nested.error.message, /does not start helpers/);
  const stranger = await d.registry.call("agents.spawn", { task: "x" }, "cli", {});
  assert.equal(stranger.error.code, "denied");
});

test("the helper's row nests in the parent's conversation: one hand-off row by request, queued, running with the helper's own session, then done", { timeout: 120_000 }, async t => {
  const { d, tool, root, project, launches } = await boot(t);
  await tool("agents.create", { name: "kit", kind: "agent", projects: [] });
  const { thread } = await realSession(root, tool, launches, project.slug);
  const r = await d.registry.call("agents.spawn", { task: "summarise the file", label: "reader" }, "mcp:agent:kit", { agent: "kit", thread });
  assert.equal(r.error, undefined, JSON.stringify(r));
  const frames = await until(async () => { const f = framesOf(root, thread); const rows = f.filter(x => x.type === "chat.handoff"); return rows.some(x => x.data.state === "done" || x.data.state === "failed") ? f : null; }, "the helper's row to finish");
  const rows = frames.filter(x => x.type === "chat.handoff");
  assert.ok(rows.length >= 2 && rows.every(x => x.data.request === r.data.helper), "one row, keyed by the helper's request");
  assert.match(rows[0].data.to.role, /^helper: reader/);
  assert.equal(rows[0].data.state, "queued");
  assert.ok(rows.some(x => x.data.state === "running" && x.data.thread === r.data.thread), "running, with the helper's own session");
  // a helper's steps are nested under its row, as the parent
  for (const f of frames.filter(x => x.data && x.data.via)) assert.equal(f.data.via, r.data.helper);
});
