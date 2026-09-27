// @ts-check
// `vyre update` on the box (box/vyre, ADR 0033 section 4), run with sh against a temp VYRE_DIR.
// docker is a fake on PATH that keeps its images as files, runs the wrapper's in-container shell
// lines against a folder standing in for the container, and records every call. Releases come
// from a local HTTP server shaped like the GitHub Releases API and its downloads, and the site
// (VYRE_BOX_URL) is the same server. No real docker, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_SRC = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
const COMPOSE = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
const CHOME = "/home/vyre/.vyre";
const APK = "android-0.2.0-abc1234.apk";
const sha = (/** @type {Buffer|string} */ b) => crypto.createHash("sha256").update(b).digest("hex");

// The fake docker. State lives in FAKE: images/<tag> holds an image id, running the id the vyre
// container runs, ctr/ the container's filesystem, calls one line per invocation.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const F = process.env.FAKE, args = process.argv.slice(2);
fs.appendFileSync(F + "/calls", args.join(" ") + "\\n");
const img = t => path.join(F, "images", t.replace(/[/:]/g, "_"));
const has = t => fs.existsSync(img(t));
const ctr = p => p.startsWith("/") ? path.join(F, "ctr", p) : p;
const db = path.join(F, "ctr", "${CHOME}", "vyre.db");
const running = () => { try { return fs.readFileSync(F + "/running", "utf8"); } catch { return ""; } };
const bad = () => { try { return fs.readFileSync(F + "/bad", "utf8").split("\\n").filter(Boolean); } catch { return []; } };
const count = n => { const f = F + "/" + n; const c = (Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : 0)) + 1; fs.writeFileSync(f, String(c)); return c; };
const target = () => fs.readFileSync(process.env.VYRE_DIR + "/.env", "utf8").includes("compose.build.yml") ? "vyre:local" : "ghcr.io/vyre-ai/vyre:latest";
function vyre(cmd) {
  const [c, a] = cmd;
  if (c === "status") process.exit(running() && !bad().includes(running()) ? 0 : 1);
  if (c === "version") { process.stdout.write((fs.existsSync(F + "/cur") ? fs.readFileSync(F + "/cur", "utf8") : "0.1.0") + "\\n"); process.exit(0); }
  if (c === "backup") { fs.copyFileSync(db, ctr(a)); process.exit(0); }
  if (c === "restore") { fs.copyFileSync(ctr(a), db); process.exit(0); }
  if (c === "call" && a === "releases.sign") {
    if (fs.existsSync(F + "/sign-error")) { console.log("  release_mismatch: the unsigned file does not match android.json"); process.exit(1); }
    console.log("{}"); process.exit(0);
  }
  if (c === "up") { console.log("  your address: https://alex.vyre.run"); process.exit(0); }
  process.exit(0);
}
if (args[0] === "image") {
  const [, op, a, b] = args;
  if (op === "inspect") process.exit(has(a) ? 0 : 1);
  if (op === "tag") { if (!has(a)) process.exit(1); fs.copyFileSync(img(a), img(b)); process.exit(0); }
  if (op === "rm") { fs.rmSync(img(a), { force: true }); process.exit(0); }
}
if (args[0] === "compose") {
  const sub = args[1];
  if (sub === "build") { if (fs.existsSync(F + "/build-fail")) process.exit(1); fs.writeFileSync(img("vyre:local"), "built-" + count("builds")); process.exit(0); }
  if (sub === "pull") { fs.writeFileSync(img(target()), "pulled-" + count("pulls")); process.exit(0); }
  if (sub === "up") {
    const id = fs.readFileSync(img(target()), "utf8");
    fs.writeFileSync(F + "/running", id);
    // A new image migrates the store on start, which only a restore undoes.
    if (id !== "orig") fs.writeFileSync(db, "migrated");
    process.exit(0);
  }
  if (sub === "stop") { fs.rmSync(F + "/running", { force: true }); process.exit(0); }
  if (sub === "exec" || sub === "run") {
    let i = 2;
    while (i < args.length && args[i].startsWith("-")) { i += ["-u", "-e"].includes(args[i]) ? 2 : 1; }
    const cmd = args.slice(i + 1);
    if (sub === "exec" && !running()) process.exit(1);
    if (cmd[0] === "sh" && cmd[1] === "-c") {
      const r = spawnSync("sh", ["-c", cmd[2], cmd[3], ...cmd.slice(4).map(ctr)], { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    if (cmd[0] === "vyre") vyre(cmd.slice(1));
  }
  process.exit(0);
}
process.exit(0);
`;

/** Release assets as files in a folder, with SHA256SUMS over them. */
function release(dir, version, { android = false, corrupt = "" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, ".pkg", "package");
  fs.mkdirSync(path.join(pkg, "box"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "box", "Dockerfile"), "FROM node:22-bookworm-slim\n");
  fs.writeFileSync(path.join(pkg, "marker"), version + "\n");
  assert.equal(spawnSync("tar", ["-czf", path.join(dir, "vyre.tgz"), "-C", path.join(dir, ".pkg"), "package"]).status, 0);
  fs.rmSync(path.join(dir, ".pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "compose.yml"), COMPOSE + `# release ${version}\n`);
  fs.writeFileSync(path.join(dir, "compose.build.yml"), `# compose.build.yml ${version}\n`);
  fs.writeFileSync(path.join(dir, "vyre.env.example"), `# vyre.env.example ${version}\n`);
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:22-bookworm-slim\n");
  fs.writeFileSync(path.join(dir, "dockerignore"), "test\n");
  fs.writeFileSync(path.join(dir, "vyre"), WRAPPER_SRC + `# release ${version}\n`);
  fs.writeFileSync(path.join(dir, "VERSION"), version + "\n");
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version, channel: "stable", commit: "abc1234", date: "2026-09-27T00:00:00Z", min_from: "0.1.0", notes: "Northwind Bakery's \"fix\"" }, null, 2));
  if (android) {
    const apk = Buffer.concat([Buffer.from("PK"), crypto.randomBytes(2048)]);
    fs.writeFileSync(path.join(dir, APK), apk);
    fs.writeFileSync(path.join(dir, "android.json"), JSON.stringify({ version, versionCode: 20, sha: "abc1234", sha256: sha(apk), size: apk.length, minSdk: 26, built: "2026-09-27T00:00:00Z", file: APK }, null, 2));
  }
  const names = fs.readdirSync(dir).filter(n => n !== "SHA256SUMS").sort();
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), names.map(n => `${sha(fs.readFileSync(path.join(dir, n)))}  ${n}\n`).join(""));
  if (corrupt) fs.appendFileSync(path.join(dir, corrupt), "tampered");
  return names;
}

/** A GitHub Releases API entry, with the fields around the ones the wrapper reads. */
function apiEntry(base, tag, prerelease, names) {
  return {
    url: `${base}/api/repos/vyre-ai/vyre/releases/1`, id: 1, author: { login: "alex", url: `${base}/api/users/alex` },
    tag_name: tag, target_commitish: "main", name: `Vyre ${tag}`, draft: false, prerelease,
    created_at: "2026-09-27T00:00:00Z",
    assets: [...names, "SHA256SUMS"].map(n => ({ name: n, uploader: { login: "kit" }, browser_download_url: `${base}/dl/${tag}/${n}` })),
    body: "Harlow Legal asked for \"prerelease\": true in the notes, which is not a key.",
  };
}

async function box(t, { site = "0.1.5", releases = [], build = true } = {}) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "bu-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const FAKE = path.join(root, "fake"), DIR = path.join(root, "srv"), DL = path.join(root, "dl");
  for (const d of ["bin", "images", `ctr${CHOME}`]) fs.mkdirSync(path.join(FAKE, d), { recursive: true });
  fs.writeFileSync(path.join(FAKE, "bin", "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(FAKE, "images", build ? "vyre_local" : "ghcr.io_vyre-ai_vyre_latest"), "orig");
  fs.writeFileSync(path.join(FAKE, "running"), "orig");
  fs.writeFileSync(path.join(FAKE, `ctr${CHOME}`, "vyre.db"), "v1");
  fs.mkdirSync(path.join(DIR, "src", "box"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "src", "box", "Dockerfile"), "FROM node:22-bookworm-slim\n");
  fs.writeFileSync(path.join(DIR, "src", "marker"), "old\n");
  fs.writeFileSync(path.join(DIR, "compose.yml"), COMPOSE);
  fs.writeFileSync(path.join(DIR, "compose.build.yml"), "# old\n");
  fs.writeFileSync(path.join(DIR, "vyre.env.example"), "# old\n");
  const env = build
    ? `COMPOSE_PROJECT_NAME=vyre\nCOMPOSE_FILE=compose.yml:compose.build.yml\nVYRE_SOURCE=${DIR}/src\nTS_AUTHKEY=tskey-northwind\n`
    : "COMPOSE_PROJECT_NAME=vyre\nCOMPOSE_FILE=compose.yml\n";
  fs.writeFileSync(path.join(DIR, ".env"), env, { mode: 0o600 });
  const WRAPPER = path.join(root, "bin", "vyre");
  fs.mkdirSync(path.dirname(WRAPPER));
  fs.writeFileSync(WRAPPER, WRAPPER_SRC, { mode: 0o755 });

  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url || "/", "http://x");
    if (u.pathname === "/api/repos/vyre-ai/vyre/releases") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(api, null, 2));
    }
    const m = /^\/(dl\/[^/]+|site)\/([^/]+)$/.exec(u.pathname);
    const file = m && path.join(DL, m[1], m[2]);
    if (file && fs.existsSync(file)) return res.end(fs.readFileSync(file));
    res.statusCode = 404; res.end("not here");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(null)));
  t.after(() => new Promise(r => server.close(() => r(null))));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  if (site) release(path.join(DL, "site"), site);
  const api = releases.map(r => apiEntry(base, r.tag, Boolean(r.pre), release(path.join(DL, "dl", r.tag), r.tag.slice(1), r)));

  /** Run the wrapper with sh; stdin is a pipe, never a terminal. */
  const run = (/** @type {string[]} */ args, /** @type {Record<string,string>} */ extra = {}) => new Promise(resolve => {
    const c = spawn("sh", [WRAPPER, ...args], {
      env: { PATH: `${FAKE}/bin:${process.env.PATH}`, HOME: root, TMPDIR: SCRATCH, FAKE, VYRE_DIR: DIR, VYRE_WRAPPER: WRAPPER,
        VYRE_UPDATE_WAIT: "2", VYRE_RELEASES_API: `${base}/api`, VYRE_BOX_URL: `${base}/site/`, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", d => { out += d; });
    c.stderr.on("data", d => { out += d; });
    c.stdin.end();
    c.on("close", code => resolve({ code, out }));
  });
  const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");
  return {
    DIR, FAKE, DL, WRAPPER, hits, run, read, env,
    calls: () => fs.existsSync(path.join(FAKE, "calls")) ? read(path.join(FAKE, "calls")).split("\n").filter(Boolean) : [],
    image: (/** @type {string} */ tag) => { try { return read(path.join(FAKE, "images", tag.replace(/[/:]/g, "_"))); } catch { return ""; } },
    db: () => read(path.join(FAKE, `ctr${CHOME}`, "vyre.db")),
    rel: (/** @type {string} */ f) => path.join(FAKE, `ctr${CHOME}`, "releases", "android", f),
  };
}

const STABLE_AND_BETA = [{ tag: "v0.3.0-beta.1", pre: true }, { tag: "v0.2.0", android: true }];

test("box update: with no release on GitHub it falls back to VYRE_BOX_URL, as before", async t => {
  const b = await box(t, { releases: [] });
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no stable release on GitHub yet/);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.1.5");
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "0.1.5");
  assert.ok(b.hits.some(h => h.startsWith("/api/")), "asked GitHub first");
  assert.ok(b.hits.includes("/site/vyre.tgz"));
  assert.ok(b.calls().includes("compose build --pull"));
  assert.match(r.out, /your address: https:\/\/alex\.vyre\.run/);
});

test("box update: VYRE_BOX_URL alone means that site, and GitHub is never asked", async t => {
  const b = await box(t, { releases: STABLE_AND_BETA });
  const r = /** @type {any} */ (await b.run(["update"], { VYRE_RELEASES_API: "" }));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.1.5");
  assert.ok(!b.hits.some(h => h.startsWith("/api/")));
});

test("box update: stable takes the newest non-prerelease, beta the newest of any", async t => {
  const b = await box(t, { releases: STABLE_AND_BETA });
  let r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /release v0\.2\.0 \(stable\)/);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.2.0");
  assert.ok(b.hits.includes("/dl/v0.2.0/vyre.tgz"));
  r = /** @type {any} */ (await b.run(["update", "--channel", "beta"]));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.3.0-beta.1");
  r = /** @type {any} */ (await b.run(["update"], { VYRE_CHANNEL: "beta" }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /v0\.3\.0-beta\.1 \(beta\)/);
  assert.equal((/** @type {any} */ (await b.run(["update", "--channel", "nightly"]))).code, 1);
});

test("box update: a checksum mismatch stops before src, the backup or the image are touched", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", corrupt: "vyre.tgz" }] });
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 1);
  assert.match(r.out, /checksum mismatch for .*vyre\.tgz/);
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.ok(!fs.existsSync(path.join(b.DIR, "src.new")) && !fs.existsSync(path.join(b.DIR, "src.prev")));
  assert.ok(!b.calls().some(c => /backup|build|image tag/.test(c)), b.calls().join("\n"));
  assert.equal(b.read(path.join(b.DIR, "compose.build.yml")), "# old\n");
});

test("box update: a healthy update keeps src.prev, tags vyre:prev, refreshes the box files and the wrapper, never .env, never restores", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.read(path.join(b.DIR, ".env")), b.env);
  assert.equal(b.read(path.join(b.DIR, "src.prev", "marker")).trim(), "old");
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "0.2.0");
  assert.equal(b.read(path.join(b.DIR, "src", ".dockerignore")), "test\n");
  assert.equal(b.image("vyre:prev"), "orig");
  assert.equal(b.image("vyre:local"), "built-1");
  assert.equal(b.read(path.join(b.DIR, "compose.build.yml")), "# compose.build.yml 0.2.0\n");
  assert.equal(b.read(path.join(b.DIR, "box.prev", "compose.build.yml")), "# old\n");
  assert.match(b.read(b.WRAPPER), /# release 0\.2\.0\n$/);
  assert.equal(b.read(path.join(b.DIR, "box.prev", "vyre")), WRAPPER_SRC);
  // The backup ran in the container before the build, and a copy sits on the host.
  const calls = b.calls();
  const backup = calls.findIndex(c => c.includes(`vyre backup ${CHOME}/backups/pre-0.2.0.tar.gz`));
  assert.ok(backup >= 0 && backup < calls.indexOf("compose build --pull"), calls.join("\n"));
  assert.equal(b.read(path.join(b.DIR, "backups", "pre-0.2.0.tar.gz")), "v1");
  assert.equal(fs.statSync(path.join(b.DIR, "backups", "pre-0.2.0.tar.gz")).mode & 0o777, 0o600);
  assert.ok(!calls.some(c => c.includes("restore")));
  assert.equal(b.db(), "migrated");
  assert.ok(!fs.existsSync(b.rel("android.json")), "a release without an Android build leaves the folder alone");
});

test("box update: vyred not healthy in the window rolls everything back, the database too, and exits 1", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  fs.writeFileSync(path.join(b.FAKE, "bad"), "built-1\n");
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /rolled back/);
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.equal(b.image("vyre:local"), "orig");
  assert.equal(b.read(path.join(b.DIR, "compose.build.yml")), "# old\n");
  assert.equal(b.db(), "v1", "the pre-update backup is back");
  assert.ok(b.calls().some(c => c.startsWith(`compose run --rm --no-deps -T vyre vyre restore ${CHOME}/backups/pre-0.2.0.tar.gz --force`)));
  assert.equal(b.read(b.WRAPPER), WRAPPER_SRC, "the wrapper is only replaced after a healthy update");
  assert.equal(b.read(path.join(b.FAKE, "running")), "orig");
});

test("box update: a build that fails puts the files back and restores nothing", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  fs.writeFileSync(path.join(b.FAKE, "build-fail"), "");
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 1);
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.equal(b.read(path.join(b.DIR, "compose.build.yml")), "# old\n");
  assert.ok(!b.calls().some(c => c.includes("restore") || c === "compose up -d"));
});

test("box update: the phone app goes in APK first, android.json last with .prev kept; a releases.sign refusal is reported, exit 0", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", android: true }] });
  fs.mkdirSync(path.dirname(b.rel("x")), { recursive: true });
  fs.writeFileSync(b.rel("android.json"), '{"version":"0.1.0"}');
  fs.writeFileSync(path.join(b.FAKE, "sign-error"), "");
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /releases\.sign did not sign the phone app: +release_mismatch/);
  assert.deepEqual(fs.readFileSync(b.rel(APK)), fs.readFileSync(path.join(b.DL, "dl", "v0.2.0", APK)));
  assert.equal(JSON.parse(b.read(b.rel("android.json"))).file, APK);
  assert.equal(b.read(b.rel("android.json.prev")), '{"version":"0.1.0"}');
  assert.ok(!fs.readdirSync(path.dirname(b.rel("x"))).some(f => f.startsWith(".")), "no temp names left");
  const calls = b.calls();
  const apk = calls.findIndex(c => c.includes("-u vyre vyre sh -c") && c.endsWith(APK));
  const man = calls.findIndex(c => c.includes("android.json.tmp"));
  const sign = calls.indexOf("compose exec -T vyre vyre call releases.sign");
  assert.ok(apk >= 0 && apk < man && man < sign, calls.join("\n"));
  // Then the report still runs, and the wrapper is still replaced.
  assert.match(r.out, /your address/);
  assert.match(b.read(b.WRAPPER), /# release 0\.2\.0/);
});

test("box update --rollback: the previous release back, the current database kept", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", android: true }] });
  fs.mkdirSync(path.dirname(b.rel("x")), { recursive: true });
  fs.writeFileSync(b.rel("android.json"), '{"version":"0.1.0"}');
  assert.equal((/** @type {any} */ (await b.run(["update"]))).code, 0);
  const r = /** @type {any} */ (await b.run(["update", "--rollback"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /the database is the current one/);
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.equal(b.read(path.join(b.DIR, "src.prev", "marker")).trim(), "0.2.0");
  assert.equal(b.image("vyre:local"), "orig");
  assert.equal(b.image("vyre:prev"), "built-1");
  assert.equal(b.image("vyre:next"), "");
  assert.equal(b.read(path.join(b.DIR, "compose.build.yml")), "# old\n");
  assert.equal(b.read(b.rel("android.json")), '{"version":"0.1.0"}');
  assert.equal(b.read(b.WRAPPER), WRAPPER_SRC);
  assert.equal(b.db(), "migrated");
  assert.ok(!b.calls().some(c => c.includes("restore")));
  assert.equal(b.read(path.join(b.DIR, ".env")), b.env);
});

test("box update --rollback --restore-data: off a terminal it needs --yes, then puts the old database back", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  assert.equal((/** @type {any} */ (await b.run(["update"]))).code, 0);
  let r = /** @type {any} */ (await b.run(["update", "--rollback", "--restore-data"]));
  assert.equal(r.code, 1);
  assert.match(r.out, /drops everything written since/);
  assert.match(r.out, /pass --yes/);
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "0.2.0", "nothing changed");
  assert.equal(b.db(), "migrated");
  r = /** @type {any} */ (await b.run(["update", "--rollback", "--restore-data", "--yes"]));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.db(), "v1");
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.equal((/** @type {any} */ (await b.run(["update", "--yes"]))).code, 1, "--yes goes with --rollback");
});

test("box update: a pulled image (no compose.build.yml) is tagged vyre:prev and pulled, src untouched", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }], build: false });
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 0, r.out);
  assert.ok(b.calls().includes("compose pull"));
  assert.equal(b.image("vyre:prev"), "orig");
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.ok(!b.hits.includes("/dl/v0.2.0/vyre.tgz"));
});

test("box update: a release whose min_from is above the running version names the step", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  fs.writeFileSync(path.join(b.FAKE, "cur"), "0.0.9");
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 1);
  assert.match(r.out, /runs 0\.0\.9, and 0\.2\.0 updates from 0\.1\.0 or newer: run vyre update --to 0\.1\.0 first/);
  assert.ok(!b.calls().some(c => c.includes("backup")));
});

test("box/vyre: shellcheck is clean, when shellcheck is installed", t => {
  const which = spawnSync("sh", ["-c", "command -v shellcheck"]);
  if (which.status !== 0) return t.skip("no shellcheck here");
  const r = spawnSync("shellcheck", ["-s", "sh", path.join(REPO, "box/vyre")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
