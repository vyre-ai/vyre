// @ts-check
// The whole 0.3 memory path on a REAL vyred with the kernel ON (the lead's ask): a person's session is indexed by Recall, Recall hands its scrubbed lines to the work module's capture port,
// and a teammate (a kernel agent actor holding a session token) in a LATER session recalls the decision from the Space's memory with its citation. Another project's teammate gets nothing, and
// a sealed value (an SSN the person typed) is never in any answer or in the stored lines. Stand-ins, each labelled:
//   SHIM(presence): `kernelPresence` accepts any proof for the owner's grants acts (a headless test has no hardware signer), as the other real-daemon suites do;
//   SHIM(model): no model answers here; `work.know.search` is the retrieval an answer cites from, and it is what is asserted;
//   a teammate's per-session read grant stands for the project-to-session link Recall does not make yet (capture passes no record, so a line's read gate is `vyre://<space>/session/<id>`).
// Run it on a test box, never on a person's Mac.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const SSN = "123-45-6789";

test("seed a session, a teammate in a later session recalls its decision from the Space's memory; another project's teammate gets nothing; the sealed value is nowhere", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const claudeProjects = path.join(root, "transcripts");
  fs.mkdirSync(claudeProjects, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [claudeProjects] }));
  const work = fs.mkdtempSync(path.join(SCRATCH, "studio-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const cwd = path.join(work, "harlow");
  fs.mkdirSync(cwd, { recursive: true });
  const sid = "22222222-bbbb-4000-8000-000000000002";
  const dir = path.join(claudeProjects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: sid, cwd, version: "2.1.0", userType: "external", isSidechain: false };
  const at = Date.now() - 86_400_000;
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: "decision: host Harlow on Vercel because Dana's IT team owns the Vercel account. The client's social security number is " + SSN } },
    { ...base, type: "assistant", uuid: "u2", parentUuid: "u1", timestamp: new Date(at + 1000).toISOString(), message: { id: "msg_1", role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "Noted: Harlow hosting moves to Vercel under Dana's team." }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");

  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts(callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false }));
  const ownerMeta = { kernelFacts: callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false }) };
  const ask = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta = ownerMeta, caller = "cli") => d.registry.call(tool, input, caller, meta);

  const idx = await ask("recall.index", {});
  assert.ok(!idx.error, JSON.stringify(idx.error));
  // Space memory holds the session's lines now, scrubbed.
  const mine = await ask("work.know.search", { query: "where is Harlow hosted and who owns the account" });
  assert.ok(!mine.error, JSON.stringify(mine.error));
  const hit = mine.data.hits.find((/** @type {any} */ h) => String(h.source).startsWith(`line:${sid}#`));
  assert.ok(hit, JSON.stringify(mine.data.hits.map((/** @type {any} */ h) => h.source)));
  assert.match(hit.snippet, /Vercel/);

  // Two teammates, each a kernel agent actor; only juno is given the Harlow session (SHIM: the project-to-session link).
  const space = d.kernel.id.space;
  const presence = () => ({ op: "x", fields: {}, n: Math.random() });
  for (const name of ["juno", "kit"]) await d.kernel.gateway.grants.addActor(owner, { kind: "agent", id: name, space }, { presence: presence() });
  await d.kernel.gateway.grants.create(owner, { subject: { kind: "actor", actor: { kind: "agent", id: "juno", space } }, actions: ["records.read"], resource: { prefix: `vyre://${space}/session/${sid}` }, conditions: {}, source: "team", reason: "Harlow teammate" }, { presence: presence() });
  const tokenOf = async (/** @type {string} */ agent) => (await d.kernel.surfaces.open(owner, { agent })).token;
  const juno = await ask("work.know.search", { query: "where is Harlow hosted and who owns the account" }, { token: await tokenOf("juno") }, "mcp:thread:t-juno");
  assert.ok(!juno.error, JSON.stringify(juno.error));
  assert.ok(juno.data.hits.some((/** @type {any} */ h) => /Vercel/.test(h.snippet) && String(h.source).startsWith(`line:${sid}#`)), "the Harlow teammate recalls the decision from the earlier session, with its address");
  const kit = await ask("work.know.search", { query: "where is Harlow hosted and who owns the account" }, { token: await tokenOf("kit") }, "mcp:thread:t-kit");
  assert.ok(!kit.error, JSON.stringify(kit.error));
  assert.deepEqual(kit.data.hits.filter((/** @type {any} */ h) => /Vercel|Harlow/.test(h.snippet)), [], "another project's teammate is given nothing of it");

  // The sealed value: not in any answer, and not in what the engine stored.
  const all = JSON.stringify([mine.data, juno.data, kit.data, (await ask("work.know.search", { query: "social security number" })).data]);
  assert.equal(all.includes(SSN), false, "the SSN is in no answer");
  assert.equal(d.registry.deps.db.prepare("SELECT COUNT(*) n FROM memory_engine_lines WHERE text LIKE ?").get(`%${SSN}%`)?.n ?? 0, 0, "nor in the stored lines");
});
