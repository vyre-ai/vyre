// @ts-check
// The owner's rows follow an adoption. A home starts with a local owner id; when the person claims their identity the kernel's owner becomes that id (`adoptOwner`), once. Whatever a module wrote for the owner
// BEFORE that (the agents roster, planner items, projects, vault items) must be there for the owner AFTER it, and a session token opened under the old id must still be the owner's. Real
// daemon, kernel on. One test makes each row, adopts, and lists every one again; it names every module that lost one rather than stopping at the first.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start, callerFacts } from "./index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const NEW = "per_dddddddddddddddddddddddddd";
const skillText = (/** @type {string} */ n) => `---\nname: ${n}\ndescription: Use this when the person asks about ${n}, which is the census skill\n---\nthe census skill\n`;

test("adopt changes the owner, and the owner's rows follow: agents, planner, projects, vault", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const old = d.kernel.id.owner;
  const cli = () => ({ kernelFacts: callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false, outside: true }) });
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta = cli()) => d.registry.call(tool, input, "cli", meta);
  /** @type {string[]} */ const lost = [], noted = [];
  const need = (/** @type {string} */ what, /** @type {boolean} */ ok, /** @type {any} */ got) => { if (!ok) lost.push(`${what}: ${JSON.stringify(got).slice(0, 160)}`); };

  // ---- before: the rows the owner makes on a fresh home
  const agent = await call("agents.create", { name: "census", kind: "agent" });
  const proj = await call("projects.create", { name: "census-project" });
  const todo = await call("planner.add", { kind: "todo", title: "census todo" });
  const vaultMade = await call("vault.put", { name: "census-secret", kind: "secret", fields: { value: "v" } });
  const pre = { token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-pre", person: old, path: "direct", session: "s" }), {})).token };
  const sk = await call("skills.draft", { name: "census-skill", level: "personal", kind: "skill", body: skillText("census-skill") }, pre);
  const skOk = !sk.error && !(await call("skills.approve", { name: "census-skill", level: "personal", version: sk.data.version }, pre)).error;
  for (const [what, r] of /** @type {[string, any][]} */ ([["agents.create", agent], ["projects.create", proj], ["planner.add", todo], ["vault.put", vaultMade], ["skills.draft + skills.approve", { error: skOk ? undefined : sk.error || "approve failed" }]])) assert.ok(!r.error, `before adoption ${what} did not work: ${JSON.stringify(r.error)}`);
  noted.push(`before: agent=${agent.error ? "x" : "ok"} project=${proj.error ? "x" : "ok"} todo=${todo.error ? "x" : "ok"} vault=${vaultMade.error ? "x" : "ok"}`);
  const oldChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-old", person: old, path: "direct", session: "s" });
  const token = (await d.kernel.surfaces.open(oldChain, {})).token;

  // ---- adopt
  const h = d.kernel.kernelFor({ name: "spaces", needs: { kernel: { actions: [], spaces: true } } });
  assert.equal((await h.adoptOwner(NEW, old)).changed, true);
  assert.equal(d.kernel.id.owner, NEW);

  // ---- after: the owner's own surface (built under the new id), and the pre-adoption token
  const names = (/** @type {any} */ r, /** @type {string} */ key) => { const list = r && r.data ? (Array.isArray(r.data) ? r.data : r.data[key] || []) : []; return JSON.stringify(list); };
  for (const [label, meta] of /** @type {[string, any][]} */ ([["owner surface", cli()], ["pre-adoption token", { token }]])) {
    const caller = label === "owner surface" ? "cli" : "deck";
    const c = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, caller, meta);
    if (!agent.error) { const r = await c("agents.list"); need(`${label}: agents.list shows census`, !r.error && names(r, "agents").includes("census"), r.error || names(r, "agents")); }
    if (!proj.error) { const r = await c("projects.list"); need(`${label}: projects.list shows census-project`, !r.error && names(r, "projects").includes("census-project"), r.error || names(r, "projects")); }
    if (!todo.error) { const r = await c("planner.list", {}); need(`${label}: planner.list shows the todo`, !r.error && JSON.stringify(r.data).includes("census todo"), r.error || r.data); }
    { const r = await c("skills.list", {}); need(`${label}: skills.list shows the personal skill`, !r.error && JSON.stringify(r.data).includes("census-skill"), r.error || r.data); }
    if (!vaultMade.error) { const r = await c("vault.list", {}); need(`${label}: vault.list shows the secret`, !r.error && JSON.stringify(r.data).includes("census-secret"), r.error || r.data); }
  }
  assert.deepEqual(lost, [], `after adoption these owner rows are gone (${noted.join("; ")})`);
});
