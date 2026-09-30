// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  RELEASE_KEY, verifyManifest, checkTarball, checkFloor, readFloor, raiseFloor,
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
function signed(kp, obj = { version: "1.2.3", tarball: "core.tgz", sha256: HASH }) {
  const bytes = Buffer.from(JSON.stringify(obj));
  return { bytes, sig: crypto.sign(null, bytes, kp.priv).toString("base64") };
}
const tar = (cwd, args) => execFileSync("tar", args, { cwd, stdio: "pipe" });

test("the baked-in key is a valid Ed25519 SPKI constant", () => {
  assert.ok(crypto.createPublicKey({ key: Buffer.from(RELEASE_KEY, "base64"), format: "der", type: "spki" }));
});

test("a good manifest verifies and returns the parsed object", () => {
  const kp = keypair();
  const { bytes, sig } = signed(kp, { version: "1.2.3", tarball: "core.tgz", sha256: HASH, channel: "stable" });
  assert.deepEqual(verifyManifest(bytes, sig, { key: kp.key }), { version: "1.2.3", tarball: "core.tgz", sha256: HASH, channel: "stable" });
});

test("tampered manifest, wrong key, empty or missing signature are refused", () => {
  const kp = keypair();
  const { bytes, sig } = signed(kp);
  assert.throws(() => verifyManifest(Buffer.concat([bytes, Buffer.from(" ")]), sig, { key: kp.key }), /does not verify/);
  assert.throws(() => verifyManifest(bytes, sig, { key: keypair().key }), /does not verify/);
  assert.throws(() => verifyManifest(bytes, sig), /does not verify/); // placeholder key
  assert.throws(() => verifyManifest(bytes, "", { key: kp.key }), /empty/);
  assert.throws(() => verifyManifest(bytes, undefined, { key: kp.key }), /missing/);
  assert.throws(() => verifyManifest(bytes, "not base64!!", { key: kp.key }), /base64/);
  assert.throws(() => verifyManifest(bytes, Buffer.alloc(10).toString("base64"), { key: kp.key }), /64 bytes/);
});

test("malformed JSON, bad version and bad hash are refused even when correctly signed", () => {
  const kp = keypair();
  const bad = (raw) => {
    const bytes = Buffer.from(raw);
    return () => verifyManifest(bytes, crypto.sign(null, bytes, kp.priv).toString("base64"), { key: kp.key });
  };
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

test("absolute path is refused", (t) => {
  refused(t, (s) => fs.writeFileSync(path.join(s, "f"), "x"), ["-P", "-s", "|^f$|/etc/evil|", "f"], /absolute/);
});

test(".. component is refused", (t) => {
  refused(t, (s) => { fs.mkdirSync(path.join(s, "sub")); fs.writeFileSync(path.join(s, "f"), "x"); },
    ["-P", "-s", "|^f$|../evil|", "f"], /\.\./);
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
