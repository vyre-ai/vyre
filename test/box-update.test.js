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
const IMAGE_REF = `ghcr.io/vyre-ai/vyre@sha256:${"a".repeat(64)}`;
const COMPUTER_REF = `ghcr.io/vyre-ai/vyre-computer@sha256:${"b".repeat(64)}`;
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
const F = process.env.FAKE;
let args = process.argv.slice(2);
fs.appendFileSync(F + "/calls.raw", args.join(" ") + "\\n");
// A root run names its compose files, project and env file explicitly: the options come before the subcommand, and calls log the rest.
if (args[0] === "compose") { let i = 1; while (["--project-directory", "--project-name", "--env-file", "-f"].includes(args[i])) i += 2; args = ["compose", ...args.slice(i)]; }
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
  // The module list (L-1): what \`vyre modules\` says, from a file a test writes (default: both signed modules run); and the owner's reset of the list (L-2), allowed only when a test says so.
  if (c === "modules") { process.stdout.write(fs.existsSync(F + "/modules-out") ? fs.readFileSync(F + "/modules-out", "utf8") : "  about                0.1.0    running\\n  work                 0.1.0    running\\n"); process.exit(0); }
  if (c === "call" && a === "modules.list.reset") { if (fs.existsSync(F + "/reset-ok")) { fs.writeFileSync(F + "/reset-done", "1"); console.log("{}"); process.exit(0); } console.log("  no_such_tool: no tool modules.list.reset"); process.exit(1); }
  if (c === "up") { console.log("  your address: https://alex.vyre.run"); process.exit(0); }
  process.exit(0);
}
if (args[0] === "run" && args.some(a => /cosign/.test(a))) {
  // The image signature check (cosign, pinned by digest): the fake says no when told to.
  fs.appendFileSync(F + "/cosign", args.join(" ") + "\\n");
  if (fs.existsSync(F + "/cosign-fail")) { console.error("Error: no matching signatures: nil certificate provided"); process.exit(1); }
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
function release(dir, version, { android = false, corrupt = "", images = false, tagCompose = false, noReleaseJson = false, list = 0, sign = /** @type {any} */ (RELEASE.privateKey) } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, ".pkg", "package");
  fs.mkdirSync(path.join(pkg, "box"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "box", "Dockerfile"), "FROM node:22-bookworm-slim\n");
  fs.writeFileSync(path.join(pkg, "marker"), version + "\n");
  assert.equal(spawnSync("tar", ["-czf", path.join(dir, "vyre.tgz"), "-C", path.join(dir, ".pkg"), "package"]).status, 0);
  fs.rmSync(path.join(dir, ".pkg"), { recursive: true });
  // A release that pulls: every image pinned by digest, as the release pipeline writes it (tagCompose: left on a moving tag).
  const pin = IMAGE_REF;
  const composeText = images && !tagCompose ? COMPOSE.replace(/^( *image: *).*$/gm, `$1${pin}`).replace("${VYRE_COMPUTERS_IMAGE:-vyre/computer:0.1}", `\${VYRE_COMPUTERS_IMAGE:-${COMPUTER_REF}}`) : COMPOSE;
  fs.writeFileSync(path.join(dir, "compose.yml"), composeText + `# release ${version}\n`);
  fs.writeFileSync(path.join(dir, "compose.build.yml"), `# compose.build.yml ${version}\n`);
  fs.writeFileSync(path.join(dir, "vyre.env.example"), `# vyre.env.example ${version}\n`);
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:22-bookworm-slim\n");
  fs.writeFileSync(path.join(dir, "dockerignore"), "test\n");
  fs.writeFileSync(path.join(dir, "vyre"), WRAPPER_SRC + `# release ${version}\n`);
  fs.writeFileSync(path.join(dir, "VERSION"), version + "\n");
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version, channel: "stable", commit: "abc1234", date: "2026-09-27T00:00:00Z", min_from: "0.1.0", notes: "Northwind Bakery's \"fix\"", ...(images ? { images: { box: { ref: IMAGE_REF }, computer: { ref: COMPUTER_REF } } } : {}) }, null, 2));
  if (noReleaseJson) fs.rmSync(path.join(dir, "release.json"));
  // A release with a signed module list at this counter, in the exact shape scripts/modules-manifest.mjs writes (one-space indent), listed in SHA256SUMS below.
  if (list) fs.writeFileSync(path.join(dir, "modules.json"), JSON.stringify({ v: 1, counter: list, release: version, modules: { about: { version: "0.1.0", tree: "a".repeat(64) }, work: { version: "0.1.0", tree: "b".repeat(64) } } }, null, 1) + "\n");
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
    DIR, U, FAKE, DL, WRAPPER, hits, run, read, env, build,
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
  const b = await box(t, { releases: [{ tag: "v0.2.0", images: true }], build: false });
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.equal(r.code, 0, r.out);
  assert.ok(b.calls().includes("compose pull"));
  assert.match(b.read(path.join(b.FAKE, "cosign")), /verify --certificate-identity-regexp .*release\\\.yml@refs\/tags\/.* --certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com ghcr\.io\/vyre-ai\/vyre@sha256:a{64}/, "the image was checked by cosign before the pull");
  assert.equal(b.image("vyre:prev"), "orig");
  assert.equal(b.read(path.join(b.DIR, "src", "marker")).trim(), "old");
  assert.ok(!b.hits.includes("/dl/v0.2.0/vyre.tgz"));
});

test("box update (pulled): an image cosign cannot verify, a compose.yml on a moving tag, and a release without release.json are each refused with nothing changed", async t => {
  const state = b => ({ calls: b.calls().filter(c => /^compose (pull|up|build)/.test(c)), compose: b.read(path.join(b.DIR, "compose.yml")), image: b.image("ghcr.io/vyre-ai/vyre:latest"), db: b.db() });
  // cosign says no (an unsigned image, or another signer's): refused before the box is touched.
  let b = await box(t, { releases: [{ tag: "v0.2.0", images: true }], build: false });
  fs.writeFileSync(path.join(b.FAKE, "cosign-fail"), "1");
  const before = state(b);
  let r = /** @type {any} */ (await b.run(["update"]));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /cosign could not verify ghcr\.io\/vyre-ai\/vyre(-computer)?@sha256:[ab]{64} against Vyre's release workflow; nothing was changed/);
  assert.deepEqual(state(b), before, "no pull, no new compose.yml, same image and data");
  // The release's compose.yml still points at a moving tag: a moved tag could change what runs, so it is refused.
  b = await box(t, { releases: [{ tag: "v0.2.0", images: true, tagCompose: true }], build: false });
  r = /** @type {any} */ (await b.run(["update"]));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /not pinned exactly by digest \(.*\); nothing was changed/);
  assert.ok(!b.calls().includes("compose pull") && !fs.existsSync(path.join(b.FAKE, "cosign")), "nothing was pulled or even checked");
  // No release.json: the image it pulls cannot be named, so cannot be checked.
  b = await box(t, { releases: [{ tag: "v0.2.0", images: true, noReleaseJson: true }], build: false });
  r = /** @type {any} */ (await b.run(["update"]));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /no release\.json, so the image it pulls cannot be verified; nothing was changed/);
  assert.ok(!b.calls().includes("compose pull"));
  // A box that builds from source needs none of this: its source is the signed tgz.
  b = await box(t, { releases: [{ tag: "v0.2.0" }] });
  assert.equal(/** @type {any} */ ((await b.run(["update"]))).code, 0);
  assert.ok(!fs.existsSync(path.join(b.FAKE, "cosign")));
});

test("box/vyre and scripts/install-box.sh pin the same cosign, identity and issuer", () => {
  const pick = (text, name) => new RegExp(`^${name}=\\\$\\{[A-Z_]+:-(.*)\\}$|^${name}=(.*)$`, "m").exec(text);
  const wrapper = WRAPPER_SRC, installer = fs.readFileSync(path.join(REPO, "scripts/install-box.sh"), "utf8");
  for (const name of ["COSIGN_IMAGE", "COSIGN_ID", "COSIGN_ISSUER"]) {
    const a = pick(wrapper, name), c = pick(installer, name);
    assert.ok(a && c, `${name} is in both`);
    assert.equal((a[1] ?? a[2]), (c[1] ?? c[2]), `${name} is the same in both`);
  }
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
const units_dirs = (/** @type {any} */ b) => { for (const [d, m] of [["", 0o755], ["request", 0o700], ["status", 0o755], ["private", 0o700]]) { const f = path.join(b.U, d); fs.mkdirSync(f, { recursive: true }); fs.chmodSync(f, m); }  // As `vyre updater install` leaves them: how the box is built, and root's own copies of the compose files it runs from.
  fs.writeFileSync(path.join(b.U, "mode"), b.build ? "build\n" : "pull\n");
  const run = path.join(b.U, "private", "run"); fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  for (const f of ["compose.yml", "compose.build.yml"]) if (fs.existsSync(path.join(b.DIR, f))) fs.copyFileSync(path.join(b.DIR, f), path.join(run, f));
};
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

test("redteam U-fifo: a request that is a named pipe or a folder is dropped without blocking and nothing runs", { timeout: 30_000 }, async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  units_dirs(b);
  const req = path.join(b.U, "request", "request");
  // A named pipe would hang a plain `head` forever: it is not a regular file, so it is never opened.
  const mk = spawnSync("mkfifo", [req]);
  // On CI a missing mkfifo is a failure, never a silent skip of the pipe half.
  if (process.env.CI) assert.equal(mk.status, 0, "mkfifo is needed for the named-pipe attack");
  if (mk.status === 0) {
    const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(req), "the pipe is removed");
  }
  // The folder half is a regression case, not proof: it is refused with or without the regular-file guard.
  fs.mkdirSync(req);
  fs.writeFileSync(path.join(req, "update"), "update\n");
  const r2 = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r2.code, 0);
  assert.equal(b.calls().length, 0, "no docker call: " + b.calls().join("\n"));
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
  try { r = /** @type {any} */ (await b.run(["updater", "remove"], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()) })); } finally { fs.chmodSync(units, 0o755); }
  assert.notEqual(r.code, 0, `a failed removal is not a success: ${r.out}`);
  assert.match(r.out, /still on this server/, r.out);
  assert.match(r.out, /sudo .* updater remove/);
  assert.match(fs.readFileSync(path.join(b.FAKE, "sudo"), "utf8"), /updater remove/, "it asked for root");
  assert.ok(fs.existsSync(path.join(units, "vyre-update.path")), "nothing was claimed removed");
  // A wrapper that is not root's is never handed to sudo: the manual command is printed instead.
  fs.rmSync(path.join(b.FAKE, "sudo"));
  fs.chmodSync(units, 0o555);
  try { r = /** @type {any} */ (await b.run(["updater", "remove"], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: "0" })); } finally { fs.chmodSync(units, 0o755); }
  assert.notEqual(r.code, 0);
  assert.match(r.out, /still on this server/);
  assert.ok(!fs.existsSync(path.join(b.FAKE, "sudo")), "sudo was not asked to run a wrapper root does not own");
});

const rawCalls = (/** @type {any} */ b) => (fs.existsSync(path.join(b.FAKE, "calls.raw")) ? fs.readFileSync(path.join(b.FAKE, "calls.raw"), "utf8").split("\n").filter(Boolean) : []);

test("root run (reviewer-2's HIGH): compose runs only from root's own copy with every file named, never from the person's folder or what is in it", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  units_dirs(b);
  const RUNDIR = path.join(b.U, "private", "run");
  // The person (or a model running as them) edits compose.yml and plants an override and a vyre.env with a hostile line.
  fs.appendFileSync(path.join(b.DIR, "compose.yml"), "    privileged: true\n");
  fs.writeFileSync(path.join(b.DIR, "vyre.env"), "CLOUDFLARE_VYRE_TOKEN=keep\nEVIL=$(touch /tmp/pwned)\nBAD=`id`\nNODE_OPTIONS=--require /work/x.js\nLD_PRELOAD=/work/x.so\nVYRE_SETUP_CODE=abc\n");
  fs.appendFileSync(path.join(b.DIR, ".env"), "VYRE_UPDATE_ROOT=/\nVYRE_COMPUTERS_CAP_ADD=SYS_ADMIN\nVYRE_IMAGE=evil/image:latest\nDOCKER_GID=abc\nVYRE_DRIVE_ACCESS=rw\nVYRE_TS_HOSTNAME=box-1\n");
  fs.writeFileSync(path.join(b.U, "request", "request"), "update\n");
  const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /an update run by root ignores these settings from .*\.env and vyre\.env .*: .*VYRE_COMPUTERS_CAP_ADD.*/s, "nothing is dropped silently");
  assert.ok(!/ignores these settings[^\n]*(tskey|keep|SYS_ADMIN=)/.test(r.out), "names only, never values");
  const composeCalls = rawCalls(b).filter(c => c.startsWith("compose "));
  assert.ok(composeCalls.length >= 3, composeCalls.join("\n"));
  for (const c of composeCalls) {
    assert.ok(c.includes(`--project-directory ${RUNDIR} --project-name vyre --env-file ${RUNDIR}/compose.env -f ${RUNDIR}/compose.yml`), `compose is told its files explicitly: ${c}`);
    assert.ok(!c.includes(b.DIR + "/compose") && !c.includes(b.DIR + "/.env"), `never the person's folder: ${c}`);
  }
  assert.ok(!fs.readFileSync(path.join(RUNDIR, "compose.yml"), "utf8").includes("    privileged: true\n"), "root's copy is the verified release, not the edited file");
  // The env file root wrote: only what the compose file reads, each in its shape, plus root's own paths.
  const env = fs.readFileSync(path.join(RUNDIR, "compose.env"), "utf8");
  assert.match(env, /^VYRE_UPDATE_ROOT=.*\/uroot$/m, "the update root is root's own, not the .env's");
  assert.match(env, /^VYRE_DRIVE_ACCESS=rw$/m);
  assert.match(env, /^VYRE_TS_HOSTNAME=box-1$/m);
  for (const bad of ["SYS_ADMIN", "evil/image", "DOCKER_GID", "VYRE_COMPUTERS", "VYRE_IMAGE", "VYRE_UPDATE_ROOT=/\n"]) assert.ok(!env.includes(bad), `${bad} was not passed on`);
  const venv = fs.readFileSync(path.join(RUNDIR, "vyre.env"), "utf8");
  assert.match(venv, /^CLOUDFLARE_VYRE_TOKEN=keep$/m);
  assert.ok(!/EVIL|BAD|\$\(|`/.test(venv), "a line with interpolation is not copied");
  assert.match(venv, /^VYRE_SETUP_CODE=abc$/m);
  assert.ok(!/NODE_OPTIONS|LD_PRELOAD/.test(venv), "only the keys the box reads are passed on (an allowlist)");
});

test("root run: an override file, a COMPOSE_* setting in .env or the environment, and a box with no record of its mode each refuse, with nothing changed", async t => {
  const refuse = async (/** @type {string} */ why, /** @type {(b: any) => void} */ plant, /** @type {RegExp} */ words, extra = {}) => {
    const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
    units_dirs(b); plant(b);
    fs.writeFileSync(path.join(b.U, "request", "request"), "update\n");
    const before = b.read(path.join(b.DIR, "compose.yml"));
    const r = /** @type {any} */ (await b.run(["update-from-request"], { ...KEY, ...extra }));
    assert.notEqual(r.code, 0, `${why}: ${r.out}`);
    assert.match(r.out, words, why);
    assert.equal(status(b).state, "failed", why);
    assert.deepEqual(rawCalls(b).filter(c => /^compose (up|pull|build)/.test(c)), [], `${why}: compose never started anything`);
    assert.equal(b.read(path.join(b.DIR, "compose.yml")), before, `${why}: the stack folder is as it was`);
    assert.ok(!fs.existsSync(path.join(b.U, "private", "lock")), `${why}: the lock is released`);
  };
  await refuse("an override file", b => fs.writeFileSync(path.join(b.DIR, "compose.override.yml"), "services:\n  vyre:\n    privileged: true\n"), /does not read override files/);
  await refuse("COMPOSE_FILE in .env", b => fs.appendFileSync(path.join(b.DIR, ".env"), "COMPOSE_FILE=evil.yml\n"), /COMPOSE_FILE is set in .*\.env/);
  await refuse("COMPOSE_PROFILES in .env", b => fs.appendFileSync(path.join(b.DIR, ".env"), "COMPOSE_PROFILES=computers\n"), /COMPOSE_PROFILES is set in/);
  await refuse("COMPOSE_* in the environment", () => {}, /COMPOSE_ENV_FILE is set in the environment/, { COMPOSE_ENV_FILE: "/tmp/evil.env" });
  await refuse("no record of the mode", b => fs.rmSync(path.join(b.U, "mode")), /root has no record of how this box is built/);
  await refuse("a box that builds from a checkout of its own", b => fs.writeFileSync(path.join(b.U, "mode"), "external\n"), /never builds from a folder you can write/);
});

test("root run: the build mode comes from root's record, so a .env cannot turn a release box into one that builds from a tree the person writes", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey, images: true }], build: false });
  units_dirs(b);
  assert.equal(b.read(path.join(b.U, "mode")).trim(), "pull");
  fs.appendFileSync(path.join(b.DIR, ".env"), `COMPOSE_FILE=compose.yml:compose.build.yml\nVYRE_SOURCE=${b.DIR}/evil-src\n`);
  fs.writeFileSync(path.join(b.U, "request", "request"), "update\n");
  const r = /** @type {any} */ (await b.run(["update-from-request"], KEY));
  assert.equal(r.code, 0, r.out);
  const calls = b.calls();
  assert.ok(calls.includes("compose pull") && !calls.some(c => c.startsWith("compose build")), `it pulled (verified) and never built: ${calls.join("; ")}`);
  assert.ok(!fs.readFileSync(path.join(b.U, "private", "run", "compose.env"), "utf8").includes("evil-src"));
  assert.ok(fs.existsSync(path.join(b.FAKE, "cosign")), "and cosign still ran on the pulled image: the .env did not skip it");
  // And a build box builds from root's own copy of the verified source, not the person's tree.
  const bb = await box(t, { releases: [{ tag: "v0.2.0", sign: RELEASE.privateKey }] });
  units_dirs(bb);
  fs.writeFileSync(path.join(bb.U, "request", "request"), "update\n");
  const rr = /** @type {any} */ (await bb.run(["update-from-request"], KEY));
  assert.equal(rr.code, 0, rr.out);
  assert.match(fs.readFileSync(path.join(bb.U, "private", "run", "compose.env"), "utf8"), new RegExp(`^VYRE_SOURCE=${path.join(bb.U, "private", "src").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(bb.read(path.join(bb.U, "private", "src", "marker")).trim(), "0.2.0", "root unpacked the verified tgz into its own folder");
});

test("updater install --dir: a box that is not in /srv/vyre hands root its folder as an argument, and root records it with the mode", async t => {
  const b = await box(t, { releases: [] });
  const units = path.join(b.DIR, "units");
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(b.FAKE, "bin", "systemctl"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  const r = /** @type {any} */ (await b.run(["updater", "install", "--dir", b.DIR], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()), VYRE_DIR: "/nowhere" }));
  assert.equal(r.code, 0, r.out);
  assert.equal(b.read(path.join(b.U, "stack")).trim(), b.DIR, "the folder came from the argument, not from the environment");
  assert.equal(b.read(path.join(b.U, "mode")).trim(), "build");
  assert.equal(b.read(path.join(b.U, "private", "run", "compose.yml")), b.read(path.join(b.DIR, "compose.yml")));
  // root recorded the hash of the compose.yml it copied: a later install from a folder whose file differs is refused, and the same file is not.
  assert.match(b.read(path.join(b.U, "compose.sha256")).trim(), /^[0-9a-f]{64}$/);
  assert.equal(/** @type {any} */ ((await b.run(["updater", "install", "--dir", b.DIR], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()) }))).code, 0, "the same file again is fine");
  fs.appendFileSync(path.join(b.DIR, "compose.yml"), "# edited by somebody\n");
  const swapped = /** @type {any} */ (await b.run(["updater", "install", "--dir", b.DIR], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()) }));
  assert.notEqual(swapped.code, 0);
  assert.match(swapped.out, /root recorded another compose\.yml for this box than the one in .*; nothing was changed/);
  assert.ok(!b.read(path.join(b.U, "private", "run", "compose.yml")).includes("edited by somebody"), "root's copy is untouched");
  fs.writeFileSync(path.join(b.DIR, "compose.yml"), b.read(path.join(b.U, "private", "run", "compose.yml")));
  assert.equal(/** @type {any} */ ((await b.run(["updater", "install", "--dir", "relative"], { VYRE_SYSTEMD_DIR: units }))).code, 1);
  // A checkout of the person's own is recorded as such, and root's automatic path will not build from it.
  fs.writeFileSync(path.join(b.DIR, ".env"), `COMPOSE_FILE=compose.yml:compose.build.yml\nVYRE_SOURCE=/home/alex/vyre\n`);
  await b.run(["updater", "install", "--dir", b.DIR], { VYRE_SYSTEMD_DIR: units, VYRE_ROOT_UID: String(process.getuid()) });
  assert.equal(b.read(path.join(b.U, "mode")).trim(), "external");
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
  fs.rmSync(path.join(b.U, "private", "release.prev"), { recursive: true, force: true });
  const secret = path.join(b.DIR, "root-only.txt");
  fs.writeFileSync(secret, "secret\n");
  write(RELEASE.privateKey);
  fs.rmSync(path.join(src, "SHA256SUMS")); fs.symlinkSync(secret, path.join(src, "SHA256SUMS"));
  await b.run(["publish-release", src], {});
  assert.deepEqual(published(), [], "nothing was published through a link");
});

test("publish-release: modules.json is published when the signed list has it, the folder is replaced whole by rename, and the counter never goes down", async t => {
  const b = await box(t, { releases: [] });
  units_dirs(b);
  const src = path.join(b.DIR, "src-rel");
  const rel = path.join(b.U, "status", "release");
  const release = (/** @type {number} */ counter, /** @type {string} */ extra = "") => {
    const modules = JSON.stringify({ v: 1, counter, release: "0.3.0", modules: { work: { version: "0.1.0", tree: "a".repeat(64) } } }, null, 1) + "\n";
    const sums = Buffer.from(`${sha(modules)}  modules.json\n${sha("shell")}  shell.json\n${sha("tgz")}  vyre.tgz\n`);
    fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "SHA256SUMS"), sums);
    fs.writeFileSync(path.join(src, "SHA256SUMS.sig"), signSums(sums, RELEASE.privateKey));
    fs.writeFileSync(path.join(src, "shell.json"), "shell");
    fs.writeFileSync(path.join(src, "modules.json"), modules + extra);
    return modules;
  };
  const counterOf = () => JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter;
  release(3004100);
  await b.run(["publish-release", src], {});
  assert.deepEqual(fs.readdirSync(rel).sort(), ["SHA256SUMS", "SHA256SUMS.sig", "modules.json", "shell.json"]);
  assert.equal(counterOf(), 3004100);
  // A modules.json that is not the file the signed list has publishes nothing: the folder keeps the release it had, with its list.
  release(3004200, " ");
  const bad = /** @type {any} */ (await b.run(["publish-release", src], {}));
  assert.match(bad.out, /modules\.json is not the file the signed SHA256SUMS lists; nothing was published/);
  assert.equal(counterOf(), 3004100, "the folder still holds the release before, whole");
  // A newer release replaces the folder as a whole and the old one is set aside, whole.
  release(3004200);
  await b.run(["publish-release", src], {});
  assert.equal(counterOf(), 3004200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.U, "private", "release.prev", "modules.json"), "utf8")).counter, 3004100, "the release before is kept whole beside it");
  assert.deepEqual(fs.readdirSync(path.join(b.U, "status")).filter(n => /^release\.new/.test(n)), [], "no temp folder left");
  // The counter only goes up: a signed older list is refused, nothing changes.
  release(3004100);
  const old = /** @type {any} */ (await b.run(["publish-release", src], {}));
  assert.match(old.out, /older \(counter 3004100\) than the one already published \(counter 3004200\)/);
  assert.equal(counterOf(), 3004200);
  // The same counter again is not a rollback (a re-run of the same release).
  release(3004200);
  await b.run(["publish-release", src], {});
  assert.equal(counterOf(), 3004200);
});


/** A box that already holds an installed signed list (counter `have`), plus the signed releases to update to. */
async function listBox(t, tags) {
  const b = await box(t, { releases: [] });
  units_dirs(b);
  const rel = path.join(b.U, "status", "release");
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, "modules.json"), JSON.stringify({ v: 1, counter: 3004100, release: "0.2.0", modules: { about: { version: "0.1.0", tree: "a".repeat(64) }, work: { version: "0.1.0", tree: "b".repeat(64) } } }, null, 1) + "\n");
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), "old\n");
  for (const [tag, list] of tags) release(path.join(b.DL, "dl", tag), tag.slice(1), { list });
  const api = tags.map(([tag]) => apiEntry(`http://127.0.0.1:0`, tag, false, []));
  void api;
  return { b, rel, counter: () => JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter };
}

test("L-1: an update whose module list is refused (an older counter) stops there: the old image and the old list stay, the person is told why", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.1", list: 3004100 }] });
  units_dirs(b);
  const rel = path.join(b.U, "status", "release");
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, "modules.json"), JSON.stringify({ v: 1, counter: 3004200, release: "0.2.0", modules: {} }, null, 1) + "\n");
  const r = /** @type {any} */ (await b.run(["update"]));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /older \(counter 3004100\) than the one already published \(counter 3004200\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter, 3004200, "the old list stays");
  assert.equal(b.read(path.join(b.FAKE, "running")), "orig", "the old image is the one running");
});

test("L-1: an update that ends with a signed module not running rolls back by itself; a healthy one keeps release.prev", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.1", list: 3004200 }] });
  units_dirs(b);
  const rel = path.join(b.U, "status", "release");
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, "modules.json"), JSON.stringify({ v: 1, counter: 3004100, release: "0.2.0", modules: {} }, null, 1) + "\n");
  // The new container comes up, but a module the list names failed: the update rolls back, the list folder goes back too.
  fs.writeFileSync(path.join(b.FAKE, "modules-out"), "  about                0.1.0    running\n  work                 0.1.0    failed   modules from outside Vyre run only under the module supervisor\n");
  let r = /** @type {any} */ (await b.run(["update"], { MODULES_WAIT: "2" }));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /these signed modules did not start: work/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter, 3004100, "the list before is back");
  assert.equal(b.read(path.join(b.FAKE, "running")), "orig");
  // Healthy: both run, the update stands, the old list is kept whole beside it for a rollback.
  fs.rmSync(path.join(b.FAKE, "modules-out"));
  r = /** @type {any} */ (await b.run(["update"], { MODULES_WAIT: "2" }));
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter, 3004200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.U, "private", "release.prev", "modules.json"), "utf8")).counter, 3004100);
});

test("L-2: update --rollback to a release with an older list asks the owner for the reset first, and refuses without it; with it, the box goes back whole", async t => {
  const b = await box(t, { releases: [{ tag: "v0.2.1", list: 3004200 }] });
  units_dirs(b);
  const rel = path.join(b.U, "status", "release");
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, "modules.json"), JSON.stringify({ v: 1, counter: 3004100, release: "0.2.0", modules: {} }, null, 1) + "\n");
  const up = /** @type {any} */ (await b.run(["update"], { MODULES_WAIT: "2" }));
  assert.equal(up.code, 0, up.out);
  const counter = () => JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter;
  assert.equal(counter(), 3004200);
  // No reset tool, or the owner did not approve: nothing is swapped.
  let r = /** @type {any} */ (await b.run(["update", "--rollback"], {}));
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /the owner has to approve going back/);
  assert.match(r.out, /not rolled back: the module list was not reset/);
  assert.equal(counter(), 3004200, "the list is untouched");
  assert.equal(b.read(path.join(b.FAKE, "running")), "built-1", "the new image still runs");
  // With the owner's reset: the image and the list go back together.
  fs.writeFileSync(path.join(b.FAKE, "reset-ok"), "1");
  r = /** @type {any} */ (await b.run(["update", "--rollback"], {}));
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(b.FAKE, "reset-done")), "the reset was asked of the running daemon first");
  assert.equal(counter(), 3004100);
});

test("L-4 and L-7: an interrupted swap (no release folder, the old one set aside) is put right before the next publish, and a list whose counter cannot be read is refused", async t => {
  const b = await box(t, { releases: [] });
  units_dirs(b);
  const src = path.join(b.DIR, "src-rel");
  const priv = path.join(b.U, "private");
  const rel = path.join(b.U, "status", "release");
  const sums = (/** @type {string} */ m) => Buffer.from(`${sha(m)}  modules.json\n${sha("tgz")}  vyre.tgz\n`);
  const write = (/** @type {string} */ m) => { fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(src); fs.writeFileSync(path.join(src, "modules.json"), m); fs.writeFileSync(path.join(src, "SHA256SUMS"), sums(m)); fs.writeFileSync(path.join(src, "SHA256SUMS.sig"), signSums(sums(m), RELEASE.privateKey)); };
  const good = (/** @type {number} */ c) => JSON.stringify({ v: 1, counter: c, release: "x", modules: {} }, null, 1) + "\n";
  // A crash left only release.prev and a temp folder.
  fs.mkdirSync(path.join(priv, "release.prev"), { recursive: true });
  fs.writeFileSync(path.join(priv, "release.prev", "modules.json"), good(3004100));
  fs.mkdirSync(path.join(b.U, "status", "release.new.AbC123"), { recursive: true });
  write(good(3004200));
  const r = /** @type {any} */ (await b.run(["publish-release", src], {}));
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter, 3004200);
  assert.ok(!fs.readdirSync(path.join(b.U, "status")).some(n => /^release\.new/.test(n)), "the temp folder is gone");
  // A counter that is not the one top-level line (a second one nested in a module entry) is not read: refused, non-zero.
  write(JSON.stringify({ v: 1, release: "x", modules: { a: { version: "1", tree: "a".repeat(64), counter: 9 } } }, null, 1) + "\n");
  const bad = /** @type {any} */ (await b.run(["publish-release", src], {}));
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /no readable counter/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rel, "modules.json"), "utf8")).counter, 3004200);
});
