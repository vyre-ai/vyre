// @ts-check
// scripts/check-release-dist.mjs against a release folder built the way the release job builds it (build-site.sh's box files, release.json, SHA256SUMS,
// the stripped wrapper). The compose.yml pin is done both ways: the integrator's first sed, which keeps `${VYRE_IMAGE:-<digest>}` (refused), and the literal lines
// the updater requires (accepted).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../scripts/check-release-dist.mjs";
import { strip } from "../scripts/strip-wrapper.mjs";
import { pin } from "../scripts/pin-release-compose.mjs";
import { SCRATCH } from "./scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOX = `ghcr.io/vyre-ai/vyre@sha256:${"a".repeat(64)}`, COMPUTER = `ghcr.io/vyre-ai/vyre-computer@sha256:${"b".repeat(64)}`, TS = `tailscale/tailscale@sha256:${"c".repeat(64)}`;
const KEY = crypto.generateKeyPairSync("ed25519");

/** A dist/ the way the release job makes it. @param {{ literal?: boolean, sign?: boolean, unstripped?: boolean, images?: boolean }} o */
function dist(t, { literal = true, sign = true, unstripped = false, images = true } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-dist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
  let compose = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
  if (images) {
    if (literal) compose = pin(compose.replace("${VYRE_TAILSCALE_IMAGE:-tailscale/tailscale:stable}", `\${VYRE_TAILSCALE_IMAGE:-${TS}}`), BOX, COMPUTER);
    else compose = compose.replace("${VYRE_IMAGE:-ghcr.io/vyre-ai/vyre:latest}", `\${VYRE_IMAGE:-${BOX}}`).replace(/\$\{VYRE_IMAGE:-ghcr\.io\/vyre-ai\/vyre:latest\}/g, `\${VYRE_IMAGE:-${BOX}}`);
    if (!literal) compose = compose.replace("${VYRE_COMPUTERS_IMAGE:-vyre/computer:0.1}", `\${VYRE_COMPUTERS_IMAGE:-${COMPUTER}}`);
  }
  const files = { "install-box.sh": "#!/bin/sh\n", "install-mac-server.sh": "#!/bin/sh\n", "compose.yml": compose, "compose.build.yml": "# build\n", "vyre.env.example": "# env\n", "vyre": unstripped ? src : strip(src),
    "Dockerfile": "FROM x\n", "dockerignore": "test\n", "vyre.tgz": "tgz", "VERSION": "0.2.0\n",
    "release.json": JSON.stringify({ version: "0.2.0", channel: "stable", commit: "abc", date: "2026-10-01T00:00:00Z", min_from: "0.1.0", notes: "n", ...(images ? { images: { box: { ref: BOX, platforms: ["linux/amd64"] }, computer: { ref: COMPUTER, platforms: ["linux/amd64"] } } } : {}) }, null, 2) + "\n" };
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  fs.writeFileSync(path.join(dir, "notes.md"), "notes\n");
  const sums = Object.keys(files).sort().map(f => `${crypto.createHash("sha256").update(files[f]).digest("hex")}  ${f}\n`).join("");
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums);
  if (sign) fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), Buffer.from(sums)]), KEY.privateKey).toString("base64") + "\n");
  return dir;
}
const pub = KEY.publicKey.export({ type: "spki", format: "der" }).toString("base64");

test("release dist: a folder built the way the release job builds it, with literal digest lines, the stripped wrapper and a good signature, passes", t => {
  assert.deepEqual(check(dist(t), { pulled: true, pubkey: pub }), []);
});

test("release dist: the first pin (a ${VYRE_IMAGE:-digest} default) is refused: the updater needs literal image lines", t => {
  const problems = check(dist(t, { literal: false }), { pulled: true });
  assert.ok(problems.some(p => /image line that is not pinned exactly by digest/.test(p)), problems.join("\n"));
  assert.ok(problems.some(p => /no image line that is exactly ghcr\.io\/vyre-ai\/vyre@sha256:a{64}/.test(p)), problems.join("\n"));
});

test("release dist: an unstripped wrapper, a missing or wrong signature, a tampered file and a release with no images are each named", t => {
  assert.ok(check(dist(t, { unstripped: true }), {}).some(p => /still names VYRE_RELEASE_KEY/.test(p)));
  assert.ok(check(dist(t, { sign: false }), { pubkey: pub }).some(p => /missing SHA256SUMS\.sig/.test(p)));
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.ok(check(dist(t), { pubkey: other }).some(p => /not a valid Ed25519 signature/.test(p)));
  const d = dist(t);
  fs.appendFileSync(path.join(d, "vyre.tgz"), "tampered");
  assert.ok(check(d, {}).some(p => /wrong hash for vyre\.tgz/.test(p)));
  assert.ok(check(dist(t, { images: false }), { pulled: true }).some(p => /names no ghcr\.io\/vyre-ai digest for the box image/.test(p)));
  assert.deepEqual(check(dist(t, { images: false }), {}), [], "a release boxes only build needs no images");
});

test("pin-release-compose: makes every image line literal from the real compose.yml, refuses what it cannot, and the result passes the checker", t => {
  const source = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
  const pinned = pin(source, BOX, COMPUTER);
  assert.ok(!/image:.*\$/.test(pinned), "no image line keeps a variable");
  assert.ok(pinned.includes(`image: ${BOX}`) && pinned.includes(`\${VYRE_COMPUTERS_IMAGE:-${COMPUTER}}`));
  assert.ok(!/tailscale/i.test(source.replace(/^\s*#.*$/gm, "")), "the box compose has no tailscale service or image");
  // A third-party default that is still a tag stops the build.
  assert.throws(() => pin(source.replace("services:", "services:\n  extra:\n    image: ${VYRE_EXTRA_IMAGE:-someone/else:stable}"), BOX, COMPUTER), /is not pinned by digest in the source/);
  assert.throws(() => pin(source, "ghcr.io/vyre-ai/vyre:latest", COMPUTER), /must be ghcr\.io\/vyre-ai/);
  assert.throws(() => pin("services: {}\n", BOX, COMPUTER), /no `image: \$\{VYRE_IMAGE/);
});

test("release dist: a second VYRE_COMPUTERS_IMAGE default that is not the signed computers ref is named", t => {
  const d = dist(t);
  const f = path.join(d, "compose.yml");
  fs.appendFileSync(f, `  other:\n    environment:\n      - VYRE_COMPUTERS_IMAGE=\${VYRE_COMPUTERS_IMAGE:-ghcr.io/vyre-ai/vyre-computer@sha256:${"d".repeat(64)}}\n`);
  const problems = check(d, { pulled: true });
  assert.ok(problems.some(p => /every default of VYRE_COMPUTERS_IMAGE/.test(p)), problems.join("\n"));
});

test("release dist: with --installer the Windows installer must be in the release under both names", t => {
  const d = dist(t);
  assert.ok(check(d, { installer: true }).some(p => /Vyre_0\.2\.0_x64-setup\.exe is not in the release/.test(p)));
  assert.ok(check(d, { installer: true }).some(p => /VyreSetup\.exe is not in the release/.test(p)));
  assert.deepEqual(check(d, {}), [], "without the flag nothing is required");
});

test("release dist: with --android the APK must be in the release under both names", t => {
  const d = dist(t);
  const problems = check(d, { android: true });
  assert.ok(problems.some(p => /Vyre_0\.2\.0_android\.apk is not in the release/.test(p)), problems.join("\n"));
  assert.ok(problems.some(p => /Vyre-android\.apk is not in the release/.test(p)));
  for (const f of ["Vyre_0.2.0_android.apk", "Vyre-android.apk"]) {
    fs.writeFileSync(path.join(d, f), f);
    fs.appendFileSync(path.join(d, "SHA256SUMS"), `${crypto.createHash("sha256").update(f).digest("hex")}  ${f}\n`);
  }
  assert.deepEqual(check(d, { android: true }), []);
  assert.deepEqual(check(dist(t), {}), [], "without the flag nothing is required");
});

test("release dist: with --mac the two stable Lumen dmgs must be in the release, listed in SHA256SUMS", t => {
  const d = dist(t);
  const problems = check(d, { mac: true });
  assert.ok(problems.some(p => /Vyre-Lumen-aarch64\.dmg is not in the release/.test(p)));
  assert.ok(problems.some(p => /Vyre-Lumen-x86_64\.dmg is not in the release/.test(p)));
  for (const f of ["Vyre-Lumen-aarch64.dmg", "Vyre-Lumen-x86_64.dmg"]) {
    fs.writeFileSync(path.join(d, f), f);
    fs.appendFileSync(path.join(d, "SHA256SUMS"), `${crypto.createHash("sha256").update(f).digest("hex")}  ${f}\n`);
  }
  assert.deepEqual(check(d, { mac: true }), []);
  assert.deepEqual(check(dist(t), {}), [], "without the flag nothing is required");
});

/** Adds setup.json to a dist and lists it in SHA256SUMS, the way the release job does. @param {string} dir @param {string} text */
function withSetup(dir, text) {
  fs.writeFileSync(path.join(dir, "setup.json"), text);
  const line = `${crypto.createHash("sha256").update(text).digest("hex")}  setup.json\n`;
  fs.appendFileSync(path.join(dir, "SHA256SUMS"), line);
}

test("release dist: with --setup, setup.json must be in the release, listed in SHA256SUMS and { v: 1, files }", t => {
  const d = dist(t);
  assert.ok(check(d, { setup: true }).some(p => /setup\.json is not in the release/.test(p)));
  assert.deepEqual(check(d, {}), [], "without the flag nothing is required");
  const ok = dist(t); withSetup(ok, JSON.stringify({ v: 1, files: [["/i", "a".repeat(64)]] }));
  assert.deepEqual(check(ok, { setup: true }), []);
  const bad = dist(t); withSetup(bad, JSON.stringify({ v: 2, files: [] }));
  assert.ok(check(bad, { setup: true }).some(p => /setup\.json is not \{ v: 1/.test(p)));
  const junk = dist(t); withSetup(junk, "not json");
  assert.ok(check(junk, { setup: true }).some(p => /setup\.json is not JSON/.test(p)));
});

test("release dist: install-mac-server.sh is a required release file, so it is signed with the rest (#9)", t => {
  const d = dist(t);
  fs.rmSync(path.join(d, "install-mac-server.sh"));
  const problems = check(d, {});
  assert.ok(problems.some(p => /missing install-mac-server\.sh/.test(p)), problems.join("\n"));
});

test("release dist --modules: modules.json must be in the release, listed in SHA256SUMS, at the release's own version and the counter that version makes", async t => {
  const { releaseCounter } = await import("../scripts/release-counter.mjs");
  const make = (/** @type {any} */ over = {}, listed = true) => {
    const dir = dist(t, { sign: false });
    const body = JSON.stringify({ v: 1, counter: releaseCounter("0.2.0"), release: "0.2.0", modules: { work: { version: "0.1.0", tree: "a".repeat(64) } }, ...over });
    if (body !== "null") fs.writeFileSync(path.join(dir, "modules.json"), body);
    // The web app's signed file list (MW-5): present beside the module list in a release.
    if (body !== "null") fs.writeFileSync(path.join(dir, "appbuild.json"), JSON.stringify({ v: 1, release: "0.2.0", version: "0.2.0", counter: releaseCounter("0.2.0"), tree: "c".repeat(64), base: "/app/", files: { "index.html": "b".repeat(64) } }));
    // shell.json carries both as exact text (lib/release-shell.js), for an old updater that knows only shell.json.
    if (body !== "null") fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ v: 1, version: "0.2.0", files: [], modulesJson: fs.readFileSync(path.join(dir, "modules.json"), "utf8"), appbuildJson: fs.readFileSync(path.join(dir, "appbuild.json"), "utf8") }));
    if (listed) {
      const names = fs.readdirSync(dir).filter(f => !/^SHA256SUMS/.test(f) && f !== "notes.md").sort();
      fs.writeFileSync(path.join(dir, "SHA256SUMS"), names.map(f => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")}  ${f}\n`).join(""));
    }
    return dir;
  };
  assert.deepEqual(check(make(), { pulled: true, modules: true }), []);
  assert.match(check(make({ counter: 5 }), { pulled: true, modules: true }).join("\n"), /counter is 5, this version makes/);
  assert.match(check(make({ release: "0.2.1" }), { pulled: true, modules: true }).join("\n"), /says release 0.2.1, VERSION says 0.2.0/);
  assert.match(check(make({ modules: {} }), { pulled: true, modules: true }).join("\n"), /with modules/);
  assert.match(check(dist(t, { sign: false }), { pulled: true, modules: true }).join("\n"), /modules\.json is not in the release/);
  const noApp = make(); fs.rmSync(path.join(noApp, "appbuild.json"));
  assert.match(check(noApp, { pulled: true, modules: true }).join("\n"), /appbuild\.json is not in the release/);
  const unlisted = make({}, false);
  fs.appendFileSync(path.join(unlisted, "modules.json"), " ");
  assert.ok(check(unlisted, { pulled: true, modules: true }).length > 0, "a list SHA256SUMS does not carry is refused");
});

test("release dist --modules: shell.json must carry modules.json and appbuild.json as exact text, and be listed", async t => {
  const { releaseCounter } = await import("../scripts/release-counter.mjs");
  const dir = dist(t, { sign: false });
  const modules = JSON.stringify({ v: 1, counter: releaseCounter("0.2.0"), release: "0.2.0", modules: { work: { version: "0.1.0", tree: "a".repeat(64) } } });
  const app = JSON.stringify({ v: 1, release: "0.2.0", version: "0.2.0", counter: releaseCounter("0.2.0"), tree: "c".repeat(64), base: "/app/", files: { "index.html": "b".repeat(64) } });
  fs.writeFileSync(path.join(dir, "modules.json"), modules); fs.writeFileSync(path.join(dir, "appbuild.json"), app);
  const seal = () => { const names = fs.readdirSync(dir).filter(f => !/^SHA256SUMS/.test(f) && f !== "notes.md").sort(); fs.writeFileSync(path.join(dir, "SHA256SUMS"), names.map(f => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")}  ${f}\n`).join("")); };
  seal();
  assert.match(check(dir, { pulled: true, modules: true }).join("\n"), /shell\.json is not in the release/);
  fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ v: 1, files: [], modulesJson: modules + " ", appbuildJson: app })); seal();
  assert.match(check(dir, { pulled: true, modules: true }).join("\n"), /does not carry modules\.json as exact text/);
  fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ v: 1, files: [], modulesJson: modules, appbuildJson: "x" })); seal();
  assert.match(check(dir, { pulled: true, modules: true }).join("\n"), /does not carry appbuild\.json as exact text/);
  fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ v: 1, files: [], modulesJson: modules, appbuildJson: app })); seal();
  assert.deepEqual(check(dir, { pulled: true, modules: true }), []);
});
