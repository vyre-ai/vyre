import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AGENTS, IN_PROCESS, agentFor, plainReason, prepareSandbox } from "./agent-sandbox.js";
import { spawnSession } from "../core/sessions/spawn.js";
import { planHome } from "../core/runner/homesandbox.js";

const HOME = "/Users/alex";
const probes = { personSocket: "/Users/alex/.vyre/vyred.sock", otherSocket: "/run/vyre-threads/other.sock", daemonPorts: [7300], keyFile: "/Users/alex/.vyre/keys/core.key" };

function fakeSandbox(over = {}) {
  const calls = { plan: [], test: [], launch: [] };
  return { calls, sandbox: {
    planHome: o => { calls.plan.push(o); return { argv: [o.command, ...(o.args || [])], env: o.env, socket: o.sessionSocket }; },
    selfTest: async o => { calls.test.push(o); return over.test || { ok: true, failures: [] }; },
    launch: (plan, opts) => { calls.launch.push([plan, opts]); return { pid: 4242 }; },
  } };
}
const cfg = fs => ({ sandbox: fs.sandbox, platform: "linux", home: HOME, probes, temp: "/tmp/ses-1" });
const sess = { provider: "claude", command: "/usr/local/bin/claude", sessionSocket: "/run/vyre-threads/abc.sock", workdirs: ["/Users/alex/work/harlow"] };

test("the provider table: one entry per agent provider with settings paths, hosts and version args; in-process providers have none", () => {
  for (const [id, e] of Object.entries(AGENTS)) {
    assert.ok(e.settingsPaths(HOME).every(p => p.startsWith(HOME + "/")), `${id} settings are inside the home`);
    assert.ok(e.hosts.length && e.hosts.every(h => /:\d+$/.test(h)), `${id} hosts carry a port`);
    assert.ok(e.versionArgs.length, id);
  }
  assert.deepEqual(agentFor("claude", { home: HOME, command: "/bin/claude" }).settingsPaths, [`${HOME}/.claude`, `${HOME}/.claude.json`]);
  assert.deepEqual(agentFor("codex", { home: HOME, command: "/bin/codex" }).settingsPaths, [`${HOME}/.codex`]);
  for (const p of IN_PROCESS) assert.equal(agentFor(p, { home: HOME, command: "/x" }), null, `${p} runs inside Vyre through the door`);
  assert.throws(() => agentFor("mystery", { home: HOME, command: "/x" }), { code: "sandbox_unsupported" });
  assert.deepEqual(agentFor("claude", { home: HOME, command: "/c", extraHosts: ["gateway.example:443"] }).hosts.at(-1), "gateway.example:443", "a custom endpoint adds its host");
});

test("the launcher: self-test first, with the agent and the probes; a failure means no session and one plain reason", async () => {
  const bad = fakeSandbox({ test: { ok: false, failures: ["the person's own socket is reachable", "another session's socket is reachable"] } });
  await assert.rejects(() => prepareSandbox(cfg(bad), sess), e => e.code === "sandbox_failed" && e.message === plainReason(["the person's own socket is reachable"]) && e.failures.length === 2);
  assert.equal(bad.calls.launch.length, 0, "nothing was launched");
  const ok = fakeSandbox();
  const spawner = await prepareSandbox(cfg(ok), sess);
  assert.equal(ok.calls.test.length, 1);
  assert.deepEqual(ok.calls.test[0].agent.hosts, AGENTS.claude.hosts);
  assert.equal(ok.calls.test[0].sessionSocket, sess.sessionSocket);
  assert.deepEqual(ok.calls.test[0].probes, probes);
  assert.equal(typeof spawner, "function");
});

test("each process of the session is planned and launched under the same rules, over the session's own socket", async () => {
  const fs = fakeSandbox();
  const spawner = await prepareSandbox(cfg(fs), sess);
  const child = spawner("/usr/local/bin/claude", ["-p"], { FOO: "1", GONE: undefined }, "/Users/alex/work/harlow/sub", { signal: "sig" });
  assert.equal(child.pid, 4242);
  const p = fs.calls.plan.at(-1);
  assert.equal(p.sessionSocket, sess.sessionSocket);
  assert.deepEqual(p.env, { FOO: "1" }, "undefined env values are dropped");
  assert.deepEqual(p.readOnly, ["/usr/local/bin"]);
  assert.ok(p.workdirs.includes("/Users/alex/work/harlow") && p.workdirs.includes("/Users/alex/work/harlow/sub"));
  assert.deepEqual(fs.calls.launch.at(-1)[1], { signal: "sig" });
  assert.equal(await prepareSandbox(cfg(fs), { ...sess, provider: "openrouter" }), null, "an in-process provider has nothing to confine");
});

test("spawnSession uses the prepared spawner and records the process for the peer check", () => {
  const seen = [];
  const child = spawnSession("/bin/x", ["a"], { cwd: "/w", env: { A: "1" }, onSpawn: g => seen.push(g), sandboxSpawn: (c, a, e, cwd) => ({ pid: 77, c, a, e, cwd }) });
  assert.equal(child.pid, 77);
  assert.deepEqual(seen, [{ pid: 77, pgid: 77, sid: 77 }]);
});

test("the runner's real planHome accepts what the table gives it, on both systems, and keeps the settings paths and nothing of the Vyre home", () => {
  for (const platform of ["darwin", "linux"]) for (const provider of Object.keys(AGENTS)) {
    const agent = agentFor(provider, { home: HOME, command: "/usr/local/bin/agent" });
    const plan = planHome({ platform, command: "/usr/local/bin/agent", args: [], home: HOME, vyreHome: `${HOME}/.vyre`, sessionSocket: "/run/vyre-threads/abc.sock", workdirs: ["/Users/alex/work/harlow"], agent, temp: "/tmp/ses-1" });
    const text = JSON.stringify(plan);
    assert.ok(agent.settingsPaths.some(p => text.includes(p)), `${platform}/${provider}: settings paths are allowed back`);
  }
});
