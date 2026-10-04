// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  RELEASE_KEY, SUMS_PREFIX, verifySums, checkManifest, checkTarball, checkFloor, readFloor, raiseFloor,
  compareVersions, listTar, checkEntries, extract,
} from "./release.js";
import { SCRATCH } from "../../test/scratch.mjs";

function tmp(t) {
  const d = fs.mkdtempSync(path.join(SCRATCH, "rel-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { key: publicKey.export({ type: "spki", format: "der" }).toString("base64"), priv: privateKey };
}
const HASH = "a".repeat(64);
// COPYFILE_DISABLE: macOS tar would add ._ AppleDouble entries beside every file.
const tar = (cwd, args) => execFileSync("tar", args, { cwd, stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });

test("the baked-in key is a valid Ed25519 SPKI constant", () => {
  assert.ok(crypto.createPublicKey({ key: Buffer.from(RELEASE_KEY, "base64"), format: "der", type: "spki" }));
});

const SUMS = Buffer.from(`${HASH}  vyre.tgz\n${"b".repeat(64)}  manifest.json\n`);
const signSums = (kp, bytes = SUMS) => crypto.sign(null, Buffer.concat([SUMS_PREFIX, bytes]), kp.priv).toString("base64");

test("a good SHA256SUMS verifies and returns its lines", () => {
  const kp = keypair();
  const m = verifySums(SUMS, signSums(kp), { key: kp.key });
  assert.equal(m.get("vyre.tgz"), HASH);
  assert.equal(m.get("manifest.json"), "b".repeat(64));
  assert.equal(m.size, 2);
});

test("tampered SHA256SUMS, wrong key, empty or missing signature are refused", () => {
  const kp = keypair();
  const sig = signSums(kp);
  assert.throws(() => verifySums(Buffer.concat([SUMS, Buffer.from(" ")]), sig, { key: kp.key }), /does not verify/);
  assert.throws(() => verifySums(SUMS, sig, { key: keypair().key }), /does not verify/);
  assert.throws(() => verifySums(SUMS, sig), /does not verify/); // the pinned key
  assert.throws(() => verifySums(SUMS, "", { key: kp.key }), /empty/);
  assert.throws(() => verifySums(SUMS, undefined, { key: kp.key }), /missing/);
  assert.throws(() => verifySums(SUMS, "not base64!!", { key: kp.key }), /base64/);
  assert.throws(() => verifySums(SUMS, Buffer.alloc(10).toString("base64"), { key: kp.key }), /64 bytes/);
});

test("a signed SHA256SUMS with a bad line, a duplicate or a path in a name is refused", () => {
  const kp = keypair();
  const bad = (raw) => () => verifySums(Buffer.from(raw), signSums(kp, Buffer.from(raw)), { key: kp.key });
  assert.throws(bad("nothex  vyre.tgz\n"), /not `sha256  name`/);
  assert.throws(bad(`${HASH}  vyre.tgz\n${HASH}  vyre.tgz\n`), /twice/);
  assert.throws(bad(`${HASH}  ../vyre.tgz\n`), /not `sha256  name`/);
  assert.throws(bad(`${HASH}  /etc/x\n`), /not `sha256  name`/);
});

test("the manifest's shape: malformed JSON, bad version and bad hash are refused", () => {
  const bad = (raw) => () => checkManifest(Buffer.from(raw));
  assert.deepEqual(checkManifest(Buffer.from(JSON.stringify({ version: "1.2.3", tarball: "core.tgz", sha256: HASH, channel: "stable" }))), { version: "1.2.3", tarball: "core.tgz", sha256: HASH, channel: "stable" });
  assert.throws(bad("{nope"), /not valid JSON/);
  assert.throws(bad("[1]"), /not a JSON object/);
  assert.throws(bad(JSON.stringify({ version: "1.2", tarball: "x", sha256: HASH })), /semver/);
  assert.throws(bad(JSON.stringify({ version: "v1.2.3", tarball: "x", sha256: HASH })), /semver/);
  assert.throws(bad(JSON.stringify({ version: "1.2.3", tarball: "x", sha256: "abc" })), /64 hex/);
  assert.throws(bad(JSON.stringify({ version: "1.2.3", tarball: "x", sha256: "g".repeat(64) })), /64 hex/);
  assert.throws(bad(JSON.stringify({ version: "1.2.3", sha256: HASH })), /tarball/);
});

test("checkTarball compares the file's sha256 to the manifest", (t) => {
  const d = tmp(t);
  const f = path.join(d, "a.tgz");
  fs.writeFileSync(f, "hello");
  const good = crypto.createHash("sha256").update("hello").digest("hex");
  assert.equal(checkTarball(f, { sha256: good }), true);
  assert.throws(() => checkTarball(f, { sha256: HASH }), /does not match/);
});

test("versions: old and equal refused, newer allowed, prerelease sorts below release", () => {
  assert.throws(() => checkFloor("1.0.0", "1.0.1"), /floor/);
  assert.throws(() => checkFloor("1.0.1", "1.0.1"), /floor/);
  assert.equal(checkFloor("1.0.2", "1.0.1"), true);
  assert.equal(checkFloor("0.0.1", null), true);
  assert.equal(checkFloor("1.10.0", "1.9.9"), true);
  assert.throws(() => checkFloor("1.0.0-rc.1", "1.0.0"), /floor/);
  assert.equal(checkFloor("1.0.1", "1.0.0-rc.1"), true);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0);
  assert.ok(compareVersions("1.0.0-1", "1.0.0-a") < 0);
  assert.throws(() => checkFloor("banana", "1.0.0"), /semver/);
});

test("floor persists atomically and never lowers", (t) => {
  const d = tmp(t);
  const p = path.join(d, "code", "floor");
  assert.equal(readFloor(p), null);
  assert.equal(raiseFloor(p, "1.2.0"), "1.2.0");
  assert.equal(readFloor(p), "1.2.0");
  assert.equal(raiseFloor(p, "1.1.0"), "1.2.0");
  assert.equal(raiseFloor(p, "1.2.0"), "1.2.0");
  assert.equal(readFloor(p), "1.2.0");
  assert.equal(raiseFloor(p, "1.3.0"), "1.3.0");
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ["floor"]);
  fs.writeFileSync(p, "garbage");
  assert.throws(() => readFloor(p), /semver/);
});

/** Build a tarball from a setup function that populates a fresh dir. */
function build(t, setup, args) {
  const d = tmp(t);
  const src = path.join(d, "src");
  fs.mkdirSync(src);
  setup(src);
  const out = path.join(d, "x.tgz");
  tar(src, ["-czf", out, ...args]);
  return { d, out };
}

test("clean tarball lists and extracts with normalized modes", (t) => {
  const { d, out } = build(t, (s) => {
    fs.mkdirSync(path.join(s, "bin"));
    fs.mkdirSync(path.join(s, "lib"));
    fs.writeFileSync(path.join(s, "bin", "run"), "#!/bin/sh\n", { mode: 0o700 });
    fs.writeFileSync(path.join(s, "lib", "a.js"), "x", { mode: 0o664 });
    fs.writeFileSync(path.join(s, "b.txt"), "y", { mode: 0o600 });
    fs.chmodSync(path.join(s, "lib"), 0o775);
  }, ["."]);
  const entries = listTar(out);
  assert.ok(entries.some((e) => e.path.endsWith("bin/run") && e.type === "file"));
  assert.equal(checkEntries(entries), true);
  const dest = path.join(d, "out", "v1");
  extract(out, dest);
  const mode = (p) => fs.statSync(path.join(dest, p)).mode & 0o7777;
  assert.equal(mode("."), 0o755);
  assert.equal(mode("bin"), 0o755);
  assert.equal(mode("lib"), 0o755);
  assert.equal(mode("bin/run"), 0o755);
  assert.equal(mode("lib/a.js"), 0o644);
  assert.equal(mode("b.txt"), 0o644);
  assert.equal(fs.readFileSync(path.join(dest, "b.txt"), "utf8"), "y");
  assert.deepEqual(fs.readdirSync(path.join(d, "out")), ["v1"]); // no staging left behind
  assert.throws(() => extract(out, dest), /already exists/);
});

test("a long path (pax or gnu long name) is parsed, not truncated", (t) => {
  const long = path.join("d".repeat(90), "e".repeat(90), "f".repeat(60) + ".txt");
  const { out } = build(t, (s) => {
    fs.mkdirSync(path.dirname(path.join(s, long)), { recursive: true });
    fs.writeFileSync(path.join(s, long), "z");
  }, ["."]);
  assert.ok(listTar(out).some((e) => e.path.endsWith(long)));
});

function refused(t, setup, args, re) {
  const { d, out } = build(t, setup, args);
  assert.throws(() => checkEntries(listTar(out)), re);
  const dest = path.join(d, "dest");
  assert.throws(() => extract(out, dest), re);
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(fs.readdirSync(d).sort(), ["src", "x.tgz"]);
}

// Rename f on the way in: bsdtar spells it -s, GNU tar --transform.
const gnuTar = /GNU/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
const renameArgs = (to) => (gnuTar ? ["-P", "--transform", `s|^f$|${to}|`, "f"] : ["-P", "-s", `|^f$|${to}|`, "f"]);

test("absolute path is refused", (t) => {
  refused(t, (s) => fs.writeFileSync(path.join(s, "f"), "x"), renameArgs("/etc/evil"), /absolute/);
});

test(".. component is refused", (t) => {
  refused(t, (s) => { fs.mkdirSync(path.join(s, "sub")); fs.writeFileSync(path.join(s, "f"), "x"); },
    renameArgs("../evil"), /\.\./);
});

test("symlink is refused", (t) => {
  refused(t, (s) => { fs.writeFileSync(path.join(s, "f"), "x"); fs.symlinkSync("/etc/passwd", path.join(s, "l")); }, ["f", "l"], /symlink/);
});

test("hardlink is refused", (t) => {
  refused(t, (s) => { fs.writeFileSync(path.join(s, "f"), "x"); fs.linkSync(path.join(s, "f"), path.join(s, "h")); }, ["f", "h"], /hardlink/);
});

test("fifo is refused", (t) => {
  refused(t, (s) => execFileSync("mkfifo", [path.join(s, "p")]), ["p"], /fifo/);
});

test("setuid bit is refused", (t) => {
  refused(t, (s) => { fs.writeFileSync(path.join(s, "f"), "x"); fs.chmodSync(path.join(s, "f"), 0o4755); }, ["f"], /setuid/);
});

test("one bad entry refuses the whole tarball even after clean ones", (t) => {
  refused(t, (s) => { fs.writeFileSync(path.join(s, "ok"), "x"); fs.symlinkSync("ok", path.join(s, "l")); }, ["ok", "l"], /symlink/);
});

test("a corrupt or non-gzip file is refused", (t) => {
  const d = tmp(t);
  const f = path.join(d, "bad.tgz");
  fs.writeFileSync(f, "not a tarball");
  assert.throws(() => listTar(f), /gzip/);
});

test("a lone package/ folder (npm pack) is stripped on extract; any other single folder is kept", (t) => {
  const pkg = build(t, (s) => { fs.mkdirSync(path.join(s, "package", "core"), { recursive: true }); fs.writeFileSync(path.join(s, "package", "core", "a.js"), "x"); }, ["package"]);
  const a = path.join(pkg.d, "out", "v1");
  extract(pkg.out, a);
  assert.equal(fs.readFileSync(path.join(a, "core", "a.js"), "utf8"), "x");
  const other = build(t, (s) => { fs.mkdirSync(path.join(s, "core"), { recursive: true }); fs.writeFileSync(path.join(s, "core", "a.js"), "y"); }, ["core"]);
  const b = path.join(other.d, "out", "v1");
  extract(other.out, b);
  assert.equal(fs.readFileSync(path.join(b, "core", "a.js"), "utf8"), "y", "a flat tarball with one folder is not stripped");
  const dot = build(t, (s) => { fs.mkdirSync(path.join(s, "package"), { recursive: true }); fs.writeFileSync(path.join(s, "package", "b.js"), "z"); }, ["."]);
  const c = path.join(dot.d, "out", "v1");
  extract(dot.out, c);
  assert.equal(fs.readFileSync(path.join(c, "b.js"), "utf8"), "z", "the same layout written with a ./ prefix strips too");
});

test("a pax size or sparse record is refused, and extract wants an absolute tar", (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, "s")); fs.writeFileSync(path.join(d, "s", "a.txt"), "x");
  for (const key of ["size", "GNU.sparse.major"]) {
    const out = path.join(d, `${key}.tgz`);
    execFileSync("python3", ["-c", `import tarfile,sys
t=tarfile.open(sys.argv[1],"w:gz",format=tarfile.PAX_FORMAT,pax_headers={sys.argv[2]:"5"})
t.add(sys.argv[3]+"/a.txt","a.txt");t.close()`, out, key, path.join(d, "s")]);
    assert.throws(() => listTar(out), /pax record/, key);
  }
  const ok = path.join(d, "ok.tgz"); tar(path.join(d, "s"), ["-czf", ok, "."]);
  assert.throws(() => extract(ok, path.join(d, "o"), { tar: "tar" }), /absolute path to tar/);
});

test("a signature over the bare SHA256SUMS bytes, without the domain prefix, is refused", () => {
  const kp = keypair();
  assert.throws(() => verifySums(SUMS, crypto.sign(null, SUMS, kp.priv).toString("base64"), { key: kp.key }), /does not verify/);
});
