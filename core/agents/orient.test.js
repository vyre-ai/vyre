// @ts-check
// What an agent's session is started with: its working folder (so Claude Code and Codex read its instructions natively), the files written there from the stored truth, and the Vyre orientation block in
// the system prompt (paths only). Real daemon on the fake claude: the spawn is read from its launch log.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot, until } from "../team/team-fixture.js";

const ADA = "per_" + "d".repeat(26);
const BEN = "per_" + "c".repeat(26);

async function world(/** @type {any} */ t) {
  const { d, project, launches, root } = await boot(t);
  const OWNER = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: ADA, role: "admin" }, { presence: { op: "x", fields: {}, n: 3 } });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const open = async (/** @type {string} */ p, /** @type {string} */ k) => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + k, person: p, path: "direct", session: "s-" + k }), {})).token });
  const ada = await open(ADA, "dddd"), ben = await open(BEN, "cccc");
  const asBen = (/** @type {string} */ n, /** @type {any} */ i = {}) => d.registry.call(n, i, "deck", ben);
  // A chat runs on the chatter's own sign-in: Ben has one, and the agent is shared with him (the agent's own credentials are for flows).
  const added = await asBen("sessions.accounts.add", { provider: "claude", label: "Ben's Claude", kind: "login" });
  assert.equal(added.error, undefined, JSON.stringify(added.error));
  return { d, project, launches, root, ben: asBen, cli: (/** @type {string} */ n, /** @type {any} */ i = {}) => d.registry.call(n, i, "cli"), ada: (/** @type {string} */ n, /** @type {any} */ i = {}) => d.registry.call(n, i, "deck", ada) };
}
const appended = (/** @type {any} */ launch) => { const a = launch.argv; const k = a.indexOf("--append-system-prompt"); return k >= 0 ? String(a[k + 1]) : ""; };

test("an agent with no project runs in its own folder: AGENTS.md and CLAUDE.md are written there, and its prompt names them by path", { timeout: 120_000 }, async t => {
  const { ada, ben, launches } = await world(t);
  const made = await ada("agents.create", { name: "intake", kind: "agent", projects: [], instructions: "Draft intake replies; never send." });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  await ada("agents.access.set", { agent: "intake", kind: "person", subject: BEN, level: "use" });
  const ask = await ben("agents.ask", { agent: "intake", text: "hello", wait: false });
  assert.equal(ask.error, undefined, JSON.stringify(ask.error));
  const run = await until(() => launches()[0], "the launch");
  const dir = run.cwd;
  assert.ok(dir.endsWith(path.join("agents", String(made.data.uid))), `the agent runs in agents/<id>: ${dir}`);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "Draft intake replies; never send.\n");
  assert.match(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /^@AGENTS\.md/, "Claude Code reads CLAUDE.md natively and it imports AGENTS.md");
  const text = appended(run);
  assert.match(text, /Vyre orientation/);
  assert.ok(text.includes(`${dir}/AGENTS.md`), "its instructions by path");
  assert.ok(!/Draft intake replies/.test(text.split("Vyre orientation")[1] || ""), "the orientation carries paths, not the file's words");
  assert.ok(!/project "/.test(text.split("Vyre orientation")[1] || ""), "no project lines for an agent with no project");
});

test("an agent working in a project runs in the project's folder and is told both: its own instructions for how it works, the project's for the work", { timeout: 120_000 }, async t => {
  const { ada, ben, launches, project } = await world(t);
  fs.writeFileSync(path.join(project.home, "AGENTS.md"), "Always cite the file number.\n");
  const made = await ada("agents.create", { name: "intake", kind: "agent", projects: [project.slug], instructions: "Draft replies." });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  await ada("agents.access.set", { agent: "intake", kind: "person", subject: BEN, level: "use" });
  const ask = await ben("agents.ask", { agent: "intake", text: "hello", wait: false });
  assert.equal(ask.error, undefined, JSON.stringify(ask.error));
  const run = await until(() => launches()[0], "the launch");
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(project.home), "the project's folder is the working folder: CLAUDE.md and AGENTS.md there are read natively");
  const text = appended(run);
  assert.ok(text.includes(`${project.home}/AGENTS.md`), "the project's instructions by path");
  assert.match(text, /agt_[A-Za-z0-9-]+\/AGENTS\.md/, "and the agent's own");
  assert.match(text, /your own instructions for how you work, then the project's instructions for the work itself/);
});
