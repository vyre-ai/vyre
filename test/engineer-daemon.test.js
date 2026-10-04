// @ts-check
// The Engineer on a REAL vyred (kernel on): a built-in agent in agents.list that only proposes. Its session reaches a short list of tools and no others; a Flow it writes is a draft, a proposal
// is one task for the admin, and an assistant's chain cannot approve, install or define anything.
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("the Engineer: built in, listed, kept, held to its tools; its drafts and proposals reach the admin as tasks and nothing applies without them", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const personChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const ownerMeta = async () => ({ token: (await d.kernel.surfaces.open(personChain, {})).token });
  const assistantMeta = async (/** @type {any} */ extra = {}) => ({ token: (await d.kernel.surfaces.open(personChain, { agent: "assistant", thread: "t-eng" })).token, ...extra });

  // listed like any agent, and says what it is
  const list = (await d.registry.call("agents.list", {}, "cli")).data;
  const eng = list.find((/** @type {any} */ a) => a.name === "engineer");
  assert.ok(eng, JSON.stringify(list.map((/** @type {any} */ a) => a.name)));
  assert.equal(eng.builtin, true); assert.equal(eng.proposes_only, true); assert.deepEqual(eng.projects, []);
  assert.ok(eng.tools.includes("flows.propose") && !eng.tools.includes("flows.approve") && !eng.tools.includes("records.define"));
  // kept: not deleted, not given a project, a credential or a computer; its words can change
  assert.ok((await d.registry.call("agents.delete", { agent: "engineer" }, "cli")).error);
  assert.ok((await d.registry.call("agents.update", { name: "engineer", projects: ["x"] }, "cli")).error);
  assert.ok((await d.registry.call("agents.update", { name: "engineer", computer: true }, "cli")).error);
  assert.ok(!(await d.registry.call("agents.update", { name: "engineer", effort: "high" }, "cli")).error);
  assert.ok((await d.registry.call("agents.create", { name: "engineer" }, "cli")).error, "no second one");
  // vyred puts its tool list on the call's meta from the stored row
  const scope = (await d.registry.call("agents.scope", { name: "engineer" }, "module:vyred")).data;
  assert.deepEqual(scope.only, eng.tools);
  assert.equal((await d.registry.call("agents.scope", { name: "assistant" }, "module:vyred")).data?.only, undefined, "the assistant is not held to a list");

  // held to the list: anything else is refused before it runs, whatever the person could do
  const only = scope.only;
  const denied = await d.registry.call("records.define", { diff: { add_types: [{ name: "oops", label: "Oops", fields: [] }] } }, "cli", { agentOnly: only, ...(await assistantMeta()) });
  assert.equal(denied.error && denied.error.code, "denied", JSON.stringify(denied));
  assert.ok(!(await d.registry.call("flows.list", {}, "cli", { agentOnly: only, ...(await assistantMeta()) })).error);

  // an assistant's Flow is a draft; it cannot approve it; asking for it is one task for the admin
  const flow = { format: 1, name: "note_new", label: "Note a new thing", authorship: "model", trigger: { on: "event", event: "contact.created" }, steps: [] };
  const defR = await d.registry.call("flows.define", { flow }, "cli", await assistantMeta({ agentOnly: only }));
  const def = defR.data;
  assert.ok(def && def.ok, JSON.stringify(defR));
  const approveTry = await d.registry.call("flows.approve", { id: def.id, version: def.version, hash: def.hash }, "cli", await assistantMeta());
  assert.ok(approveTry.error, "an assistant never approves");
  const asked = await d.registry.call("flows.propose", { what: "flow", id: def.id, version: def.version }, "cli", await assistantMeta({ agentOnly: only }));
  assert.ok(asked.data && asked.data.ok, JSON.stringify(asked));
  assert.equal(asked.data.approver, owner);
  const task = await d.kernel.gateway.ask.get(personChain, asked.data.task);
  assert.equal(task.form.kind, "proposal"); assert.equal(task.form.what, "flow"); assert.equal(task.form.hash, def.hash);
  assert.equal(task.checker.id, owner, "the owner checks it");
  const stillDraft = (await d.registry.call("flows.get", { id: def.id, version: def.version }, "cli", await ownerMeta())).data;
  assert.equal(stillDraft.approver, null, "nothing approved");
  // a change to the types is held as a proposal
  const types = await d.registry.call("flows.propose", { what: "types", diff: { add_types: [{ name: "intake-note", label: "Intake note", fields: [{ name: "body", kind: "text", label: "Body" }] }] } }, "cli", await assistantMeta({ agentOnly: only }));
  assert.ok(types.data && types.data.ok, JSON.stringify(types));
  assert.ok(!(await d.kernel.store.types()).some((/** @type {any} */ x) => x.name === "intake-note"), "not defined before the yes");
  // (A Kit proposal by an assistant's chain is covered in kernel/flows/proposals.test.js on the harness kernel: the real gateway has no `kits.install` action yet, so a Kit cannot be proposed on a real vyred by anyone. Open item for platform.)
  // a call with no person behind it proposes nothing
  assert.ok((await d.registry.call("flows.propose", { what: "flow", id: def.id, version: def.version }, "mcp")).error);
});

test("ENG-2: a user agent already named engineer becomes the built-in at start: held to the list, no projects, no computer", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  d.registry.deps.db.prepare("UPDATE agents_agents SET builtin = 0, projects = ?, computer = 1, auth = ? WHERE name = 'engineer'").run(JSON.stringify(["somewhere"]), JSON.stringify({ vault: "x" }));
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const scope = (await d.registry.call("agents.scope", { name: "engineer" }, "module:vyred")).data;
  assert.ok(Array.isArray(scope.only) && scope.only.includes("flows.propose"), JSON.stringify(scope));
  assert.deepEqual(scope.projects, []);
  const eng = (await d.registry.call("agents.list", {}, "cli")).data.find((/** @type {any} */ a) => a.name === "engineer");
  assert.equal(eng.builtin, true); assert.equal(eng.computer, false);
});
