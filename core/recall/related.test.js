// @ts-check
// recall.related — chat's "From your past sessions" inline hint (the user's chat win #1,
// 2026-09-28): 1 to 3 of a project's own past turns relevant to what the person is about to
// type. Owner surfaces only (never an agent, even one granted the project), and only inside a
// real, mapped project: project_cwds must name a real project's own folder, or it gets nothing,
// never the whole corpus and never an unmapped folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

/** The fixture corpus, moved under a real work dir so a real project can own its folder (as
 * core/recall/scope.test.js does for the same reason). */
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
  return { d, opts, work };
}

test("recall.related: a project's own relevant turns, one per session, capped at 3", async t => {
  const { d, work } = await world(t);
  const northwind = [path.join(work, "northwind")];
  const r = await d.registry.call("recall.related", { project_cwds: northwind, text: "invoices from Sam at Northwind Bakery" }, "cli");
  assert.ok(r.data.hits.length > 0);
  assert.ok(r.data.hits.length <= 3);
  const seen = new Set();
  for (const h of r.data.hits) {
    assert.match(h.cwd, /northwind$/, h.cwd);
    assert.ok(!seen.has(h.session), "one per session");
    seen.add(h.session);
    assert.ok(h.snippet, "a snippet to show in the hint");
    assert.ok(h.role === "user" || h.role === "assistant", "capsule-pro needs role to tell \"you said\" from \"you were told\"");
    assert.equal(typeof h.ts, "number");
  }
  // A term that only exists in Harlow's sessions finds nothing here: it stays inside the project.
  const cross = await d.registry.call("recall.related", { project_cwds: northwind, text: "intake form above the fold" }, "cli");
  assert.equal(cross.data.hits.length, 0);
});

test("recall.related: an unmapped folder gets nothing, never the whole corpus", async t => {
  const { d, work } = await world(t);
  // The parent of both projects: a real folder, but not itself a project's own.
  const r = await d.registry.call("recall.related", { project_cwds: [work], text: "invoice" }, "cli");
  assert.deepEqual(r.data.hits, []);
  const made_up = await d.registry.call("recall.related", { project_cwds: ["/nonexistent/nowhere"], text: "invoice" }, "cli");
  assert.deepEqual(made_up.data.hits, []);
});

test("recall.related: no text or no project_cwds is a quiet empty hint, not an error", async t => {
  const { d, work } = await world(t);
  const northwind = [path.join(work, "northwind")];
  assert.deepEqual((await d.registry.call("recall.related", { project_cwds: northwind, text: "" }, "cli")).data.hits, []);
  assert.deepEqual((await d.registry.call("recall.related", { project_cwds: [], text: "invoice" }, "cli")).data.hits, []);
});

test("recall.related: never an agent, even one granted the very project asked for", async t => {
  const { d, work } = await world(t);
  const northwind = [path.join(work, "northwind")];
  for (const caller of ["mcp", "mcp:agent:kit"]) {
    const r = await d.registry.call("recall.related", { project_cwds: northwind, text: "invoice" }, caller);
    assert.match(r.error?.message || "", /not available/, caller);
  }
  // chat and native-core call it as themselves (a module, or the Deck/Capsule directly), never
  // forwarded to a model, so there is no agent field to scope by in the first place.
  assert.ok((await d.registry.call("recall.related", { project_cwds: northwind, text: "invoice" }, "module:chat")).data.hits.length > 0);
});

test("recall.related: fast on the cached index (chat's 150ms budget)", async t => {
  const { d, work } = await world(t);
  const northwind = [path.join(work, "northwind")];
  const t0 = Date.now();
  await d.registry.call("recall.related", { project_cwds: northwind, text: "invoice watcher" }, "cli");
  assert.ok(Date.now() - t0 < 150, `${Date.now() - t0}ms`);
});
