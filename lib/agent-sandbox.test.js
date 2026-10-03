import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PARTIAL_NOTICE, AGENTS, IN_PROCESS, agentFor, plainReason, prepareSandbox, cleanEnv, checkArgs, checkWorkdirs, WINDOWS_NOTICE } from "./agent-sandbox.js";
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
    if (e.relocatable === false) { assert.ok(e.settingsPaths(HOME).every(p => p.startsWith(HOME + "/"))); continue; }
    if (!e.unsupported) { const pr = e.private(HOME); assert.ok(pr.from.startsWith(HOME + "/") && /^[A-Z_]+$/.test(pr.env) && pr.credentialFiles.length && pr.credentialFiles.every(f => !/[\\/]/.test(f)), `${id} relocates its config folder`); }
    assert.ok(e.hosts.length && e.hosts.every(h => /:\d+$/.test(h)), `${id} hosts carry a port`);
    assert.ok(e.versionArgs.length, id);
  }
  assert.deepEqual(agentFor("claude", { home: HOME, command: "/bin/claude" }).private, { from: `${HOME}/.claude`, env: "CLAUDE_CONFIG_DIR", credentialFiles: [".credentials.json"] });
  assert.deepEqual(agentFor("codex", { home: HOME, command: "/bin/codex" }).private, { from: `${HOME}/.codex`, env: "CODEX_HOME", credentialFiles: ["auth.json", "config.toml"] });
  const g = agentFor("grok", { home: HOME, command: "/bin/grok" });
  assert.deepEqual(g.settingsPaths, [`${HOME}/.grok`], "Grok cannot relocate: its own real folder, and nothing else of the person's");
  assert.equal(g.private, undefined);
  assert.throws(() => { AGENTS.nothing = { hosts: [], versionArgs: [] }; try { agentFor("nothing", { home: HOME, command: "/x" }); } finally { delete AGENTS.nothing; } }, { code: "sandbox_unsupported" }, "a provider with neither still refuses");
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
  assert.equal(spawner.sandboxed, true);
  assert.equal(typeof spawner.spawn, "function");
});

test("each process of the session is planned and launched under the same rules, over the session's own socket", async () => {
  const fs = fakeSandbox();
  const { spawn: spawner } = await prepareSandbox(cfg(fs), sess);
  const child = spawner("/usr/local/bin/claude", ["-p"], { LANG: "en_US.UTF-8", GONE: undefined }, "/Users/alex/work/harlow/sub", { signal: "sig" });
  assert.equal(child.pid, 4242);
  const p = fs.calls.plan.at(-1);
  assert.equal(p.sessionSocket, sess.sessionSocket);
  assert.deepEqual(p.env, { LANG: "en_US.UTF-8" }, "undefined values are dropped");
  assert.deepEqual(p.readOnly, ["/usr/local/bin"]);
  assert.ok(p.workdirs.includes("/Users/alex/work/harlow") && p.workdirs.includes("/Users/alex/work/harlow/sub"));
  assert.deepEqual(fs.calls.launch.at(-1)[1], { signal: "sig" });
  assert.deepEqual(await prepareSandbox(cfg(fs), { ...sess, provider: "openrouter" }), { sandboxed: false, reason: "in_process" }, "an in-process provider has nothing to confine");
});

test("spawnSession uses the prepared spawner and records the process for the peer check", () => {
  const seen = [];
  const child = spawnSession("/bin/x", ["a"], { cwd: "/w", env: { A: "1" }, onSpawn: g => seen.push(g), sandboxSpawn: (c, a, e, cwd) => ({ pid: 77, c, a, e, cwd }) });
  assert.equal(child.pid, 77);
  assert.deepEqual(seen, [{ pid: 77, pgid: 77, sid: 77 }]);
});

test("the runner's real planHome accepts what the table gives it, on both systems, and keeps the settings paths and nothing of the Vyre home", () => {
  for (const platform of ["darwin", "linux"]) for (const provider of ["claude", "codex"]) {
    const agent = agentFor(provider, { home: HOME, command: "/usr/local/bin/agent" });
    const plan = planHome({ platform, command: "/usr/local/bin/agent", args: [], home: HOME, vyreHome: `${HOME}/.vyre`, sessionSocket: "/run/vyre-threads/abc.sock", workdirs: ["/Users/alex/work/harlow"], agent, temp: "/tmp/ses-1" });
    const text = JSON.stringify(plan);
    assert.ok(text.includes(agent.private.env), `${platform}/${provider}: the config folder is relocated`);
    assert.ok(!text.includes(agent.private.from + "\"") && !JSON.stringify(plan.argv).includes(`${agent.private.from}:`), `${platform}/${provider}: the real folder is not bound`);
  }
});

test("all three platforms: macOS and Linux run the self-test and confine; Windows starts unsandboxed with the notice and no sandbox call; anything else refuses", async () => {
  for (const platform of ["darwin", "linux"]) {
    const fs = fakeSandbox();
    const r = await prepareSandbox({ ...cfg(fs), platform, credentials: () => "sk-ant-oat01-test-token-aaaaaaaaaaaa" }, sess);
    assert.equal(r.sandboxed, true, platform);
    assert.equal(fs.calls.test.length, 1, `${platform} runs the self-test`);
    assert.equal(fs.calls.test[0].platform, platform);
  }
  const win = fakeSandbox();
  const w = await prepareSandbox({ ...cfg(win), platform: "win32" }, sess);
  assert.deepEqual(w, { sandboxed: false, reason: "windows", notice: WINDOWS_NOTICE });
  assert.equal(WINDOWS_NOTICE, "On Windows, sessions aren't sandboxed yet. An assistant here runs like any program you start. Add a server to run them sandboxed.");
  assert.deepEqual([win.calls.test.length, win.calls.plan.length, win.calls.launch.length], [0, 0, 0], "no sandbox call, so planHome's refusal on Windows is never a crash");
  await assert.rejects(() => prepareSandbox({ ...cfg(fakeSandbox()), platform: "freebsd" }, sess), { code: "sandbox_unsupported" });
});

test("the launcher refuses a workdir that is or contains the home, and the Vyre home", async () => {
  const fs = fakeSandbox();
  for (const w of [HOME, "/Users", "/", `${HOME}/.vyre`, `${HOME}/.vyre/keys`]) await assert.rejects(() => prepareSandbox(cfg(fs), { ...sess, workdirs: [w] }), { code: "sandbox_workdir" }, w);
  checkWorkdirs([`${HOME}/work/harlow`], HOME, `${HOME}/.vyre`);
  const { spawn } = await prepareSandbox(cfg(fs), sess);
  assert.throws(() => spawn("/usr/local/bin/claude", [], {}, HOME), { code: "sandbox_workdir" }, "a process started in the home is refused too");
});

test("environment allow-list: no token, key, secret or kernel session token reaches the session, and none goes in argv", async () => {
  const kernelToken = "eyJ2IjoxLCJzcGFjZSI6InNwYyJ9AAAA.0123456789abcdef0123456789abcdef";
  const { env, dropped } = cleanEnv({ PATH: "/usr/bin", HOME, LANG: "C", GIT_AUTHOR_NAME: "Alex", VYRE_THREAD: "t1", ANTHROPIC_API_KEY: "sk-ant-aaaaaaaaaaaaaaaaaaaa", CLAUDE_CODE_OAUTH_TOKEN: "x", VYRE_SESSION: kernelToken, SOMETHING: "else", AWS_SECRET_ACCESS_KEY: "s", MY: kernelToken });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_AUTHOR_NAME", "HOME", "LANG", "PATH", "VYRE_THREAD"]);
  assert.ok(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "VYRE_SESSION", "SOMETHING", "AWS_SECRET_ACCESS_KEY", "MY"].every(k => dropped.includes(k)));
  assert.throws(() => checkArgs(["-p", kernelToken]), { code: "sandbox_failed" });
  assert.throws(() => checkArgs(["--key", "sk-ant-aaaaaaaaaaaaaaaaaaaa"]), { code: "sandbox_failed" });
  checkArgs(["-p", "--output-format", "stream-json"]);
  const fs = fakeSandbox();
  const { spawn } = await prepareSandbox(cfg(fs), sess);
  spawn("/usr/local/bin/claude", ["-p"], { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-aaaaaaaaaaaaaaaaaaaa", VYRE_X: kernelToken }, "/Users/alex/work/harlow");
  assert.deepEqual(fs.calls.plan.at(-1).env, { PATH: "/usr/bin" });
});

test("Claude on macOS: no Keychain; the vault's setup token goes in the session's own process only, and without one the session does not start with the way to add it", async () => {
  const fs = fakeSandbox();
  const base = { ...cfg(fs), platform: "darwin" };
  await assert.rejects(() => prepareSandbox(base, sess), { code: "sandbox_credential", message: /claude setup-token/ });
  assert.equal(fs.calls.test.length, 0, "nothing ran");
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-LEAKED-FROM-LAUNCHER-aaaaaaaaaaaa";
  try {
    const { spawn } = await prepareSandbox({ ...base, credentials: p => (p === "claude" ? "sk-ant-oat01-FROM-THE-VAULT-bbbbbbbbbbbb" : undefined) }, sess);
    spawn("/usr/local/bin/claude", ["-p"], { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }, "/Users/alex/work/harlow");
    assert.deepEqual(fs.calls.plan.at(-1).env, { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-FROM-THE-VAULT-bbbbbbbbbbbb" }, "the vault's token, not the launcher's, and nothing else secret");
  } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  // Linux copies the credentials file instead and needs no token; Codex keeps its sign-in in a file on every system
  const lin = fakeSandbox(); assert.equal((await prepareSandbox({ ...cfg(lin), platform: "linux" }, sess)).sandboxed, true);
  const cdx = fakeSandbox(); assert.equal((await prepareSandbox({ ...cfg(cdx), platform: "darwin" }, { ...sess, provider: "codex", command: "/usr/local/bin/codex" })).sandboxed, true);
});

test("Grok runs partly sandboxed: the self-test and every process carry its own settings folder and the result says so", async () => {
  const fs = fakeSandbox();
  const r = await prepareSandbox(cfg(fs), { ...sess, provider: "grok", command: "/usr/local/bin/grok" });
  assert.equal(r.sandboxed, true);
  assert.deepEqual(r.partial, { reason: "own_settings_folder", folder: [`${HOME}/.grok`], notice: PARTIAL_NOTICE });
  assert.deepEqual(fs.calls.test[0].agent.settingsPaths, [`${HOME}/.grok`]);
  r.spawn("/usr/local/bin/grok", ["acp"], {}, "/Users/alex/work/harlow");
  assert.deepEqual(fs.calls.plan.at(-1).agent.settingsPaths, [`${HOME}/.grok`]);
  assert.equal(fs.calls.plan.at(-1).agent.private, undefined);
  assert.equal((await prepareSandbox(cfg(fs), sess)).partial, undefined, "a provider that relocates is fully sandboxed");
});
