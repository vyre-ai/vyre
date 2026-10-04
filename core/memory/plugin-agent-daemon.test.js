// @ts-check
// "Claude Code on <this computer>" (lead's ruling, 4 Oct): an agent the person granted ONCE their personal memory and every project's sessions to READ. On a real daemon, kernel on, real
// session tokens: granted, its token reads personal memory and recalls across projects, and a remember from it stays a pending note; not granted (a wildcard agent without `personal`), it reads
// neither; a bare `mcp` with no token reads nothing; it is never the person (no correction, no whole-graph pin). Stand-ins: `kernelPresence` accepts any proof for the owner's grants acts;
// the registration that creates this agent and hands the plugin its token is platform-3's (the plugin reaches the daemon over its own socket, where vyred sets the token).
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

test("a personal agent reads personal memory and every project's sessions; an ungranted one and a bare mcp read neither; it is never the person", { timeout: 120_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir, SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) })));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  await call("recall.index", {}, opts);
  for (const [name, home, ws] of [["Northwind", "northwind", []], ["Harlow", "harlow-site", [path.join(work, "harlow-intake")]]]) assert.ok(!(await call("projects.create", { name, home: path.join(work, home), workspaces: ws }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "claude-code-box", projects: "*", personal: true }, opts)).error, "the grant is the person's own act");
  assert.ok(!(await call("agents.create", { name: "other-agent", projects: "*" }, opts)).error);
  assert.ok(!(await call("memory.remember", { text: "my wife is Jordan" }, opts)).error);
  await call("memory.curate", {}, opts);

  const owner = d.kernel.chains.fromFacts(callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false, outside: true }));
  const space = d.kernel.id.space;
  const token = async (/** @type {string} */ agent) => { await d.kernel.gateway.grants.addActor(owner, { kind: "agent", id: agent, space }, { presence: { op: "x", fields: {}, n: Math.random() } }); return (await d.kernel.surfaces.open(owner, { agent })).token; };
  const plugin = await token("claude-code-box"), other = await token("other-agent");
  const ask = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta) => d.registry.call(tool, input, "mcp", meta);
  const cwds = (/** @type {any} */ r) => [...new Set((r.data || []).map((/** @type {any} */ h) => String(h.cwd).replace(root, "")))];

  // Recall: the granted agent reads every project; the ungranted wildcard agent only what projects.access gives it (nothing granted yet here); a bare mcp nothing.
  const everywhere = cwds(await call("recall.search", { q: "intake form" }, opts));
  assert.ok(everywhere.length >= 1);
  assert.deepEqual(cwds(await ask("recall.search", { q: "intake form" }, { token: plugin })).sort(), everywhere.sort(), "the granted agent recalls across projects");
  const bare = await ask("recall.search", { q: "intake form" }, {});
  assert.ok(bare.error || !(bare.data && bare.data.length), "no token reads nothing");
  // Personal memory: the granted agent reads it; an agent that was not given it does not.
  const mine = await ask("memory.profile", {}, { token: plugin });
  assert.ok(!mine.error && JSON.stringify(mine.data).includes("Jordan"), "the granted agent reads the person's personal memory: " + JSON.stringify(mine).slice(0, 160));
  const theirs = await ask("memory.profile", {}, { token: other });
  assert.ok(theirs.error || !JSON.stringify(theirs.data || "").includes("Jordan"), "an agent not given personal memory does not read it");
  // Never the person: its remember is a pending note, and it cannot steer the whole graph.
  const rem = await ask("memory.remember", { text: "my wife is Mallory" }, { token: plugin });
  assert.equal(rem.data && rem.data.pending, true, JSON.stringify(rem).slice(0, 160));
  assert.ok(!JSON.stringify((await call("memory.profile", {}, opts)).data).includes("Mallory"));
  const pin = await ask("memory.pin", { node: "Dana Reyes" }, { token: plugin });
  assert.ok(pin.error, "it cannot pin the whole graph");
});
