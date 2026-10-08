// @ts-check
// install-mac-server.sh (anywhere, the Mac mini case): the setup code and its time land in vyre.env at
// 0600 and in no argument, the release is checked against SHA256SUMS, the LaunchAgent runs vyred under
// caffeinate with the env file's lines exported, and uninstall leaves the person's data. The default
// (system service) mode runs the root installer under one fake sudo. All against a
// fake launchctl, caffeinate, brew and colima in a temp home: no real service, no Homebrew, no root.
import "../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reap, processesWith } from "./reap.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "install-mac-server.sh");
const CODE = "A".repeat(20) + "b-_" + "Z".repeat(20);

/** Every temp folder this run made: the final check looks only for processes naming one of these, never another run's. */
const BASES = /** @type {string[]} */ ([]);

/** A temp home with stub launchctl (runs the wrapper for real, like launchd), caffeinate, brew and colima, and a tiny fake vyred to install. */
function mac(/** @type {import("node:test").TestContext} */ t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-mac-"));
  const pids = path.join(base, "pids");
  BASES.push(base);
  t.after(() => {
    try { for (const p of fs.readFileSync(pids, "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(p)); } catch {} } } catch {}
    // Whatever else the fake launchctl, the fake root installer or the script started: anything whose
    // command line names this test's own folder, by group and by pid, on success, failure and timeout.
    reap(base);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const bin = path.join(base, "bin"), log = path.join(base, "calls.log"), home = path.join(base, "home");
  fs.mkdirSync(bin); fs.mkdirSync(home);
  const stubs = {
    launchctl: `echo "launchctl $*" >>"${log}"
if [ "$1" = bootstrap ]; then
  P=$(sed -n 's|.*<string>\\(.*vyre-serve\\)</string>.*|\\1|p' "$3")
  if [ -n "$P" ]; then "$P" >>"${base}/serve.out" 2>&1 & echo $! >>"${pids}"; fi
fi
exit 0`,
    caffeinate: `echo "caffeinate $*" >>"${log}"\nshift\nexec "$@"`,
    brew: `echo "brew $*" >>"${log}"; exit 0`,
    colima: `echo "colima $*" >>"${log}"; exit 0`,
  };
  for (const [n, b] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  // A fake checkout: only what the installer looks for, and a vyred that writes its pid and the env it saw.
  const src = path.join(base, "src");
  fs.mkdirSync(path.join(src, "core", "daemon"), { recursive: true });
  fs.writeFileSync(path.join(src, "core", "daemon", "main.js"),
    `import fs from "node:fs"; import path from "node:path";
     const h = process.env.VYRE_HOME; fs.mkdirSync(h, { recursive: true });
     fs.writeFileSync(path.join(h, "vyred.pid"), String(process.pid));
     fs.writeFileSync(path.join(h, "saw.json"), JSON.stringify({ code: process.env.VYRE_SETUP_CODE ?? null, at: process.env.VYRE_SETUP_CODE_AT ?? null, docker: process.env.DOCKER_HOST ?? null }));
     // A fake vyred that never outlives its test: it ends when its VYRE_HOME is removed (the test's own cleanup).\n     setInterval(() => { if (!fs.existsSync(h)) process.exit(0); }, 500);\n`);
  // The vyre command a person (and the installer's check words) would call: answers relay.setup.status with four words, anything else with an error.
  fs.mkdirSync(path.join(src, "bin"), { recursive: true });
  fs.writeFileSync(path.join(src, "bin", "vyre"), `if (process.argv[3] === "relay.setup.status") console.log(JSON.stringify({ words: "come pilot company release" })); else { console.error("no"); process.exit(1); }\n`);
  const env = {
    VYRE_WORDS_TRIES: "1",
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, VYRE_UNAME_S: "Darwin", VYRE_GH_SHA256: "", VYRE_HEADSCALE_SHA256: "",
    VYRE_LAUNCHCTL: path.join(bin, "launchctl"), VYRE_CAFFEINATE: path.join(bin, "caffeinate"),
    VYRE_HOME: path.join(home, ".vyre"), VYRE_SERVER_DIR: path.join(home, ".vyre-server"), VYRE_LAUNCHAGENTS: path.join(home, "LaunchAgents"),
  };
  return { base, home, src, env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

// The tests below the login-only ones pass "--system" to take the default (system service) path;
// everything else runs the login-only mode these tests were written for.
const run = (/** @type {Record<string,string>} */ env, /** @type {string[]} */ args) => {
  const system = args.includes("--system");
  const a = system ? args.filter(x => x !== "--system") : ["--login-only", ...args];
  // VYRE_TEST_SCRIPT: a copy of the script with a throwaway release key patched in (the real one has no override).
  return spawnSync("sh", [env.VYRE_TEST_SCRIPT || SCRIPT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 60_000 });
};

test("install-mac-server.sh: --code is refused, because a process list shows arguments", t => {
  const m = mac(t);
  const r = run(m.env, ["--code", CODE, "--from", m.src]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /never a command-line argument/);
  assert.ok(!(r.stdout + r.stderr).includes(CODE));
});

test("install-mac-server.sh: not on Linux, and not with a malformed code", t => {
  const m = mac(t);
  assert.match(run({ ...m.env, VYRE_UNAME_S: "Linux" }, ["--from", m.src]).stderr, /for a Mac/);
  const bad = "not-a-code-xxxxx";
  const r = run({ ...m.env, VYRE_CODE: bad }, ["--yes", "--from", m.src]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /setup code does not look right/);
  assert.ok(!(r.stdout + r.stderr).includes(bad));
});

test("install-mac-server.sh: --dry-run changes nothing", t => {
  const m = mac(t);
  const r = run({ ...m.env, VYRE_CODE: CODE }, ["--dry-run", "--from", m.src]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(m.home), [], "nothing written to the home");
  assert.ok(!(r.stdout + r.stderr).includes(CODE));
  assert.ok(!/launchctl/.test(m.calls()));
});

test("install-mac-server.sh: installs, writes the code and its time at 0600, runs vyred under caffeinate", t => {
  const m = mac(t);
  fs.mkdirSync(m.env.VYRE_HOME, { recursive: true });
  fs.writeFileSync(path.join(m.env.VYRE_HOME, "vyre.env"), "KEEP=mine\nVYRE_SETUP_CODE=stale\n", { mode: 0o600 });
  const r = run({ ...m.env, VYRE_CODE: CODE }, ["--yes", "--from", m.src]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const f = path.join(m.env.VYRE_HOME, "vyre.env");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /^KEEP=mine$/m);
  assert.equal(text.match(/^VYRE_SETUP_CODE=/gm)?.length, 1, "the stale line is replaced");
  assert.ok(text.includes(`VYRE_SETUP_CODE=${CODE}`));
  assert.ok(!/^VYRE_CODE=/m.test(text), "VYRE_CODE is only the host-side pipe");
  const at = Number(text.match(/^VYRE_SETUP_CODE_AT=(\d+)$/m)?.[1]);
  assert.ok(Math.abs(at - Date.now() / 1000) < 120, "the time, epoch seconds, as a real variable");
  assert.match(text, /^DOCKER_HOST=unix:\/\/.*\/\.colima\/default\/docker\.sock$/m, "Colima's own socket, never Docker Desktop's");
  assert.ok(!(r.stdout + r.stderr).includes(CODE), "never shown");
  assert.ok(!m.calls().includes(CODE), "in no launchctl, brew or colima argument");
  // The wrapper exported the file's lines to vyred, and ran it under caffeinate.
  const saw = JSON.parse(fs.readFileSync(path.join(m.env.VYRE_HOME, "saw.json"), "utf8"));
  assert.equal(saw.code, CODE);
  assert.equal(saw.at, String(at));
  assert.match(m.calls(), /caffeinate -ims /);
  assert.match(m.calls(), /launchctl bootstrap gui\/\d+ .*run\.vyre\.server\.plist/);
  const plist = fs.readFileSync(path.join(m.env.VYRE_LAUNCHAGENTS, "run.vyre.server.plist"), "utf8");
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(!plist.includes(CODE), "the plist never carries the code");
  assert.match(m.calls(), /colima start/);
});

test("install-mac-server.sh: the Records choice from the install line lands in vyre.env: auto by default, sqlite when asked, a later choice replaces an older one, anything else refuses", t => {
  const m = mac(t);
  const f = path.join(m.env.VYRE_HOME, "vyre.env");
  assert.equal(run({ ...m.env }, ["--yes", "--from", m.src]).status, 0);
  assert.match(fs.readFileSync(f, "utf8"), /^VYRE_STORE=auto$/m);
  assert.equal(run({ ...m.env, VYRE_STORE: "sqlite" }, ["--yes", "--from", m.src]).status, 0);
  assert.equal(fs.readFileSync(f, "utf8").match(/^VYRE_STORE=/gm)?.length, 1);
  assert.match(fs.readFileSync(f, "utf8"), /^VYRE_STORE=sqlite$/m);
  assert.equal(run({ ...m.env }, ["--yes", "--from", m.src]).status, 0);
  assert.match(fs.readFileSync(f, "utf8"), /^VYRE_STORE=sqlite$/m, "no choice named keeps the one made");
  const bad = run({ ...m.env, VYRE_STORE: "twenty" }, ["--yes", "--from", m.src]);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /VYRE_STORE is auto/);
});

test("install-mac-server.sh: the wrapper drops a setup code older than an hour, and keeps the rest", t => {
  const m = mac(t);
  fs.mkdirSync(m.env.VYRE_HOME, { recursive: true });
  const r = run(m.env, ["--yes", "--from", m.src]);
  assert.equal(r.status, 0, r.stderr);
  const f = path.join(m.env.VYRE_HOME, "vyre.env");
  fs.appendFileSync(f, `KEEP=mine\nVYRE_SETUP_CODE_AT=${Math.floor(Date.now() / 1000) - 4000}\nVYRE_SETUP_CODE=${CODE}\n`);
  fs.rmSync(path.join(m.env.VYRE_HOME, "saw.json"));
  const wrapper = path.join(m.env.VYRE_SERVER_DIR, "bin", "vyre-serve");
  const c = spawnSync("sh", [wrapper], { env: m.env, timeout: 500, encoding: "utf8" });
  void c; // the fake vyred never exits: the timeout stops it, and it has written what it saw by then
  const saw = JSON.parse(fs.readFileSync(path.join(m.env.VYRE_HOME, "saw.json"), "utf8"));
  assert.equal(saw.code, null, "an old code is not armed");
  const text = fs.readFileSync(f, "utf8");
  assert.ok(!/VYRE_SETUP_CODE/.test(text), "both lines are gone");
  assert.match(text, /^KEEP=mine$/m);
});

test("install-mac-server.sh: a download that does not match SHA256SUMS installs nothing", t => {
  const m = mac(t);
  const site = path.join(m.base, "site");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "vyre.tgz"), "not what the sums say");
  fs.writeFileSync(path.join(site, "SHA256SUMS"), `${crypto.createHash("sha256").update("something else").digest("hex")}  vyre.tgz\n`);
  const r = run({ ...m.env, VYRE_BOX_URL: `file://${site}/` }, ["--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match SHA256SUMS/);
  assert.ok(!fs.existsSync(path.join(m.env.VYRE_SERVER_DIR, "app")));
  assert.ok(!/launchctl bootstrap/.test(m.calls()));
});

test("install-mac-server.sh: a release tarball that matches installs and runs", t => {
  const m = mac(t);
  const site = path.join(m.base, "site");
  fs.mkdirSync(site);
  const pkg = path.join(m.base, "pkg", "vyre");
  fs.mkdirSync(path.dirname(pkg));
  fs.cpSync(m.src, pkg, { recursive: true });
  execFileSync("tar", ["-czf", path.join(site, "vyre.tgz"), "-C", path.dirname(pkg), "vyre"]);
  const sum = crypto.createHash("sha256").update(fs.readFileSync(path.join(site, "vyre.tgz"))).digest("hex");
  fs.writeFileSync(path.join(site, "SHA256SUMS"), `${sum}  vyre.tgz\n`);
  const r = run({ ...m.env, VYRE_BOX_URL: `file://${site}/` }, ["--yes"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(m.env.VYRE_SERVER_DIR, "app", "core", "daemon", "main.js")));
});

test("install-mac-server.sh: uninstall stops the service and removes the app, and keeps the person's data", t => {
  const m = mac(t);
  assert.equal(run(m.env, ["--yes", "--from", m.src]).status, 0);
  const r = run(m.env, ["--uninstall", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(m.env.VYRE_LAUNCHAGENTS, "run.vyre.server.plist")));
  assert.ok(!fs.existsSync(m.env.VYRE_SERVER_DIR));
  assert.ok(fs.existsSync(path.join(m.env.VYRE_HOME, "vyre.env")), "data stays");
  assert.match(m.calls(), /launchctl bootout/);
  assert.equal(run(m.env, ["--uninstall", "--purge", "--yes"]).status, 0);
  assert.ok(!fs.existsSync(m.env.VYRE_HOME), "--purge --yes deletes it");
});

const sha = (/** @type {Buffer|string} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/** A Mac with no Homebrew and no colima: PATH holds only launchctl, caffeinate, node, and system dirs. Fake release files are served from file:// URLs. */
function noBrew(/** @type {import("node:test").TestContext} */ t, /** @type {{ docker?: boolean }} */ opts = {}) {
  const m = mac(t);
  const bin = path.join(m.base, "bin"), tools = path.join(m.base, "tools"), rel = path.join(m.base, "rel");
  fs.mkdirSync(tools); fs.mkdirSync(rel);
  for (const n of ["launchctl", "caffeinate"]) fs.copyFileSync(path.join(bin, n), path.join(tools, n));
  if (opts.docker) fs.writeFileSync(path.join(tools, "docker"), "#!/bin/sh\necho docker-desktop\n", { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(tools, "node"));
  const colima = "#!/bin/sh\necho fake-colima\n";
  fs.writeFileSync(path.join(rel, "colima"), colima);
  const pk = (/** @type {string} */ name, /** @type {string} */ file, /** @type {string} */ body) => {
    const d = path.join(m.base, "pk-" + name); fs.mkdirSync(path.join(d, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(d, file), body, { mode: 0o755 });
    execFileSync("tar", ["-czf", path.join(rel, name + ".tgz"), "-C", d, file.split("/")[0]]);
    return sha(fs.readFileSync(path.join(rel, name + ".tgz")));
  };
  const limaSum = pk("lima", "bin/limactl", "#!/bin/sh\n");
  const dockerSum = pk("docker", "docker/docker", "#!/bin/sh\necho docker-static\n");
  const env = {
    ...m.env, PATH: `${tools}:/usr/bin:/bin`, VYRE_UNAME_M: "arm64",
    VYRE_COLIMA_URL: `file://${rel}/colima`, VYRE_COLIMA_SHA256: sha(colima),
    VYRE_LIMA_URL: `file://${rel}/lima.tgz`, VYRE_LIMA_SHA256: limaSum,
    VYRE_DOCKER_URL: `file://${rel}/docker.tgz`, VYRE_DOCKER_SHA256: dockerSum,
  };
  const installed = (/** @type {string} */ f) => fs.existsSync(path.join(m.env.VYRE_SERVER_DIR, f));
  return { ...m, env, rel, installed, colimaPlist: path.join(m.env.VYRE_LAUNCHAGENTS, "run.vyre.colima.plist") };
}

test("install-mac-server.sh: without Homebrew, pinned Colima and Lima that match are installed with their own LaunchAgent", t => {
  const m = noBrew(t);
  const r = run(m.env, ["--yes", "--from", m.src]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // A docker already on PATH (a Linux CI image) is used, not replaced.
  const hasDocker = spawnSync("sh", ["-c", "command -v docker"], { env: { PATH: "/usr/bin:/bin" } }).status === 0;
  assert.ok(m.installed("bin/colima") && m.installed("lima/bin/limactl") && (hasDocker || m.installed("bin/docker")));
  assert.equal(fs.statSync(path.join(m.env.VYRE_SERVER_DIR, "bin", "colima")).mode & 0o111, 0o111);
  const plist = fs.readFileSync(m.colimaPlist, "utf8");
  assert.ok(plist.includes(`<string>${m.env.VYRE_SERVER_DIR}/bin/vyre-runtime</string><string>run</string>`));
  assert.match(plist, /<key>PATH<\/key><string>[^<]*\.vyre-server\/bin:/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(m.calls(), /launchctl bootstrap gui\/\d+ .*run\.vyre\.colima\.plist/);
  assert.match(m.calls(), /launchctl bootstrap gui\/\d+ .*run\.vyre\.server\.plist/);
});

test("install-mac-server.sh: a Colima download that does not match its pinned sum installs nothing", t => {
  const m = noBrew(t);
  const r = run({ ...m.env, VYRE_COLIMA_SHA256: sha("something else") }, ["--yes", "--from", m.src]);
  assert.equal(r.status, 0, "the server itself still installs");
  assert.match(r.stdout, /does not match its pinned checksum; nothing was installed/);
  assert.ok(!m.installed("bin/colima") && !m.installed("lima") && !m.installed("bin/docker"));
  assert.ok(!fs.existsSync(m.colimaPlist));
  assert.ok(!/run\.vyre\.colima/.test(m.calls()));
});

test("install-mac-server.sh: a Lima download that does not match refuses too, and Colima is not left behind", t => {
  const m = noBrew(t);
  const r = run({ ...m.env, VYRE_LIMA_SHA256: sha("nope") }, ["--yes", "--from", m.src]);
  assert.match(r.stdout, /Lima download does not match/);
  assert.ok(!m.installed("bin/colima") && !fs.existsSync(m.colimaPlist));
});

test("install-mac-server.sh: an empty pinned sum refuses with 'no pinned Colima for this release'", t => {
  const m = noBrew(t);
  const r = run({ ...m.env, VYRE_COLIMA_SHA256: "" }, ["--yes", "--from", m.src]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no pinned Colima for this release/);
  assert.ok(!m.installed("bin/colima") && !fs.existsSync(m.colimaPlist));
});

test("install-mac-server.sh: the fallback is taken only when brew is absent and colima is missing", t => {
  // brew present: brew installs, no download, no colima LaunchAgent.
  const a = mac(t);
  const ra = run({ ...a.env, VYRE_COLIMA_URL: "file:///nonexistent" }, ["--yes", "--from", a.src]);
  assert.equal(ra.status, 0, ra.stderr);
  assert.ok(!fs.existsSync(path.join(a.env.VYRE_LAUNCHAGENTS, "run.vyre.colima.plist")));
  assert.ok(!fs.existsSync(path.join(a.env.VYRE_SERVER_DIR, "bin", "colima")));
  // colima already on PATH and no brew: left alone.
  const b = noBrew(t);
  fs.copyFileSync(path.join(a.base, "bin", "colima"), path.join(b.base, "tools", "colima"));
  fs.chmodSync(path.join(b.base, "tools", "colima"), 0o755);
  const rb = run(b.env, ["--yes", "--from", b.src]);
  assert.equal(rb.status, 0, rb.stderr);
  assert.ok(!b.installed("bin/colima") && !fs.existsSync(b.colimaPlist));
});

test("install-mac-server.sh: a Docker Desktop already there is untouched and no docker client is downloaded", t => {
  const m = noBrew(t, { docker: true });
  const app = path.join(m.base, "Docker.app"); fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "Info.plist"), "docker desktop");
  const before = fs.readFileSync(path.join(m.base, "tools", "docker"), "utf8");
  const r = run({ ...m.env, VYRE_DOCKER_URL: "file:///nonexistent", VYRE_DOCKER_SHA256: "" }, ["--yes", "--from", m.src]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(m.installed("bin/colima"), "Colima still installs");
  assert.ok(!m.installed("bin/docker"), "the existing docker is used, not replaced");
  assert.equal(fs.readFileSync(path.join(m.base, "tools", "docker"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(app, "Info.plist"), "utf8"), "docker desktop");
});

// ---------------------------------------------------------------------------------------------
// The default mode: the system service (ADR 0040 phase 4). The root installer is a fake that acts
// like the real one where the script can see it: it prints the enrolment line last, writes core.json
// and core's socket file, and starts the wrapper it was given as launchd would.

const ENROL = "K7QX2M";

/** A Mac where the script installs the system service: a fake sudo that records its argv, a fake root installer, a Node tarball to bundle, and a signed-looking release on file://. */
function sys(/** @type {import("node:test").TestContext} */ t, /** @type {{ fail?: boolean, noEnrol?: boolean }} */ o = {}) {
  const m = mac(t);
  const bin = path.join(m.base, "bin"), site = path.join(m.base, "site"), core = path.join(m.base, "core-base");
  fs.mkdirSync(site); fs.mkdirSync(core);
  // The Node the script bundles: a tarball whose bin/node runs the real one.
  const nd = path.join(m.base, "nodepkg", "node-v0"); fs.mkdirSync(path.join(nd, "bin"), { recursive: true });
  fs.writeFileSync(path.join(nd, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  execFileSync("tar", ["-czf", path.join(m.base, "node.tgz"), "-C", path.dirname(nd), "node-v0"]);
  // sudo: records that it ran and with what, then runs the command as this user (the test is not root).
  // FAKE_TAMPER=1: the person's release file changes between the check and root's copy (argv 6 is the release dir).
  fs.writeFileSync(path.join(bin, "sudo"), `#!/bin/sh\necho "sudo $*" >>"${path.join(m.base, "calls.log")}"\n[ -z "\${FAKE_TAMPER:-}" ] || echo tamper >>"$6/vyre.tgz"\nexec "$@"\n`, { mode: 0o755 });
  // The fake root installer.
  const pkg = path.join(m.base, "pkg", "vyre"); fs.mkdirSync(path.join(pkg, "core", "daemon"), { recursive: true }); fs.mkdirSync(path.join(pkg, "core", "vyre-core"), { recursive: true });
  fs.copyFileSync(path.join(m.src, "core", "daemon", "main.js"), path.join(pkg, "core", "daemon", "main.js"));
  fs.mkdirSync(path.join(pkg, "bin")); fs.copyFileSync(path.join(m.src, "bin", "vyre"), path.join(pkg, "bin", "vyre"));
  fs.writeFileSync(path.join(pkg, "core", "vyre-core", "install-main.js"), `import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const a = process.argv.slice(2), cmd = a[0];
const flag = k => a[a.indexOf(k) + 1];
const base = process.env.FAKE_CORE_BASE;
fs.appendFileSync(path.join(process.env.FAKE_LOG_DIR, "root.log"), JSON.stringify({ argv: a, uid: process.getuid?.(), from: new URL(import.meta.url).pathname }) + "\\n");
if (cmd === "uninstall") { fs.rmSync(path.join(base, "core.json"), { force: true }); console.log("  ok  removed"); process.exit(0); }
if (${o.fail ? "true" : "false"}) { console.error("vyre-install: the manifest signature does not verify"); process.exit(1); }
for (const f of ["vyre.tgz", "manifest.json", "SHA256SUMS", "SHA256SUMS.sig"]) if (!fs.existsSync(path.join(flag("--release-dir"), f))) { console.error("missing " + f); process.exit(1); }
const sock = path.join(base, "vyre-core.sock"); fs.writeFileSync(sock, "");
fs.writeFileSync(path.join(base, "core.json"), JSON.stringify({ socket: sock, uid: 400 }));
spawn(flag("--vyred-wrapper"), [], { detached: true, stdio: "ignore" }).unref();
console.log("  ok  installed");
${o.noEnrol ? "" : `console.log("VYRE_CORE_ENROL=${ENROL}");`}
`);
  execFileSync("tar", ["-czf", path.join(site, "vyre.tgz"), "-C", path.dirname(pkg), "vyre"]);
  const kp = crypto.generateKeyPairSync("ed25519");
  const manifest = Buffer.from(JSON.stringify({ version: "0.2.0", tarball: "vyre.tgz", sha256: sha(fs.readFileSync(path.join(site, "vyre.tgz"))) }));
  fs.writeFileSync(path.join(site, "manifest.json"), manifest);
  const patched = path.join(m.base, "install-mac-server.sh");
  fs.writeFileSync(patched, fs.readFileSync(SCRIPT, "utf8").replace(/^RELEASE_KEY=.*$/m, `RELEASE_KEY=${kp.publicKey.export({ type: "spki", format: "der" }).toString("base64")}`));
  fs.mkdirSync(path.join(m.base, "roottmp"));
  // The one signature: over SHA256SUMS, which lists the tarball and the manifest.
  const sums = Buffer.from(["vyre.tgz", "manifest.json"].map(f => `${sha(fs.readFileSync(path.join(site, f)))}  ${f}`).join("\n") + "\n");
  fs.writeFileSync(path.join(site, "SHA256SUMS"), sums);
  fs.writeFileSync(path.join(site, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), kp.privateKey).toString("base64") + "\n");
  const env = {
    ...m.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, VYRE_UNAME_M: "arm64",
    VYRE_TEST_SCRIPT: patched, VYRE_ROOT_TMP: path.join(m.base, "roottmp"), VYRE_SUDO: path.join(bin, "sudo"), VYRE_CORE_BASE: core, FAKE_CORE_BASE: core, FAKE_LOG_DIR: m.base,
    VYRE_BOX_URL: `file://${site}/`, VYRE_NODE_URL: `file://${path.join(m.base, "node.tgz")}`, VYRE_NODE_SHA256: sha(fs.readFileSync(path.join(m.base, "node.tgz"))),
  };
  const rootCalls = () => (fs.existsSync(path.join(m.base, "root.log")) ? fs.readFileSync(path.join(m.base, "root.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { ...m, env, site, core, rootCalls };
}

test("install-mac-server.sh: the default is the system service, under one sudo, and vyred and core are up", t => {
  const m = sys(t);
  const r = run({ ...m.env, VYRE_CODE: CODE }, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal((m.calls().match(/^sudo /gm) || []).length, 1, "one sudo, once");
  const calls = m.rootCalls();
  assert.equal(calls.length, 1);
  const a = calls[0].argv;
  assert.equal(a[0], "install");
  assert.equal(a[a.indexOf("--owner-uid") + 1], String(process.getuid?.()), "the person's own uid, never root");
  assert.equal(a[a.indexOf("--vyred-wrapper") + 1], path.join(m.env.VYRE_SERVER_DIR, "bin", "vyre-serve"));
  // the full install is a server, and core is told which key the install line named: the last 16 bytes of the code, as hex (the secret half never goes)
  assert.ok(a.includes("--server"));
  assert.equal(a[a.indexOf("--first-key-fp") + 1], Buffer.from(CODE, "base64url").subarray(16).toString("hex"));
  assert.ok(!JSON.stringify(a).includes(Buffer.from(CODE, "base64url").subarray(0, 16).toString("hex")), "not the secret half");
  assert.ok(!JSON.stringify(a).includes(CODE), "not the code");
  // Root ran the installer, its node and its release files from a root-made folder, never from the person's.
  const roottmp = path.join(m.base, "roottmp");
  assert.ok(calls[0].from.startsWith(roottmp + path.sep) || calls[0].from.includes("/roottmp/"), calls[0].from);
  assert.ok(a[a.indexOf("--node") + 1].includes("/roottmp/"), "the root-owned node");
  assert.match(a[a.indexOf("--node-sha256") + 1], /^[0-9a-f]{64}$/);
  assert.ok(a[a.indexOf("--release-dir") + 1].includes("/roottmp/"));
  assert.ok(!calls[0].from.includes(m.env.VYRE_SERVER_DIR), "not the copy in the person's folder");
  assert.deepEqual(fs.readdirSync(roottmp), [], "root's folder is removed when it is done");
  assert.ok(!fs.existsSync(path.join(m.env.VYRE_LAUNCHAGENTS, "run.vyre.server.plist")), "no LaunchAgent: launchd's system domain runs it");
  assert.ok(!/launchctl bootstrap/.test(m.calls()), "the script never bootstraps; the root installer does");
  assert.match(r.stdout, /vyre-core is up/);
  assert.match(r.stdout, /starts when this Mac boots, with nobody signed in/);
  // The enrolment code is read and dropped: never on screen, never in the env file, never in a call.
  assert.ok(!(r.stdout + r.stderr).includes(ENROL) && !m.calls().includes(ENROL));
  assert.ok(!fs.readFileSync(path.join(m.env.VYRE_HOME, "vyre.env"), "utf8").includes(ENROL));
  assert.ok(!(r.stdout + r.stderr).includes(CODE), "the setup code is never shown either");
});

test("install-mac-server.sh: the full install is a server (config.json says machine server, a choice already made is kept); the light --login-only install is My Home and writes none", t => {
  const login = mac(t);
  assert.equal(run({ ...login.env }, ["--yes", "--from", login.src]).status, 0);
  assert.ok(!fs.existsSync(path.join(login.env.VYRE_HOME, "config.json")), "a login-only install stays a Home: nothing says server");
  const full = (pre, extra = {}) => {
    const m = sys(t);
    const f = path.join(m.env.VYRE_HOME, "config.json");
    if (pre !== undefined) { fs.mkdirSync(m.env.VYRE_HOME, { recursive: true }); fs.writeFileSync(f, pre); }
    const r = run({ ...m.env, ...extra }, ["--yes", "--system"]);
    return { r, f, m };
  };
  let x = full();
  assert.equal(x.r.status, 0, x.r.stderr + x.r.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(x.f, "utf8")), { machine: "server" });
  assert.equal(fs.statSync(x.f).mode & 0o777, 0o600);
  x = full(JSON.stringify({ name: "mini", relay: { enabled: true } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(x.f, "utf8")), { name: "mini", relay: { enabled: true }, machine: "server" });
  x = full(JSON.stringify({ machine: "device" }));
  assert.equal(JSON.parse(fs.readFileSync(x.f, "utf8")).machine, "device");
  x = full(JSON.stringify({ role: "box" }));
  assert.deepEqual(JSON.parse(fs.readFileSync(x.f, "utf8")), { role: "box" });
  x = full("{ not json");
  assert.notEqual(x.r.status, 0); assert.match(x.r.stderr, /not valid JSON/);
});

test("install-mac-server.sh: with the app's install line it prints the four check words and ends 'Back in the Vyre app'; without one it names the long code", t => {
  let m = sys(t);
  let r = run({ ...m.env, VYRE_CODE: CODE }, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Your four words: come pilot company release/);
  assert.match(r.stdout, /They should match the four on your screen\./);
  assert.match(r.stdout, /Done\. Back in the Vyre app\./);
  assert.ok(!/wink\.server\.code/.test(r.stdout), "the old pairing text is gone from an app-led install");
  assert.ok(!(r.stdout + r.stderr).includes(CODE));
  m = sys(t);
  r = run({ ...m.env }, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!/Your four words|Go back to the Vyre app/.test(r.stdout));
  assert.match(r.stdout, /wink\.server\.code/);
  // words that cannot be read are said so, with the command that shows them
  m = sys(t);
  fs.rmSync(path.join(m.src, "bin"), { recursive: true });
  fs.writeFileSync(path.join(m.base, "pkg", "vyre", "bin", "vyre"), "process.exit(1)\n");
  execFileSync("tar", ["-czf", path.join(m.site, "vyre.tgz"), "-C", path.join(m.base, "pkg"), "vyre"]);
  // the manifest and signature name the old tarball; the words case only needs the final lines, so use a login-only run for it
  const l = mac(t);
  fs.writeFileSync(path.join(l.src, "bin", "vyre"), "process.exit(1)\n");
  r = run({ ...l.env, VYRE_CODE: CODE }, ["--yes", "--from", l.src]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /four words did not show yet\. To see them, run: .*\/vyre words/);
  assert.match(r.stdout, /Back in the Vyre app/);
});

test("install-mac-server.sh: a failing root installer stops the script, says so, and shows no code", t => {
  const m = sys(t, { fail: true });
  const r = run(m.env, ["--yes", "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the root installer failed/);
  assert.ok(!/vyre-core is up/.test(r.stdout));
});

test("install-mac-server.sh: an installer that never printed the enrolment line did not finish", t => {
  const m = sys(t, { noEnrol: true });
  const r = run(m.env, ["--yes", "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not finish/);
});

test("install-mac-server.sh: system mode refuses a manifest that is not the one SHA256SUMS lists, before root is asked", t => {
  const m = sys(t);
  fs.writeFileSync(path.join(m.site, "manifest.json"), "{\"version\":\"9.9.9\"}");
  const r = run(m.env, ["--yes", "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manifest\.json does not match SHA256SUMS/);
  assert.equal(m.rootCalls().length, 0, "root is never asked");
  assert.ok(!/^sudo /m.test(m.calls()));
});
test("install-mac-server.sh: a Node download that does not match its pin installs nothing and never reaches sudo", t => {
  const m = sys(t);
  const r = run({ ...m.env, VYRE_NODE_SHA256: sha("other") }, ["--yes", "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Node download does not match its pinned checksum/);
  assert.ok(!/^sudo /m.test(m.calls()));
  assert.ok(!fs.existsSync(path.join(m.env.VYRE_SERVER_DIR, "node-dist")));
});

test("install-mac-server.sh: --from needs --login-only in system mode, because a checkout has no signed release", t => {
  const m = sys(t);
  const r = run(m.env, ["--from", m.src, "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no signed release/);
});

test("install-mac-server.sh: --dry-run in system mode prints the plan and changes nothing", t => {
  const m = sys(t);
  const r = run({ ...m.env, VYRE_CODE: CODE }, ["--dry-run", "--system"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /one sudo/);
  assert.deepEqual(fs.readdirSync(m.home), []);
  assert.ok(!/^sudo /m.test(m.calls()));
});

test("install-mac-server.sh: a box-url file beside the script is the release source (the rc channel); the environment beats it; a link that is not https is ignored", t => {
  const m = sys(t);
  const dir = fs.mkdtempSync(path.join(m.base || os.tmpdir(), "setup-"));
  const copy = path.join(dir, "install-mac-server.sh");
  fs.copyFileSync(SCRIPT, copy);
  const url = (/** @type {Record<string,string>} */ extra) => run({ ...m.env, VYRE_CODE: CODE, VYRE_TEST_SCRIPT: copy, VYRE_BOX_URL: "", ...extra }, ["--dry-run", "--system"]);
  fs.writeFileSync(path.join(dir, "box-url"), "https://github.com/vyre-ai/vyre/releases/download/v0.3.0-rc.1/\n");
  let r = url({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /from https:\/\/github\.com\/vyre-ai\/vyre\/releases\/download\/v0\.3\.0-rc\.1\//);
  r = url({ VYRE_BOX_URL: "https://example.test/box/" });
  assert.match(r.stdout, /from https:\/\/example\.test\/box\//);
  fs.writeFileSync(path.join(dir, "box-url"), "http://insecure.test/\n");
  r = url({});
  assert.match(r.stdout, /from https:\/\/vyre\.run\/box\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("install-mac-server.sh: the system Colima start command reaches the root installer, one argument each", t => {
  const m = noBrewSys(t);
  const r = run(m.env, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const a = m.rootCalls()[0].argv;
  const progs = a.flatMap((x, i) => (x === "--colima-program" ? [a[i + 1]] : []));
  assert.equal(progs[0], "/usr/bin/env");
  assert.match(progs[1], /^PATH=.*\.vyre-server\/bin:/);
  assert.equal(progs.at(-2), path.join(m.env.VYRE_SERVER_DIR, "bin", "vyre-runtime"), "the job runs the account's own helper, which sizes the VM");
  assert.equal(progs.at(-1), "run");
  assert.match(progs[1], new RegExp(`${path.dirname(path.join(m.env.VYRE_SERVER_DIR, "bin", "colima"))}`), "colima is on the job's PATH");
  assert.ok(!fs.existsSync(path.join(m.env.VYRE_LAUNCHAGENTS, "run.vyre.colima.plist")), "no per-user Colima agent in system mode");
});

/** The installed `vyre-runtime` helper (a system-mode install puts it in BIN), with a fake colima that logs and answers status from a file. */
function runtimeHelper(t) {
  const m = noBrewSys(t);
  const r = run(m.env, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const helper = path.join(m.env.VYRE_SERVER_DIR, "bin", "vyre-runtime");
  const fakeBin = path.join(m.base, "rt-bin"); fs.mkdirSync(fakeBin);
  const log = path.join(m.base, "colima.log"), up = path.join(m.base, "colima.up");
  fs.writeFileSync(path.join(fakeBin, "colima"), `#!/bin/sh
echo "colima $*" >>"${log}"
case "$1" in start) : >"${up}" ;; stop) rm -f "${up}"; [ -z "\${FAKE_JOB:-}" ] || : >"${up}" ;; status) [ -f "${up}" ] ;; esac
`, { mode: 0o755 });
  const GiB = 1024 ** 3;
  const env = (/** @type {number} */ ramGiB, /** @type {number} */ cores) => ({ PATH: `${fakeBin}:/usr/bin:/bin`, HOME: m.home, VYRE_HOME: m.env.VYRE_HOME, VYRE_RAM_BYTES: String(ramGiB * GiB), VYRE_CORES: String(cores) });
  const call = (/** @type {string[]} */ args, /** @type {any} */ e) => spawnSync("sh", [helper, ...args], { encoding: "utf8", env: e, timeout: 60_000 });
  const size = () => Object.fromEntries(fs.readFileSync(path.join(m.env.VYRE_HOME, "colima-size.env"), "utf8").trim().split("\n").map(l => l.split("=")));
  return { m, helper, env, call, size, log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""), up, setUp: (/** @type {boolean} */ v) => (v ? fs.writeFileSync(up, "") : fs.rmSync(up, { force: true })) };
}

test("vyre-runtime: memory is 2 GiB plus 2.5 per space, never under 4, capped at half the Mac's RAM, 4 CPUs from 8 cores, and the room answer says plainly when it is full", t => {
  const h = runtimeHelper(t);
  const room = (/** @type {number} */ n, /** @type {number} */ ram, /** @type {number} */ cores) => { const r = h.call(["room", String(n)], h.env(ram, cores)); return { code: r.status, ...JSON.parse(r.stdout) }; };
  // 32 GiB Mac: cap 16
  assert.deepEqual(["memory_gib", "cpus", "ok"].map(k => /** @type {any} */ (room(1, 32, 10))[k]), [5, 4, true], "one space: 2 + 2.5 rounded up");
  assert.equal(room(2, 32, 8).memory_gib, 7);
  assert.equal(room(4, 32, 4).memory_gib, 12);
  assert.equal(room(4, 32, 4).cpus, 2);
  assert.equal(room(5, 32, 4).memory_gib, 15);
  // 16 GiB Mac: cap 8, so 2 spaces fit (7) and a third does not (9.5 > 8)
  const two = room(2, 16, 8), three = room(3, 16, 8);
  assert.equal(two.ok, true); assert.equal(two.code, 0);
  assert.equal(three.ok, false); assert.equal(three.code, 3);
  assert.equal(three.max_spaces, 2);
  assert.equal(three.memory_gib, 8, "reports the cap it would stay under");
  assert.match(three.message, /room for 2 spaces/);
  assert.match(three.message, /your server/);
  // never under the 4 GiB Colima had before
  assert.equal(room(1, 8, 4).memory_gib, 4);
});

test("vyre-runtime: run writes the first size and starts Colima in the foreground at it; resize writes the new size, says what it is doing, and brings Colima back at it", t => {
  const h = runtimeHelper(t);
  // the job's own first start: 16 GiB, 8 cores, one space
  const e = { ...h.env(16, 8), FAKE_JOB: "1" }; // FAKE_JOB: the fake colima comes straight back after a stop, as launchd's job does
  const first = h.call(["run"], e);
  assert.equal(first.status, 0, first.stderr);
  assert.match(h.log(), /colima start --foreground --vm-type vz --cpu 4 --memory 5 --disk 40/);
  assert.deepEqual([h.size().SPACES, h.size().MEMORY, h.size().CPUS, h.size().JOB], ["1", "5", "4", "1"]);
  // a second space: a launchd job supervises (JOB=1), so stopping Colima is the restart and the helper does not start a second one
  h.setUp(true);
  const r = h.call(["resize", "2"], e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^Making room for a new space$/m);
  assert.equal(h.size().MEMORY, "7");
  assert.match(h.log(), /colima stop/);
  assert.ok(!/colima start --cpu/.test(h.log()), "no second start next to the job's own");
  // the same size again changes nothing and does not restart
  const before = h.log();
  const same = h.call(["resize", "2"], e);
  assert.equal(same.status, 0);
  assert.ok(!/Making room/.test(same.stdout));
  assert.equal(h.log(), before);
  // too many: refused, size untouched, nothing stopped
  const full = h.call(["resize", "3"], e);
  assert.equal(full.status, 3);
  assert.equal(h.size().MEMORY, "7");
  assert.equal(h.log(), before);
});

test("vyre-runtime: a resize leaves a restart flag and the job's run loop starts Colima again at the new size, because launchd would not relaunch an exit 0; no flag ends the job with Colima's exit code", t => {
  const h = runtimeHelper(t);
  const e = h.env(32, 8);
  const flag = path.join(h.m.env.VYRE_HOME, "colima-restart");
  // the fake colima's foreground start ends at once (as after `colima stop`), exit 0 the first time and 7 the second
  const counter = path.join(h.m.base, "starts");
  fs.writeFileSync(path.join(h.m.base, "rt-bin", "colima"), `#!/bin/sh
echo "colima $*" >>"${h.m.base}/colima.log"
if [ "$1" = start ]; then n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n + 1)) >"${counter}"; [ "$n" = 0 ] || exit 7; fi
exit 0
`, { mode: 0o755 });
  fs.mkdirSync(h.m.env.VYRE_HOME, { recursive: true });
  fs.writeFileSync(path.join(h.m.env.VYRE_HOME, "colima-size.env"), "SPACES=1\nCPUS=4\nMEMORY=5\nDISK=40\nJOB=1\n");
  fs.writeFileSync(flag, "");
  const r = h.call(["run"], e);
  assert.equal(r.status, 7, "ends with Colima's own exit code once there is no restart flag");
  assert.equal((h.log().match(/colima start --foreground/g) || []).length, 2, "started again after the flag");
  assert.ok(!fs.existsSync(flag), "the flag is consumed");
  // and a resize leaves the flag when a job supervises
  fs.rmSync(counter);
  h.setUp(true);
  fs.writeFileSync(path.join(h.m.base, "rt-bin", "colima"), `#!/bin/sh\necho "colima $*" >>"${h.m.base}/colima.log"\ncase "$1" in start) : >"${h.up}" ;; stop) : >"${h.up}" ;; status) [ -f "${h.up}" ] ;; esac\n`, { mode: 0o755 });
  const rz = h.call(["resize", "2"], e);
  assert.equal(rz.status, 0, rz.stderr + rz.stdout);
  assert.ok(fs.existsSync(flag), "resize left the restart flag for the run loop");
});

test("vyre-runtime: with no job (brew services), resize stops Colima and starts it again at the new size itself", t => {
  const h = runtimeHelper(t);
  const e = h.env(32, 8);
  assert.equal(h.call(["start"], e).status, 0);
  assert.match(h.log(), /colima start --cpu 4 --memory 5 --disk 40/);
  assert.equal(h.size().JOB, "0");
  const r = h.call(["resize", "3"], e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(h.log(), /colima stop[\s\S]*colima start --cpu 4 --memory 10 --disk 40/);
});

test("lib/mac-runtime: roomFor and makeRoom call the helper, pass the progress line on, and say plainly when there is no room", async t => {
  const h = runtimeHelper(t);
  const { roomFor, makeRoom, helperPath } = await import("../lib/mac-runtime.js");
  const env = { ...h.env(16, 8), VYRE_SERVER_DIR: h.m.env.VYRE_SERVER_DIR };
  assert.equal(helperPath(env), h.helper);
  assert.equal((await roomFor(2, { env })).ok, true);
  const full = await roomFor(3, { env });
  assert.equal(full.ok, false);
  assert.match(full.message, /your server/);
  h.setUp(true);
  const lines = /** @type {string[]} */ ([]);
  const made = await makeRoom(2, { env, onProgress: l => lines.push(l) });
  assert.equal(made.ok, true, made.message);
  assert.deepEqual(lines, ["Making room for a new space"]);
  const refused = await makeRoom(3, { env, onProgress: l => lines.push(l) });
  assert.equal(refused.ok, false);
  assert.equal(lines.length, 1);
  assert.match((await roomFor(2, { env: { ...env, VYRE_SERVER_DIR: "/nonexistent" } })).message, /could not be asked/);
});

test("install-mac-server.sh: a Colima that does not match its pin is not handed to the root installer", t => {
  const m = noBrewSys(t);
  const r = run({ ...m.env, VYRE_COLIMA_SHA256: sha("no") }, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!m.rootCalls()[0].argv.includes("--colima-program"));
});

test("install-mac-server.sh: system uninstall runs the root uninstaller once, and --purge --yes asks it to purge", t => {
  const m = sys(t);
  assert.equal(run(m.env, ["--yes", "--system"]).status, 0);
  const im = path.join(m.core, "current-install-main.js");
  fs.copyFileSync(path.join(m.env.VYRE_SERVER_DIR, "app", "core", "vyre-core", "install-main.js"), im);
  const r = run({ ...m.env, VYRE_INSTALL_MAIN: im }, ["--uninstall", "--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const last = m.rootCalls().at(-1).argv;
  assert.deepEqual(last, ["uninstall"]);
  assert.ok(fs.existsSync(path.join(m.env.VYRE_HOME, "vyre.env")), "data stays");
  const p = run({ ...m.env, VYRE_INSTALL_MAIN: im }, ["--uninstall", "--purge", "--yes", "--system"]);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(m.rootCalls().at(-1).argv, ["uninstall", "--purge"]);
  assert.ok(!fs.existsSync(m.env.VYRE_HOME));
});

/** sys() on a Mac with no Homebrew and no colima, the release and pinned tools served from file://. */
function noBrewSys(/** @type {import("node:test").TestContext} */ t) {
  const s = sys(t), nb = noBrew(t);
  const tools = path.join(s.base, "tools"); fs.mkdirSync(tools);
  for (const n of ["launchctl", "caffeinate", "sudo"]) fs.copyFileSync(path.join(s.base, "bin", n), path.join(tools, n));
  fs.symlinkSync(process.execPath, path.join(tools, "node"));
  for (const k of ["VYRE_COLIMA_URL", "VYRE_COLIMA_SHA256", "VYRE_LIMA_URL", "VYRE_LIMA_SHA256", "VYRE_DOCKER_URL", "VYRE_DOCKER_SHA256"]) s.env[k] = nb.env[k];
  s.env.PATH = `${tools}:/usr/bin:/bin`;
  return s;
}

// A gh on the machine's own PATH (hosted Linux runners have one) is used as it is, which is the next test;
// the pinned download is what a Mac with no gh takes, and the macOS runner proof runs it for real.
const hasSystemGh = spawnSync("sh", ["-c", "command -v gh"], { env: { PATH: "/usr/bin:/bin" } }).status === 0;
test("install-mac-server.sh: gh is the pinned download when neither PATH nor Homebrew has it, and vyred is told where it is", { skip: hasSystemGh && "this machine has a gh on its PATH, so the download is never taken" }, t => {
  const m = noBrewSys(t);
  const d = path.join(m.base, "pk-gh", "gh_9_macOS_arm64", "bin"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "gh"), "#!/bin/sh\necho gh\n", { mode: 0o755 });
  const zip = path.join(m.base, "gh.zip");
  execFileSync("zip", ["-qr", zip, "gh_9_macOS_arm64"], { cwd: path.join(m.base, "pk-gh") });
  const env = { ...m.env, VYRE_GH_URL: `file://${zip}`, VYRE_GH_SHA256: sha(fs.readFileSync(zip)) };
  const r = run(env, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const gh = path.join(m.env.VYRE_SERVER_DIR, "bin", "gh");
  assert.ok(fs.existsSync(gh));
  const a = m.rootCalls()[0].argv;
  assert.equal(a[a.indexOf("--gh-bin") + 1], gh);
  assert.match(fs.readFileSync(path.join(m.env.VYRE_SERVER_DIR, "bin", "vyre-serve"), "utf8"), new RegExp(`export VYRE_GH_BIN="${gh}"`));
  // A download that does not match its pin installs nothing and passes nothing on.
  const bad = noBrewSys(t);
  const r2 = run({ ...bad.env, VYRE_GH_URL: `file://${zip}`, VYRE_GH_SHA256: sha("no") }, ["--yes", "--system"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /gh download does not match its pinned checksum/);
  assert.ok(!bad.rootCalls()[0].argv.includes("--gh-bin"));
});

test("install-mac-server.sh: a gh already on PATH is used as it is", t => {
  const m = sys(t);
  fs.writeFileSync(path.join(m.base, "bin", "gh"), "#!/bin/sh\necho gh\n", { mode: 0o755 });
  const r = run(m.env, ["--yes", "--system"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const a = m.rootCalls()[0].argv;
  assert.equal(a[a.indexOf("--gh-bin") + 1], path.join(m.base, "bin", "gh"));
  assert.ok(!fs.existsSync(path.join(m.env.VYRE_SERVER_DIR, "bin", "gh")));
});

test("install-mac-server.sh: SHA256SUMS signed by another key is refused before sudo", t => {
  const m = sys(t);
  const other = crypto.generateKeyPairSync("ed25519");
  const sums = fs.readFileSync(path.join(m.site, "SHA256SUMS"));
  fs.writeFileSync(path.join(m.site, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), other.privateKey).toString("base64") + "\n");
  const r = run(m.env, ["--yes", "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /signature does not verify/);
  assert.ok(!/^sudo /m.test(m.calls()) && m.rootCalls().length === 0);
});
test("install-mac-server.sh: a release that changes after it was verified is caught by root's own signature check of its copy", t => {
  const m = sys(t);
  const r = run({ ...m.env, FAKE_TAMPER: "1" }, ["--yes", "--system"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not verify against the release key/);
  assert.equal(m.rootCalls().length, 0, "the installer never ran");
});

test("install-mac-server.sh: the embedded release key is the one release.js compiles in", () => {
  const key = /^RELEASE_KEY=(.*)$/m.exec(fs.readFileSync(SCRIPT, "utf8"))?.[1];
  const rel = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(REPO, "core", "vyre-core", "release.js"), "utf8"))?.[1];
  assert.equal(key, rel);
});

// The file's last word: no process of any test in it may survive (a leaked daemon is a failure, not a chore).
after(() => {
  const left = BASES.flatMap(b => processesWith(b));
  if (left.length) {
    for (const b of BASES) reap(b);
    assert.fail(`${left.length} process(es) from these tests were still running: ${left.map(p => p.pid).join(", ")}`);
  }
});

test("install-mac-server.sh: the built-in network's programs are pinned downloads and your own build, put in Vyre's bin and handed to vyred by env; a bad sum installs nothing", t => {
  const m = mac(t);
  const hs = path.join(m.base, "headscale-dl");
  fs.writeFileSync(hs, "#!/bin/sh\necho headscale\n", { mode: 0o755 });
  const sum = crypto.createHash("sha256").update(fs.readFileSync(hs)).digest("hex");
  const fwd = path.join(m.base, "my-forwarder");
  fs.writeFileSync(fwd, "#!/bin/sh\necho forwarder\n", { mode: 0o755 });
  const r = run({ ...m.env, VYRE_HEADSCALE_URL: `file://${hs}`, VYRE_HEADSCALE_SHA256: sum, VYRE_FORWARDER_FILE: fwd }, ["--from", m.src]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const bin = path.join(m.env.VYRE_SERVER_DIR, "bin");
  assert.ok(fs.existsSync(path.join(bin, "headscale")));
  assert.ok(fs.existsSync(path.join(bin, "wink-forwarder")));
  assert.match(r.stdout, /Headscale 0\.29\.4 is/);
  assert.match(r.stdout, /the node program is .* \(your own build\)/);
  const wrapper = fs.readFileSync(path.join(bin, "vyre-serve"), "utf8");
  assert.match(wrapper, new RegExp(`export VYRE_HEADSCALE_BIN="${path.join(bin, "headscale")}"`));
  assert.match(wrapper, new RegExp(`export VYRE_WINK_FORWARDER_BIN="${path.join(bin, "wink-forwarder")}"`));

  const bad = mac(t);
  const r2 = run({ ...bad.env, VYRE_HEADSCALE_URL: `file://${hs}`, VYRE_HEADSCALE_SHA256: "0".repeat(64) }, ["--from", bad.src]);
  assert.equal(r2.status, 0, "a missing network never stops the install");
  assert.match(r2.stdout, /Headscale download does not match its pinned checksum; nothing was installed/);
  assert.ok(!fs.existsSync(path.join(bad.env.VYRE_SERVER_DIR, "bin", "headscale")));
  assert.match(r2.stdout, /this release has no node program for this Mac/);
  const w2 = fs.readFileSync(path.join(bad.env.VYRE_SERVER_DIR, "bin", "vyre-serve"), "utf8");
  assert.ok(!/VYRE_HEADSCALE_BIN|VYRE_WINK_FORWARDER_BIN/.test(w2), "no program, no env: netd says no-binary and the relay carries everything");
});

test("install-mac-server.sh: the node program comes from the signed release's own SHA256SUMS line, not from anywhere else", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.match(src, /get "\$fname"/, "fetched through get, which checks the line in SHA256SUMS");
  assert.match(src, /fname=wink-forwarder-darwin-\$fa/);
  assert.match(src, /HEADSCALE_SHA256_ARM64=b5cfd0f81caaa1e8f71f830fd89fdf86a8719bb6e9f9a2ec5b47d9426c96986e/);
  assert.match(src, /HEADSCALE_SHA256_AMD64=06e4c94a8b9397ed8c2714a4cd484c998604dc884e9b5d4a186aef05f14047b1/);
});
