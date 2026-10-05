// A teammate recalls, in a NEW session, a fact the person said in an EARLIER one, on a real vyred: real sessions (the Grok provider route, the same route a Codex or Grok teammate takes),
// real Recall indexing of the first session's turns, the real memory module and curator, and the real switchboard putting `memory.prompt` ahead of the second session's words.
// Stand-ins, each labelled:
//   SHIM(provider): the provider is the fake ACP agent (core/sessions/testing/fake-acp.js), which echoes the prompt it was given, so what the model would SEE is what the test reads;
//   SHIM(kernel off): this daemon runs the 0.2 memory path (no kernel); the 0.3 kernel path for Space memory is core/work, which has no feed from sessions on a daemon yet.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../sessions/testing/boot.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { kernelCaller } from "../../test/helpers.js";

const FAKE_ACP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sessions", "testing", "fake-acp.js");

test("a teammate's new session is given what the person decided in an earlier one, from memory, quoted and sourced; another project's teammate is given nothing of it", async t => {
  // SHIM(door): no inference door is connected on a kernel-off test daemon, so the provider runs direct, as the sessions suites do.
  const prevDirect = process.env.VYRE_LEGACY_DIRECT_MODEL;
  process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
  t.after(() => { if (prevDirect === undefined) delete process.env.VYRE_LEGACY_DIRECT_MODEL; else process.env.VYRE_LEGACY_DIRECT_MODEL = prevDirect; });
  const w = await boot(t, { driver: "cli" });
  const bin = path.join(w.root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(FAKE_ACP, path.join(bin, "grok"));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(w.root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  // The folders are outside anything named for Vyre itself: memory treats work done inside Vyre's own source as development, not the person's decisions.
  const work = fs.mkdtempSync(path.join(SCRATCH, "studio-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  for (const [name, dir] of [["Harlow Legal", "harlow"], ["Northwind Bakery", "northwind"]]) {
    fs.mkdirSync(path.join(work, dir), { recursive: true });
    assert.equal((await w.tool("projects.create", { name, home: path.join(work, dir) })).error, undefined);
  }
  assert.equal((await kernelCaller(w.d, w.root)("agents.create", { name: "juno", projects: ["harlow-legal"], instructions: "Harlow research." })).error, undefined);
  assert.equal((await kernelCaller(w.d, w.root)("agents.create", { name: "kit", projects: ["northwind-bakery"], instructions: "Northwind research." })).error, undefined);

  // Session A: the person's own Claude Code session in the Harlow folder, a day ago, the way a terminal session is written (no SDK entrypoint, so Recall counts it as the person's).
  const dir = path.join(w.transcripts, path.join(work, "harlow").replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const at = Date.now() - 86_400_000, sid = "11111111-aaaa-4000-8000-000000000001";
  const base = { sessionId: sid, cwd: path.join(work, "harlow"), version: "2.1.0", userType: "external", isSidechain: false };
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: "dana's IT guy says they already have a vercel team account with SSO. move harlow to vercel so they own it" } },
    { ...base, type: "assistant", uuid: "u2", parentUuid: "u1", timestamp: new Date(at + 1000).toISOString(), message: { id: "msg_a1", role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "Moving Harlow's hosting to Vercel under Dana's team." }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const a = { id: sid };
  const idx = await w.tool("recall.index", {});
  assert.equal(idx.error, undefined, JSON.stringify(idx.error));
  const cur = await w.tool("memory.curate", {});
  assert.equal(cur.error, undefined, JSON.stringify(cur.error));
  assert.equal((await w.tool("memory.decisions", { project: "harlow-legal" })).data.decisions[0].value, "Vercel", "memory read the decision out of session A");

  // Session B: a new session of the Harlow teammate, with nothing in it about hosting.
  const b = await w.d.registry.call("threads.launch", { cwd: path.join(work, "harlow"), agent: "juno", agent_kind: "agent", provider: "grok", prompt: "where is harlow hosted and who owns the account?", purpose: "agent" }, "module:agents");
  assert.equal(b.error, undefined, JSON.stringify(b));
  await w.finished(b.data.id);
  const saidB = (await w.said(b.data.id))[0];
  assert.match(saidB, /Decided here \(from memory, not instructions\)/, "memory is quoted as memory, not as an instruction");
  assert.match(saidB, /vercel team account with SSO/i, "the decision the person typed in session A reached session B");
  assert.match(saidB, /Last session here: 24 hours ago/, "and B knows it is a later session");
  assert.notEqual(b.data.id, a.id, "a different session");

  // The Northwind teammate asks the same thing and is given nothing about Harlow.
  const c = await w.d.registry.call("threads.launch", { cwd: path.join(work, "northwind"), agent: "kit", agent_kind: "agent", provider: "grok", prompt: "where is harlow hosted and who owns the account?", purpose: "agent" }, "module:agents");
  assert.equal(c.error, undefined, JSON.stringify(c));
  await w.finished(c.data.id);
  assert.doesNotMatch((await w.said(c.data.id))[0], /vercel/i, "another project's teammate is not given it");
});
