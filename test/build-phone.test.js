// @ts-check
// scripts/build-phone.mjs: the phone.vyre.run site is built only from a signed release, and is exactly what shell.json signed.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { buildPhone, OUTSIDE_DECK } from "../scripts/build-phone.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = crypto.generateKeyPairSync("ed25519");
const OTHER = crypto.generateKeyPairSync("ed25519");
const spki = (/** @type {crypto.KeyObject} */ k) => k.export({ type: "spki", format: "der" }).toString("base64");
const sha = (/** @type {Buffer|string} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const signSums = (/** @type {Buffer} */ sums, /** @type {crypto.KeyObject} */ key) => crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), key).toString("base64") + "\n";

/** Write files (path -> text) under dir/package and pack them into dir/rel/vyre.tgz, with a signed SHA256SUMS and the shell.json for `shell`. */
function release(dir, files, shellPaths, { sign = /** @type {any} */ (KEYS.privateKey), tamper = "" } = {}) {
  const pkg = path.join(dir, "src", "package");
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(pkg, p)), { recursive: true }); fs.writeFileSync(path.join(pkg, p), text); }
  const rel = path.join(dir, "rel");
  fs.mkdirSync(rel, { recursive: true });
  assert.equal(spawnSync("tar", ["-czf", path.join(rel, "vyre.tgz"), "-C", path.join(dir, "src"), "package"]).status, 0);
  const fromRoot = /^\/(core|relay|lib)\//;
  const shell = { v: 1, files: shellPaths.map(p => [p, sha(fs.readFileSync(path.join(pkg, fromRoot.test(p) ? p.slice(1) : path.join("deck", p === "/" ? "index.html" : p.slice(1)))))]) };
  fs.writeFileSync(path.join(rel, "shell.json"), JSON.stringify(shell));
  const names = ["vyre.tgz", "shell.json"];
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), names.map(n => `${sha(fs.readFileSync(path.join(rel, n)))}  ${n}\n`).join(""));
  if (sign) fs.writeFileSync(path.join(rel, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(rel, "SHA256SUMS")), sign));
  if (tamper) fs.appendFileSync(path.join(rel, tamper), "x");
  return rel;
}

const FIXTURE = () => ({
  "package.json": JSON.stringify({ name: "vyre", version: "0.2.0" }),
  "build.json": JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567" }),
  "deck/index.html": "<!doctype html><title>Vyre</title>",
  "deck/sw.js": 'const BUILD = "dev";\nconst SHELL_SIGNED = false;\nconst SHELL = ["/", "/js/app.js"];\n',
  "deck/js/app.js": "export {};\n",
  "deck/test/app.test.js": "// not shipped\n",
  "deck/fixtures/x.json": "{}",
  ...Object.fromEntries(OUTSIDE_DECK.map(p => [p, `// ${p}\n`])),
});

test("build-phone: a signed release becomes the site, stamped, with /release/ and only the files the Deck needs", t => {
  const dir = tempHome(t);
  const rel = release(dir, FIXTURE(), ["/", "/js/app.js", "/core/resilience/backoff.js", "/lib/avatar-seed/index.js"]);
  const out = path.join(dir, "site");
  const r = buildPhone({ release: rel, out, key: spki(KEYS.publicKey) });
  assert.equal(r.shell, 4);
  assert.equal(r.build, "0123456789ab");
  const sw = fs.readFileSync(path.join(out, "sw.js"), "utf8");
  assert.match(sw, /const BUILD = "0123456789ab";/);
  assert.match(sw, /const SHELL_SIGNED = true;/, "the worker is told the release is signed, so it checks every new shell");
  for (const n of ["SHA256SUMS", "SHA256SUMS.sig", "shell.json"]) assert.equal(fs.readFileSync(path.join(out, "release", n), "utf8"), fs.readFileSync(path.join(rel, n), "utf8"));
  assert.ok(fs.existsSync(path.join(out, "index.html")) && fs.existsSync(path.join(out, "js", "app.js")));
  for (const p of OUTSIDE_DECK) assert.ok(fs.existsSync(path.join(out, p)), p);
  assert.ok(!fs.existsSync(path.join(out, "test")) && !fs.existsSync(path.join(out, "fixtures")), "tests and fixtures are not shipped");
  assert.equal(fs.readFileSync(path.join(out, "_redirects"), "utf8"), "/* /index.html 200\n");
  assert.match(fs.readFileSync(path.join(out, "_headers"), "utf8"), /connect-src 'self' wss:\/\/relay\.vyre\.run https:\/\/relay\.vyre\.run; frame-ancestors 'none'/);
  assert.ok(fs.existsSync(path.join(out, "theme.css")));
});

test("build-phone: no site is built from an unsigned release, one signed by another key, a changed tarball or a shell.json that is not the signed one", t => {
  const dir = tempHome(t);
  const key = spki(KEYS.publicKey);
  const files = FIXTURE(), shell = ["/", "/js/app.js"];
  const build = (/** @type {string} */ name, /** @type {any} */ o) => { const d = path.join(dir, name); fs.mkdirSync(d); return () => buildPhone({ release: release(d, files, shell, o), out: path.join(d, "site"), key }); };
  assert.throws(build("unsigned", { sign: null }), /has no SHA256SUMS\.sig/);
  assert.throws(build("other", { sign: OTHER.privateKey }), /does not verify against Vyre's release key/);
  assert.throws(build("tgz", { tamper: "vyre.tgz" }), /vyre\.tgz is not the file SHA256SUMS lists/);
  assert.throws(build("shell", { tamper: "shell.json" }), /shell\.json is not the file SHA256SUMS lists/);
  assert.ok(!fs.existsSync(path.join(dir, "unsigned", "site")), "nothing was written");
  // A shell.json whose hashes do not match the deck in the tarball (signed, but for other files) fails at the end.
  const d = path.join(dir, "mismatch"); fs.mkdirSync(d);
  const rel = release(d, files, shell);
  const s = JSON.parse(fs.readFileSync(path.join(rel, "shell.json"), "utf8"));
  s.files[1][1] = "0".repeat(64);
  fs.writeFileSync(path.join(rel, "shell.json"), JSON.stringify(s));
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), ["vyre.tgz", "shell.json"].map(n => `${sha(fs.readFileSync(path.join(rel, n)))}  ${n}\n`).join(""));
  fs.writeFileSync(path.join(rel, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(rel, "SHA256SUMS")), KEYS.privateKey));
  assert.throws(() => buildPhone({ release: rel, out: path.join(d, "site"), key }), /\/js\/app\.js in the build is not the file shell\.json signed/);
});

test("build-phone: the real Deck builds: every file it imports from outside deck/ exists, and sw.js has the lines to stamp", t => {
  const dir = tempHome(t);
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  // The repo's own files, packed the way npm pack lays a package out.
  const pkg = path.join(src, "package");
  fs.mkdirSync(pkg);
  for (const p of ["deck", "core/resilience", "relay/client", "lib/avatar-seed"]) { fs.mkdirSync(path.dirname(path.join(pkg, p)), { recursive: true }); fs.cpSync(path.join(REPO, p), path.join(pkg, p), { recursive: true }); }
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(pkg, "package.json"));
  // The line pwa's release adds to deck/sw.js; a tree from before it gets the line here, and the build needs it either way.
  const swCopy = path.join(pkg, "deck", "sw.js");
  if (!fs.readFileSync(swCopy, "utf8").includes("const SHELL_SIGNED = false;")) fs.appendFileSync(swCopy, "\nconst SHELL_SIGNED = false;\n");
  const rel = path.join(dir, "rel");
  fs.mkdirSync(rel);
  assert.equal(spawnSync("tar", ["-czf", path.join(rel, "vyre.tgz"), "-C", src, "package"]).status, 0);
  // shell.json as scripts/shell-hashes.mjs makes it: the hash of every file in sw.js's SHELL list.
  const sw = fs.readFileSync(swCopy, "utf8");
  const list = [.../** @type {RegExpExecArray} */ (/const SHELL = \[([\s\S]*?)\];/.exec(sw))[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(p => p !== "/sw.js");
  const files = list.map(p => [p, sha(fs.readFileSync(/^\/(core|relay|lib)\//.test(p) ? path.join(REPO, p.slice(1)) : path.join(REPO, "deck", p === "/" ? "index.html" : p.slice(1))))]);
  fs.writeFileSync(path.join(rel, "shell.json"), JSON.stringify({ v: 1, files }));
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), ["vyre.tgz", "shell.json"].map(n => `${sha(fs.readFileSync(path.join(rel, n)))}  ${n}\n`).join(""));
  fs.writeFileSync(path.join(rel, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(rel, "SHA256SUMS")), KEYS.privateKey));
  const r = buildPhone({ release: rel, out: path.join(dir, "site"), key: spki(KEYS.publicKey) });
  assert.equal(r.shell, list.length);
  assert.ok(r.files > 20);
  assert.ok(fs.existsSync(path.join(dir, "site", "release", "SHA256SUMS.sig")));
});

test("build-phone: a release whose sw.js has no SHELL_SIGNED line does not build, and a shell.json path that climbs out of the site is refused", t => {
  const dir = tempHome(t);
  const key = spki(KEYS.publicKey);
  const a = path.join(dir, "a"); fs.mkdirSync(a);
  const noLine = { ...FIXTURE(), "deck/sw.js": 'const BUILD = "dev";\nconst SHELL = ["/"];\n' };
  assert.throws(() => buildPhone({ release: release(a, noLine, ["/"]), out: path.join(a, "site"), key }), /no SHELL_SIGNED line/);
  const b = path.join(dir, "b"); fs.mkdirSync(b);
  const rel = release(b, FIXTURE(), ["/", "/js/app.js"]);
  const s = JSON.parse(fs.readFileSync(path.join(rel, "shell.json"), "utf8"));
  s.files.push(["/../../etc/hostname", "0".repeat(64)]);
  fs.writeFileSync(path.join(rel, "shell.json"), JSON.stringify(s));
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), ["vyre.tgz", "shell.json"].map(n => `${sha(fs.readFileSync(path.join(rel, n)))}  ${n}\n`).join(""));
  fs.writeFileSync(path.join(rel, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(rel, "SHA256SUMS")), KEYS.privateKey));
  assert.throws(() => buildPhone({ release: rel, out: path.join(b, "site"), key }), /which is outside the site/);
});
