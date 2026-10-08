// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { plan, install, uninstall, apply, buildPlists, plistXml, flipCurrent, signCapsule, RUNTIME, LABELS } from "./installer.js";
import { strictProblems } from "./strict.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VYRE_UID = 301;

function tmp(t) {
  const d = fs.mkdtempSync(path.join(SCRATCH, "inst-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { key: publicKey.export({ type: "spki", format: "der" }).toString("base64"), priv: privateKey };
}

/** A release dir signed by kp: vyre.tgz with core/vyre-core/main.js, manifest.json, SHA256SUMS and SHA256SUMS.sig. */
function release(dir, kp, version, { badSig = false, tamper = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const tree = path.join(dir, "tree");
  fs.mkdirSync(path.join(tree, "core", "vyre-core"), { recursive: true });
  fs.writeFileSync(path.join(tree, "core", "vyre-core", "main.js"), `// v${version}\n`);
  fs.writeFileSync(path.join(tree, "core", "vyre-core", "install-main.js"), "// apply\n");
  fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ version }));
  execFileSync("tar", ["-czf", path.join(dir, "vyre.tgz"), "-C", tree, "."]);
  fs.rmSync(tree, { recursive: true });
  const h = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
  const manifest = Buffer.from(JSON.stringify({ version, tarball: "vyre.tgz", sha256: h("vyre.tgz") }));
  fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
  const sums = Buffer.from(`${h("manifest.json")}  manifest.json\n${h("vyre.tgz")}  vyre.tgz\n`);
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums);
  const other = badSig ? keypair().priv : kp.priv;
  fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), other).toString("base64"));
  if (tamper) fs.appendFileSync(path.join(dir, "vyre.tgz"), "x");
  return { tarball: path.join(dir, "vyre.tgz"), manifest: path.join(dir, "manifest.json"), sums: path.join(dir, "SHA256SUMS"), sig: path.join(dir, "SHA256SUMS.sig") };
}

/** A recording run. state: which dscl records exist, which jobs are loaded. */
function fakeRun(state = {}) {
  const st = { user: false, group: false, loaded: new Set(), ...state };
  /** @type {{ cmd: string, args: string[] }[]} */ const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    const line = args.join(" ");
    if (cmd.endsWith("dscl")) {
      if (args[1] === "-create" && args[2].startsWith("/Users/") && args[3] === "UniqueID") st.user = true;
      if (args[1] === "-create" && args[2].startsWith("/Groups/") && args[3] === "PrimaryGroupID") st.group = true;
      if (args[1] === "-read" && args[2].startsWith("/Users/")) { if (!st.user) throw new Error("no such user"); return "UniqueID: 301\n"; }
      if (args[1] === "-read" && args[2].startsWith("/Groups/")) { if (!st.group) throw new Error("no such group"); return "PrimaryGroupID: 301\n"; }
      if (args[1] === "-list" && args[2] === "/Users") return "root 0\nalice 501\n_www 70\n_vyre_old 200\n";
      if (args[1] === "-list" && args[2] === "/Groups") return "wheel 0\nstaff 20\n";
      return "";
    }
    if (cmd.endsWith("launchctl") && args[0] === "bootout") st.loaded.delete(args[1]);
    if (cmd.endsWith("launchctl") && args[0] === "print") { if (!st.loaded.has(args[1])) throw new Error("not loaded"); return ""; }
    if (cmd.endsWith("sudo") && /\ code( --first-key-fp [0-9a-f]+)?$/.test(line)) return "SEKRET-CODE-42 1999999999\n";
    return "";
  };
  return { run, calls, st, has: (re) => calls.some((c) => re.test(`${c.cmd} ${c.args.join(" ")}`)) };
}

function fixture(t, version = "1.0.0") {
  const dir = tmp(t);
  const kp = keypair();
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const node = path.join(dir, "node-bin");
  fs.writeFileSync(node, "#!/bin/sh\n");
  const opts = (rel, extra = {}) => ({ ownerUid: 501, ownerName: "alice", version, release: rel, nodeBinary: node, vyredWrapper: "/Users/alice/.vyre-server/bin/vyred-run", ...extra });
  return { dir, kp, root, node, opts, rel: release(path.join(dir, "rel"), kp, version) };
}
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }) : []);

test("plan lists the steps in order, verify first, and prints as data", () => {
  const f = { ownerUid: 501, ownerName: "alice", version: "1.0.0", release: { tarball: "a", manifest: "b", sums: "d", sig: "c" }, nodeBinary: "/n", vyredWrapper: "/w" };
  assert.deepEqual(plan(f).map((s) => s.id), ["verify-release", "account", "code-tree", "node", "dirs", "plists", "launchd", "enrol-code"]);
  const withColima = plan({ ...f, colimaAgent: true, colimaProgram: ["/c", "start"] });
  assert.ok(withColima.find((s) => s.id === "launchd")?.detail.some((d) => d.includes("com.vyre.colima")));
  assert.throws(() => plan({ ...f, ownerUid: 0 }), /never root/);
  assert.throws(() => plan({ ...f, ownerName: "_vyre" }), /ownerName/);
  assert.throws(() => plan({ ...f, colimaAgent: true }), /colimaProgram/);
});

test("a bad signature changes nothing: no dscl, no launchctl, no files", (t) => {
  const f = fixture(t);
  const bad = release(path.join(f.dir, "bad"), f.kp, "1.0.0", { badSig: true });
  const r = fakeRun();
  assert.throws(() => install(f.opts(bad), { run: r.run, root: f.root, key: f.kp.key }), /signature/);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(walk(f.root), []);
});

test("a tampered tarball and an old version change nothing", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  const bad = release(path.join(f.dir, "bad"), f.kp, "1.0.0", { tamper: true });
  assert.throws(() => install(f.opts(bad), { run: r.run, root: f.root, key: f.kp.key }), /does not match the signed/);
  const floor = path.join(f.root, RUNTIME.floor);
  fs.mkdirSync(path.dirname(floor), { recursive: true });
  fs.writeFileSync(floor, "2.0.0\n");
  assert.throws(() => install(f.opts(f.rel), { run: r.run, root: f.root, key: f.kp.key }), /below the floor/);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(walk(f.root).sort(), ["Library", "Library/Application Support", "Library/Application Support/Vyre", "Library/Application Support/Vyre/.floor"].sort());
});

test("a manifest for another version than asked is refused", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  assert.throws(() => install({ ...f.opts(f.rel), version: "1.0.1" }, { run: r.run, root: f.root, key: f.kp.key }), /not 1.0.1/);
  assert.equal(r.calls.length, 0);
});

test("install: minting the enrolment code is tried again when core is still making its database (the migrations collided on the Mac runner), and gives up after a few tries", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  let n = 0;
  const flaky = (cmd, args) => { if (cmd.endsWith("sudo") && [...args].pop() === "code" && ++n <= 2) throw new Error("migration presence v9 failed: UNIQUE constraint failed: _migrations.module, _migrations.version"); return r.run(cmd, args); };
  const res = install(f.opts(f.rel), { run: flaky, root: f.root, key: f.kp.key, step: () => {} });
  assert.equal(res.code, "SEKRET-CODE-42");
  assert.equal(n, 3, "failed twice, then minted");
  const f2 = fixture(t), r2 = fakeRun();
  const always = (cmd, args) => { if (cmd.endsWith("sudo") && [...args].pop() === "code") throw new Error("still colliding"); return r2.run(cmd, args); };
  assert.throws(() => install(f2.opts(f2.rel), { run: always, root: f2.root, key: f2.kp.key, step: () => {} }), /still colliding/);
});

test("a server install: core's plist says so, the code mint names the first key's fingerprint, and the options are checked", (t) => {
  const f = fixture(t);
  assert.equal(buildPlists(f.opts(f.rel))[LABELS.core].EnvironmentVariables.VYRE_CORE_SERVER, undefined, "a Home Mac is not a server");
  assert.equal(buildPlists(f.opts(f.rel, { server: true }))[LABELS.core].EnvironmentVariables.VYRE_CORE_SERVER, "1");
  const fp = "ab".repeat(16);
  const r = fakeRun();
  const res = install(f.opts(f.rel, { server: true, firstKeyFp: fp }), { run: r.run, root: f.root, key: f.kp.key, step: () => {} });
  assert.equal(res.code, "SEKRET-CODE-42");
  const last = r.calls.filter((c) => c.cmd.endsWith("sudo")).at(-1);
  assert.ok(last, "the mint ran");
  assert.deepEqual(last.args.slice(-3), ["code", "--first-key-fp", fp]);
  assert.ok(last.args.includes("VYRE_CORE_SERVER=1"));
  assert.throws(() => buildPlists(f.opts(f.rel, { firstKeyFp: fp })), /only for a server/);
  assert.throws(() => buildPlists(f.opts(f.rel, { server: true, firstKeyFp: "xyz" })), /32 hex/);
});

test("install runs in order: verify, account, tree, node, dirs, plists, launchd core first, code last", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  const seen = [];
  const res = install(f.opts(f.rel), { run: r.run, root: f.root, key: f.kp.key, step: (n) => seen.push(n) });
  assert.equal(seen.length, 8);
  assert.match(seen[0], /^verify release/);
  const cmds = r.calls.map((c) => `${path.basename(c.cmd)} ${c.args.join(" ")}`);
  const first = (re) => cmds.findIndex((c) => re.test(c));
  assert.ok(first(/dscl \. -create \/Users\/_vyre$/) >= 0);
  assert.ok(first(/dscl \. -create \/Users\/_vyre$/) < first(/chown -R root:wheel/));
  const boot = cmds.filter((c) => c.startsWith("launchctl bootstrap"));
  assert.deepEqual(boot.map((c) => path.basename(c.split(" ").pop())), ["com.vyre.core.plist", "com.vyre.core.update.plist", "com.vyre.vyred.plist"]);
  assert.ok(cmds.at(-1).startsWith("sudo -n -u _vyre /usr/bin/env -i"));
  assert.match(cmds.at(-1), /VYRE_CORE_OWNER=501 \/Library\/Application Support\/Vyre\/node \/Library\/Application Support\/Vyre\/current\/core\/vyre-core\/main\.js code$/);
  assert.equal(res.code, "SEKRET-CODE-42");
  assert.equal(res.expires, 1999999999);
  assert.equal(fs.readFileSync(path.join(f.root, RUNTIME.floor), "utf8").trim(), "1.0.0");
  // the code is returned, never written anywhere
  for (const rel of walk(f.root)) {
    const p = path.join(f.root, String(rel));
    if (fs.lstatSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes("SEKRET-CODE-42"), p);
  }
  assert.ok(!cmds.some((c) => c.includes("SEKRET-CODE-42")));
});

test("the account is created in the system id range, and skipped when it exists", (t) => {
  const f = fixture(t);
  const a = fakeRun();
  install(f.opts(f.rel), { run: a.run, root: f.root, key: f.kp.key });
  const uid = a.calls.find((c) => c.args.includes("UniqueID") && c.args[1] === "-create");
  const n = Number(uid?.args.at(-1));
  assert.ok(n >= 200 && n <= 399);
  assert.equal(n, 201, "200 is taken in the fake directory");
  assert.ok(a.has(/UserShell \/usr\/bin\/false/) && a.has(/NFSHomeDirectory \/var\/empty/) && a.has(/IsHidden 1/) && a.has(/-create \/Groups\/_vyre PrimaryGroupID 201/));
  const g = fixture(t);
  const b = fakeRun({ user: true, group: true });
  install(g.opts(g.rel), { run: b.run, root: g.root, key: g.kp.key });
  assert.ok(!b.has(/dscl \. -create/), "no dscl create when both exist");
  const c = fixture(t);
  const only = fakeRun({ group: true });
  install(c.opts(c.rel), { run: only.run, root: c.root, key: c.kp.key });
  assert.ok(only.has(/-create \/Users\/_vyre$/) && !only.has(/-create \/Groups/), "repairs just the missing user");
});

test("plist contents", (t) => {
  const f = fixture(t);
  const r = fakeRun({ loaded: new Set(["system/com.vyre.vyred"]) });
  install(f.opts(f.rel, { colimaAgent: true, colimaProgram: ["/opt/homebrew/bin/colima", "start"] }), { run: r.run, root: f.root, key: f.kp.key });
  const p = buildPlists(f.opts(f.rel, { colimaAgent: true, colimaProgram: ["/opt/homebrew/bin/colima", "start"] }));
  const core = p[LABELS.core];
  assert.deepEqual(core.ProgramArguments, [RUNTIME.node, RUNTIME.mainJs, "serve"]);
  assert.equal(core.UserName, "_vyre");
  assert.deepEqual(core.EnvironmentVariables, { VYRE_CORE_OWNER: "501" });
  assert.deepEqual(core.KeepAlive, { SuccessfulExit: false });
  assert.equal(core.RunAtLoad, true);
  const upd = p[LABELS.update];
  assert.equal(upd.UserName, undefined, "the updater is root");
  assert.deepEqual(upd.WatchPaths, [RUNTIME.staging]);
  assert.deepEqual(upd.ProgramArguments.slice(-1), ["apply"]);
  assert.ok(!("Sockets" in upd));
  const vyred = p[LABELS.vyred];
  assert.equal(vyred.UserName, "alice");
  assert.notEqual(vyred.UserName, "root");
  assert.notEqual(vyred.UserName, "_vyre");
  assert.deepEqual(vyred.ProgramArguments, ["/Users/alice/.vyre-server/bin/vyred-run"]);
  assert.equal(vyred.EnvironmentVariables.HOME, "/Users/alice");
  assert.equal(vyred.KeepAlive, true);
  assert.equal(p[LABELS.colima].UserName, "alice");
  assert.deepEqual(p[LABELS.colima].ProgramArguments, ["/opt/homebrew/bin/colima", "start"]);
  assert.equal(Object.keys(buildPlists(f.opts(f.rel))).length, 3, "no colima plist without colimaAgent");
  // on disk: written, 0644, chowned root:wheel, an already loaded job is booted out first
  const file = path.join(f.root, "Library/LaunchDaemons/com.vyre.core.plist");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.match(fs.readFileSync(file, "utf8"), /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(r.has(/chown root:wheel .*com\.vyre\.core\.plist\.tmp-/));
  const cmds = r.calls.map((c) => c.args.join(" "));
  assert.ok(cmds.indexOf("bootout system/com.vyre.vyred") < cmds.findIndex((c) => c.startsWith("bootstrap system") && c.includes("vyred")));
  assert.equal(walk(path.join(f.root, "Library/LaunchDaemons")).length, 4);
  assert.match(plistXml({ a: "<&>" }), /&lt;&amp;&gt;/);
});

test("the tree: root-owned modes, bundled node, folders, and no stray temp files", (t) => {
  const f = fixture(t);
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  const base = path.join(f.root, RUNTIME.base);
  assert.equal(fs.statSync(path.join(base, "node")).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(base, "data")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(base, "staging")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.root, RUNTIME.socketDir)).mode & 0o777, 0o755);
  const v = path.join(base, "versions/1.0.0");
  for (const rel of fs.readdirSync(v, { recursive: true })) assert.equal(fs.lstatSync(path.join(v, String(rel))).mode & 0o022, 0, String(rel));
  assert.deepEqual(fs.readdirSync(base).sort(), [".floor", "core.json", "current", "data", "node", "run", "staging", "versions"]);
});

test("current flips atomically: written as current.new then renamed, never absent", (t) => {
  const f = fixture(t);
  const rel2 = release(path.join(f.dir, "rel2"), f.kp, "1.1.0");
  const run = fakeRun().run;
  install(f.opts(f.rel), { run, root: f.root, key: f.kp.key });
  const base = path.join(f.root, RUNTIME.base);
  assert.equal(fs.readlinkSync(path.join(base, "current")), "versions/1.0.0");
  // a stale current.new from a crash is replaced, and the old current stays in force until the rename
  fs.symlinkSync("versions/9.9.9", path.join(base, "current.new"));
  const seen = [];
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => { if (String(b).endsWith("/current")) seen.push([fs.readlinkSync(path.join(base, "current")), fs.readlinkSync(String(a))]); return realRename(a, b); };
  try { flipCurrent(f.root, "1.0.0", run); install({ ...f.opts(rel2), version: "1.1.0" }, { run, root: f.root, key: f.kp.key }); } finally { fs.renameSync = realRename; }
  assert.deepEqual(seen.at(-1), ["versions/1.0.0", "versions/1.1.0"]);
  assert.equal(fs.readlinkSync(path.join(base, "current")), "versions/1.1.0");
  assert.ok(!fs.existsSync(path.join(base, "current.new")));
  assert.equal(fs.readFileSync(path.join(base, "current/core/vyre-core/main.js"), "utf8"), "// v1.1.0\n");
  assert.equal(fs.readFileSync(path.join(base, ".floor"), "utf8").trim(), "1.1.0");
});

test("a re-run of the same version repairs a damaged tree", (t) => {
  const f = fixture(t);
  const run = fakeRun().run;
  install(f.opts(f.rel), { run, root: f.root, key: f.kp.key });
  const main = path.join(f.root, RUNTIME.versions, "1.0.0/core/vyre-core/main.js");
  fs.writeFileSync(main, "// tampered\n");
  install(f.opts(f.rel), { run, root: f.root, key: f.kp.key });
  assert.equal(fs.readFileSync(main, "utf8"), "// v1.0.0\n");
  assert.deepEqual(fs.readdirSync(path.join(f.root, RUNTIME.versions)), ["1.0.0"]);
});

test("uninstall keeps data without purge, purge removes it and the account", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  install(f.opts(f.rel), { run: r.run, root: f.root, key: f.kp.key });
  const base = path.join(f.root, RUNTIME.base);
  fs.writeFileSync(path.join(base, "data", "vyre-core.db"), "secrets");
  const u = fakeRun({ loaded: new Set(["system/com.vyre.core"]) });
  uninstall({}, { run: u.run, root: f.root });
  assert.equal(fs.readFileSync(path.join(base, "data", "vyre-core.db"), "utf8"), "secrets");
  assert.deepEqual(fs.readdirSync(base).sort(), [".floor", "data"]);
  assert.equal(walk(path.join(f.root, "Library/LaunchDaemons")).length, 0);
  assert.ok(!fs.existsSync(path.join(f.root, RUNTIME.socketDir)));
  assert.ok(u.has(/bootout system\/com\.vyre\.core$/));
  assert.ok(!u.has(/dscl \. -delete/));
  const p = fakeRun();
  uninstall({ purge: true }, { run: p.run, root: f.root });
  assert.ok(!fs.existsSync(base));
  assert.ok(p.has(/dscl \. -delete \/Users\/_vyre/) && p.has(/dscl \. -delete \/Groups\/_vyre/));
});

function stage(f, rel) {
  const s = path.join(f.root, RUNTIME.staging);
  fs.mkdirSync(s, { recursive: true });
  fs.copyFileSync(rel.tarball, path.join(s, "vyre.tgz"));
  fs.copyFileSync(rel.manifest, path.join(s, "manifest.json"));
  fs.copyFileSync(rel.sums, path.join(s, "SHA256SUMS"));
  fs.copyFileSync(rel.sig, path.join(s, "SHA256SUMS.sig"));
  return s;
}

test("apply installs a newer signed release, raises the floor, kickstarts core, empties staging", (t) => {
  const f = fixture(t);
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  const s = stage(f, release(path.join(f.dir, "rel2"), f.kp, "1.2.0"));
  const r = fakeRun();
  const res = apply({ run: r.run, root: f.root, key: f.kp.key });
  assert.deepEqual(res, { status: "applied", version: "1.2.0" });
  const base = path.join(f.root, RUNTIME.base);
  assert.equal(fs.readlinkSync(path.join(base, "current")), "versions/1.2.0");
  assert.equal(fs.readFileSync(path.join(base, ".floor"), "utf8").trim(), "1.2.0");
  assert.ok(r.has(/launchctl kickstart -k system\/com\.vyre\.core$/));
  assert.deepEqual(fs.readdirSync(s), []);
  assert.deepEqual(fs.readdirSync(base).filter((n) => n.startsWith(".work")), []);
  assert.equal(apply({ run: r.run, root: f.root, key: f.kp.key }).status, "empty");
});

test("apply waits until the signature has landed, and touches nothing", (t) => {
  const f = fixture(t);
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  const s = stage(f, release(path.join(f.dir, "rel2"), f.kp, "1.2.0"));
  fs.rmSync(path.join(s, "SHA256SUMS.sig"));
  const r = fakeRun();
  assert.equal(apply({ run: r.run, root: f.root, key: f.kp.key }).status, "waiting");
  assert.equal(fs.readdirSync(s).length, 3);
  assert.equal(r.calls.length, 0);
});

test("apply refuses a downgrade and an equal version, leaves the old current, empties staging", (t) => {
  const f = fixture(t, "2.0.0");
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  for (const v of ["1.9.0", "2.0.0"]) {
    const s = stage(f, release(path.join(f.dir, `old-${v}`), f.kp, v));
    const r = fakeRun();
    assert.throws(() => apply({ run: r.run, root: f.root, key: f.kp.key }), /floor/);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(fs.readdirSync(s), []);
  }
  const base = path.join(f.root, RUNTIME.base);
  assert.equal(fs.readlinkSync(path.join(base, "current")), "versions/2.0.0");
  assert.deepEqual(fs.readdirSync(path.join(base, "versions")), ["2.0.0"]);
});

test("apply refuses a tampered tarball and a release signed by another key", (t) => {
  const f = fixture(t);
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  for (const [opt, re] of [[{ tamper: true }, /does not match the signed/], [{ badSig: true }, /signature/]]) {
    stage(f, release(path.join(f.dir, `x-${Object.keys(opt)[0]}`), f.kp, "1.5.0", opt));
    const r = fakeRun();
    assert.throws(() => apply({ run: r.run, root: f.root, key: f.kp.key }), re);
    assert.equal(r.calls.length, 0);
  }
  const base = path.join(f.root, RUNTIME.base);
  assert.equal(fs.readlinkSync(path.join(base, "current")), "versions/1.0.0");
  assert.deepEqual(fs.readdirSync(path.join(base, "versions")), ["1.0.0"]);
});

test("a failed extract leaves the old version current (crash between extract and flip)", (t) => {
  const f = fixture(t);
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  stage(f, release(path.join(f.dir, "rel2"), f.kp, "1.3.0"));
  const base = path.join(f.root, RUNTIME.base);
  const r = fakeRun();
  const boom = (cmd, args) => { if (args[0] === "-R") throw new Error("crash after extract"); return r.run(cmd, args); };
  assert.throws(() => apply({ run: boom, root: f.root, key: f.kp.key }), /crash after extract/);
  assert.equal(fs.readlinkSync(path.join(base, "current")), "versions/1.0.0");
  assert.equal(fs.readFileSync(path.join(base, ".floor"), "utf8").trim(), "1.0.0");
  assert.ok(!fs.existsSync(path.join(base, "versions/1.3.0")));
});

test("signCapsule is a no-op hook for now", () => { assert.equal(signCapsule("/nowhere"), undefined); });

test("the produced tree passes strictProblems (ownership modelled from the recorded chowns)", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  install(f.opts(f.rel), { run: r.run, root: f.root, key: f.kp.key });
  // The test OS has no _vyre, so ownership comes from the chown commands we recorded; modes are the real ones on disk.
  const owners = [];
  for (const c of r.calls) if (c.cmd.endsWith("chown") && !c.args.includes("-h")) {
    const rec = c.args[0] === "-R"; const [who, p] = rec ? [c.args[1], c.args[2]] : [c.args[0], c.args[1]];
    owners.push({ p, rec, uid: who.startsWith("_vyre") ? VYRE_UID : 0 });
  }
  const stat = (p) => {
    const rel = path.relative(f.root, p);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { uid: 0, mode: 0o755 };
    const st = fs.statSync(p);
    let uid = 0;
    for (const o of owners) if (o.p === p || (o.rec && p.startsWith(o.p + path.sep))) uid = o.uid;
    return { uid, mode: st.mode & 0o7777 };
  };
  const base = path.join(f.root, RUNTIME.base);
  const problems = strictProblems({ codeDir: path.join(base, "versions/1.0.0"), dataDir: path.join(base, "data"), socketDir: path.join(f.root, RUNTIME.socketDir), ownerUid: 501, uid: VYRE_UID, stat });
  assert.deepEqual(problems, []);
  // and the check is live: a group-writable code dir is caught
  fs.chmodSync(path.join(base, "versions/1.0.0"), 0o775);
  assert.ok(strictProblems({ codeDir: path.join(base, "versions/1.0.0"), dataDir: path.join(base, "data"), ownerUid: 501, uid: VYRE_UID, stat }).length > 0);
});

test("install-main: --dry-run prints the plan without root and touches nothing; a real run refuses non-root", (t) => {
  const f = fixture(t);
  const main = path.join(HERE, "install-main.js");
  const args = ["install", "--owner-uid", "501", "--owner-name", "alice", "--release-dir", path.dirname(f.rel.tarball), "--node", f.node, "--vyred-wrapper", "/Users/alice/w"];
  const dry = spawnSync(process.execPath, [main, ...args, "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would  verify release 1\.0\.0/);
  assert.ok(!dry.stdout.includes("VYRE_CORE_ENROL"));
  if (process.getuid && process.getuid() !== 0) {
    const real = spawnSync(process.execPath, [main, ...args], { encoding: "utf8" });
    assert.equal(real.status, 1);
    assert.match(real.stderr, /must run as root/);
    assert.equal(spawnSync(process.execPath, [main, "apply"], { encoding: "utf8" }).status, 1);
  }
});

test("vyred's LaunchDaemon carries VYRE_GH_BIN only when given, and only an absolute path", (t) => {
  const f = fixture(t);
  assert.equal(buildPlists(f.opts(f.rel))[LABELS.vyred].EnvironmentVariables.VYRE_GH_BIN, undefined);
  const p = buildPlists(f.opts(f.rel, { ghBin: "/Users/alice/.vyre-server/bin/gh" }));
  assert.deepEqual(p[LABELS.vyred].EnvironmentVariables, { HOME: "/Users/alice", VYRE_GH_BIN: "/Users/alice/.vyre-server/bin/gh" });
  assert.equal(p[LABELS.core].EnvironmentVariables.VYRE_GH_BIN, undefined, "core never gets it");
  assert.throws(() => buildPlists(f.opts(f.rel, { ghBin: "gh" })), /absolute/);
});

test("a refused release clears only the four staged names: a link is unlinked, never followed, and nothing else is touched", (t) => {
  const f = fixture(t);
  install(f.opts(f.rel), { run: fakeRun().run, root: f.root, key: f.kp.key });
  const staging = path.join(f.root, RUNTIME.staging);
  const victim = path.join(f.dir, "victim"); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, "keep.txt"), "mine");
  fs.mkdirSync(path.join(staging, "vyre.tgz.d")); fs.writeFileSync(path.join(staging, "vyre.tgz.d", "x"), "x");
  fs.symlinkSync(victim, path.join(staging, "vyre.tgz"));               // the tarball name is a link to a folder
  fs.writeFileSync(path.join(staging, "manifest.json"), "{}");
  fs.writeFileSync(path.join(staging, "SHA256SUMS"), "");
  fs.writeFileSync(path.join(staging, "SHA256SUMS.sig"), "AAAA");
  assert.throws(() => apply({ run: fakeRun().run, root: f.root, key: f.kp.key }), /signature|not a regular file/);
  assert.ok(fs.existsSync(path.join(victim, "keep.txt")), "the link's target is untouched");
  assert.ok(!fs.existsSync(path.join(staging, "vyre.tgz")) && !fs.existsSync(path.join(staging, "manifest.json")), "the staged names are gone");
  assert.ok(fs.existsSync(path.join(staging, "vyre.tgz.d", "x")), "any other entry is left alone, never recursed into");
});

test("a bundled node that does not match its expected sha256 installs nothing", (t) => {
  const f = fixture(t);
  const r = fakeRun();
  const good = crypto.createHash("sha256").update(fs.readFileSync(f.node)).digest("hex");
  assert.throws(() => install(f.opts(f.rel, { nodeSha256: "0".repeat(64) }), { run: r.run, root: f.root, key: f.kp.key }), /does not match its expected sha256/);
  assert.equal(r.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(f.root, RUNTIME.base)));
  install(f.opts(f.rel, { nodeSha256: good }), { run: fakeRun().run, root: f.root, key: f.kp.key });
  assert.ok(fs.existsSync(path.join(f.root, RUNTIME.node)));
});
