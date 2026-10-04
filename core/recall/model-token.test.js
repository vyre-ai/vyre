// @ts-check
// Who a model's recall call is, on a REAL daemon with the kernel on. The person's own Claude carries a kernel session token whose chain says which person and which agent it runs as: that is
// the route (not a label), so it reads every project's sessions. A named agent's token reads only that agent's granted project. No token, a bare `mcp`, and a label that CLAIMS a thread
// (`mcp:thread:<id>`, which a model can send as it likes: RC-1) read nothing. Stand-ins: `kernelPresence` accepts any proof for the owner's grants acts.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start, callerFacts } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("the person's own Claude (a kernel token) reads across projects; a named agent's token only its project; no token or a claimed thread label reads nothing", { timeout: 120_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) }));
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir, moved);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  await call("recall.index", {}, opts);
  for (const [name, home, ws] of [["Northwind", "northwind", []], ["Harlow", "harlow-site", [path.join(work, "harlow-intake")]]]) assert.ok(!(await call("projects.create", { name, home: path.join(work, home), workspaces: ws }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: ["northwind"] }, opts)).error);

  const facts = callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false, outside: true });
  const owner = d.kernel.chains.fromFacts(facts);
  const space = d.kernel.id.space;
  await d.kernel.gateway.grants.addActor(owner, { kind: "agent", id: "kit", space }, { presence: { op: "x", fields: {}, n: 1 } });
  const person = (await d.kernel.surfaces.open(owner, {})).token;
  const kit = (await d.kernel.surfaces.open(owner, { agent: "kit" })).token;
  const ask = (/** @type {string} */ caller, /** @type {any} */ meta, /** @type {any} */ input = { q: "intake form" }) => d.registry.call("recall.search", input, caller, meta);
  const folders = async (/** @type {any} */ r) => [...new Set((r.data || []).map((/** @type {any} */ h) => String(h.cwd).replace(root, "")))];

  const all = await call("recall.search", { q: "intake form" }, opts);
  const everywhere = await folders(all);
  assert.ok(everywhere.length >= 2, "the corpus spans projects: " + JSON.stringify(everywhere));
  // The person's own Claude: its token's chain is the person's.
  const mine = await ask("mcp", { token: person });
  assert.ok(!mine.error, JSON.stringify(mine.error));
  assert.deepEqual((await folders(mine)).sort(), everywhere.sort(), "the person's token reads every project's sessions");
  // A named agent's token: that agent's granted project only (a Harlow-only term finds nothing for kit; its own project's term finds only its own).
  const harlowOnly = await ask("mcp", { token: kit });
  assert.ok(!harlowOnly.error && (harlowOnly.data || []).length === 0, "kit's token finds nothing of Harlow: " + JSON.stringify(harlowOnly).slice(0, 120));
  const own = await ask("mcp", { token: kit }, { q: "invoice" });
  const ownFolders = await folders(own);
  assert.ok(!own.error && ownFolders.length > 0 && ownFolders.every(f => f.includes("northwind")), "kit's token reads northwind only: " + JSON.stringify(ownFolders));
  // No token: nothing. A bare mcp, and the label that claims a thread of someone else's project.
  for (const caller of ["mcp", "mcp:thread:11111111-aaaa-4000-8000-000000000001"]) {
    const r = await ask(caller, {});
    assert.ok(r.error || !(r.data && r.data.length), `${caller} with no token reads nothing: ${JSON.stringify(r).slice(0, 140)}`);
  }
  // A terminal session the daemon vouched for (meta.thread: bound to its claude process) reads its OWN session's project, and only that: the folders come from its own transcript.
  const bound = await ask("mcp", { thread: "11111111-aaaa-4000-8000-000000000001" });
  const bf = await folders(bound);
  assert.ok(!bound.error && bf.length > 0 && bf.every(f => /harlow/.test(f)), "a bound Harlow session reads Harlow: " + JSON.stringify(bf));
  const other = await ask("mcp", { thread: "11111111-aaaa-4000-8000-000000000003" }, { q: "intake form" });
  assert.ok(!other.error && (other.data || []).length === 0, "a bound Northwind session finds nothing of Harlow");
});
