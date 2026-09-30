// @ts-check
// install-mac-server.sh (anywhere, the Mac mini case): the setup code and its time land in vyre.env at
// 0600 and in no argument, the release is checked against SHA256SUMS, the LaunchAgent runs vyred under
// caffeinate with the env file's lines exported, and uninstall leaves the person's data. All against a
// fake launchctl, caffeinate, brew and colima in a temp home: no real service, no Homebrew, no root.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "install-mac-server.sh");
const CODE = "A".repeat(20) + "b-_" + "Z".repeat(20);

/** A temp home with stub launchctl (runs the wrapper for real, like launchd), caffeinate, brew and colima, and a tiny fake vyred to install. */
function mac(/** @type {import("node:test").TestContext} */ t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-mac-"));
  const pids = path.join(base, "pids");
  t.after(() => {
    try { for (const p of fs.readFileSync(pids, "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(p)); } catch {} } } catch {}
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
     setInterval(() => {}, 1000);\n`);
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, VYRE_UNAME_S: "Darwin",
    VYRE_LAUNCHCTL: path.join(bin, "launchctl"), VYRE_CAFFEINATE: path.join(bin, "caffeinate"),
    VYRE_HOME: path.join(home, ".vyre"), VYRE_SERVER_DIR: path.join(home, ".vyre-server"), VYRE_LAUNCHAGENTS: path.join(home, "LaunchAgents"),
  };
  return { base, home, src, env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

const run = (/** @type {Record<string,string>} */ env, /** @type {string[]} */ args) =>
  spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 60_000 });

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
  assert.ok(m.installed("bin/colima") && m.installed("lima/bin/limactl") && m.installed("bin/docker"));
  assert.equal(fs.statSync(path.join(m.env.VYRE_SERVER_DIR, "bin", "colima")).mode & 0o111, 0o111);
  const plist = fs.readFileSync(m.colimaPlist, "utf8");
  assert.match(plist, /<string>--foreground<\/string>/);
  assert.ok(plist.includes(`<string>${m.env.VYRE_SERVER_DIR}/bin/colima</string>`));
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
