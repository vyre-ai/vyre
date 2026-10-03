// @ts-check
// install-box.sh v2 (0.2 launch plan, C6/R6/R7/M6): the setup code is never an argument, a release
// that names image digests is cosign-checked and pulled by digest, a running install is never replaced,
// and the Docker flavors that cannot work stop in plain words. All against stub docker/sudo and a
// file:// release site: no network, no real Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRelay } from "../relay/node/server.js";
import { createSetupKey, setupCode, mailboxReader } from "../relay/client/setup.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "install-box.sh");
const CODE = "A".repeat(20) + "b-_" + "Z".repeat(20);
const DIGEST = "ghcr.io/vyre-ai/vyre@sha256:" + "a".repeat(64);
const COMPUTER = "ghcr.io/vyre-ai/vyre-computer@sha256:" + "b".repeat(64);

/** @param {import("node:test").TestContext} t @param {{docker?: string}} [opts] */
function box(t, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-v2-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const log = path.join(base, "calls.log");
  const stubs = {
    uname: "echo Linux",
    id: 'case "$1" in -u) echo 1000 ;; -un|-gn) echo alex ;; *) exit 1 ;; esac',
    docker: `echo "docker $*" >>"${log}"\n` + (opts.docker ?? 'case "$1 $2" in "compose version") echo 2.29.1 ;; esac; exit 0'),
    sudo: `echo "sudo $*" >>"${log}"\nexec "$@"`,
  };
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: base, VYRE_DIR: path.join(base, "srv", "vyre"),
    VYRE_WRAPPER: path.join(base, "bin-out", "vyre"), VYRE_DOCKER_SOCK: path.join(base, "none"),
    VYRE_NO_UP: "1",
    // Never the real relay: a closed local port, so a code's progress lines go nowhere in tests.
    VYRE_RELAY: "http://127.0.0.1:9",
  };
  return { base, env, log, dir: env.VYRE_DIR, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

/** The installer as a child that lets this process's own relay server answer (spawnSync would block it). @param {Record<string,string>} env @param {string[]} args */
const runAsync = (env, args) => new Promise(resolve => {
  const c = spawn("sh", [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  c.stdout.on("data", d => { stdout += d; }); c.stderr.on("data", d => { stderr += d; });
  c.on("close", status => resolve({ status, stdout, stderr }));
});

/** @param {Record<string,string>} env @param {string[]} args */
const run = (env, args) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });

/** A file:// release site: the box files, a SHA256SUMS over them, and release.json. */
function site(base, { images = true, pin = true } = {}) {
  const dir = path.join(base, "site");
  fs.mkdirSync(dir, { recursive: true });
  const compose = pin ? `services:\n  vyre:\n    image: ${DIGEST}\n    environment:\n      - VYRE_COMPUTERS_IMAGE=\${VYRE_COMPUTERS_IMAGE:-${COMPUTER}}\n` : "image: ghcr.io/vyre-ai/vyre:latest\n";
  const files = {
    "compose.yml": compose, "compose.build.yml": "# build\n", "vyre.env.example": "# env\n", vyre: "#!/bin/sh\n# vyre on a Docker box\n",
    "release.json": JSON.stringify({ version: "0.2.0", channel: "stable", ...(images ? { images: { box: { ref: DIGEST, platforms: ["linux/amd64"] }, computer: { ref: COMPUTER, platforms: ["linux/amd64"] } } } : {}) }, null, 2),
  };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  const sums = Object.entries(files).map(([n, c]) => `${crypto.createHash("sha256").update(c).digest("hex")}  ${n}`).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums);
  return `file://${dir}/`;
}

test("install-box.sh v2: --code is refused, because a process list shows arguments", t => {
  const b = box(t);
  const r = run(b.env, ["--code", CODE, "--dry-run", "--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /never a command-line argument/);
  assert.ok(!(r.stdout + r.stderr).includes(CODE), "the refusal does not echo the code");
});

test("install-box.sh v2: a malformed VYRE_CODE stops the install, and is never printed", t => {
  const b = box(t);
  const bad = "not-a-code-" + "x".repeat(5);
  const r = run({ ...b.env, VYRE_CODE: bad }, ["--dry-run", "--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /setup code does not look right/);
  assert.ok(!(r.stdout + r.stderr).includes(bad));
});

test("install-box.sh v2: the code lands in vyre.env at 0600, keeps the person's lines, and is in no argument", t => {
  const b = box(t);
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(path.join(b.dir, "vyre.env"), "CLOUDFLARE_VYRE_TOKEN=keep\nVYRE_SETUP_CODE=stale\n", { mode: 0o600 });
  const r = run({ ...b.env, VYRE_CODE: CODE }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  const envFile = path.join(b.dir, "vyre.env");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const text = fs.readFileSync(envFile, "utf8");
  assert.match(text, /^CLOUDFLARE_VYRE_TOKEN=keep$/m);
  assert.equal(text.match(/^VYRE_SETUP_CODE=/gm)?.length, 1, "one code line, the stale one replaced");
  assert.ok(text.includes(`VYRE_SETUP_CODE=${CODE}`));
  assert.ok(!/^VYRE_CODE=/m.test(text), "VYRE_CODE is only the host-side pipe, never written into the box's env file");
  const at = Number(text.match(/^VYRE_SETUP_CODE_AT=(\d+)$/m)?.[1]);
  assert.ok(Math.abs(at - Date.now() / 1000) < 120, "the time it was written, as a real variable the box can read");
  assert.ok(!(r.stdout + r.stderr).includes(CODE), "never shown");
  assert.ok(!b.calls().includes(CODE), "never in a docker or sudo argument");
});

test("install-box.sh v2: with a code the terminal ends on the plain line", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; esac; exit 0' });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Done\. Back to your browser\./);
});

test("install-box.sh v2: when the box is not running after the start, the installer fails and says so (it never exits 0 without a running box)", t => {
  const b = box(t); // the stub docker lists no running container
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_VERIFY_TRIES: "1" }, ["--yes", "--from", REPO]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /Vyre is not running/);
  assert.doesNotMatch(r.stdout, /Your server is ready|Back to your browser/);
});

test("install-box.sh v2: when the box is running after the start, the installer is done", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; esac; exit 0' });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_VERIFY_TRIES: "1" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(b.calls().includes("--filter name=vyre-vyre-1 --filter status=running"), b.calls());
});

test("install-box.sh v2: --from as an account outside the docker group stops early with the command to run, and lays nothing out", t => {
  // docker only answers `info` under sudo (the account is not in the docker group)
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; esac; if [ "$1" = info ] && [ -z "${STUB_SUDO:-}" ]; then exit 1; fi; exit 0' });
  fs.writeFileSync(path.join(b.base, "bin", "sudo"), `#!/bin/sh\necho "sudo $*" >>"${b.log}"\nSTUB_SUDO=1 exec "$@"\n`, { mode: 0o755 });
  const r = run({ ...b.env, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sudo usermod -aG docker alex/);
  assert.ok(!fs.existsSync(path.join(b.dir, "compose.yml")), "nothing was laid out");
});

test("install-box.sh v2: the preflight says how many spaces fit, its memory number is the larger store's, and the kernel settings land once in vyre.env", async t => {
  const { REQUIRE } = await import("../stores/twenty/space-store.js");
  assert.equal(Number(/^SPACE_MEM_MB=\$\{VYRE_SPACE_MEM_MB:-(\d+)\}/m.exec(fs.readFileSync(SCRIPT, "utf8"))?.[1]), REQUIRE.memoryMb, "the installer's per-space memory is stores/twenty REQUIRE.memoryMb: change both together");
  const b = box(t);
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(path.join(b.dir, "vyre.env"), "CLOUDFLARE_VYRE_TOKEN=keep\nVYRE_STORE=sqlite\n", { mode: 0o600 });
  const r = run(b.env, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /GB of memory free/);
  const text = fs.readFileSync(path.join(b.dir, "vyre.env"), "utf8");
  assert.match(text, /^CLOUDFLARE_VYRE_TOKEN=keep$/m);
  assert.match(text, /^VYRE_KERNEL=1$/m);
  assert.equal(text.match(/^VYRE_STORE=/gm)?.length, 1, "a person's own VYRE_STORE stays, and none is added");
  assert.match(text, /^VYRE_STORE=sqlite$/m);
});

test("install-box.sh v2: a release with digests is cosign-checked against the workflow identity, then pulled by digest", t => {
  const b = box(t);
  const r = run({ ...b.env, VYRE_BOX_URL: site(b.base) }, ["--yes"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = b.calls();
  const verifies = calls.split("\n").filter(l => / verify /.test(l));
  assert.equal(verifies.length, 2, `box and computer both verified:\n${calls}`);
  for (const l of verifies) {
    assert.match(l, /ghcr\.io\/sigstore\/cosign\/cosign@sha256:[0-9a-f]{64}/, "cosign is pinned by digest");
    assert.match(l, /--certificate-identity-regexp \^https:\/\/github\\\.com\/vyre-ai\/vyre\/\\\.github\/workflows\/release\\\.yml@refs\/tags\//);
    assert.match(l, /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  }
  assert.ok(calls.includes(`docker pull -q ${DIGEST}`), calls);
  assert.ok(!calls.includes("manifest inspect"), "no tag lookup when the release names a digest");
  assert.ok(!fs.existsSync(path.join(b.dir, "vyre.tgz")) && !fs.existsSync(path.join(b.dir, "src")), "nothing built from source");
  assert.match(r.stdout, /signed by Vyre's release workflow/);
});

test("install-box.sh v2: a failed signature check stops the install before anything is laid out", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "run --rm") echo "no matching signatures" >&2; exit 1 ;; esac; exit 0' });
  const r = run({ ...b.env, VYRE_BOX_URL: site(b.base) }, ["--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not verify ghcr\.io\/vyre-ai\/vyre@sha256:/);
  assert.match(r.stderr, /Nothing was installed/);
  assert.ok(!fs.existsSync(b.dir), "no stack folder left behind");
  assert.ok(!b.calls().includes("docker pull"), "an unverified image is never pulled");
});

test("install-box.sh v2: a compose.yml that does not pin the digest release.json names is refused", t => {
  const b = box(t);
  const r = run({ ...b.env, VYRE_BOX_URL: site(b.base, { pin: false }) }, ["--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not pinned by digest/);
  assert.ok(!b.calls().includes(" verify "));
});

test("install-box.sh v2: a release with no digests, or no release.json at all, fails closed", t => {
  const noImages = box(t);
  let r = run({ ...noImages.env, VYRE_BOX_URL: site(noImages.base, { images: false, pin: false }) }, ["--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /names no image digest/);
  assert.ok(!fs.existsSync(noImages.dir), "nothing laid out");

  const noFile = box(t);
  const url = site(noFile.base);
  const dir = url.replace("file://", "");
  fs.unlinkSync(path.join(dir, "release.json"));
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").split("\n").filter(l => !l.includes("release.json")).join("\n"));
  r = run({ ...noFile.env, VYRE_BOX_URL: url }, ["--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no release\.json in its SHA256SUMS/);
  assert.ok(!noFile.calls().includes("docker pull"), "no tag is pulled instead");
});

test("install-box.sh v2: every image the released compose.yml starts must be pinned by digest", t => {
  const b = box(t);
  const url = site(b.base);
  const file = path.join(url.replace("file://", ""), "compose.yml");
  const text = fs.readFileSync(file, "utf8") + "  ts:\n    image: tailscale/tailscale:stable\n";
  fs.writeFileSync(file, text);
  const sumsFile = path.join(path.dirname(file), "SHA256SUMS");
  const h = crypto.createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(sumsFile, fs.readFileSync(sumsFile, "utf8").replace(/^[0-9a-f]{64}(  compose\.yml)$/m, `${h}$1`));
  const r = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not pinned by digest \(image: tailscale\/tailscale:stable\)/);
});

test("install-box.sh v2: a variable or a comment cannot stand in for a pinned image line", t => {
  for (const [why, add] of [["a variable with the digest as its default", `  ts:\n    image: \${VYRE_TAILSCALE_IMAGE:-tailscale/tailscale@sha256:${"c".repeat(64)}}\n`],
    ["a tag with the digest in a comment", `  ts:\n    image: tailscale/tailscale:stable # @sha256:${"c".repeat(64)}\n`]]) {
    const b = box(t);
    const url = site(b.base);
    const file = path.join(url.replace("file://", ""), "compose.yml");
    const text = fs.readFileSync(file, "utf8") + add;
    fs.writeFileSync(file, text);
    const sumsFile = path.join(path.dirname(file), "SHA256SUMS");
    fs.writeFileSync(sumsFile, fs.readFileSync(sumsFile, "utf8").replace(/^[0-9a-f]{64}(  compose\.yml)$/m, `${crypto.createHash("sha256").update(text).digest("hex")}$1`));
    const r = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes"]);
    assert.notEqual(r.status, 0, why);
    assert.match(r.stderr, /not pinned by digest/, why);
    assert.ok(!b.calls().includes("docker pull"), `${why}: nothing was pulled`);
  }
});

test("install-box.sh v2: the install line as shown (curl | VYRE_CODE=... sh) hands sh the code", t => {
  const b = box(t);
  fs.mkdirSync(b.dir, { recursive: true });
  const r = spawnSync("sh", ["-c", `cat '${SCRIPT}' | VYRE_CODE='${CODE}' sh -s -- --yes --from '${REPO}'`], { encoding: "utf8", env: b.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(path.join(b.dir, "vyre.env"), "utf8").includes(`VYRE_SETUP_CODE=${CODE}`), "sh saw the variable");
  // And the placement the reviewer caught: on the reader, it never reaches the script.
  const b2 = box(t);
  fs.mkdirSync(b2.dir, { recursive: true });
  const wrong = spawnSync("sh", ["-c", `VYRE_CODE='${CODE}' cat '${SCRIPT}' | sh -s -- --yes --from '${REPO}'`], { encoding: "utf8", env: b2.env });
  assert.equal(wrong.status, 0);
  const wrongEnv = path.join(b2.dir, "vyre.env");
  assert.ok(!fs.existsSync(wrongEnv) || !fs.readFileSync(wrongEnv, "utf8").includes("VYRE_SETUP_CODE="), "the variable on curl's side is not the script's");
});

test("install-box.sh v2: a running install is updated, never replaced", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "compose -p") echo abc123 ;; esac; exit 0' });
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(path.join(b.dir, "compose.yml"), "# mine\n");
  const r = run(b.env, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already running/);
  assert.match(r.stdout, /vyre update/);
  assert.equal(fs.readFileSync(path.join(b.dir, "compose.yml"), "utf8"), "# mine\n", "compose.yml untouched");
  assert.ok(!fs.existsSync(b.env.VYRE_WRAPPER), "no wrapper written");
});

test("install-box.sh v2: Podman and rootless Docker stop with a plain line", t => {
  const podman = box(t, { docker: 'case "$1" in --version) echo "podman version 4.9" ;; esac; case "$1 $2" in "compose version") echo 2.29.1 ;; esac; exit 0' });
  let r = run(podman.env, ["--dry-run", "--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Podman/);
  const rootless = box(t, { docker: 'case "$1" in info) [ "$2" = --format ] && echo "[name=seccomp name=rootless]"; exit 0 ;; esac; case "$1 $2" in "compose version") echo 2.29.1 ;; esac; exit 0' });
  r = run(rootless.env, ["--dry-run", "--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rootless/);
});

// --- vyre uninstall (box/vyre): one flow, every volume named, asking is approving ---

const BOXVYRE = path.join(REPO, "box", "vyre");
const VOLS = ["vyre_vyre-home", "vyre_vyre-work", "vyre_vyre-accounts", "vyre_vyre-agent-home", "vyre_mystery"];

/** A box with a stack folder, our wrapper installed, and a docker that knows the volumes. */
function installed(t) {
  const b = box(t, {
    docker: `case "$1 $2" in "compose version") echo 2.29.1 ;; "volume ls") printf '%s\\n' ${VOLS.join(" ")} ;; "ps -aq") echo c1 c2 ;; "image ls") printf '%s\\n' img2 img1 img2 ;; esac; exit 0`,
  });
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(path.join(b.dir, "compose.yml"), "name: vyre\n");
  fs.mkdirSync(path.dirname(b.env.VYRE_WRAPPER), { recursive: true });
  fs.copyFileSync(BOXVYRE, b.env.VYRE_WRAPPER);
  return b;
}
const uninstall = (b, args) => spawnSync("sh", [BOXVYRE, "uninstall", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: b.env });

test("vyre uninstall: with no answer the data is kept, every volume is listed in plain words, and the wrapper goes", t => {
  const b = installed(t);
  const r = uninstall(b, []);
  assert.equal(r.status, 0, r.stderr);
  for (const v of VOLS) assert.ok(r.stdout.includes(v), `${v} is named:\n${r.stdout}`);
  assert.match(r.stdout, /vyre_vyre-accounts: each AI account's sign-in/);
  assert.match(r.stdout, /vyre_mystery: Vyre data/, "an unknown volume is still listed");
  assert.match(r.stdout, /your data is kept/);
  const calls = b.calls();
  assert.ok(!calls.includes("volume rm"), calls);
  assert.ok(calls.includes("rm -f c1 c2"), "agents' computers are removed");
  assert.ok(calls.includes("compose --profile computers down --remove-orphans"), calls);
  assert.ok(calls.includes("image rm -f img1 img2"), "Vyre's own images go, once each: " + calls);
  assert.ok(!fs.existsSync(b.env.VYRE_WRAPPER), "the vyre command is removed");
  assert.doesNotMatch(r.stdout, /Tailscale/i, "no Tailscale step: there is none");
  assert.match(r.stdout, /vyre backup/, "the export is offered beside it");
});

test("vyre uninstall --delete-data deletes every volume in one step, with no second confirm", t => {
  const b = installed(t);
  const r = uninstall(b, ["--delete-data"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(b.calls().includes(`volume rm ${VOLS.join(" ")}`), b.calls());
  assert.match(r.stdout, /your data is deleted/);
});

test("vyre uninstall --keep-data and a bad option", t => {
  const b = installed(t);
  const bad = uninstall(b, ["--nuke"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown option --nuke/);
  assert.ok(fs.existsSync(b.env.VYRE_WRAPPER), "a bad option changes nothing");
  const r = uninstall(b, ["--keep-data"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!b.calls().includes("volume rm"));
});

test("install-box.sh --uninstall --purge --yes hands the one uninstall the delete answer", t => {
  const b = installed(t);
  const r = run(b.env, ["--uninstall", "--purge", "--yes"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(b.calls().includes("volume rm"), b.calls());
});


// --- the progress mailbox: the install's steps reach the setup page, sealed, in order ---

test("install-box.sh v2: with a code the steps are sent sealed to the relay mailbox, and only the page's key can read them", async t => {
  const relay = createRelay({});
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = box(t);
  const key = await createSetupKey();
  const secret = crypto.randomBytes(16);
  const code = await setupCode(secret, key.spki);
  // An openssl with no `dgst -mac` (a Mac's LibreSSL on some releases): the script must not need it.
  const real = spawnSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(b.base, "bin", "openssl"), `#!/bin/sh\nfor a in "$@"; do case "$a" in -mac|-macopt) echo "unknown option $a" >&2; exit 1 ;; esac; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  const r = await runAsync({ ...b.env, VYRE_CODE: code, VYRE_RELAY: base }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr + b.calls()).includes(code), "the code is still never shown");
  const reader = await mailboxReader({ relay: base, secret, key, wait: 0 });
  const lines = await reader.next(0);
  assert.ok(lines.length >= 6, `the steps arrived: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^\[1\/4\] Checking Docker$/);
  assert.ok(lines.some(l => /^done: /.test(l)));
  assert.ok(lines.some(l => /Installing the vyre command/.test(l)));
  // A reader with another key gets nothing.
  const other = await createSetupKey();
  await assert.rejects(mailboxReader({ relay: base, secret, key: other, wait: 0 }).then(x => x.next(0)), /would not give this page/);
});

test("install-box.sh v2: a second paste of the same code on a running install posts nothing to the mailbox", async t => {
  const relay = createRelay({});
  const base = await relay.listen();
  t.after(() => relay.close());
  const b = box(t);
  const key = await createSetupKey();
  const secret = crypto.randomBytes(16);
  const code = await setupCode(secret, key.spki);
  const first = await runAsync({ ...b.env, VYRE_CODE: code, VYRE_RELAY: base }, ["--yes", "--from", REPO]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const before = (await (await mailboxReader({ relay: base, secret, key, wait: 0 })).next(0)).length;
  // Now the stack is up: the fake docker answers `compose -p vyre ps -q` with a container id.
  fs.writeFileSync(path.join(b.base, "bin", "docker"), `#!/bin/sh\ncase "$1 $2" in "compose version") echo 2.29.1 ;; "compose -p") echo abc123 ;; esac\nexit 0\n`, { mode: 0o755 });
  const second = await runAsync({ ...b.env, VYRE_CODE: code, VYRE_RELAY: base }, ["--yes", "--from", REPO]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /already running/);
  const after = (await (await mailboxReader({ relay: base, secret, key, wait: 0 })).next(0)).length;
  assert.equal(after, before, "the second paste wrote no lines, so the page's reader stays in order");
});

test("install-box.sh v2: a code another server already used stops with the plain refusal", async t => {
  const relay = createRelay({});
  const base = await relay.listen();
  t.after(() => relay.close());
  const key = await createSetupKey();
  const code = await setupCode(crypto.randomBytes(16), key.spki);
  // The first box uses the code; the second, with a different fingerprint claim at the same locator, is refused.
  const first = box(t), second = box(t);
  const a = await runAsync({ ...first.env, VYRE_CODE: code, VYRE_RELAY: base }, ["--yes", "--from", REPO]);
  assert.equal(a.status, 0, a.stderr);
  // Same locator, another writer token: the mailbox is contested, so the second install refuses to go on.
  const other = await createSetupKey();
  const raw = Buffer.from(code, "base64url");
  const forged = Buffer.concat([raw.subarray(0, 16), Buffer.from(await (await import("../relay/client/setup.js")).setupFingerprint(other.spki))]).toString("base64url");
  const c = await runAsync({ ...second.env, VYRE_CODE: forged, VYRE_RELAY: base }, ["--yes", "--from", REPO]);
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /Another server already used this code\. Your browser is not connected to this server\. Start again at https:\/\/vyre\.run\/setup\./);
  assert.ok(!fs.existsSync(second.dir), "nothing was installed");
});

test("install-box.sh v2: the check words come from the box, show on the terminal, and never go through the mailbox", t => {
  const b = box(t, { docker: `case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; "compose exec") case "$*" in *relay.setup.status*) echo '{"data":{"state":"waiting","words":"lantern quiet river oak"}}' ;; esac ;; esac; exit 0` });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Check words: lantern quiet river oak/);
  assert.match(r.stdout, /They should match the four on your screen\./);
  assert.ok(r.stdout.indexOf("Check words") < r.stdout.indexOf("Done. Back to your browser."), "words, then the plain last line");
  assert.ok(!b.calls().includes("lantern"), "the words are not sent anywhere");
});

test("vyre wrapper: a setup code older than an hour is removed from vyre.env at the next up or update, a fresh one stays", t => {
  const b = box(t);
  fs.mkdirSync(b.dir, { recursive: true });
  const f = path.join(b.dir, "vyre.env");
  const fn = fs.readFileSync(BOXVYRE, "utf8").match(/^expire_code\(\) \{[\s\S]*?^\}/m)[0];
  const call = () => spawnSync("sh", ["-c", `DIR='${b.dir}'\n${fn}\nexpire_code`], { encoding: "utf8", env: b.env });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(f, `CLOUDFLARE_VYRE_TOKEN=keep\nVYRE_SETUP_CODE_AT=${now - 4000}\nVYRE_SETUP_CODE=${CODE}\n`, { mode: 0o600 });
  assert.equal(call().status, 0);
  assert.equal(fs.readFileSync(f, "utf8"), "CLOUDFLARE_VYRE_TOKEN=keep\n", "the expired code and its time are gone, the rest is kept");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, `VYRE_SETUP_CODE_AT=${now - 100}\nVYRE_SETUP_CODE=${CODE}\n`, { mode: 0o600 });
  call();
  assert.ok(fs.readFileSync(f, "utf8").includes(`VYRE_SETUP_CODE=${CODE}`), "a code inside its hour stays");
});


// --- a Mac runs the same line: the Mac server's installer comes from the site, checked, with the same arguments and code ---

test("install-box.sh v2: on a Mac it fetches install-mac-server.sh, checks it against SHA256SUMS, and runs it with the same arguments and VYRE_CODE", t => {
  const b = box(t);
  fs.writeFileSync(path.join(b.base, "bin", "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  const url = site(b.base);
  const dir = url.replace("file://", "");
  const out = path.join(b.base, "mac-ran.txt");
  const script = `#!/bin/sh\nprintf 'args=%s code=%s\\n' "$*" "$VYRE_CODE" >"${out}"\n`;
  fs.writeFileSync(path.join(dir, "install-mac-server.sh"), script);
  const sums = path.join(dir, "SHA256SUMS");
  fs.appendFileSync(sums, `${crypto.createHash("sha256").update(script).digest("hex")}  install-mac-server.sh\n`);
  const r = run({ ...b.env, VYRE_BOX_URL: url, VYRE_CODE: CODE }, ["--yes", "--name", "harlow"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), `args=--yes --name harlow code=${CODE}\n`);
  assert.ok(!fs.existsSync(b.dir), "nothing of the Linux install ran");

  // A tampered script, or one the checksum list does not name, never runs.
  fs.writeFileSync(path.join(dir, "install-mac-server.sh"), script + "# changed\n");
  fs.rmSync(out);
  let x = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes"]);
  assert.notEqual(x.status, 0);
  assert.match(x.stderr, /checksum mismatch for .*install-mac-server\.sh/);
  assert.ok(!fs.existsSync(out));
  fs.writeFileSync(sums, fs.readFileSync(sums, "utf8").split("\n").filter(l => l && !l.includes("install-mac-server.sh")).join("\n") + "\n");
  x = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes"]);
  assert.notEqual(x.status, 0);
  assert.match(x.stderr, /SHA256SUMS has no line for install-mac-server\.sh/);
  assert.ok(!fs.existsSync(out));
});
