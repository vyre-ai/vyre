// @ts-check
// `vyre capsule install` against a local http server and a temp Applications folder. Never the
// real ~/Applications: VYRE_APPS_DIR is always set. The zip is made here with ditto, so these
// tests run on macOS only.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { install, expected, stray } from "./capsule-install.js";

const mac = process.platform === "darwin";

test("capsule install: SHA256SUMS lines, both spellings, and a missing one", () => {
  const h = "a".repeat(64);
  assert.equal(expected(`${"b".repeat(64)}  vyre-1.0.tgz\n${h}  Vyre-mac.zip\n`), h);
  assert.equal(expected(`${h} *Vyre-mac.zip`), h);
  assert.equal(expected(`${h}  Vyre-mac.zip.sig`), null);
  assert.equal(expected(""), null);
});

test("capsule install: on Linux it says the Capsule is a Mac app", async t => {
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  assert.equal(await install([], { platform: "linux", env: {} }), 1);
  assert.match(lines.join("\n"), /Capsule is a Mac app/);
});

/** A zip holding a tiny Vyre.app, served with SHA256SUMS; a temp Applications folder. */
async function setup(t, { sums, layout } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-capsule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, "src", "Vyre.app", "Contents");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "Info.plist"), "<plist>new</plist>\n");
  const zip = path.join(dir, "Vyre-mac.zip");
  if (layout) layout(path.join(dir, "src"), zip);
  else execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", path.join(dir, "src", "Vyre.app"), zip]);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  const body = sums ?? `${hash}  Vyre-mac.zip\n`;
  const server = http.createServer((req, res) => {
    if (req.url === "/box/SHA256SUMS") { res.end(typeof body === "function" ? body(hash) : body); return; }
    if (req.url === "/box/Vyre-mac.zip") { fs.createReadStream(zip).pipe(res); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(null)));
  t.after(() => new Promise(r => server.close(() => r(null))));
  const port = /** @type {any} */ (server.address()).port;
  const apps = path.join(dir, "Applications");
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  const env = { VYRE_DOWNLOAD_BASE: `http://127.0.0.1:${port}/box/`, VYRE_APPS_DIR: apps };
  const nopin = path.join(dir, "no-such.sha256");
  const pinned = h => { const f = path.join(dir, "Vyre-mac.sha256"); fs.writeFileSync(f, h + "\n"); return f; };
  return { apps, env, nopin, pinned, hash, text: () => lines.join("\n"), plist: () => fs.readFileSync(path.join(apps, "Vyre.app", "Contents", "Info.plist"), "utf8") };
}

const noTty = { tty: false, ask: async () => "" };

test("capsule install: checks the zip, unpacks Vyre.app into the Applications folder, cleans up", { skip: !mac }, async t => {
  const s = await setup(t);
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 0);
  assert.match(s.plist(), /new/);
  assert.deepEqual(fs.readdirSync(s.apps), ["Vyre.app"], "no work folder left behind");
  assert.match(s.text(), /installed .*Vyre\.app/);
  assert.match(s.text(), /vyre capsule/);
});

test("capsule install: a zip that does not match SHA256SUMS is refused", { skip: !mac }, async t => {
  const s = await setup(t, { sums: `${"0".repeat(64)}  Vyre-mac.zip\n` });
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 1);
  assert.match(s.text(), /does not match SHA256SUMS/);
  assert.equal(fs.existsSync(path.join(s.apps, "Vyre.app")), false);
});

test("capsule install: no line for the zip in SHA256SUMS is refused", { skip: !mac }, async t => {
  const s = await setup(t, { sums: h => `${h}  something-else.zip\n` });
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 1);
  assert.match(s.text(), /no line for Vyre-mac\.zip/);
  assert.equal(fs.existsSync(path.join(s.apps, "Vyre.app")), false);
});

test("capsule install: an existing Vyre.app is replaced only after a yes, or with --yes", { skip: !mac }, async t => {
  const s = await setup(t);
  const old = path.join(s.apps, "Vyre.app", "Contents");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "Info.plist"), "<plist>old</plist>\n");

  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 1, "no terminal, no --yes: kept");
  assert.match(s.plist(), /old/);
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: { tty: true, ask: async () => "n" } }), 1, "a no keeps it");
  assert.match(s.plist(), /old/);
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: { tty: true, ask: async () => "y" } }), 0);
  assert.match(s.plist(), /new/);
  fs.writeFileSync(path.join(old, "Info.plist"), "<plist>old</plist>\n");
  assert.equal(await install(["--yes"], { env: s.env, pin: s.nopin, io: noTty }), 0);
  assert.match(s.plist(), /new/);
  assert.deepEqual(fs.readdirSync(s.apps), ["Vyre.app"]);
});

test("capsule install: never /Applications", { skip: !mac }, async t => {
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  assert.equal(await install([], { env: { VYRE_APPS_DIR: "/Applications", VYRE_DOWNLOAD_BASE: "http://127.0.0.1:9/box" }, io: noTty }), 1);
  assert.match(lines.join("\n"), /never writes to \/Applications/);
});

test("capsule install: zip entries outside Vyre.app are named", () => {
  assert.equal(stray(["Vyre.app/", "Vyre.app/Contents/Info.plist"]), null);
  assert.equal(stray(["Vyre.app/", "extra.txt"]), "extra.txt");
  assert.equal(stray(["Vyre.app/../../evil"]), "Vyre.app/../../evil");
  assert.equal(stray(["Vyre.appx/a"]), "Vyre.appx/a");
});

test("capsule install: without a pin it says the check is only vyre.run's SHA256SUMS", { skip: !mac }, async t => {
  const s = await setup(t);
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 0);
  assert.match(s.text(), /checked against vyre\.run's SHA256SUMS; the app is not signed yet/);
});

test("capsule install: the package's pin decides; SHA256SUMS only cross-checks it", { skip: !mac }, async t => {
  // A pin that matches installs, even when SHA256SUMS has no line for the zip.
  const ok = await setup(t, { sums: "" });
  assert.equal(await install([], { env: ok.env, pin: ok.pinned(ok.hash), io: noTty }), 0);
  assert.match(ok.text(), /hash in this npm package/);
  t.mock.restoreAll();

  // The server's zip and its SHA256SUMS agree with each other, but not with the pin: refused.
  const swapped = await setup(t);
  assert.equal(await install([], { env: swapped.env, pin: swapped.pinned("1".repeat(64)), io: noTty }), 1);
  assert.match(swapped.text(), /disagrees with the hash this package was released with/);
  assert.equal(fs.existsSync(path.join(swapped.apps, "Vyre.app")), false);
  t.mock.restoreAll();

  // A pin and no SHA256SUMS line, and the zip does not match the pin: refused.
  const wrong = await setup(t, { sums: "" });
  assert.equal(await install([], { env: wrong.env, pin: wrong.pinned("2".repeat(64)), io: noTty }), 1);
  assert.match(wrong.text(), /does not match the hash this package was released with/);
  t.mock.restoreAll();

  // A pin file that holds no hash: refused rather than ignored.
  const bad = await setup(t);
  assert.equal(await install([], { env: bad.env, pin: bad.pinned("not a hash"), io: noTty }), 1);
  assert.match(bad.text(), /does not hold a sha256/);
});

test("capsule install: a zip with anything beside Vyre.app is refused before unpacking", { skip: !mac }, async t => {
  const s = await setup(t, { layout: (src, zip) => {
    fs.writeFileSync(path.join(src, "extra.txt"), "hi\n");
    execFileSync("/usr/bin/ditto", ["-c", "-k", src, zip]);
  } });
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 1);
  assert.match(s.text(), /holds extra\.txt, outside Vyre\.app/);
  assert.equal(fs.existsSync(path.join(s.apps, "Vyre.app")), false);
});

test("capsule install: a Vyre.app that is a symlink is refused", { skip: !mac }, async t => {
  const s = await setup(t, { layout: (src, zip) => {
    const real = path.join(path.dirname(src), "elsewhere");
    fs.renameSync(path.join(src, "Vyre.app"), real);
    fs.symlinkSync(real, path.join(src, "Vyre.app"));
    execFileSync("/usr/bin/zip", ["-q", "-y", zip, "Vyre.app"], { cwd: src });
  } });
  assert.equal(await install([], { env: s.env, pin: s.nopin, io: noTty }), 1);
  assert.match(s.text(), /holds Vyre\.app as a link/);
  assert.equal(fs.existsSync(path.join(s.apps, "Vyre.app")), false);
});
