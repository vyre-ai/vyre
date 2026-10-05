// @ts-check
// recall.turn and recall.links are reads of raw session text, so they are scoped exactly as recall.thread is: a named agent reads only its granted project's
// sessions, a session it may not read is "not found" (never "denied", and never told apart from one that does not exist), and the person's own surfaces read all.
// The MCP tool memory_turn is a name for recall.turn.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { ALIASES } from "../../harness/mcp/memory-tools.js";

const NORTHWIND_SESSION = "11111111-aaaa-4000-8000-000000000003";
const HARLOW_SESSION = "11111111-aaaa-4000-8000-000000000001";

async function world(t) {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) }));
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir, moved);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const opts = { root };
  await call("recall.index", {}, opts);
  assert.ok(!(await call("projects.create", { name: "Northwind", home: path.join(work, "northwind") }, opts)).error);
  assert.ok(!(await call("projects.create", { name: "Harlow", home: path.join(work, "harlow-site"), workspaces: [path.join(work, "harlow-intake")] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: ["northwind"] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant" }, opts)).error);
  return { d, opts };
}

test("recall.turn: the person reads any session word for word; a named agent only its project's, and a session outside is not told apart from none", async t => {
  const { d } = await world(t);
  const own = await d.registry.call("recall.turn", { session: NORTHWIND_SESSION, seq: 1, before: 1, after: 1 }, "cli");
  assert.equal(own.error, undefined, JSON.stringify(own));
  assert.deepEqual(own.data.turns.map(x => x.seq), [0, 1, 2]);
  assert.match(own.data.turns[1].text, /^I wrote a watcher, northwind-invoices,/);
  assert.equal(own.data.turns[1].pointer, `${NORTHWIND_SESSION}:1`);
  // kit is granted northwind only.
  const kit = await d.registry.call("recall.turn", { session: NORTHWIND_SESSION, seq: 1 }, "mcp:agent:kit");
  assert.equal(kit.data.turns[0].text, own.data.turns[1].text);
  const outside = await d.registry.call("recall.turn", { session: HARLOW_SESSION, seq: 0 }, "mcp:agent:kit");
  assert.equal(outside.error?.code, "not_found", JSON.stringify(outside));
  const missing = await d.registry.call("recall.turn", { session: "no-such-session", seq: 0 }, "mcp:agent:kit");
  assert.equal(outside.error?.message, missing.error?.message.replace("no-such-session", HARLOW_SESSION), "an agent learns nothing about what it cannot read");
  // the assistant reads every mapped project; an unnamed model session with no thread reads nothing.
  assert.ok((await d.registry.call("recall.turn", { session: HARLOW_SESSION, seq: 0 }, "mcp:agent:juno")).data.turns.length > 0);
  for (const caller of ["mcp", "mcp:thread:t-none"]) {
    const r = await d.registry.call("recall.turn", { session: NORTHWIND_SESSION, seq: 0 }, caller);
    assert.ok(r.error, `${caller} must be refused: ${JSON.stringify(r).slice(0, 160)}`);
  }
  // not a reader at all
  assert.match((await d.registry.call("recall.turn", { session: NORTHWIND_SESSION, seq: 0 }, "tailnet-guest:bob")).error?.message || "", /not available/);
  assert.equal((await d.registry.call("recall.turn", { session: NORTHWIND_SESSION, seq: 0 }, "hook")).error?.code, "no_such_tool");
  // a bad call names no turn
  assert.equal((await d.registry.call("recall.turn", { session: NORTHWIND_SESSION }, "cli")).error?.code, "bad_input");
});

test("recall.links: what a turn touched is found for the person; a named agent finds only inside its project", async t => {
  const { d } = await world(t);
  // Every fixture session reads src/intake.tsx between its first two turns; the read hangs on the assistant turn before the person's next one.
  const all = await d.registry.call("recall.links", { ref: "intake.tsx" }, "cli");
  assert.equal(all.error, undefined, JSON.stringify(all));
  assert.ok(all.data.length >= 4, JSON.stringify(all.data.map(x => x.pointer)));
  assert.ok(all.data.every(x => x.kind === "read" && x.ref === "src/intake.tsx" && /:\d+$/.test(x.pointer)));
  const harlow = all.data.filter(x => /harlow/.test(x.cwd || ""));
  assert.ok(harlow.length > 0 && harlow.length < all.data.length);
  const kit = (await d.registry.call("recall.links", { ref: "intake.tsx" }, "mcp:agent:kit")).data;
  assert.ok(kit.length > 0 && kit.every(x => /northwind$/.test(x.cwd)), JSON.stringify(kit.map(x => x.cwd)));
  assert.equal((await d.registry.call("recall.links", { ref: "intake.tsx" }, "mcp:agent:juno")).data.some(x => /harlow/.test(x.cwd)), true);
  assert.equal((await d.registry.call("recall.links", { ref: "intake.tsx", session: HARLOW_SESSION }, "mcp:agent:kit")).error?.code, "not_found");
  assert.equal((await d.registry.call("recall.links", { ref: "src/intake.tsx", kind: "file" }, "cli")).data.length, 0, "it was read, not changed");
  assert.ok(!(await d.registry.call("recall.links", { ref: "intake.tsx" }, "mcp")).data?.length, "an unnamed session with no thread finds nothing");
});

test("memory_turn is recall.turn, and memory_search's file and commit narrow memory.retrieve", () => {
  assert.equal(ALIASES.memory_turn.tool, "recall.turn");
  assert.deepEqual(ALIASES.memory_turn.map({ session: "abc", seq: 4, before: 2, after: 2, junk: 1 }, {}), { session: "abc", seq: 4, before: 2, after: 2 });
  assert.deepEqual(ALIASES.memory_search.map({ query: "login", file: "auth.ts", commit: "c0ffee1" }, {}), { question: "login", file: "auth.ts", commit: "c0ffee1" });
});

test("memory.retrieve: file narrows the passages to turns that touched it", async t => {
  const { d } = await world(t);
  const plain = await d.registry.call("memory.retrieve", { question: "intake form above the fold", project_cwds: [] }, "cli");
  assert.equal(plain.error, undefined, JSON.stringify(plain));
  assert.ok(plain.data.passages.length > 1);
  const narrow = await d.registry.call("memory.retrieve", { question: "intake form above the fold", project_cwds: [], file: "intake.tsx" }, "cli");
  assert.equal(narrow.error, undefined, JSON.stringify(narrow));
  assert.ok(narrow.data.passages.length > 0 && narrow.data.passages.length < plain.data.passages.length, `${narrow.data.passages.length} of ${plain.data.passages.length}`);
  const linked = new Set((await d.registry.call("recall.links", { ref: "intake.tsx" }, "cli")).data.map(x => x.session));
  for (const p of narrow.data.passages) assert.ok(linked.has(p.session), p.session);
  const none = await d.registry.call("memory.retrieve", { question: "intake form above the fold", project_cwds: [], file: "nothing-here.ts" }, "cli");
  assert.equal(none.data.passages.length, 0);
});
