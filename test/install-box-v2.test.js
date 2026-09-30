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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    VYRE_WRAPPER: path.join(base, "bin-out", "vyre"), VYRE_TUN: "/dev/null", VYRE_DOCKER_SOCK: path.join(base, "none"),
    VYRE_NO_UP: "1",
  };
  return { base, env, log, dir: env.VYRE_DIR, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

/** @param {Record<string,string>} env @param {string[]} args */
const run = (env, args) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });

/** A file:// release site: the box files, a SHA256SUMS over them, and release.json. */
function site(base, { images = true, pin = true } = {}) {
  const dir = path.join(base, "site");
  fs.mkdirSync(dir, { recursive: true });
  const compose = pin ? `image: \${VYRE_IMAGE:-${DIGEST}}\ncomputer: ${COMPUTER}\n` : "image: ghcr.io/vyre-ai/vyre:latest\n";
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
  assert.ok(!(r.stdout + r.stderr).includes(CODE), "never shown");
  assert.ok(!b.calls().includes(CODE), "never in a docker or sudo argument");
});

test("install-box.sh v2: with a code the terminal ends on the plain line", t => {
  const b = box(t);
  const r = run({ ...b.env, VYRE_CODE: CODE, VYRE_NO_UP: "0" }, ["--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Done\. Back to your browser\./);
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
  assert.match(r.stderr, /not pinned by digest \(tailscale\/tailscale:stable\)/);
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
  assert.ok(!fs.existsSync(path.join(b2.dir, "vyre.env")), "the variable on curl's side is not the script's");
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
const VOLS = ["vyre_vyre-home", "vyre_vyre-work", "vyre_vyre-accounts", "vyre_vyre-agent-home", "vyre_tailscale-state", "vyre_mystery"];

/** A box with a stack folder, our wrapper installed, and a docker that knows the volumes. */
function installed(t) {
  const b = box(t, {
    docker: `case "$1 $2" in "compose version") echo 2.29.1 ;; "volume ls") printf '%s\\n' ${VOLS.join(" ")} ;; "ps -aq") echo c1 c2 ;; esac; exit 0`,
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
  assert.ok(!fs.existsSync(b.env.VYRE_WRAPPER), "the vyre command is removed");
  assert.match(r.stdout, /Tailscale machines list/);
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
