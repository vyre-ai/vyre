// @ts-check
// install-box.sh v2 (0.2 launch plan, C6/R6/R7/M6): the setup code is never an argument, a release
// that names image digests is cosign-checked and pulled by digest, a running install is never replaced,
// and the Docker flavors that cannot work stop in plain words. All against stub docker/sudo and a
// file:// release site: no network, no real Docker.
import "../scripts/mac-test-guard.mjs";
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

/** @param {import("node:test").TestContext} t @param {{docker?: string, sudo?: string}} [opts] */
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
    sudo: `echo "sudo $*" >>"${log}"\n` + (opts.sudo ?? 'exec "$@"'),
  };
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: base, VYRE_DIR: path.join(base, "srv", "vyre"),
    VYRE_WRAPPER: path.join(base, "bin-out", "vyre"), VYRE_DOCKER_SOCK: path.join(base, "none"),
    VYRE_NO_UP: "1", VYRE_MODULES_TRIES: "0", VYRE_DEV_SIGN: "0",
    // the stub box answers the check words at once or never (the sudo retry starts at the third ask): the installer waits for them up to 180 tries, about 3 minutes, otherwise
    VYRE_WORDS_TRIES: "4",
    // Never the machine's own units: on a host that runs a real Vyre the uninstall sees them and keeps the wrapper.
    VYRE_SYSTEMD_DIR: path.join(base, "systemd"),
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
function site(base, { images = true, pin = true, extra = /** @type {Record<string,string>} */ ({}) } = {}) {
  const dir = path.join(base, "site");
  fs.mkdirSync(dir, { recursive: true });
  const compose = pin ? `services:\n  vyre:\n    image: ${DIGEST}\n    environment:\n      - VYRE_COMPUTERS_IMAGE=\${VYRE_COMPUTERS_IMAGE:-${COMPUTER}}\n` : "image: ghcr.io/vyre-ai/vyre:latest\n";
  const files = {
    VERSION: "0.2.0\n", "compose.yml": compose, "compose.build.yml": "# build\n", "vyre.env.example": "# env\n", vyre: "#!/bin/sh\n# vyre on a Docker box\n[ \"$1\" = status ] && echo \"  3 modules running\"\nexit 0\n",
    "release.json": JSON.stringify({ version: "0.2.0", channel: "stable", ...(images ? { images: { box: { ref: DIGEST, platforms: ["linux/amd64"] }, computer: { ref: COMPUTER, platforms: ["linux/amd64"] } } } : {}) }, null, 2),
  };
  Object.assign(files, extra);
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
  assert.match(r.stdout, /Go back to the Vyre app to finish\./);
});

test("install-box.sh v2: when the box is not running after the start, the installer fails and says so (it never exits 0 without a running box)", t => {
  const b = box(t); // the stub docker lists no running container
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_VERIFY_TRIES: "1" }, ["--yes", "--from", REPO]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /Vyre is not running/);
  assert.doesNotMatch(r.stdout, /Vyre is running on this server|Back in the Vyre app/);
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
  const { REQUIRE, requireFor } = await import("../stores/twenty/space-store.js");
  assert.equal(Number(/^SPACE_MEM_TINY_MB=(?:\$\{VYRE_SPACE_MEM_TINY_MB:-)?(\d+)/m.exec(fs.readFileSync(SCRIPT, "utf8"))?.[1]), requireFor(4096).memoryMb, "the installer's small-server number is requireFor(4096): change both together");
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

test("install-box.sh v2: the custody notice is the one the kernel says, and it is printed when the server is ready", async t => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const said = /^CUSTODY_NOTE="(.*)"$/m.exec(text)?.[1];
  assert.ok(said);
  const mod = await import("../kernel/seal/process.js").catch(() => null);
  if (mod && mod.custodyNote) assert.equal(said, mod.custodyNote("server", "linux"));
  const win = fs.readFileSync(path.join(REPO, "scripts", "install-windows.ps1"), "utf8");
  assert.match(win, /About your keys: Sealed data on this PC is only as protected as this PC's own Windows account: any program running as you can read the key file\./);
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc ;; esac; exit 0' });
  const r = run({ ...b.env, VYRE_NO_UP: "0", VYRE_VERIFY_TRIES: "1" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("About your keys: " + said), r.stdout);
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
  assert.match(lines[0], /^\[1\/4\] Checking this server$/);
  assert.ok(lines.some(l => /^done: /.test(l)));
  assert.ok(lines.some(l => /Adding the vyre command/.test(l)));
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
  assert.match(c.stderr, /Another server already used this code\. Run the install line again to get a new code\./);
  assert.ok(!fs.existsSync(second.dir), "nothing was installed");
});

test("install-box.sh v2: the check words come from the box, show on the terminal, and never go through the mailbox", t => {
  const b = box(t, { docker: `case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; "compose exec") case "$*" in *relay.setup.status*) echo '{"data":{"state":"waiting","words":"lantern quiet river oak"}}' ;; esac ;; esac; exit 0` });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Your four words: lantern quiet river oak/);
  assert.match(r.stdout, /If it shows the same four, choose Same\./);
  assert.ok(r.stdout.indexOf("Your four words") < r.stdout.indexOf("Go back to the Vyre app to finish."), "words, then the plain last line");
  assert.ok(!b.calls().includes("lantern"), "the words are not sent anywhere");
});

// A server whose account may not talk to the box itself: Docker answers `info` and the box answers the check words only to a root caller (the sudo stub says so).
const ROOT_ONLY = `case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; "compose exec") case "$*" in *relay.setup.status*) [ -n "$FAKE_ROOT" ] && echo '{"data":{"state":"waiting","words":"lantern quiet river oak"}}' ;; esac ;; esac; exit 0`;
const AS_ROOT = '[ "$1" = -n ] && shift\nFAKE_ROOT=1 exec "$@"';
// The wrapper a downloaded install lays down, as a stub: it answers the check words to a root caller only.
const WRAPPER_STUB = `#!/bin/sh\ncase "$*" in "call relay.setup.status") [ -n "$FAKE_ROOT" ] && echo '{"data":{"words":"lantern quiet river oak"}}' ;; esac\nexit 0\n`;

test("install-box.sh v2: IR-1 an account that cannot reach Docker still gets the check words, through the same sudo path vyre up took", t => {
  const b = box(t, { sudo: AS_ROOT, docker: `case "$1" in info) [ -n "$FAKE_ROOT" ] || exit 1 ;; esac\n${ROOT_ONLY}` });
  const r = run({ ...b.env, VYRE_BOX_URL: site(b.base, { extra: { vyre: WRAPPER_STUB } }), VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Your four words: lantern quiet river oak/);
  assert.match(b.calls(), /sudo env VYRE_DIR=\S+ \S+ call relay\.setup\.status/, "the call went through sudo");
});

test("install-box.sh v2: IR-1 words only a root caller can read are tried through sudo, not given up on", t => {
  const b = box(t, { sudo: AS_ROOT, docker: ROOT_ONLY });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Your four words: lantern quiet river oak/);
});

test("install-box.sh v2: IR-1 words that cannot be read at all are said so, with the command that shows them", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; esac; exit 0' });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_WORDS_TRIES: "3" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /The four words did not show yet\. To see them, run: sudo vyre words/);
  assert.ok(r.stdout.indexOf("four words did not show") < r.stdout.indexOf("Go back to the Vyre app to finish."));
});

test("install-box.sh v2: a box that says why it did not take the setup code is believed at once, and the person is told what to do, not left on the fallback line", t => {
  const why = "the relay or this box refused the setup code: too many setup requests; wait a minute";
  const b = box(t, { docker: `case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; "compose exec") case "$*" in *relay.setup.status*) echo '{"data":{"state":"none","failed":true,"why":"${why}"}}' ;; esac ;; esac; exit 0` });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_WORDS_TRIES: "50" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Vyre could not start the pairing: the relay or this box refused the setup code: too many setup requests; wait a minute/);
  assert.match(r.stdout, /Make a new install line in the Vyre app and run it again\./);
  assert.doesNotMatch(r.stdout, /The four words did not show yet/);
});

const PAIRING_BOX = `case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; "compose exec") case "$*" in *relay.setup.status*) echo '{"data":{"words":"lantern quiet river oak"}}' ;; *wink.server.code*) echo '{"data":{"qr":"WINKLONGCODE","art":"##","code":"ABCD-EFGH","code_tries":3,"code_expires":9999999999999}}' ;; esac ;; esac; exit 0`;

test("install-box.sh v2: IR-2 with a setup code the terminal shows the check words only, no pairing QR, long code or typed code", t => {
  const b = box(t, { docker: PAIRING_BOX });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Your four words: lantern quiet river oak/);
  for (const gone of [/WINKLONGCODE/, /Long code/, /ABCD-EFGH/, /type this code/i, /Pair this server from your Vyre app/]) assert.doesNotMatch(r.stdout, gone);
  assert.ok(!b.calls().includes("wink.server.code"), "the pairing was not even asked for");
});

test("install-box.sh v2: without a setup code the terminal asks nothing and pairs nothing: it says to use the app's line, and the start is quiet", t => {
  const b = box(t, { docker: PAIRING_BOX });
  const r = run({ ...b.env, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Open the Vyre app, choose "Add a server", and run the line it shows on this server\./);
  for (const gone of [/Long code/, /WINKLONGCODE/, /type this code/i, /Pair this server from your Vyre app/, /wink\.server\.code/]) assert.doesNotMatch(r.stdout, gone);
  assert.ok(!b.calls().includes("wink.server.code") && !b.calls().includes("wink.server.pairing"), "the pairing was not asked for");
  assert.match(b.calls(), /vyre up --quiet/, "the installer starts vyre without its own pairing or status lines");
  assert.doesNotMatch(r.stdout, /already running|not paired yet/);
});

/** A server with no Docker: the get.docker.com script (a curl stub) prints a flood, and either installs a Docker stub or fails. */
function noDocker(t, { fail = false } = {}) {
  const b = box(t);
  const bin = path.join(b.base, "bin");
  const installed = `#!/bin/sh\ncase "$1 $2" in "compose version") echo 2.29.1 ;; esac\nexit 0\n`;
  fs.rmSync(path.join(bin, "docker"));
  // The machine's own tools without its docker: a PATH folder of links to everything in /usr/bin and /bin but the Docker programs.
  const tools = path.join(b.base, "tools");
  fs.mkdirSync(tools);
  for (const d of ["/usr/bin", "/bin"]) for (const n of fs.readdirSync(d)) if (!/^(docker|podman)/.test(n) && !fs.existsSync(path.join(tools, n))) { try { fs.symlinkSync(path.join(d, n), path.join(tools, n)); } catch {} }
  b.env.PATH = `${bin}:${tools}`;
  const script = `echo NOISE_FROM_DOCKER_SCRIPT\necho "rootless note" >&2\n` + (fail ? "exit 1\n" : `printf '%s' '${installed.replace(/'/g, "'\\''")}' > "${path.join(bin, "docker")}"\nchmod 755 "${path.join(bin, "docker")}"\n`);
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\ncat <<'EOS'\n${script}EOS\n`, { mode: 0o755 });
  return b;
}

test("install-box.sh v2: IR-7 Docker's own install output goes to a log, and the screen shows one progress line", t => {
  const b = noDocker(t);
  const r = run({ ...b.env, TMPDIR: b.base }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Installing Docker\. This takes a minute or two\./);
  assert.doesNotMatch(r.stdout + r.stderr, /NOISE_FROM_DOCKER_SCRIPT|rootless note|vyre-docker-install/);
  assert.deepEqual(fs.readdirSync(b.base).filter(n => n.startsWith("vyre-docker-install")), [], "the log of a good install is not left behind");
});

test("install-box.sh v2: IR-7 when Docker's install fails the screen names the log, which holds the output", t => {
  const b = noDocker(t, { fail: true });
  const r = run({ ...b.env, TMPDIR: b.base }, ["--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /NOISE_FROM_DOCKER_SCRIPT|rootless note/);
  const log = (r.stderr.match(/output is in (\S+);/) || [])[1];
  assert.ok(log, r.stderr);
  assert.match(fs.readFileSync(log, "utf8"), /NOISE_FROM_DOCKER_SCRIPT/);
});

test("install-box.sh v2: a root run on Ubuntu with no Docker installs it from Docker's signed apt repository, with one printed line and no question", t => {
  const b = noDocker(t);
  const bin = path.join(b.base, "bin");
  const calls = path.join(b.base, "apt.calls");
  const inst = `printf '#!/bin/sh\\ncase "$1 $2" in "compose version") echo 2.29.1 ;; esac\\nexit 0\\n' > "${path.join(bin, "docker")}"; chmod 755 "${path.join(bin, "docker")}"`;
  fs.writeFileSync(path.join(bin, "apt-get"), `#!/bin/sh\necho "apt-get $*" >> "${calls}"\ncase "$*" in *docker-ce*) ${inst} ;; esac\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "dpkg"), `#!/bin/sh\necho amd64\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho "curl $*" >> "${calls}"\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && echo KEY > "$2"; shift; done\nexit 0\n`, { mode: 0o755 });
  const osr = path.join(b.base, "os-release");
  fs.writeFileSync(osr, 'ID=ubuntu\nVERSION_CODENAME=noble\n');
  const aroot = path.join(b.base, "aroot");
  const r = run({ ...b.env, TMPDIR: b.base, VYRE_APT_AS_ROOT: "0", VYRE_OS_RELEASE: osr, VYRE_APT_ROOT: aroot }, ["--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Installing Docker \(about a minute\)\./);
  assert.doesNotMatch(r.stdout + r.stderr, /get\.docker\.com|\[y\/N\]/);
  const log = fs.readFileSync(calls, "utf8");
  assert.match(log, /curl .*download\.docker\.com\/linux\/ubuntu\/gpg/);
  assert.match(log, /apt-get install -y docker-ce docker-ce-cli containerd\.io docker-buildx-plugin docker-compose-plugin/);
  assert.doesNotMatch(log, /get\.docker\.com/);
  assert.match(fs.readFileSync(path.join(aroot, "etc/apt/sources.list.d/docker.list"), "utf8"), /^deb \[arch=amd64 signed-by=\/etc\/apt\/keyrings\/docker\.asc\] https:\/\/download\.docker\.com\/linux\/ubuntu noble stable\n?$/);
  // Another system keeps the older way: nothing from apt runs.
  fs.rmSync(calls);
  fs.rmSync(path.join(bin, "docker"), { force: true });
  fs.writeFileSync(osr, 'ID=fedora\nVERSION_CODENAME=\n');
  const c = noDocker(t);
  const r2 = run({ ...c.env, TMPDIR: c.base, VYRE_APT_AS_ROOT: "0", VYRE_OS_RELEASE: osr }, ["--yes", "--from", REPO]);
  assert.match(r2.stdout, /Installing Docker\. This takes a minute or two\./);
  assert.equal(fs.existsSync(calls), false, "apt was not used on a system that is not Ubuntu or Debian");
});

test("install-box.sh v2: the Records choice rides the install line as VYRE_STORE: auto (the default) or sqlite, written once into vyre.env; anything else stops the install", t => {
  const b = box(t);
  let r = run({ ...b.env, VYRE_STORE: "sqlite" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(b.dir, "vyre.env"), "utf8"), /^VYRE_STORE=sqlite$/m, "without Records: the small built-in store");
  const d = box(t);
  r = run(d.env, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(d.dir, "vyre.env"), "utf8"), /^VYRE_STORE=auto$/m, "with Records is the default");
  // a person's choice already in vyre.env stays when the line is run again
  const e = box(t);
  fs.mkdirSync(e.dir, { recursive: true });
  fs.writeFileSync(path.join(e.dir, "vyre.env"), "VYRE_STORE=sqlite\n", { mode: 0o600 });
  run({ ...e.env, VYRE_STORE: "auto" }, ["--yes", "--from", REPO]);
  assert.equal(fs.readFileSync(path.join(e.dir, "vyre.env"), "utf8").match(/^VYRE_STORE=/gm)?.length, 1);
  assert.match(fs.readFileSync(path.join(e.dir, "vyre.env"), "utf8"), /^VYRE_STORE=sqlite$/m);
  const f = box(t);
  r = run({ ...f.env, VYRE_STORE: "twenty" }, ["--yes", "--from", REPO]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /VYRE_STORE is auto \(Records\) or sqlite/);
  assert.ok(!fs.existsSync(f.dir), "nothing was installed");
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


test("install-box.sh: the Space helper is installed as soon as the container is running, before the wait for modules (the entry holds the daemon back until the helper proves the firewall), and once, not after the wait", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const body = src.slice(src.indexOf("\nverify_up() {"), src.indexOf("\n}\n", src.indexOf("\nverify_up() {")));
  const at = (/** @type {string} */ re) => body.search(new RegExp(re));
  assert.ok(at("install_space_helper") > at("status=running") && at("install_space_helper") < at("modules running"), "inside verify_up, after the container runs and before the modules wait");
  assert.equal((src.match(/^\s*install_space_helper$/gm) ?? []).length, 1, "called once");
  assert.ok(!/verify_running_build; install_space_helper/.test(src), "no second call after the wait");
});

test("install-box.sh: --version names what the release site must serve; another version stops the install and names both", t => {
  const b = box(t);
  const url = site(b.base);
  let r = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes", "--version", "0.2.9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /asked for Vyre 0\.2\.9, but .* serves 0\.2\.0\. Nothing was installed/);
  assert.match(r.stderr, /--version 0\.2\.0/);
  assert.ok(!fs.existsSync(b.dir), "nothing laid out");
  assert.ok(!b.calls().includes("docker pull"), "no image is pulled");

  // the same version, and latest, and no version at all, go through to the next step (the stub docker stops it later, never at the version check)
  for (const args of [["--version", "0.2.0"], ["--version=0.2.0"], ["--version", "latest"], []]) {
    const c = box(t);
    r = run({ ...c.env, VYRE_BOX_URL: site(c.base) }, ["--yes", ...args]);
    assert.doesNotMatch(r.stderr, /asked for Vyre|cannot be checked|not a version/, args.join(" "));
  }
  const d = box(t);
  r = run({ ...d.env, VYRE_BOX_URL: site(d.base) }, ["--yes", "--version", "0.2.9; rm"]);
  assert.match(r.stderr, /not a version like 0\.2\.9/);
  const e = box(t);
  r = run({ ...e.env, VYRE_BOX_URL: site(e.base), VYRE_VERSION: "0.2.5" }, ["--yes"]);
  assert.match(r.stderr, /asked for Vyre 0\.2\.5/, "VYRE_VERSION is the same as --version");
});

test("install-box.sh on a Mac: the version is checked on this path too, and the other arguments reach the Mac script one by one", t => {
  const b = box(t);
  fs.writeFileSync(path.join(b.base, "bin", "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  const out = path.join(b.base, "args.txt");
  const mac = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "[$a]"; done >"${out}"\n`;
  const url = site(b.base, { extra: { "install-mac-server.sh": mac } });
  // another version than the site serves: refused before the Mac script runs, saying how to install a build that is not published
  let r = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes", "--version", "0.2.9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /asked for Vyre 0\.2\.9, but .* serves 0\.2\.0\. Nothing was installed/);
  assert.match(r.stderr, /--from <folder>/);
  assert.ok(!fs.existsSync(out), "the Mac script did not run");
  // the served version: the script runs, never sees --version, and an argument with a space stays one argument
  r = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes", "--version", "0.2.0", "--name", "my mac"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), "[--yes]\n[--name]\n[my mac]\n");
  // --version=V form, and --version given last, are taken out the same way
  r = run({ ...b.env, VYRE_BOX_URL: url }, ["--version=0.2.0", "a  b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), "[a  b]\n");
});

test("install-box.sh: a site that does not list VERSION cannot confirm a named version, and says so", t => {
  const b = box(t);
  const url = site(b.base);
  const dir = url.replace("file://", "");
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").split("\n").filter(l => !l.endsWith("  VERSION")).join("\n"));
  const r = run({ ...b.env, VYRE_BOX_URL: url }, ["--yes", "--version", "0.2.0"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not say which version it serves/);
});

test("install-box.sh v2: Docker is made to start at boot when it is not, so the restart policy brings the server back after a reboot or a power cut", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; esac; exit 0' });
  // a systemctl that knows docker and containerd, says they are disabled, and records what it is told
  const sc = (state) => `echo "systemctl $*" >>"${b.log}"\ncase "$1" in cat) exit 0 ;; is-enabled) echo ${state}; exit 0 ;; enable) exit 0 ;; esac; exit 0`;
  fs.writeFileSync(path.join(b.base, "bin", "systemctl"), `#!/bin/sh\n${sc("disabled")}\n`, { mode: 0o755 });
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_VERIFY_TRIES: "1" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(b.calls(), /systemctl enable docker/);
  assert.match(b.calls(), /systemctl enable containerd/);
  // already enabled: nothing is changed
  const b2 = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; esac; exit 0' });
  fs.writeFileSync(path.join(b2.base, "bin", "systemctl"), `#!/bin/sh\necho "systemctl $*" >>"${b2.log}"\ncase "$1" in is-enabled) echo enabled ;; esac\nexit 0\n`, { mode: 0o755 });
  const r2 = run({ ...b2.env, VYRE_CODE: CODE, VYRE_NO_UP: "0", VYRE_VERIFY_TRIES: "1" }, ["--yes", "--from", REPO]);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.doesNotMatch(b2.calls(), /systemctl enable/);
});

// The install line is run as root on most servers (a fresh droplet logs in as root), and the release `vyre` command refuses a root run that inherits any VYRE_ setting (its root_guard):
// the installer must keep VYRE_STORE and VYRE_CODE out of the environment of every vyre command it runs. The stub `vyre` writes what it inherited into a file.
const SEES_ENV_WRAPPER = `#!/bin/sh\nprintf '%s|%s\\n' "$VYRE_STORE" "$VYRE_CODE" >>"$WRAP_SAW"\ncase "$*" in "call relay.setup.status") echo '{"data":{"words":"lantern quiet river oak"}}' ;; esac\nexit 0\n`;
test("install-box.sh v2: VYRE_STORE and VYRE_CODE do not reach the vyre command's environment, and the store choice still reaches vyre.env", t => {
  const b = box(t, { docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; "ps -q") echo abc123 ;; esac; exit 0' });
  const saw = path.join(b.base, "saw.log");
  const r = run({ ...b.env, WRAP_SAW: saw, VYRE_BOX_URL: site(b.base, { extra: { vyre: SEES_ENV_WRAPPER } }), VYRE_CODE: CODE, VYRE_STORE: "sqlite", VYRE_NO_UP: "0" }, ["--yes"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = fs.existsSync(saw) ? fs.readFileSync(saw, "utf8").trim().split("\n") : [];
  assert.ok(seen.length > 0, "the installer ran the vyre command at least once");
  assert.deepEqual([...new Set(seen)], ["|"], "no run of the vyre command inherited VYRE_STORE or VYRE_CODE");
  assert.match(fs.readFileSync(path.join(b.dir, "vyre.env"), "utf8"), /^VYRE_STORE=sqlite$/m, "the choice the line carried is in vyre.env");
});
