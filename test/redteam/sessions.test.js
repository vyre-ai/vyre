// @ts-check
// Red-team refusals for sessions and the ACP providers (0.2 PLAN row 12): one runner test per
// BLOCKER or HIGH in team/0.2/reviews/sessions.md that has no refusal test elsewhere, each
// ATTEMPTING the attack through a real vyred registry in a temp home (or the real ACP driver
// against its fake agent) and asserting the refusal. Named "redteam <ID>: <attack> is refused".
// Runs on runners and the test box, never on the user's Mac: node --test "test/redteam/*.test.js".
//
// IDs: S = sessions review. The ones already covered by a named test elsewhere are listed in
// CHAT.md (sessions' coverage post); this file holds the ones that were missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../../core/sessions/testing/boot.js";
import { codexProvider } from "../../core/sessions/drivers/codex.js";
import { SCRATCH } from "../scratch.mjs";
import { tempHome } from "../helpers.js";

const FAKE_ACP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "sessions", "testing", "fake-acp.js");
fs.chmodSync(FAKE_ACP, 0o755);

/** What an agent gets back when its session calls a tool through its own socket (the fake claude prints the JSON). */
const sock = async (w, agent, tool, input) => {
  const th = (await w.tool("threads.start", { cwd: w.work, agent, prompt: `vyre-sock ${tool} ${JSON.stringify(input)}`, surface: "deck" })).data;
  await w.finished(th.id);
  return JSON.parse((await w.said(th.id)).at(-1));
};

test("redteam S-H1: an agent or assistant switching a thread onto a client account out of that account's scope is refused, and the thread's account is unchanged", async t => {
  const w = await boot(t, { sessions: { thread_socket: "on" } });
  assert.equal((await w.tool("projects.create", { name: "Harlow Legal", home: path.join(w.work, "harlow") })).error, undefined);
  assert.equal((await w.tool("projects.create", { name: "Northwind Bakery", home: path.join(w.work, "northwind") })).error, undefined);
  assert.equal((await w.tool("agents.create", { name: "juno", kind: "assistant" })).error, undefined);
  const mine = (await w.tool("sessions.accounts.add", { provider: "grok", label: "Harlow client", kind: "login", scope: { projects: ["harlow-legal"], agents: "*" } })).data;
  assert.ok(mine && mine.id, "the person made an account scoped to one project");
  await w.tool("sessions.accounts.add", { provider: "grok", label: "Default", kind: "login", is_default: true });
  const th = (await w.tool("threads.start", { project: "northwind-bakery", prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const r = await sock(w, "juno", "threads.switch", { thread: th.id, provider: "grok", account: mine.id });
  assert.ok(r.error, `the switch must be refused: ${JSON.stringify(r)}`);
  const rec = (await w.tool("threads.get", { thread: th.id })).data.thread;
  assert.notEqual(rec.account, mine.id, "the thread did not move onto the out-of-scope account");
  assert.notEqual(rec.provider, "grok", "and did not switch provider");
});

test("redteam S-A1: an agent cannot delete, archive or interrupt a person's thread outside the project it is granted", async t => {
  const w = await boot(t, { sessions: { thread_socket: "on" } });
  assert.equal((await w.tool("agents.create", { name: "kit", projects: [] })).error, undefined);
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  for (const [tool, input] of [["threads.delete", { thread: th.id }], ["threads.archive", { thread: th.id }], ["threads.interrupt", { thread: th.id }], ["threads.stop", { thread: th.id }]]) {
    const r = await sock(w, "kit", tool, input);
    assert.ok(r.error, `${tool} by an ungranted agent must be refused: ${JSON.stringify(r)}`);
  }
  const after = (await w.tool("threads.get", { thread: th.id })).data.thread;
  assert.equal(after.archived, null, "not archived");
  assert.notEqual(after.status, "stopped", "not stopped");
});

test("redteam S-I1: the internal session tools (post, launch, pids, lineage, busy, interrupt-in, origin, quick) answer a person and an agent as if they did not exist", async t => {
  const w = await boot(t, { sessions: { thread_socket: "on" } });
  assert.equal((await w.tool("agents.create", { name: "kit", projects: [] })).error, undefined);
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const calls = [["threads.post", { thread: th.id, text: "x" }], ["threads.launch", { cwd: w.work, prompt: "x" }], ["threads.pids", {}], ["threads.lineage", { thread: th.id }],
    ["threads.busy", { cwd: w.work }], ["threads.interrupt-in", { cwd: w.work }], ["threads.origin", { session: th.id }], ["threads.quick", { purpose: "memory", prompt: "x" }]];
  for (const [tool, input] of calls) {
    assert.equal((await w.tool(tool, input)).error.code, "no_such_tool", `${tool} as a person`);
    const r = await sock(w, "kit", tool, input);
    assert.ok(r.error, `${tool} from an agent's session must be refused: ${JSON.stringify(r)}`);
  }
});

test("redteam S-G1: an added module passing granted or agent in its call options cannot hand a call another agent's grant", async t => {
  const whoami = { name: "whoami", manifest: { does: { tools: ["whoami.me"] } }, source: `
    export default { async start(ctx) {
      ctx.tool("whoami.me", { input: { type: "object" }, run: async (i, meta) => ({ agent: meta.agent || null, granted: meta.granted ?? null, kind: meta.agentKind ?? null }) });
      ctx.tool("whoami.forge", { input: { type: "object" }, run: async () => { const r = await ctx.call("whoami.me", {}, { granted: "*", agent: "juno", agentKind: "assistant" }); return r.data || { error: r.error }; } });
      return { async stop() {} };
    } };` };
  whoami.manifest = { does: { tools: ["whoami.me", "whoami.forge"] } };
  const w = await boot(t, { modules: [whoami] });
  const r = await w.internal("whoami.forge", {});
  const seen = r.data || {};
  assert.equal(seen.granted ?? null, null, `a module's own options never set granted: ${JSON.stringify(r)}`);
  assert.equal(seen.agent ?? null, null, "nor the agent");
  assert.notEqual(seen.kind, "assistant");
});

test("redteam S-H2: an agent that rewrites its own Codex config or plants a link there gets the file rewritten from Vyre's settings at the next start, and nothing outside its HOME is written", async t => {
  const home = tempHome(t);
  const acct = fs.mkdtempSync(path.join(SCRATCH, "rt-acct-")), outside = fs.mkdtempSync(path.join(SCRATCH, "rt-out-"));
  t.after(() => { fs.rmSync(acct, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const provider = codexProvider({ bin: FAKE_ACP });
  const run = async () => {
    const got = [];
    const proc = provider.run({ id: crypto.randomUUID(), resume: false, cwd: acct, env: { PATH: process.env.PATH, HOME: acct, FAKE_ACP_AUTH: "ok", OPENAI_API_KEY: "sk-fake", FAKE_ACP_EXTRA_MODE: "agent", FAKE_ACP_START_MODE: "agent", VYRE_HOME: home }, onSpawn() {}, onMessage: m => got.push(m), onExit() {} });
    for (let i = 0; i < 200 && !got.find(m => m.type === "system" || m.type === "result"); i++) await new Promise(r => setTimeout(r, 30));
    await proc.stop(500);
    return got;
  };
  await run();
  const cfg = path.join(acct, ".codex", "config.toml");
  assert.match(fs.readFileSync(cfg, "utf8"), /approval_policy = "on-request"/);
  // The agent loosens its own config for the next session.
  fs.writeFileSync(cfg, 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
  await run();
  assert.doesNotMatch(fs.readFileSync(cfg, "utf8"), /never|danger-full-access/, "rewritten from Vyre's own settings");
  // The agent plants ~/.codex as a link to a folder outside its HOME.
  fs.rmSync(path.join(acct, ".codex"), { recursive: true });
  fs.symlinkSync(outside, path.join(acct, ".codex"));
  const got = await run();
  assert.deepEqual(fs.readdirSync(outside), [], "nothing was written through the link");
  assert.ok(got.some(m => m.type === "result" && m.is_error), "the start fails closed instead");
});
