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
// Vyre's release key, for these tests: a key of their own, given to the wrapper as VYRE_RELEASE_KEY (test only). Every release
// is signed by it unless a test says sign: false, or another key.
const RELEASE = crypto.generateKeyPairSync("ed25519");
const OTHER = crypto.generateKeyPairSync("ed25519");
const spki = (/** @type {crypto.KeyObject} */ k) => k.export({ type: "spki", format: "der" }).toString("base64");
const KEY = { VYRE_RELEASE_KEY: spki(RELEASE.publicKey) };
/** The signed message: the domain-separation line, then the exact SHA256SUMS bytes. */
const signSums = (/** @type {Buffer} */ sums, /** @type {crypto.KeyObject} */ key) => crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), key).toString("base64") + "\n";
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
if (args[0] === "run") {
  // The signature check: Node in the image that runs now, with the release's SHA256SUMS on stdin.
  const i = args.indexOf("--entrypoint");
  if (i >= 0 && args[i + 1] === "node") { const r = spawnSync("node", args.slice(i + 3), { stdio: "inherit" }); process.exit(r.status ?? 1); }
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
function release(dir, version, { android = false, corrupt = "", sign = /** @type {any} */ (RELEASE.privateKey) } = {}) {
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
  // SHA256SUMS.sig: Ed25519 over the exact bytes of SHA256SUMS, base64. Not listed in SHA256SUMS itself.
  if (sign) fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(dir, "SHA256SUMS")), sign));
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
  const U = path.join(root, "uroot");
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
        VYRE_UPDATE_WAIT: "2", VYRE_RELEASES_API: `${base}/api`, VYRE_BOX_URL: `${base}/site/`, ...KEY, VYRE_UPDATE_MIN_GAP: "0", VYRE_UPDATE_ROOT: U, VYRE_ROOT_UID: String(process.getuid()), VYRE_CHAIN_TOP: root, ...extra },
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
    DIR, U, FAKE, DL, WRAPPER, hits, run, read, env,
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


// --- the automatic path: vyred's request file, run by a root path unit (vyre update-from-request) ---

const status = (/** @type {any} */ b) => JSON.parse(b.read(path.join(b.U, "status", "status.json")));
/** The unit's folders, made the way `vyre updater install` makes them (here "root" is the test's own account: VYRE_ROOT_UID). */
const units_dirs = (/** @type {any} */ b) => { for (const [d, m] of [["", 0o755], ["request", 0o700], ["status", 0o755], ["private", 0o700]]) { const f = path.join(b.U, d); fs.mkdirSync(f, { recursive: true }); fs.chmodSync(f, m); } };
const ask = (/** @type {any} */ b, text = "update\n") => { units_dirs(b); fs.writeFileSync(path.join(b.U, "request", "request"), text); };

test("update-from-request: a signed release is installed, the request is consumed, and the state file says from, to and ok", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  ask(b);
  const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /signature checked against Vyre's release key/);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.2.0");
  assert.ok(!fs.existsSync(path.join(b.U, "request", "request")), "the request is gone");
  assert.ok(!fs.existsSync(path.join(b.U, "private", "lock")), "the lock is released");
  assert.deepEqual([status(b).state, status(b).from, status(b).to], ["ok", "0.1.0", "0.2.0"]);
});

test("update-from-request: only the word update starts anything; a link or another word is dropped and nothing runs", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  ask(b, "update --to 0.0.1; rm -rf /\n");
  let r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(b.U, "request", "request")));
  // A link to somewhere else: not followed, removed, nothing runs.
  const secret = path.join(b.DIR, "secret.txt");
  fs.writeFileSync(secret, "update\n");
  fs.symlinkSync(secret, path.join(b.U, "request", "request"));
  r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(b.U, "request", "request")) && fs.readFileSync(secret, "utf8") === "update\n", "the link is removed, its target untouched");
  assert.equal(b.calls().length, 0, "no docker call at all: " + b.calls().join("\n"));
  assert.ok(!fs.existsSync(path.join(b.U, "status", "status.json")));
});

test("update-from-request: an unsigned release, or one signed by another key, installs nothing", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: false }] });
  ask(b);
  let r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 1);
  assert.match(r.out, /not signed, and an automatic update installs only signed releases/);
  assert.equal(status(b).state, "failed");
  assert.match(status(b).message, /not signed/);
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.ok(!b.calls().some(c => /backup|build|image tag/.test(c)));
  const w = await box(t, { releases: [{ tag: "v0.2.0", sign: OTHER.privateKey }] });
  ask(w);
  r = /** @type {any} */ (await w.run(["update-from-request"], KEY));
  assert.equal(r.code, 1);
  assert.match(r.out, /signature does not match Vyre's release key/);
  assert.equal(w.read(path.join(w.DIR, "src", "marker")).trim(), "old");
  // Run by hand, an unsigned or badly signed release is refused too, and only --allow-unsigned installs one, with a warning.
  const m = await box(t, { releases: [{ tag: "v0.2.0", sign: OTHER.privateKey }] });
  const bad = /** @type {any} */ (await m.run(["update"], KEY));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /signature does not match Vyre's release key; nothing was changed/);
  assert.match(bad.out, /--allow-unsigned/);
  assert.equal(m.read(path.join(m.DIR, "src", "marker")).trim(), "old");
  const u = await box(t, { releases: [{ tag: "v0.2.0", sign: false }] });
  const refused = /** @type {any} */ (await u.run(["update"], KEY));
  assert.equal(refused.code, 1);
  assert.match(refused.out, /this release is not signed; nothing was changed/);
  const hand = /** @type {any} */ (await u.run(["update", "--allow-unsigned"], KEY));
  assert.equal(hand.code, 0, hand.out);
  assert.match(hand.out, /WARNING: this release is not signed\. Installing it anyway because you passed --allow-unsigned/);
  // The override is a person's alone: the unit never passes it, and the request cannot.
  const auto = await box(t, { releases: [{ tag: "v0.2.0", sign: false }] });
  ask(auto);
  assert.equal(/** @type {any} */ ((await auto.run(["update-from-request"], KEY))).code, 1);
});

test("update-from-request: a vyred that does not come up rolls back and the state says rolled_back; it never goes back a version", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  fs.writeFileSync(path.join(b.FAKE, "bad"), "built-1\n");
  ask(b);
  const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 1, r.out);
  assert.equal(status(b).state, "rolled_back");
  assert.equal(b.db(), "v1", "the database is back");
  assert.ok(!fs.existsSync(path.join(b.U, "private", "lock")));
  // The backup's passphrase went in on stdin, and its key file is kept 0600 beside it.
  assert.ok(fs.statSync(path.join(b.U, "private", "backups", "pre-0.2.0.key")).mode % 0o1000 === 0o600);
  assert.ok(!b.calls().some(c => c.includes(fs.readFileSync(path.join(b.U, "private", "backups", "pre-0.2.0.key"), "utf8").trim())), "never in argv");
  const old = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  fs.writeFileSync(path.join(old.FAKE, "cur"), "0.3.0");
  ask(old);
  const back = /** @type {any} */ (await old.run(["update-from-request"], KEY));
  assert.equal(back.code, 1);
  assert.match(back.out, /never goes back/);
  assert.ok(!old.calls().some(c => c.includes("backup")));
});

test("update-from-request: a second request while one runs waits for the next; the channel is the host's own", async t => {
  const b = await box(t, { releases: [{ tag: "v0.3.0-beta.1", pre: true, sign: RELEASE.privateKey }, { tag: "v0.2.0", sign: RELEASE.privateKey }] });
  fs.mkdirSync(path.join(b.U, "private", "lock"), { recursive: true });
  ask(b);
  const busy = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(busy.code, 0);
  assert.match(busy.out, /already running/);
  assert.equal(b.calls().length, 0);
  fs.rmdirSync(path.join(b.U, "private", "lock"));
  // The unit picks the channel from the host's .env; vyred's request cannot.
  fs.appendFileSync(path.join(b.DIR, ".env"), "VYRE_CHANNEL=beta\n");
  ask(b);
  const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.3.0-beta.1");
});

test("vyre updater install: writes a path unit watching vyred's request file and a service that runs update-from-request, and enables it", async t => {
  const b = await box(t, { releases: [] });
  const units = path.join(b.DIR, "units");
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(b.FAKE, "bin", "systemctl"), `#!/bin/sh\necho "$@" >>"$FAKE/systemctl"\n`, { mode: 0o755 });
  const r = /** @type {any} */ (await b.run(["updater", "install"], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()) }));
  assert.equal(r.code, 0, r.out);
  const path_ = fs.readFileSync(path.join(units, "vyre-update.path"), "utf8");
  assert.match(path_, new RegExp(`PathExists=${b.U}/request/request`));
  assert.match(path_, /Unit=vyre-update\.service/);
  const svc = fs.readFileSync(path.join(units, "vyre-update.service"), "utf8");
  assert.match(svc, new RegExp(`ExecStart=${b.WRAPPER} update-from-request`));
  assert.match(svc, /Type=oneshot/);
  assert.ok(!/(User|Group)=/.test(svc), "root's, so it can run docker");
  const ctl = fs.readFileSync(path.join(b.FAKE, "systemctl"), "utf8");
  assert.match(ctl, /daemon-reload/);
  assert.match(ctl, /enable --now vyre-update\.path/);
  assert.ok(fs.statSync(path.join(b.U, "status")).isDirectory());
  assert.equal(fs.readFileSync(path.join(b.U, "status", "ready"), "utf8"), "1\n", "vyred is told a unit will act");
  assert.match(/** @type {any} */ ((await b.run(["updater", "status"], { VYRE_SYSTEMD_DIR: units }))).out, /installed/);
  await b.run(["updater", "remove"], { VYRE_SYSTEMD_DIR: units });
  assert.ok(!fs.existsSync(path.join(units, "vyre-update.path")));
  assert.ok(!fs.existsSync(path.join(b.U, "status", "ready")));
});

test("vyre updater remove: units a person cannot write are removed through sudo, and when that fails the command says plainly they remain", { skip: process.getuid() === 0 }, async t => {
  const b = await box(t, { releases: [] });
  const units = path.join(b.DIR, "units");
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(units, "vyre-update.path"), "x");
  fs.writeFileSync(path.join(units, "vyre-update.service"), "x");
  fs.chmodSync(units, 0o555);
  fs.writeFileSync(path.join(b.FAKE, "bin", "sudo"), `#!/bin/sh\necho "$@" >>"$FAKE/sudo"\nexit 1\n`, { mode: 0o755 });
  let r;
  try { r = /** @type {any} */ (await b.run(["updater", "remove"], { VYRE_SYSTEMD_DIR: units })); } finally { fs.chmodSync(units, 0o755); }
  assert.notEqual(r.code, 0, `a failed removal is not a success: ${r.out}`);
  assert.match(r.out, /still on this server/, r.out);
  assert.match(r.out, /sudo .* updater remove/);
  assert.match(fs.readFileSync(path.join(b.FAKE, "sudo"), "utf8"), /updater remove/, "it asked for root");
  assert.ok(fs.existsSync(path.join(units, "vyre-update.path")), "nothing was claimed removed");
});

test("compose: vyred gets only its own request folder (writable) and the state folder read-only", () => {
  assert.match(COMPOSE, /- \$\{VYRE_UPDATE_ROOT:-\/var\/lib\/vyre-update\}\/request:\/run\/vyre-update\n/);
  assert.match(COMPOSE, /- \$\{VYRE_UPDATE_ROOT:-\/var\/lib\/vyre-update\}\/status:\/run\/vyre-update-state:ro\n/);
  assert.match(COMPOSE, /- \$\{VYRE_UPDATE_ROOT:-\/var\/lib\/vyre-update\}\/status\/release:\/opt\/vyre\/deck\/release:ro\n/, "the served release files are on the host, read-only");
  assert.ok(!/vyre-update\}\/private/.test(COMPOSE), "the private folder (floor, lock, backup keys) is never mounted");
  assert.ok(!/docker\.sock/.test(COMPOSE.split("docker-api:")[0]), "still no socket in the vyre service");
});

test("vyre updater install: refuses a wrapper or a folder that others could write, since the unit runs it as root", async t => {
  const b = await box(t, { releases: [] });
  const units = path.join(b.DIR, "units");
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(b.FAKE, "bin", "systemctl"), `#!/bin/sh\n:\n`, { mode: 0o755 });
  const env = { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()) };
  fs.chmodSync(b.WRAPPER, 0o775);
  let r = /** @type {any} */ (await b.run(["updater", "install"], env));
  assert.equal(r.code, 1);
  assert.match(r.out, /must not be writable by its group or others/);
  fs.chmodSync(b.WRAPPER, 0o755);
  fs.chmodSync(b.DIR, 0o777);
  r = /** @type {any} */ (await b.run(["updater", "install"], env));
  assert.equal(r.code, 1, r.out);
  fs.chmodSync(b.DIR, 0o755);
  // Owned by someone who is not root: the wrapper is refused.
  r = /** @type {any} */ (await b.run(["updater", "install"], { ...env, VYRE_ROOT_UID: "0" }));
  assert.equal(r.code, 1);
  assert.ok(!fs.existsSync(path.join(units, "vyre-update.path")), "nothing was written");
  r = /** @type {any} */ (await b.run(["updater", "install"], env));
  assert.equal(r.code, 0, r.out);
});

test("update-from-request: the no-downgrade floor is the host's own file, not what the container says; it rises after an update", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  // vyred lies low (it says it runs 0.0.5), but the host has had 0.3.0.
  fs.writeFileSync(path.join(b.FAKE, "cur"), "0.0.5");
  units_dirs(b);
  fs.writeFileSync(path.join(b.U, "private", "floor"), "0.3.0\n");
  ask(b);
  const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 1);
  assert.match(r.out, /the newest this server has had is 0\.3\.0; an automatic update never goes back/);
  assert.ok(!b.calls().some(c => c.includes("backup")));
  // With a lower floor the update goes ahead, and the floor becomes its version.
  fs.writeFileSync(path.join(b.U, "private", "floor"), "0.1.0\n");
  fs.writeFileSync(path.join(b.FAKE, "cur"), "0.1.0");
  ask(b);
  assert.equal(/** @type {any} */ ((await b.run(["update-from-request"], KEY))).code, 0);
  assert.equal(b.read(path.join(b.U, "private", "floor")).trim(), "0.2.0");
});

test("update-from-request: at least the minimum gap between updates, and only stable or beta from the host's .env", async t => {
  const b = await box(t, { releases: [{ tag: "v0.3.0-beta.1", pre: true }, { tag: "v0.2.0" }] });
  ask(b);
  let r = /** @type {any} */ (await b.run(["update-from-request"], { VYRE_UPDATE_MIN_GAP: "600" }));
  assert.equal(r.code, 0, r.out);
  assert.equal(status(b).state, "ok");
  const calls = b.calls().length;
  ask(b);
  r = /** @type {any} */ (await b.run(["update-from-request"], { VYRE_UPDATE_MIN_GAP: "600" }));
  assert.equal(r.code, 0);
  assert.match(r.out, /an update ran a moment ago/);
  assert.equal(status(b).state, "failed");
  assert.equal(status(b).stage, "too-soon");
  assert.equal(b.calls().length, calls, "nothing ran");
  assert.ok(!fs.existsSync(path.join(b.U, "private", "lock")));
  // A channel that is not stable or beta is ignored with a note, and stable is used.
  fs.appendFileSync(path.join(b.DIR, ".env"), "VYRE_CHANNEL=nightly; rm -rf /\n");
  ask(b);
  r = /** @type {any} */ (await b.run(["update-from-request"], {}));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not stable or beta; using stable/);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.2.0");
});

// One shared test vector for the release signature (also in anywhere's tests): a fixed key (seed 32 bytes of 0x07), a fixed
// SHA256SUMS, and the signature over "vyre-release-sums\n" + those exact bytes. Ed25519 is deterministic, so it is a constant.
const VECTOR = {
  key: "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  sums: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  manifest.json\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  vyre.tgz\n",
  sig: "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==",
};

test("release signature: the box verifies the shared vector, and refuses the same signature over the bare bytes", () => {
  const js = /-e '(const c=require\("crypto"\)[^']*)'/.exec(WRAPPER_SRC)?.[1];
  assert.ok(js, "the wrapper's verifier is found");
  const check = (/** @type {string} */ sums, /** @type {string} */ sig) => spawnSync("node", ["-e", /** @type {string} */ (js), VECTOR.key, sig], { input: sums, encoding: "utf8" }).stdout.trim();
  assert.equal(check(VECTOR.sums, VECTOR.sig), "signed");
  assert.equal(check(VECTOR.sums + "x", VECTOR.sig), "bad", "one more byte");
  const bare = crypto.sign(null, Buffer.from(VECTOR.sums), crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" })).toString("base64");
  assert.equal(check(VECTOR.sums, bare), "bad", "a signature without the prefix is refused");
});

test("update-from-request: a link planted in the person's stack folder or in root's floor file is replaced, never written through", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  const victim = path.join(b.DIR, "victim.txt");
  fs.writeFileSync(victim, "keep me\n");
  const victimDir = path.join(b.DIR, "victim-dir");
  fs.mkdirSync(victimDir);
  fs.writeFileSync(path.join(victimDir, "inside.txt"), "keep me too\n");
  // The stack folder is the person's: links where root will write.
  fs.symlinkSync(victim, path.join(b.DIR, "VERSION"));
  fs.symlinkSync(victimDir, path.join(b.DIR, "box.prev"));
  // A link to a FOLDER where a box file goes: mv would drop the new file into that folder, so it is removed first.
  fs.rmSync(path.join(b.DIR, "vyre.env.example"), { force: true });
  fs.symlinkSync(victimDir, path.join(b.DIR, "vyre.env.example"));
  fs.rmSync(path.join(b.DIR, "compose.build.yml"), { force: true });
  fs.symlinkSync(victim, path.join(b.DIR, "compose.build.yml"));
  ask(b);
  fs.symlinkSync(victim, path.join(b.U, "private", "floor"));
  const r = /** @type {any} */ (await b.run(["update-from-request"], {}));
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n", "nothing was written through a link");
  assert.equal(fs.readFileSync(path.join(victimDir, "inside.txt"), "utf8"), "keep me too\n");
  assert.deepEqual(fs.readdirSync(victimDir), ["inside.txt"], "no box file was copied into a folder a link pointed at");
  for (const f of [path.join(b.DIR, "vyre.env.example"), path.join(b.DIR, "VERSION"), path.join(b.DIR, "compose.build.yml"), path.join(b.U, "private", "floor")]) assert.ok(fs.lstatSync(f).isFile(), `${f} is a real file now`);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.2.0");
  assert.equal(b.read(path.join(b.U, "private", "floor")).trim(), "0.2.0");
  assert.ok(!fs.readdirSync(b.DIR).some(n => /\.[A-Za-z0-9]{6}$/.test(n)), "no temp file left behind: " + fs.readdirSync(b.DIR).join(" "));
});

test("update-from-request: root's folders must be root's alone: a link for status/, or a folder above that others can write, means no update starts", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  const elsewhere = path.join(b.DIR, "elsewhere");
  fs.mkdirSync(elsewhere);
  ask(b);
  fs.rmSync(path.join(b.U, "status"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(b.U, "status"));
  let r = /** @type {any} */ (await b.run(["update-from-request"], {}));
  assert.equal(r.code, 0);
  assert.match(r.out, /is not root's alone/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing written through the link");
  assert.equal(b.calls().length, 0);
  assert.ok(fs.existsSync(path.join(b.U, "request", "request")), "the request is left; nothing was read or removed");
  // A folder above that others can write (the person could rename root's folder away).
  fs.rmSync(path.join(b.U, "status"));
  fs.mkdirSync(path.join(b.U, "status"), { mode: 0o755 });
  fs.chmodSync(path.dirname(b.U), 0o777);
  r = /** @type {any} */ (await b.run(["update-from-request"], {}));
  fs.chmodSync(path.dirname(b.U), 0o755);
  assert.match(r.out, /is not root's alone/);
  assert.equal(b.calls().length, 0);
  // And once it is right again, the same request goes through.
  r = /** @type {any} */ (await b.run(["update-from-request"], {}));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.read(path.join(b.DIR, "VERSION")).trim(), "0.2.0");
});

test("update-from-request: the update's backup and its passphrase live in root's private folder, which is never mounted; a hand-run update keeps them in the stack folder", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  ask(b);
  assert.equal(/** @type {any} */ ((await b.run(["update-from-request"], {}))).code, 0);
  assert.ok(fs.existsSync(path.join(b.U, "private", "backups", "pre-0.2.0.key")));
  assert.equal(fs.statSync(path.join(b.U, "private", "backups", "pre-0.2.0.tar.gz")).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(b.DIR, "backups")), "nothing of it in the person's folder");
  assert.equal(fs.readdirSync(path.join(b.U, "status")).sort().join(), "release,status.json", "the mounted folder holds only the status and the published release files, never a key");
  const h = await box(t, { releases: [{ tag: "v0.2.0" }] });
  assert.equal(/** @type {any} */ ((await h.run(["update"], {}))).code, 0);
  assert.ok(fs.existsSync(path.join(h.DIR, "backups", "pre-0.2.0.key")));
});

test("box update: the release's SHA256SUMS, signature and shell.json are put in root's status/release, mounted at the install's deck/release, for the phone's shell check (pwa)", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  // shell.json is one more file of the release; it is listed in SHA256SUMS like the rest.
  const dl = path.join(b.DL, "dl", "v0.2.0");
  fs.writeFileSync(path.join(dl, "shell.json"), JSON.stringify({ "/deck/app.js": "abc" }));
  const names = fs.readdirSync(dl).filter(n => n !== "SHA256SUMS" && n !== "SHA256SUMS.sig").sort();
  fs.writeFileSync(path.join(dl, "SHA256SUMS"), names.map(n => `${sha(fs.readFileSync(path.join(dl, n)))}  ${n}\n`).join(""));
  fs.writeFileSync(path.join(dl, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(dl, "SHA256SUMS")), RELEASE.privateKey));
  const r = /** @type {any} */ (await b.run(["update"], {}));
  assert.equal(r.code, 0, r.out);
  const rel = path.join(b.U, "status", "release");
  assert.equal(fs.readFileSync(path.join(rel, "SHA256SUMS"), "utf8"), fs.readFileSync(path.join(dl, "SHA256SUMS"), "utf8"));
  assert.equal(fs.readFileSync(path.join(rel, "SHA256SUMS.sig"), "utf8"), fs.readFileSync(path.join(dl, "SHA256SUMS.sig"), "utf8"));
  assert.equal(fs.readFileSync(path.join(rel, "shell.json"), "utf8"), fs.readFileSync(path.join(dl, "shell.json"), "utf8"));
  assert.deepEqual(fs.readdirSync(rel).sort(), ["SHA256SUMS", "SHA256SUMS.sig", "shell.json"], "no temp file left");
  // A release without shell.json still updates; only what it has is put there.
  const p = await box(t, { releases: [{ tag: "v0.2.0" }] });
  assert.equal(/** @type {any} */ ((await p.run(["update"], {}))).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(p.U, "status", "release")).sort(), ["SHA256SUMS", "SHA256SUMS.sig"]);
});

test("publish-release: root copies without following links and publishes only when SHA256SUMS.sig verifies over the copy and shell.json is the listed file", async t => {
  const b = await box(t, { releases: [] });
  units_dirs(b);
  const src = path.join(b.DIR, "src-rel");
  fs.mkdirSync(src);
  const sums = Buffer.from(`${sha("shell")}  shell.json\n${sha("tgz")}  vyre.tgz\n`);
  const write = (/** @type {crypto.KeyObject|null} */ key, shell = "shell") => {
    fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "SHA256SUMS"), sums);
    if (key) fs.writeFileSync(path.join(src, "SHA256SUMS.sig"), signSums(sums, key));
    fs.writeFileSync(path.join(src, "shell.json"), shell);
  };
  const published = () => (fs.existsSync(path.join(b.U, "status", "release")) ? fs.readdirSync(path.join(b.U, "status", "release")).sort() : []);
  // Unsigned, and signed by another key: nothing is published.
  write(null);
  let r = /** @type {any} */ (await b.run(["publish-release", src], {}));
  assert.deepEqual(published(), []);
  assert.match(r.out, /SHA256SUMS\.sig is missing or does not verify/);
  write(OTHER.privateKey);
  await b.run(["publish-release", src], {});
  assert.deepEqual(published(), []);
  // A shell.json that is not the one the signed list has is left out, the signed files still go.
  write(RELEASE.privateKey, "not the signed shell");
  r = /** @type {any} */ (await b.run(["publish-release", src], {}));
  assert.deepEqual(published(), ["SHA256SUMS", "SHA256SUMS.sig"]);
  assert.match(r.out, /shell\.json is not the file the signed SHA256SUMS lists/);
  // Signed and right: all three.
  write(RELEASE.privateKey);
  await b.run(["publish-release", src], {});
  assert.deepEqual(published(), ["SHA256SUMS", "SHA256SUMS.sig", "shell.json"]);
  // A link in the caller's folder is copied as a link and refused: a file only root can read is never published through it.
  fs.rmSync(path.join(b.U, "status", "release"), { recursive: true });
  const secret = path.join(b.DIR, "root-only.txt");
  fs.writeFileSync(secret, "secret\n");
  write(RELEASE.privateKey);
  fs.rmSync(path.join(src, "SHA256SUMS")); fs.symlinkSync(secret, path.join(src, "SHA256SUMS"));
  await b.run(["publish-release", src], {});
  assert.deepEqual(published(), [], "nothing was published through a link");
});
