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
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n", "Claude Code reads CLAUDE.md natively and it is only a pointer at AGENTS.md");
  const text = appended(run);
  assert.match(text, /Vyre orientation/);
  assert.ok(text.includes(`${dir}/AGENTS.md`), "its instructions by path");
  assert.ok(!/Draft intake replies/.test((text.split("Vyre orientation")[1] || "").split("Instructions for")[0]), "the orientation carries paths, not the file's words");
  assert.match(text, /Instructions for you, the agent "intake" \(its AGENTS\.md\):\n\nDraft intake replies; never send\./, "the system prompt itself carries the agent's AGENTS.md, for every provider");
  assert.ok(!/project "/.test(text.split("Vyre orientation")[1] || ""), "no project lines for an agent with no project");
});

test("an agent working in a project runs in the project's folder and is told both: its own instructions for how it works, the project's for the work", { timeout: 120_000 }, async t => {
  const { d, ada, ben, launches, project } = await world(t);
  /** @type {any[]} */ const seen = [];
  const tl = /** @type {any} */ (d.registry).tools.get("threads.launch"), realRun = tl.run;
  tl.run = (/** @type {any} */ i, /** @type {any} */ m, /** @type {any[]} */ ...r) => { seen.push(i); return realRun(i, m, ...r); };
  t.after(() => { tl.run = realRun; });
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
  const own = /(agt_[A-Za-z0-9-]+)\/AGENTS\.md/.exec(text);
  assert.ok(own, "its own folder named");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].read_only.length, 1, "exactly one read-only folder");
  assert.ok(seen[0].read_only[0].endsWith(`/agents/${own[1]}`), "and it is its own agent folder: " + seen[0].read_only[0]);
  assert.match(text, /your own instructions for how you work, then the project's instructions for the work itself/);
  assert.match(text, /Instructions for you, the agent "intake" \(its AGENTS\.md\):\n\nDraft replies\./, "the prompt carries the agent's AGENTS.md");
  assert.match(text, /Instructions for the project "[^"]+" \(its AGENTS\.md\):\n\nAlways cite the file number\./, "and the project's");
});

test("a project the person may not use puts none of its AGENTS.md in the prompt (no_project_docs), one they may use does", { timeout: 120_000 }, async t => {
  const { d, project } = await world(t);
  fs.writeFileSync(path.join(project.home, "AGENTS.md"), "Always cite the file number.\n");
  const compose = async (/** @type {any} */ i) => (await d.registry.call("sessions.prompt.compose", { project: project.slug, ...i }, "module:vyre")).data.text;
  assert.match(await compose({}), /Instructions for the project "[^"]+" \(its AGENTS\.md\):\n\nAlways cite the file number\./);
  assert.ok(!(await compose({ no_project_docs: true })).includes("Always cite the file number."), "a project she cannot use injects nothing");
});
