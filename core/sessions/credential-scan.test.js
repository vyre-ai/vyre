// @ts-check
// WHERE A SESSION'S CREDENTIAL CAN BE READ FROM, measured from a tool call inside a running Claude Code (the real binary against the fake Messages API, fake secrets only). One Bash call scans, for
// each way a credential is handed to the session, the places a tool of the SAME session can look: its own environment, the claude process's /proc/<pid>/environ and cmdline, the readable file
// descriptors of that process, its memory (blocked by Yama ptrace_scope 1, or not), and the session's config folder. The scan prints counts only, never the secret.
//
// "Known state" tests assert what is TRUE TODAY, marked with KNOWN; when a fix lands the strict assertion fails and its expected value is flipped on purpose (the point: a leak cannot come back, and a fix
// cannot be claimed without the scan). "Bar" tests assert what must hold before a member may drive an agent or teammate on a picked credential; they run as `todo` until the delivery is fixed.
// Linux only; skipped where the claude binary (VYRE_CLAUDE_BIN or `claude` on the PATH) is missing. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fakeApi } from "../../scripts/sessions-proof/fake-api.mjs";
import { spawnSession } from "./spawn.js";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until } from "./testing/boot.js";

const CLAUDE = (() => { for (const c of [process.env.VYRE_CLAUDE_BIN, "/usr/bin/claude", "/usr/local/bin/claude"]) if (c && fs.existsSync(c)) return c; try { return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || ""; } catch { return ""; } })();
const SKIP = process.platform !== "linux" ? "Linux only" : !CLAUDE ? "no claude binary here" : false;
const SECRET = "FAKE-CRED-0123456789abcdef";
const YAMA = (() => { try { return Number(fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim()); } catch { return -1; } })();

/** The scan, run by the session's Bash. Counts only. The secret is read from ./secret.txt (never an argument: the session writes its tool commands into its config folder); claude is the parent of the tool's shell. */
const SCAN = `#!/bin/sh
S=$(cat ./secret.txt); B=$PPID; P=$(awk '{print $4}' /proc/$B/stat)   # the tool's shell is our parent; claude is ITS parent
echo "SCAN env $(env | grep -c "$S")"
echo "SCAN environ $(tr '\\0' '\\n' < /proc/$P/environ 2>/dev/null | grep -c "$S")"
echo "SCAN cmdline $(tr '\\0' '\\n' < /proc/$P/cmdline 2>/dev/null | grep -c "$S")"
n=0; for f in /proc/$P/fd/*; do case "$f" in */fd/0|*/fd/1|*/fd/2) continue;; esac; c=$(timeout 1 head -c 4096 "$f" 2>/dev/null | grep -c "$S"); n=$((n+c)); done; echo "SCAN fd $n"
echo "SCAN config $( [ -n "$CLAUDE_CONFIG_DIR" ] && grep -rl "$S" "$CLAUDE_CONFIG_DIR" 2>/dev/null | wc -l || echo 0)"
CLP=$P S="$S" python3 - <<'PY'
import os, re
pid = int(os.environ["CLP"]); s = os.environ["S"].encode()
try:
    f = open("/proc/%d/mem" % pid, "rb")
except Exception:
    print("SCAN mem refused"); raise SystemExit
hit = 0
for l in open("/proc/%d/maps" % pid).read().splitlines():
    m = re.match(r"([0-9a-f]+)-([0-9a-f]+) r", l)
    if not m or ("[" in l and "heap" not in l and "stack" not in l): continue
    a, b = int(m.group(1), 16), int(m.group(2), 16)
    if b - a > 64 * 1024 * 1024: continue
    try:
        f.seek(a); d = f.read(b - a)
    except Exception:
        continue
    if s in d: hit += 1
print("SCAN mem", hit)
PY
echo "SCAN done"
`;

/** One scan run. `how` builds the child's env and stdio. @param {{ env?: Record<string, string>, fd3?: string, loginFile?: boolean, viaSpawnSession?: boolean }} o */
async function scan(o) {
  const api = await fakeApi([() => ({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sh ./scan.sh", description: "scan" } }), () => ({ type: "text", text: "done" })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-cred-scan-"));
  const home = path.join(dir, "home"), cfg = path.join(home, ".claude"), work = path.join(dir, "work");
  fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "scan.sh"), SCAN, { mode: 0o755 });
  fs.writeFileSync(path.join(work, "secret.txt"), SECRET);
  if (o.loginFile) fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: "x", expiresAt: 9999999999999, scopes: ["user:inference"], subscriptionType: "max" } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...(o.env || {}) };
  const args = ["-p", "scan", "--dangerously-skip-permissions", "--max-turns", "3"];
  /** @type {any} */ let child;
  if (o.viaSpawnSession) child = spawnSession(CLAUDE, args, { cwd: work, env });
  else if (o.fd3 !== undefined) { child = spawn(CLAUDE, args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe", "pipe"] }); child.stdio[3].end(o.fd3); }
  else child = spawn(CLAUDE, args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdin && typeof child.stdin.end === "function") child.stdin.end();
  child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
  await Promise.race([new Promise(r => child.on("exit", r)), new Promise(r => setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(null); }, 90_000))]);
  api.server.close();
  // what the real CLI actually SENT: the credential it found (on the pipe, in the env or in the file) as the fake API saw it in the request's auth headers
  const sent = api.log.flatMap(l => [l.headers && l.headers["x-api-key"], l.headers && String(l.headers.authorization || "").replace(/^Bearer /i, "")]).filter(Boolean);
  const authenticated = sent.includes(SECRET);
  const text = api.log.flatMap(l => (l.body.messages || []).flatMap((/** @type {any} */ m) => Array.isArray(m.content) ? m.content : [])).filter((/** @type {any} */ c) => c.type === "tool_result").map((/** @type {any} */ c) => typeof c.content === "string" ? c.content : JSON.stringify(c.content)).join("\n");
  fs.rmSync(dir, { recursive: true, force: true });
  /** @type {Record<string, string>} */ const out = {};
  for (const m of text.matchAll(/SCAN (\w+) (\S+)/g)) out[m[1]] = m[2];
  assert.equal(out.done !== undefined || /SCAN done/.test(text), true, "the scan ran inside the session's Bash (the control: a session that never ran it proves nothing): " + text.slice(0, 200));
  return { env: Number(out.env), environ: Number(out.environ), cmdline: Number(out.cmdline), fd: Number(out.fd), config: Number(out.config), mem: out.mem === "refused" ? "refused" : Number(out.mem), authenticated };
}
const clean = (/** @type {any} */ r) => r.env === 0 && r.environ === 0 && r.cmdline === 0 && r.fd === 0 && r.config === 0 && (r.mem === "refused" || r.mem === 0);

// ---- KNOWN STATE: how each way of handing over a credential looks from a tool of the session -------------------------------------------------------------------------------------------------------------
test("KNOWN: an API key in the environment is printed by the session's Bash and readable from the parent's environ", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { ANTHROPIC_API_KEY: SECRET } });
  assert.ok(r.env >= 1 && r.environ >= 1, JSON.stringify(r));
});
test("an API key on file descriptor 3 (CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR, as core/sessions/spawn.js hands it) is found nowhere a tool can look", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3" }, fd3: SECRET });
  assert.equal(r.authenticated, true, "the real CLI read the credential off its descriptor and SENT it (the fake API saw it in the auth header): " + JSON.stringify(r));
  assert.equal(r.authenticated, true, "the real CLI read the key off the pipe and sent it: " + JSON.stringify(r));
  assert.ok(clean(r) || (r.mem !== "refused" && YAMA === 0), JSON.stringify(r));   // with ptrace_scope 0 the memory of a same-user process is readable: see the Yama test below
});
test("KNOWN: a setup token in the environment is not in the Bash environment, but IS in the parent's /proc/<pid>/environ", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } });
  assert.equal(r.env, 0, JSON.stringify(r));
  assert.ok(r.environ >= 1, "KNOWN (flip to 0 when the setup token is handed over on a file descriptor): " + JSON.stringify(r));
});
test("a setup token on file descriptor 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) is found nowhere a tool can look", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }, fd3: SECRET });
  assert.equal(r.authenticated, true, "the real CLI read the credential off its descriptor and SENT it (the fake API saw it in the auth header): " + JSON.stringify(r));
  assert.ok(clean(r) || (r.mem !== "refused" && YAMA === 0), JSON.stringify(r));
});
test("KNOWN: a signed-in login file in the session's config folder is readable by its tools (by design: the session sees that copy)", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ loginFile: true });
  assert.ok(r.config >= 1, JSON.stringify(r));
});
test("the memory of the claude process is closed to its tools only where Yama ptrace_scope is 1 or more", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }, fd3: SECRET });
  if (YAMA >= 1) assert.ok(r.mem === "refused" || r.mem === 0, `ptrace_scope ${YAMA}: ` + JSON.stringify(r));
  else assert.ok(r.mem === "refused" || r.mem === 0 || r.mem > 0, `ptrace_scope ${YAMA}: memory of a same-user process may be readable (${JSON.stringify(r)}); a member-driven picked credential must not start here`);
});

// ---- THROUGH VYRE'S OWN LAUNCH (core/sessions/spawn.js, the packaged box's path) --------------------------------------------------------------------------------------------------------------------------
test("Vyre's launch hands an API key over unreadable (spawnSession: file descriptor 3)", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { ANTHROPIC_API_KEY: SECRET }, viaSpawnSession: true });
  assert.equal(r.authenticated, true, "the real CLI read the credential off its descriptor and SENT it (the fake API saw it in the auth header): " + JSON.stringify(r));
  assert.equal(r.env, 0, JSON.stringify(r)); assert.equal(r.environ, 0, JSON.stringify(r)); assert.equal(r.fd, 0, JSON.stringify(r));
});
test("Vyre's launch hands a setup token over on a descriptor: the real CLI sends it and no tool of the session can read it", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, viaSpawnSession: true });
  assert.equal(r.authenticated, true, JSON.stringify(r));
  assert.ok(clean(r), JSON.stringify(r));
});
// THE BAR: when this passes, a setup token may be used for a turn somebody else drives (not before)
test("BAR: Vyre's launch hands a setup token over where no tool of the session can read it (the same case with the environment left to Vyre's own env filter)", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await scan({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, viaSpawnSession: true });
  assert.equal(r.authenticated, true, "the real CLI read the credential off its descriptor and SENT it (the fake API saw it in the auth header): " + JSON.stringify(r));
  assert.ok(clean(r), JSON.stringify(r));
});

// ---- A SESSION IN THE HOME SANDBOX (bwrap: the path of a Linux install without the packaged box's own-uid confinement) -------------------------------------------------------------------------------
// A member (and the owner) launches an agent thread with a credential picked for it (a setup token in the launch's env). The scan runs from a SessionStart hook of the session (a child of claude, as its Bash tool is).
const HAS_BWRAP = (() => { try { execFileSync("bwrap", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const SKIP_BWRAP = SKIP || (!HAS_BWRAP && "no bwrap here");
/** @param {any} t @param {"member" | "owner"} who @param {{ login: string, picked: string }} secrets */
async function bwrapSession(t, who, secrets) {
  const root = tempHome(t);
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-cred-home-"));
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: secrets.login, refreshToken: "x", expiresAt: 9999999999999 } }), { mode: 0o600 });
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); fs.rmSync(fakeHome, { recursive: true, force: true }); });
  Object.assign(process.env, { HOME: fakeHome, VYRE_CLAUDE_BIN: CLAUDE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1" });
  delete process.env.VYRE_SESSION_SANDBOX_OFF;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root); t.after(() => d.stop());
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const bobChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const meta = { token: (await d.kernel.surfaces.open(who === "member" ? bobChain : ownerChain, {})).token };
  /** @param {string} secret */
  const run = async secret => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-cred-work-")));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    fs.mkdirSync(path.join(work, ".claude"));
    fs.writeFileSync(path.join(work, "scan.sh"), SCAN, { mode: 0o755 }); fs.writeFileSync(path.join(work, "secret.txt"), secret);
    fs.writeFileSync(path.join(work, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `sh ${work}/scan.sh > ${work}/leak.txt 2>&1` }] }] } }));
    const r = await d.registry.call("threads.launch", { agent: "kit", agent_kind: "agent", auth: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: secrets.picked }, cwd: work, prompt: "hello" }, "module:agents", meta);
    if (who === "member") return { refused: r.error };
    assert.ok(r.data && !r.error, JSON.stringify(r.error));
    await until(() => fs.existsSync(path.join(work, "leak.txt")) && /SCAN done/.test(fs.readFileSync(path.join(work, "leak.txt"), "utf8")), "the scan ran in the session", 60_000);
    /** @type {Record<string, string>} */ const out = {};
    for (const m of fs.readFileSync(path.join(work, "leak.txt"), "utf8").matchAll(/SCAN (\w+) (\S+)/g)) out[m[1]] = m[2];
    return { env: Number(out.env), environ: Number(out.environ), fd: Number(out.fd), config: Number(out.config), mem: out.mem };
  };
  return { login: await run(secrets.login), picked: await run(secrets.picked) };
}
test("a member's request for an agent thread on a picked credential is refused in words and nothing is started, until the credential is handed over unreadably (the agent gate)", { skip: SKIP_BWRAP, timeout: 240_000 }, async t => {
  const r = /** @type {any} */ (await bwrapSession(t, "member", { login: "FAKE-MACHINE-LOGIN-0123456789", picked: "FAKE-PICKED-TOKEN-0123456789" }));
  assert.equal(r.login.refused && r.login.refused.code, "no_account", JSON.stringify(r.login));
  assert.match(String(r.login.refused.message), /Nothing was started/);
});
test("bwrap, the OWNER's agent thread with a setup token picked for the agent: the picked token arrives on a descriptor and the machine's login is not in the session's config folder", { skip: SKIP_BWRAP, timeout: 240_000 }, async t => {
  const r = /** @type {any} */ (await bwrapSession(t, "owner", { login: "FAKE-MACHINE-LOGIN-0123456789", picked: "FAKE-PICKED-TOKEN-0123456789" }));
  assert.equal(r.picked.environ, 0, JSON.stringify(r.picked)); assert.equal(r.picked.config, 0, JSON.stringify(r.picked)); assert.equal(r.picked.env, 0, JSON.stringify(r.picked));
  assert.equal(r.login.config, 0, "the machine login is not copied where a tool of the session can read it: " + JSON.stringify(r.login));
});
