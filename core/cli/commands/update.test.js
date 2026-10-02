// @ts-check
// `vyre update` against a fake GitHub Releases server on 127.0.0.1 that serves releases this file
// builds itself. npm is a shell script that writes down what it was asked to install; vyred is
// never started (bring and the health wait are fakes); restore and stop only record their calls.
// Nothing here reaches the network, a real npm, or a real vyred.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempHome } from "../../../test/helpers.js";
import { setJson } from "../kit.js";
import * as config from "../../config/index.js";
import { update, prune, publishRelease } from "./update.js";

process.env.VYRE_NO_DIALOGS = "1";

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
// A release key of the tests' own, given to `vyre update` as deps.key; every fixture release is signed with it unless a test says not.
const KEYS = crypto.generateKeyPairSync("ed25519");
const OTHER = crypto.generateKeyPairSync("ed25519");
const spki = k => k.export({ type: "spki", format: "der" }).toString("base64");
const signSums = (sums, key) => crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), key).toString("base64") + "\n";
const COMMIT = v => sha(v).slice(0, 40);

/** A release's assets as the workflow makes them: a real tar.gz, release.json and SHA256SUMS. */
function assets(root, version, { min_from = "0.1.0", sign = /** @type {any} */ (KEYS.privateKey) } = {}) {
  const dir = path.join(root, "src-" + version, "package");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "vyre", version }));
  const tgz = path.join(root, "src-" + version, "vyre.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", path.dirname(dir), "package"]);
  /** @type {Record<string, Buffer>} */
  const files = {
    "vyre.tgz": fs.readFileSync(tgz),
    VERSION: Buffer.from(version + "\n"),
    "release.json": Buffer.from(JSON.stringify({ version, channel: /-/.test(version) ? "beta" : "stable", commit: COMMIT(version), date: "2026-09-01T00:00:00Z", min_from, notes: `what ${version} changed` })),
  };
  files.SHA256SUMS = Buffer.from(Object.keys(files).sort().map(n => `${sha(files[n])}  ${n}`).join("\n") + "\n");
  // The signature is over SHA256SUMS, so it is not one of its lines.
  if (sign) files["SHA256SUMS.sig"] = Buffer.from(signSums(files.SHA256SUMS, sign));
  return files;
}

/** Put a release into <home>/releases/<version>/, as a past update would have kept it. */
function keep(home, version) {
  const dir = path.join(home, "releases", version);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, b] of Object.entries(assets(path.join(home, ".fixtures"), version))) if (n !== "VERSION") fs.writeFileSync(path.join(dir, n), b);
  return dir;
}

/** What a test printed: console lines, and the JSON lines kit.emit writes. Once per test. */
const captured = new WeakMap();
function capture(t) {
  if (captured.has(t)) return captured.get(t);
  const c = { lines: /** @type {string[]} */ ([]), json: /** @type {any[]} */ ([]) };
  captured.set(t, c);
  t.mock.method(console, "log", (...a) => { c.lines.push(a.join(" ")); });
  // kit.emit writes JSON straight to stdout. Take those lines and pass the test runner's own
  // output (buffers) through untouched.
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.startsWith("{")) { c.json.push(JSON.parse(chunk)); return true; }
    return write(chunk, ...rest);
  });
  return c;
}

/**
 * A temp home, a fake Releases server and fakes for every other piece.
 * @param {any} t
 * @param {{ current?: string, versions?: string[], minFrom?: Record<string, string>, serve?: (p: string) => string | Buffer | undefined,
 *   healthy?: boolean, tty?: boolean, answers?: string[], stamped?: boolean }} [o]
 */
async function world(t, { sign = /** @type {any} */ (KEYS.privateKey), current = "0.1.0", versions = ["0.1.0", "0.2.0"], minFrom = {}, serve = () => undefined, healthy = true, tty = false, answers = [], stamped = true, tips = null } = {}) {
  const home = tempHome(t);
  config.save({ role: "local" });
  const fixtures = path.join(home, ".fixtures");
  const byVersion = Object.fromEntries(versions.map(v => [v, assets(fixtures, v, { min_from: minFrom[v], sign })]));
  const served = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || "/", "http://x").pathname;
    served.push(p);
    const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
    const over = serve(p);
    if (over !== undefined) { res.writeHead(200); res.end(over); return; }
    if (p === "/repos/vyre-ai/vyre/releases") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(versions.map(v => ({
        tag_name: "v" + v, prerelease: /-/.test(v), draft: false, body: `what ${v} changed`, published_at: "2026-09-01T00:00:00Z",
        assets: Object.keys(byVersion[v]).map(name => ({ name, browser_download_url: `${base}/dl/v${v}/${name}` })),
      }))));
      return;
    }
    const m = /^\/dl\/v([^/]+)\/([^/]+)$/.exec(p);
    const file = m && byVersion[m[1]] && byVersion[m[1]][m[2]];
    if (file) { res.writeHead(200); res.end(file); return; }
    res.writeHead(404); res.end("<html>Not Found</html>");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(null)));
  t.after(() => new Promise(r => server.close(() => r(null))));

  // npm: writes its arguments down; a file named npm.fail makes an install whose tarball path
  // holds that text fail.
  const npmLog = path.join(home, "npm.log");
  const npm = path.join(home, "npm");
  fs.writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${npmLog}"\nif [ -f "${home}/npm.fail" ] && echo "$3" | grep -q "$(cat "${home}/npm.fail")"; then echo "npm ERR! boom" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });

  const calls = { bring: [], waitFor: [], restore: [], stop: 0, asked: [], tools: [] };
  const { lines, json } = capture(t);
  const from = lines.length;
  t.after(() => setJson(false));
  const answerQueue = [...answers];
  const deps = {
    home, api: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, npm, repo: home, supervisor: "",
    build: () => ({ version: current, commit: COMMIT(current), dirty: false, stamped }),
    bring: async (role, mineOf) => { calls.bring.push({ role, ...mineOf() }); return { ok: true, note: null }; },
    waitFor: async (version, ms, commit) => { calls.waitFor.push({ version, commit }); return healthy || calls.waitFor.length > 1 ? { version } : null; },
    restore: async o => { calls.restore.push(o); return { restored: ["vyre.db"] }; },
    stop: async () => { calls.stop++; return { ok: true, wasRunning: true }; },
    call: async (tool, input) => { calls.tools.push({ tool, input }); return tips ? { data: { tips } } : { error: { code: "no_tool" } }; },
    io: { tty, ask: async q => { calls.asked.push(q); return answerQueue.shift() ?? ""; } },
    window: 1000, key: spki(KEYS.publicKey),
  };
  const installs = () => { try { return fs.readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
  const text = () => lines.slice(from).join("\n");
  return { home, deps, calls, lines, json, installs, text, served };
}

test("update --check: exit 0 when current, 1 when an update waits, and one line of JSON", async t => {
  const w = await world(t, { versions: ["0.1.0", "0.2.0", "0.3.0-beta.1"] });
  setJson(true);
  assert.equal(await update(["--check", "--json"], w.deps), 1);
  assert.deepEqual(w.json.pop(), { current: "0.1.0", latest: "0.2.0", channel: "stable" });
  assert.equal(await update(["--check", "--channel", "beta", "--json"], w.deps), 1);
  assert.deepEqual(w.json.pop(), { current: "0.1.0", latest: "0.3.0-beta.1", channel: "beta" });
  // The channel comes from config when no flag names one.
  config.save({ update: { channel: "beta" } });
  assert.equal(await update(["--check", "--json"], w.deps), 1);
  assert.equal(w.json.pop().channel, "beta");
  setJson(false);
  assert.deepEqual(w.installs(), [], "a check installs nothing");

  const cur = await world(t, { current: "0.2.0", versions: ["0.1.0", "0.2.0", "0.3.0-beta.1"] });
  assert.equal(await update(["--check"], cur.deps), 0);
  assert.match(cur.text(), /0\.2\.0 is the newest stable release/);
  assert.equal(await update(["--check", "--channel", "beta"], cur.deps), 1);
  assert.match(cur.text(), /0\.3\.0-beta\.1 is out on beta/);
  assert.match(cur.text(), /what 0\.3\.0-beta\.1 changed/, "the changelog is shown");
  assert.equal(await update(["--check", "--channel", "nightly"], cur.deps), 2);
});

test("update: a checksum mismatch refuses before anything is backed up or installed", async t => {
  const w = await world(t, { serve: p => p === "/dl/v0.2.0/vyre.tgz" ? Buffer.from("not the tarball Harlow Legal was sent") : undefined });
  assert.equal(await update(["--yes"], w.deps), 1);
  assert.match(w.text(), /checksum mismatch for vyre\.tgz .*; nothing was installed/);
  assert.deepEqual(w.installs(), []);
  assert.ok(!fs.existsSync(path.join(w.home, "releases", "0.2.0")), "the bad download is not kept");
  assert.ok(!fs.existsSync(path.join(w.home, "backups")), "no backup was taken");
  assert.equal(w.calls.bring.length, 0);
});

test("update: a SHA256SUMS that is an HTML page refuses", async t => {
  const w = await world(t, { serve: p => p === "/dl/v0.2.0/SHA256SUMS" ? "<!doctype html>\n<html><body>Sign in to GitHub</body></html>\n" : undefined });
  assert.equal(await update(["--yes"], w.deps), 1);
  assert.match(w.text(), /SHA256SUMS is not a checksum list; nothing was installed/);
  assert.deepEqual(w.installs(), []);
  assert.ok(!w.served.includes("/dl/v0.2.0/vyre.tgz"), "the tarball is never fetched");
});

test("update: below min_from it refuses and names the release to step through", async t => {
  const w = await world(t, { versions: ["0.1.0", "0.2.0", "0.3.0"], minFrom: { "0.3.0": "0.2.0" } });
  setJson(true);
  assert.equal(await update(["--yes", "--json"], w.deps), 1);
  const e = w.json.pop().error;
  assert.equal(e.code, "min_from");
  assert.match(e.message, /0\.3\.0 updates only from 0\.2\.0 or newer, and this is 0\.1\.0/);
  assert.equal(e.next, "vyre update --to 0.2.0 first, then vyre update");
  assert.deepEqual(w.installs(), []);
  // Stepping through works.
  assert.equal(await update(["--yes", "--to", "0.2.0", "--json"], w.deps), 0);
  assert.equal(w.json.pop().to, "0.2.0");
});

test("update: installs, restarts through bring, waits for health, and keeps two releases", async t => {
  const w = await world(t, { versions: ["0.1.0", "0.2.0"] });
  keep(w.home, "0.0.8");
  keep(w.home, "0.0.9");
  assert.equal(await update(["--yes"], w.deps), 0, w.text());
  const tgz = path.join(w.home, "releases", "0.2.0", "vyre.tgz");
  assert.deepEqual(w.installs(), [`install -g ${tgz}`]);
  assert.deepEqual(w.calls.bring, [{ role: "local", version: "0.2.0", commit: COMMIT("0.2.0"), dirty: false, stamped: true }]);
  assert.deepEqual(w.calls.waitFor, [{ version: "0.2.0", commit: COMMIT("0.2.0") }]);
  assert.ok(fs.existsSync(path.join(w.home, "backups", "pre-0.2.0", "vyre-backup.tar.gz")), "backed up first");
  assert.deepEqual(fs.readdirSync(path.join(w.home, "releases")).sort(), ["0.1.0", "0.2.0"], "the running tarball is kept, older ones go");
  assert.ok(fs.existsSync(path.join(w.home, "releases", "0.1.0", "vyre.tgz")));
  assert.equal(w.calls.restore.length, 0, "a healthy update never restores data");
  assert.match(w.text(), /what 0\.2\.0 changed/);
  assert.match(w.text(), /updated.*0\.1\.0 → 0\.2\.0/);
});

test("update: after a healthy update it prints up to five New lines from tips.whatsnew; no tips module is fine", async t => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, since: "0.2.0", text: `tip ${i} for alex` }));
  const w = await world(t, { tips: many });
  assert.equal(await update(["--yes"], w.deps), 0, w.text());
  assert.deepEqual(w.calls.tools, [{ tool: "tips.whatsnew", input: { since: "0.1.0" } }]);
  assert.equal((w.text().match(/New in 0\.2\.0/g) || []).length, 5);
  const off = await world(t);
  assert.equal(await update(["--yes"], off.deps), 0, off.text());
  assert.doesNotMatch(off.text(), /New in/);
});

test("update: prune keeps the two newest and the running one", t => {
  const home = tempHome(t);
  for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) fs.mkdirSync(path.join(home, "releases", v), { recursive: true });
  fs.mkdirSync(path.join(home, "releases", "notes"));
  assert.deepEqual(prune(home, "0.1.0").sort(), ["0.2.0"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "releases")).sort(), ["0.1.0", "0.3.0", "0.4.0", "notes"]);
});

test("update: when health fails inside the window, the previous tarball and the backup go back", async t => {
  const w = await world(t, { healthy: false });
  assert.equal(await update(["--yes"], w.deps), 1);
  const dir = v => path.join(w.home, "releases", v, "vyre.tgz");
  assert.deepEqual(w.installs(), [`install -g ${dir("0.2.0")}`, `install -g ${dir("0.1.0")}`]);
  assert.equal(w.calls.stop, 1, "vyred is stopped before the restore");
  assert.equal(w.calls.restore.length, 1);
  assert.equal(w.calls.restore[0].file, path.join(w.home, "backups", "pre-0.2.0", "vyre-backup.tar.gz"));
  assert.equal(w.calls.restore[0].force, true);
  assert.deepEqual(w.calls.bring.map(b => b.version), ["0.2.0", "0.1.0"]);
  assert.match(w.text(), /the update to 0\.2\.0 failed: vyred did not report 0\.2\.0.*Rolled back: reinstalled 0\.1\.0, restored the backup, restarted vyred/);
  assert.ok(!fs.existsSync(path.join(w.home, "releases", "0.2.0")), "the failed release is not kept, so --rollback never picks it");
});

test("update: a failed npm install puts the old code back and leaves the data alone", async t => {
  const w = await world(t);
  fs.writeFileSync(path.join(w.home, "npm.fail"), "0.2.0");
  assert.equal(await update(["--yes"], w.deps), 1);
  assert.equal(w.installs().length, 2);
  assert.equal(w.calls.restore.length, 0, "vyred never ran the new code, so the store is untouched");
  assert.match(w.text(), /npm install failed: npm exited 1: npm ERR! boom/);
});

test("update: with no terminal and no --yes it asks for --yes and changes nothing", async t => {
  const w = await world(t);
  assert.equal(await update([], w.deps), 2);
  assert.match(w.text(), /needs --yes/);
  assert.deepEqual(w.installs(), []);
  const tty = await world(t, { tty: true, answers: ["n"] });
  assert.equal(await update([], tty.deps), 1);
  assert.match(tty.calls.asked[0], /Update to 0\.2\.0 now\?/);
  assert.deepEqual(tty.installs(), []);
});

test("update --rollback: the previous release goes back and the data stays", async t => {
  const w = await world(t, { current: "0.2.0" });
  keep(w.home, "0.1.0");
  keep(w.home, "0.2.0");
  assert.equal(await update(["--rollback"], w.deps), 0, w.text());
  assert.deepEqual(w.installs(), [`install -g ${path.join(w.home, "releases", "0.1.0", "vyre.tgz")}`]);
  assert.equal(w.calls.restore.length, 0);
  assert.equal(w.calls.stop, 0);
  assert.deepEqual(w.calls.bring.map(b => b.version), ["0.1.0"]);
  assert.deepEqual(w.calls.asked, [], "no prompt: the person typed the command");
  assert.match(w.text(), /rolled back.*0\.2\.0 → 0\.1\.0.*kept the current data/);
});

test("update --rollback: a kept tarball that no longer matches its SHA256SUMS is refused", async t => {
  const w = await world(t, { current: "0.2.0" });
  fs.writeFileSync(path.join(keep(w.home, "0.1.0"), "vyre.tgz"), "changed");
  assert.equal(await update(["--rollback"], w.deps), 1);
  assert.match(w.text(), /does not check out: checksum mismatch/);
  assert.deepEqual(w.installs(), []);
});

test("update --rollback --restore-data says what it drops and needs a typed confirm or --yes", async t => {
  const setup = async o => {
    const w = await world(t, { current: "0.2.0", ...o });
    keep(w.home, "0.1.0");
    const file = path.join(w.home, "backups", "pre-0.2.0", "vyre-backup.tar.gz");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "backup");
    // R8: a real backup always has its passphrase's key file beside it (update.js writes one at
    // the same moment it makes the backup); rollback --restore-data reads it back.
    fs.writeFileSync(file + ".key", "a-fake-key-for-this-test-fixture");
    fs.utimesSync(file, new Date("2026-09-20T08:30:00Z"), new Date("2026-09-20T08:30:00Z"));
    return { w, file };
  };
  // No terminal, no --yes: refused, nothing changes.
  const a = await setup({});
  assert.equal(await update(["--rollback", "--restore-data"], a.w.deps), 2);
  assert.match(a.w.text(), /puts back the data from 2026-09-20 08:30 UTC.*drops everything written since then; add --yes/);
  assert.deepEqual(a.w.installs(), []);
  assert.equal(a.w.calls.restore.length, 0);
  // --json without --yes: the same refusal, as an error object.
  setJson(true);
  assert.equal(await update(["--rollback", "--restore-data", "--json"], a.w.deps), 2);
  assert.equal(a.w.json.pop().error.code, "needs_yes");
  setJson(false);
  // A terminal and the wrong word: nothing changes.
  const b = await setup({ tty: true, answers: ["yes"] });
  assert.equal(await update(["--rollback", "--restore-data"], b.w.deps), 1);
  assert.match(b.w.calls.asked[0], /Type restore/);
  assert.equal(b.w.calls.restore.length, 0);
  assert.deepEqual(b.w.installs(), []);
  // The typed word: the old release and the old data both go back.
  const c = await setup({ tty: true, answers: ["restore"] });
  assert.equal(await update(["--rollback", "--restore-data"], c.w.deps), 0, c.w.text());
  assert.deepEqual(c.w.calls.restore.map(r => [r.file, r.force]), [[c.file, true]]);
  assert.equal(c.w.calls.stop, 1);
  // --yes with --json: no question.
  const d = await setup({});
  setJson(true);
  assert.equal(await update(["--rollback", "--restore-data", "--yes", "--json"], d.w.deps), 0);
  assert.deepEqual(d.w.json.pop(), { rolledBack: true, from: "0.2.0", to: "0.1.0", restoredData: true, backup: d.file });
  setJson(false);
  // --restore-data alone is a usage mistake.
  assert.equal(await update(["--restore-data"], d.w.deps), 2);
});

test("update: a checkout refuses and points at git; so does the box's container", async t => {
  const w = await world(t, { stamped: false });
  assert.equal(await update(["--check"], w.deps), 1);
  assert.match(w.text(), /this vyre runs from a checkout; update it with git/);
  const g = await world(t);
  fs.mkdirSync(path.join(g.home, ".git"));
  assert.equal(await update(["--yes"], g.deps), 1);
  assert.match(g.text(), /runs from a checkout/);
  assert.deepEqual(g.installs(), []);
  const box = await world(t);
  assert.equal(await update(["--yes"], { ...box.deps, supervisor: "docker" }), 1);
  assert.match(box.text(), /the server's own vyre update does this/);
  assert.deepEqual(box.served, [], "nothing was fetched");
});

test("update: after a healthy update the release's SHA256SUMS, signature and shell.json go into the installed package's deck/release, and never into a checkout", t => {
  const home = tempHome(t);
  const dir = path.join(home, "rel"), pkg = path.join(home, "pkg"), checkout = path.join(home, "co");
  for (const d of [dir, pkg, checkout]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(checkout, ".git"));
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), "sums\n");
  fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), "sig\n");
  publishRelease(dir, pkg);
  const to = path.join(pkg, "deck", "release");
  assert.deepEqual(fs.readdirSync(to).sort(), ["SHA256SUMS", "SHA256SUMS.sig"], "only what the release has, and no temp file");
  assert.equal(fs.readFileSync(path.join(to, "SHA256SUMS.sig"), "utf8"), "sig\n");
  publishRelease(dir, checkout);
  assert.ok(!fs.existsSync(path.join(checkout, "deck")), "a git checkout is left alone");
});

test("update: an unsigned release, or one signed by another key, is refused before anything is downloaded; --allow-unsigned installs it with a warning", async t => {
  const none = await world(t, { sign: null });
  assert.equal(await update(["--yes"], none.deps), 1);
  assert.match(none.text(), /this release is not signed; nothing was installed/);
  assert.deepEqual(none.installs(), []);
  assert.ok(!none.served.some(p => p.endsWith("/vyre.tgz")), "the tarball was never fetched");
  const bad = await world(t, { sign: OTHER.privateKey });
  assert.equal(await update(["--yes"], bad.deps), 1);
  assert.match(bad.text(), /signature does not match Vyre's release key; nothing was installed/);
  assert.deepEqual(bad.installs(), []);
  // The override is explicit, and says what it means.
  const over = await world(t, { sign: null });
  assert.equal(await update(["--yes", "--allow-unsigned"], over.deps), 0, over.text());
  assert.match(over.text(), /WARNING: this release is not signed\. Installing it anyway because you passed --allow-unsigned/);
  assert.equal(over.installs().length, 1);
  // A signed one shows the check.
  const ok = await world(t);
  assert.equal(await update(["--yes"], ok.deps), 0, ok.text());
  assert.match(ok.text(), /Release signature checked\./);
});

test("update: only a release whose signature verified is published for the phone's shell check; --allow-unsigned installs and stops there", async t => {
  const signed = await world(t);
  const pkg = path.join(signed.home, "pkg");
  fs.mkdirSync(pkg);
  assert.equal(await update(["--yes"], { ...signed.deps, pkg }), 0, signed.text());
  assert.deepEqual(fs.readdirSync(path.join(pkg, "deck", "release")).sort(), ["SHA256SUMS", "SHA256SUMS.sig"]);
  const unsigned = await world(t, { sign: null });
  const pkg2 = path.join(unsigned.home, "pkg");
  fs.mkdirSync(pkg2);
  assert.equal(await update(["--yes", "--allow-unsigned"], { ...unsigned.deps, pkg: pkg2 }), 0, unsigned.text());
  assert.ok(!fs.existsSync(path.join(pkg2, "deck")), "an unsigned release is installed but nothing of it is published");
});
