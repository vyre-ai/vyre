// (rig copied from lib/agent-sandbox.e2e.test.js) The launcher against a REAL sandbox: runner's planHome, selfTest and launch (bubblewrap on Linux, seatbelt on macOS) composed by hand, the per-session socket a real listening
// socket, and a scripted provider adapter as the session. Skipped where there is no sandbox. The real `claude` and `codex` binaries are used when they are installed
// (CLAUDE_BIN, CODEX_BIN, or the usual places).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { SCRATCH } from "../test/scratch.mjs";
import * as runner from "../core/runner/homesandbox.js";
import { launch, unavailable } from "../core/runner/sandbox.js";
import { AGENTS, prepareSandbox } from "./agent-sandbox.js";

const SKIP = !["darwin", "linux"].includes(process.platform) || unavailable() !== "";
const CLAUDE = process.env.CLAUDE_BIN || ["/usr/bin/claude", "/usr/local/bin/claude"].find(p => fs.existsSync(p));
const CODEX = process.env.CODEX_BIN || [path.join(process.env.HOME || "", "vyre-ci/codex/node_modules/.bin/codex")].find(p => fs.existsSync(p));
const sandbox = { planHome: runner.planHome, selfTest: runner.selfTest, launch };
const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "as-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const listen = where => new Promise((res, rej) => { const s = net.createServer(c => { c.on("error", () => {}); c.end("hi"); }); s.once("error", rej); s.listen(where, () => res(s)); });
const run = (child) => new Promise(res => { let out = "", err = ""; child.stdout.on("data", d => (out += d)); child.stderr.on("data", d => (err += d)); child.on("close", code => res({ code, out, err })); });

async function rig(t) {
  const home = tmp(); t.after(() => rm(home));
  const runDir = path.join(home, ".vyre", "run", "sessions"); fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".vyre", "keys"), { recursive: true }); fs.writeFileSync(path.join(home, ".vyre", "keys", "device.key"), "SECRET-DEVICE-KEY");
  const own = path.join(runDir, "s1.sock"), other = path.join(runDir, "s2.sock"), person = path.join(home, ".vyre", "vyred.sock");
  const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); t.after(() => daemon.kill("SIGKILL"));
  const servers = await Promise.all([listen(own), listen(other), listen(person), listen({ port: 0, host: "127.0.0.1" })]);
  t.after(() => servers.forEach(s => s.close()));
  fs.mkdirSync(path.join(home, "Documents"), { recursive: true }); fs.writeFileSync(path.join(home, "Documents", "private.txt"), "PERSONAL");
  const proj = path.join(home, "proj"), temp = path.join(home, "tmp-session"); for (const d of [proj, temp]) fs.mkdirSync(d, { recursive: true });
  // the real agent folders the sessions must never touch, each with a sign-in and something that is not the sign-in
  for (const [d, cred, other2] of [[".claude", ".credentials.json", "projects/other-space.jsonl"], [".codex", "auth.json", "history.jsonl"]]) {
    fs.mkdirSync(path.join(home, d, path.dirname(other2)), { recursive: true });
    fs.writeFileSync(path.join(home, d, cred), cred === "auth.json" ? '{"OPENAI_API_KEY":"sk-test-aaaaaaaaaaaaaaaaaaaaaaaa"}' : '{"claudeAiOauth":{"accessToken":"SIGN-IN"}}');
    fs.writeFileSync(path.join(home, d, other2), "ANOTHER CONVERSATION");
  }
  const probes = { personSocket: person, otherSocket: other, daemonPorts: [servers[3].address().port], keyFile: path.join(home, ".vyre", "keys", "device.key"), homeFile: path.join(home, "Documents", "private.txt"), daemonPid: daemon.pid };
  const cfg = { sandbox, platform: process.platform, home, vyreHome: path.join(home, ".vyre"), probes, temp };
  return { home, own, proj, temp, probes, cfg };
}

const noHosts = () => { const was = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.hosts])); for (const v of Object.values(AGENTS)) v.hosts = []; return () => { for (const [k, v] of Object.entries(AGENTS)) v.hosts = was[k]; }; };

// THE REAL CLAUDE CODE, in the real home sandbox, handed its credential on the pipe: does it find it and use it? `claude auth status` reports, with no network at all, whether the CLI found a credential and which kind it
// is (the same discovery that sends the credential on a request; the request itself is proven against a fake Messages API in core/sessions/credential-scan.test.js). Without the pipe it says loggedIn false.
const KEY = "sk-ant-api03-fakeFAKEfake00000000000000000000000000000000000000000000-AAAAAAAA", TOKEN = "sk-ant-oat01-fakeFAKEfake00000000000000000000000000000000000000000000-AAAAAAAA";
const CASES = /** @type {const} */ ([["an API key", KEY, "ANTHROPIC_API_KEY", "api_key"], ["a setup token", TOKEN, "CLAUDE_CODE_OAUTH_TOKEN", "oauth_token"], ["nothing", "", "", "none"]]);
for (const withShim of [false, true]) for (const [name, secret, plain, method] of CASES) {
  test(`real claude in the real sandbox${withShim ? " behind the egress shim (--pass-fd)" : ""}: ${name} on the pipe ${secret ? "is found and used" : "leaves it logged out"}`, { skip: SKIP || !CLAUDE, timeout: 120_000 }, async t => {
    const r = await rig(t); t.after(noHosts());
    // a stand-in egress socket: the shim only listens and forwards; `auth status` makes no request
    const egress = path.join(r.home, "egress.sock"); const eg = await listen(egress); t.after(() => eg.close());
    const cfg = { ...r.cfg, ...(secret ? { credentials: async () => ({ [plain]: secret }) } : { credentials: async () => ({}) }), sandbox: { ...r.cfg.sandbox, ...(withShim ? { homeProxy: async () => ({ proxy: { socket: egress, token: "t" }, stop: async () => {} }) } : {}) } };
    const s = await prepareSandbox(cfg, { provider: "claude", command: CLAUDE, args: ["auth", "status"], sessionSocket: r.own, workdirs: [r.proj], readOnly: [path.dirname(CLAUDE)] });
    assert.equal(s.sandboxed, true);
    const out = await run(s.spawn(CLAUDE, ["auth", "status"], { ...process.env }, r.proj));
    const j = JSON.parse(out.out.slice(out.out.indexOf("{")).trim());
    assert.equal(j.authMethod, method, out.out.slice(0, 300) + out.err.slice(0, 200));
    assert.equal(j.loggedIn, Boolean(secret));
  });
}
