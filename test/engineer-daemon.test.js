// @ts-check
// @Engineer (R031-16) on a REAL vyred: ships with the Space, holds exactly the tools that set a Space up by conversation, builds a template and a Flow from a description by drafting and proposing, and is refused
// everything that applies a change. The model's part is scripted here (the same calls in the order the instructions and the build-a-template skill teach); a run with a live model is a paid eval.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { ENGINEER } from "../core/agents/index.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("the Engineer ships with the Space and holds the tools that set it up; from a description it drafts a template and a Flow and proposes both; it cannot apply, start, approve or change an agent", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await meta());
  /** The Engineer's calls: the owner's authority held to the Engineer's tool list, as the registry holds its model session. */
  const engineer = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { ...(await meta()), agentOnly: [...ENGINEER.tools] });

  // it is in the roster of a new Space, built in, proposing only, with the tools it needs
  const list = (await asOwner("agents.list")).data;
  const eng = list.find((/** @type {any} */ a) => a.name === "engineer");
  assert.ok(eng && eng.builtin && eng.proposes_only, "shipped with the Space");
  for (const need of ["work.template.define", "work.template.test", "flows.define", "flows.simulate", "flows.propose", "docs.find", "skills.find"]) assert.ok(eng.tools.includes(need), `${need} is in its toolbox`);
  assert.match(eng.instructions, /work\.template\.test/, "and its instructions teach the template way");

  // from a description: "an intake for new clients: gather documents, then a conflict check, then draft"
  const body = { name: "New client intake", roles: [{ role: "researcher", agent: "research", lead: true }], stages: [
    { name: "Intake", owner: "role:attorney", tasks: [{ title: "Gather documents", doer: "role:researcher", output: { kind: "note" } }] },
    { name: "Conflicts", tasks: [{ title: "Run the conflict check", doer: "role:researcher", checker: "role:attorney", output: { kind: "decision" } }] },
    { name: "Drafting" },
  ] };
  const def = await engineer("work.template.define", { body });
  assert.equal(def.error, undefined, JSON.stringify(def));
  const tried = await engineer("work.template.test", { template: def.data.template, version: def.data.version, sample: { name: "Chen" } });
  assert.ok(tried.data.ok && /Goal: Gather documents for Chen/.test(tried.data.lines.join("\n")), "it reads the briefs it wrote");
  const card = await engineer("flows.propose", { what: "template", template: def.data.template, version: def.data.version });
  assert.ok(card.data && card.data.ok, JSON.stringify(card));

  const flow = { format: 1, name: "tag_new_contacts", label: "Note new contacts", authorship: "model", trigger: { on: "manual" }, steps: [{ id: "f", kind: "find", type: "task", where: "true", limit: 1 }] };
  const fdef = await engineer("flows.define", { flow });
  assert.ok(fdef.data && fdef.data.ok, JSON.stringify(fdef));
  const fcard = await engineer("flows.propose", { what: "flow", id: fdef.data.id, version: fdef.data.version });
  assert.ok(fcard.data && fcard.data.ok, JSON.stringify(fcard));

  // nothing is live until the owner says yes
  assert.equal((await asOwner("work.template.list", { template: def.data.template })).data.versions[0].state, "draft");
  // what it must not do: the registry refuses what is not in its list, and what only a person does is not in the list at all
  for (const [tool, input] of [["work.start-project", { template: def.data.template, name: "X" }], ["agents.update", { name: "research", model: "x" }]] ) {
    const r = await engineer(/** @type {string} */ (tool), input);
    assert.equal(r.error && r.error.code, "denied", `${tool} is not the Engineer's: ${JSON.stringify(r.error)}`);
    assert.match(r.error.message, /drafts and proposes, and a person approves/);
  }
  for (const person of ["work.template.golive", "work.start-project", "flows.approve", "flows.rollback", "agents.update", "agents.create", "agents.delete", "grants.create"]) assert.ok(!ENGINEER.tools.includes(person), `${person} stays a person's`);

  // the owner's yes on the template card puts it live
  const row = await d.kernel.gateway.ask.get(ownerChain, card.data.task);
  await d.kernel.gateway.ask.decide(ownerChain, card.data.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: card.data.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  await until(async () => (await asOwner("work.template.list", { template: def.data.template })).data.versions[0].state === "live", "the template to go live on the owner's yes");
});
