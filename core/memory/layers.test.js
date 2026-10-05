// @ts-check
// The three layers of memory (team/0.3/DESIGN-memory-layers.md): Identity, Spaces, Projects. The test that matters most comes first: what is learned in one project's memory is not
// retrievable from another by any agent or person on the strength of a marker, only the identity-level assistant (and the person) follow markers across, and a project agent sees only
// its own layer. Fictional data only; the real daemon, the fixture corpus (Harlow's and Northwind's sessions) moved under real project folders.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { projectMarker, spaceMarker, visible, find } from "./markers.js";

async function world(t) {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) }));
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir, moved);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const opts = { root };
  await call("recall.index", {}, opts);
  assert.ok(!(await call("projects.create", { name: "Northwind", home: path.join(work, "northwind") }, opts)).error);
  assert.ok(!(await call("projects.create", { name: "Harlow", home: path.join(work, "harlow-site"), workspaces: [path.join(work, "harlow-intake")] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: ["northwind"] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant" }, opts)).error);
  return { d, root, nw: path.join(work, "northwind") };
}
const cwdsOf = r => (r.data.passages || r.data.hits || []).map(p => p.cwd).filter(Boolean);

test("layers: a project agent cannot retrieve another project's memory, sees that it exists and not what is in it, and cannot follow its marker; the identity assistant and the person can", async t => {
  const { d, nw: nwDir } = await world(t);
  const ask = (tool, input, caller) => d.registry.call(tool, input, caller);

  // 1. Retrieval inside the layer: kit reads Northwind and nothing of Harlow, however the question is worded.
  const own = await ask("memory.retrieve", { question: "Northwind invoices billing", project_cwds: [nwDir] }, "mcp:agent:kit");
  assert.equal(own.error, undefined, JSON.stringify(own));
  assert.ok(own.data.passages.length > 0 && cwdsOf(own).every(c => /northwind$/.test(c)));
  const across = await ask("memory.retrieve", { question: "Harlow Legal Dana Reyes intake form above the fold", project_cwds: [nwDir] }, "mcp:agent:kit");
  assert.ok(!cwdsOf(across).some(c => /harlow/.test(c)), "no Harlow turn reached a Northwind agent");
  // Asking for Harlow's folder by name is refused outright, not answered empty.
  const named = await ask("memory.retrieve", { question: "intake form", project_cwds: [nwDir.replace(/northwind$/, "harlow-site")] }, "mcp:agent:kit");
  assert.equal(named.error?.code, "denied");
  assert.ok(!JSON.stringify(across.data.passages).includes("Dana Reyes"), "nor its words");

  // 2. The markers: kit follows its own, and is only told the other exists.
  const km = (await ask("memory.markers", {}, "mcp:agent:kit")).data.markers;
  const nw = km.find(m => m.name === "Northwind"), hl = km.find(m => m.name === "Harlow");
  assert.equal(nw.access, "follow");
  assert.match(nw.summary, /\d+ facts?, \d+ decisions?, \d+ sessions?/);
  assert.deepEqual(Object.keys(hl).sort(), ["access", "kind", "name", "urn"], "named, nothing more: no summary, counts, topics or slug");
  assert.equal(hl.access, "exists");
  assert.ok(!JSON.stringify(km).includes("Dana"), "a marker carries no content of another layer");

  // 3. Following: its own, yes; the other's, refused with the reason, by name or by address.
  const f1 = await ask("memory.follow", { marker: "Northwind", question: "weekly invoice total" }, "mcp:agent:kit");
  assert.equal(f1.error, undefined, JSON.stringify(f1));
  assert.equal(f1.data.layer, "project");
  assert.ok(cwdsOf(f1).every(c => /northwind$/.test(c)));
  for (const ref of ["Harlow", hl.urn]) {
    const r = await ask("memory.follow", { marker: ref, question: "intake form" }, "mcp:agent:kit");
    assert.equal(r.error?.code, "denied", JSON.stringify(r));
    assert.match(r.error.message, /exists, but your grants do not reach it/);
  }
  assert.equal((await ask("memory.follow", { marker: "Nowhere", question: "x" }, "mcp:agent:kit")).error?.code, "not_found");

  // 4. The identity-level assistant follows every marker for its person; so does the person.
  for (const caller of ["mcp:agent:juno", "cli"]) {
    const m = (await ask("memory.markers", {}, caller)).data.markers;
    assert.ok(m.filter(x => x.kind === "project").every(x => x.access === "follow" && x.summary), caller);
    const harlow = await ask("memory.follow", { marker: "Harlow", question: "intake form above the fold" }, caller);
    assert.equal(harlow.error, undefined, `${caller}: ${JSON.stringify(harlow)}`);
    assert.ok(cwdsOf(harlow).some(c => /harlow/.test(c)), caller);
    assert.ok(cwdsOf(harlow).every(c => /harlow/.test(c)), "and it answers from that layer only, not a blend");
  }

  // 5. A bare model session is the person's own Claude Code (memory's existing rule: it reads as the person), so it follows as they do; a guest or an unknown tailnet peer does not.
  assert.equal((await ask("memory.follow", { marker: "Harlow", question: "intake" }, "mcp")).error, undefined);
  assert.ok((await ask("memory.follow", { marker: "Harlow", question: "intake" }, "tailnet-guest:bob")).error, "a guest has no layer to follow from");
});

test("markers: derived, never content; the Space's marker is for the assistant and the person, and a project agent only knows it exists", () => {
  const nw = projectMarker({ space: "s1", slug: "northwind", name: "Northwind", facts: 3, decisions: 1, sessions: 2, topics: ["Sam Okafor", "Sam Okafor", "<b>x</b>", "Northwind Bakery"], updated: 5 });
  assert.equal(nw.urn, "vyre://s1/project/northwind");
  assert.equal(nw.summary, "3 facts, 1 decision, 2 sessions; about Sam Okafor, b x /b, Northwind Bakery");
  assert.ok(nw.summary.length <= 200 && !/[<>`]/.test(nw.summary));
  const sp = spaceMarker({ space: "s1", name: "Studio", projects: 2 });
  const hl = projectMarker({ space: "s1", slug: "harlow", name: "Harlow" });
  const all = [sp, nw, hl];
  const agent = visible(all, { slugs: new Set(["northwind"]) });
  assert.deepEqual(agent.map(m => `${m.name}:${m.access}`), ["Studio:exists", "Northwind:follow", "Harlow:exists"]);
  assert.deepEqual(Object.keys(agent[0]).sort(), ["access", "kind", "name", "urn"]);
  assert.ok(visible(all, { assistant: true }).every(m => m.access === "follow"));
  assert.ok(visible(all, { all: true }).every(m => m.access === "follow"));
  assert.ok(visible(all, {}).every(m => m.access === "exists"));
  assert.equal(find(all, "harlow")?.slug, "harlow");
  assert.equal(find(all, "NORTHWIND")?.name, "Northwind");
  assert.equal(find(all, nw.urn)?.kind, "project");
  assert.equal(find(all, ""), null);
});
