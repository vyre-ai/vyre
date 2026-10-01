// @ts-check
// The release build of box/vyre (scripts/strip-wrapper.mjs): every test override cut out, the pinned key and cosign image as constants.
// reviewer-2's blocker: one wrapper is installed at /usr/local/bin/vyre and run by root (the path unit) and by the person, and it
// honoured VYRE_RELEASE_KEY, VYRE_COSIGN_IMAGE and others from the environment, and ran its signature check inside an image named in a file
// the person can write. Here the built wrapper is checked: clean of every name, identical to the source except the marked block, and
// then run with every hostile override and a hostile .env to show each is ignored or refused. Functions of the stripped text are run
// (the file cut before its dispatch), with a fake docker that records every call and says yes to everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { strip, SEAMS } from "../scripts/strip-wrapper.mjs";
import { SCRATCH } from "./scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
const BUILT = strip(SOURCE);
const spki = k => k.export({ type: "spki", format: "der" }).toString("base64");
const THROWAWAY = crypto.generateKeyPairSync("ed25519");
const signSums = (sums, key) => crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), key).toString("base64") + "\n";

test("build-clean: the release wrapper names none of the test overrides, parses, and equals the source except the marked block", () => {
  for (const n of SEAMS) assert.ok(!BUILT.includes(n), `the release wrapper names ${n}`);
  for (const n of SEAMS) assert.ok(SOURCE.includes(n), `the source still reads ${n} (the tests need it)`);
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-strip-"));
  fs.writeFileSync(path.join(dir, "vyre"), BUILT);
  assert.equal(spawnSync("sh", ["-n", path.join(dir, "vyre")]).status, 0, "it parses");
  fs.rmSync(dir, { recursive: true, force: true });
  const cut = (text, a, b) => text.slice(0, text.indexOf(a)) + text.slice(text.indexOf(b));
  assert.equal(cut(BUILT, "# >>> release constants", "root_guard \"${1:-}\"\n"), cut(SOURCE, "# >>> seams", "root_guard \"${1:-}\"\n"), "everything outside the block is the source, byte for byte");
  // The pins are the source's own defaults, written once.
  assert.match(BUILT, /^RELEASE_KEY=MCowBQYDK2VwAyEA[A-Za-z0-9+/=]{32,}$/m);
  assert.ok(BUILT.includes("COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign@sha256:"));
  assert.ok(BUILT.includes("UPD_ROOT=/var/lib/vyre-update") && BUILT.includes("WRAPPER=/usr/local/bin/vyre") && BUILT.includes("ROOT_UID=0"));
});

/** A harness: the wrapper text cut before its dispatch, plus `body`, run with sh in a temp world with a recording fake docker and fake id. */
function harness(t, { text, env = {}, root = false, body, envFile = "" }) {
  const base = fs.mkdtempSync(path.join(SCRATCH, "vyre-hostile-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const DIR = path.join(base, "srv"), BIN = path.join(base, "bin"), UP = path.join(base, "upd");
  fs.mkdirSync(DIR, { recursive: true }); fs.mkdirSync(BIN); fs.mkdirSync(UP);
  fs.writeFileSync(path.join(DIR, "compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(DIR, ".env"), envFile);
  const calls = path.join(base, "calls");
  fs.writeFileSync(path.join(BIN, "docker"), `#!/bin/sh\necho "docker $*" >>"${calls}"\n# an image that says yes to everything, except a ref named in FAILREF\ncase "$*" in *node*) echo signed ;; esac\n[ -z "\${FAILREF:-}" ] || case "$*" in *"\${FAILREF}"*) echo "Error: no signatures found" >&2; exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
  if (root) fs.writeFileSync(path.join(BIN, "id"), `#!/bin/sh\ncase "$1" in -u) echo 0 ;; -un) echo root ;; *) /usr/bin/id "$@" ;; esac\n`, { mode: 0o755 });
  // The constant /var/lib/vyre-update is a test folder only for this run, so the stack file a root run reads can be shown.
  // (The release wrapper fixes PATH to the system folders; the harness points that one line at its own fake binaries.)
  const prepared = text.slice(0, text.indexOf('case "${1:-}" in\n  up)')).split("/var/lib/vyre-update").join(UP).split("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").join(`PATH=${BIN}:/usr/bin:/bin`) + `\n${body}\n`;
  const file = path.join(base, "vyre");
  fs.writeFileSync(file, prepared);
  if (root) fs.writeFileSync(path.join(UP, "stack"), `${DIR}\n`);
  const run = (args = []) => spawnSync("sh", [file, ...args], { encoding: "utf8", env: { PATH: `${BIN}:${process.env.PATH}`, HOME: base, TMPDIR: SCRATCH, VYRE_DIR: DIR, ...env } });
  return { run, DIR, UP, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []), base };
}

const HOSTILE = {
  VYRE_RELEASE_KEY: spki(THROWAWAY.publicKey), VYRE_COSIGN_IMAGE: "evil.example/cosign@sha256:" + "b".repeat(64),
  VYRE_BOX_URL: "http://127.0.0.1:1/", VYRE_RELEASES_API: "http://127.0.0.1:1/api", VYRE_RELEASES_REPO: "evil/repo", VYRE_UPDATE_ROOT: "/tmp/not-roots",
  VYRE_ROOT_UID: "12345", VYRE_CHAIN_TOP: "/tmp", VYRE_WRAPPER: "/tmp/evil-wrapper", VYRE_UPDATE_WAIT: "1", VYRE_UPDATE_MIN_GAP: "0",
  VYRE_SYSTEMD_DIR: "/tmp/units", VYRE_UPDATER_NAME: "evil", VYRE_CONTAINER_HOME: "/tmp/evil-home",
};

test("hostile environment: the release wrapper's signature check is the pinned key's alone, however the environment and .env are set", t => {
  const sums = Buffer.from(`${"0".repeat(64)}  vyre.tgz\n`);
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-sig-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums);
  fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), signSums(sums, THROWAWAY.privateKey));
  const body = `sig_ok "${dir}/SHA256SUMS" "${dir}/SHA256SUMS.sig" && echo ACCEPTED || echo REFUSED`;
  const env = { ...HOSTILE };
  // The positive control: the SOURCE wrapper, told to trust the throwaway key through the environment, accepts it (so the test can fail).
  assert.match(harness(t, { text: SOURCE, env, body }).run().stdout, /ACCEPTED/, "the unstripped source honours the override, as the tests need");
  // The release wrapper refuses it with every hostile override set and a hostile .env naming an image that says "signed".
  const h = harness(t, { text: BUILT, env, body, envFile: "VYRE_IMAGE=evil.example/signs-everything:latest\nVYRE_RELEASE_KEY=" + spki(THROWAWAY.publicKey) + "\n" });
  const r = h.run();
  assert.match(r.stdout, /REFUSED/, `the throwaway key is not the release key: ${r.stdout}${r.stderr}`);
  assert.deepEqual(h.calls(), [], "no image ran for the check: nothing a .env or an image says can change the answer");
  // A signature that is not even 64 bytes, an empty file and a signature over other bytes are refused too.
  for (const bad of ["", "AAAA\n", "not base64 at all !!\n", signSums(Buffer.from("other"), THROWAWAY.privateKey)]) {
    fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), bad);
    assert.match(h.run().stdout, /REFUSED/, JSON.stringify(bad));
  }
});

test("hostile environment: the release wrapper reads its pins and its places from constants, not from the environment", t => {
  const body = `echo "RELEASE_KEY=$RELEASE_KEY"; echo "COSIGN_IMAGE=$COSIGN_IMAGE"; echo "SITE=$SITE"; echo "API=$API"; echo "REPO=$REPO"; echo "USE_API=$USE_API"; echo "WRAPPER=$WRAPPER"; echo "UPD_ROOT=$UPD_ROOT"; echo "ROOT_UID=$ROOT_UID"; echo "CHAIN_TOP=$CHAIN_TOP"; echo "UPDATE_WAIT=$UPDATE_WAIT"; echo "MIN_GAP=$MIN_GAP"; echo "SYSTEMD_DIR=$SYSTEMD_DIR"; echo "SYSTEMD_SEAM=$SYSTEMD_SEAM"; echo "UPDATER_NAME=$UPDATER_NAME"; echo "CHOME=$CHOME"`;
  const out = harness(t, { text: BUILT, env: HOSTILE, body }).run().stdout;
  const got = Object.fromEntries(out.trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(got.RELEASE_KEY, /^RELEASE_KEY=(.*)$/m.exec(BUILT)?.[1]);
  assert.match(got.COSIGN_IMAGE, /^ghcr\.io\/sigstore\/cosign\/cosign@sha256:[0-9a-f]{64}$/);
  assert.deepEqual([got.SITE, got.API, got.REPO, got.USE_API, got.WRAPPER, got.ROOT_UID, got.CHAIN_TOP, got.UPDATE_WAIT, got.MIN_GAP, got.SYSTEMD_DIR, got.SYSTEMD_SEAM, got.UPDATER_NAME, got.CHOME],
    ["https://vyre.run/box/", "https://api.github.com", "vyre-ai/vyre", "1", "/usr/local/bin/vyre", "0", "/", "60", "600", "/etc/systemd/system", "", "vyre-update", "/home/vyre/.vyre"]);
  assert.ok(got.UPD_ROOT.endsWith("/upd"), "the update root is the constant (the harness only moves it to a temp folder)");
  // And the source, given the same environment, takes every one of them (so the line above is not a test that cannot fail).
  const src = Object.fromEntries(harness(t, { text: SOURCE, env: HOSTILE, body }).run().stdout.trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(src.WRAPPER, "/tmp/evil-wrapper");
  assert.equal(src.SITE, "http://127.0.0.1:1/");
});

test("hostile environment: the cosign check runs the pinned image whatever VYRE_COSIGN_IMAGE says", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-rel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ref = `ghcr.io/vyre-ai/vyre@sha256:${"a".repeat(64)}`;
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ images: { box: { ref } } }));
  fs.writeFileSync(path.join(dir, "compose.yml"), `services:\n  vyre:\n    image: ${ref}\n`);
  const h = harness(t, { text: BUILT, env: HOSTILE, body: `tmp="${dir}"; verify_release_images` });
  const r = h.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const run = h.calls().find(c => /verify/.test(c)) || "";
  assert.match(run, /^docker run --rm ghcr\.io\/sigstore\/cosign\/cosign@sha256:[0-9a-f]{64} verify /, run);
  assert.ok(!run.includes("evil.example"), "the hostile image never ran");
});

test("hostile compose.yml: only `image: name@sha256:<64 hex>` lines pass; a variable, a comment, a tag or an unnamed ref is refused", t => {
  const ref = `ghcr.io/vyre-ai/vyre@sha256:${"a".repeat(64)}`, other = `ghcr.io/vyre-ai/vyre@sha256:${"c".repeat(64)}`;
  const verify = compose => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-rel-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ images: { box: { ref } } }));
    fs.writeFileSync(path.join(dir, "compose.yml"), compose);
    return harness(t, { text: BUILT, body: `tmp="${dir}"; verify_release_images` }).run();
  };
  assert.equal(verify(`services:\n  vyre:\n    image: ${ref}\n`).status, 0, "the exact line passes");
  for (const [why, compose] of [
    ["a variable a .env can replace", `services:\n  vyre:\n    image: \${VYRE_IMAGE:-${ref}}\n`],
    ["a tag with the digest in a comment", `services:\n  vyre:\n    image: evil/x:latest # @sha256:${"a".repeat(64)}\n`],
    ["the ref only in a comment", `services:\n  vyre:\n    image: evil/x@sha256:${"d".repeat(64)}\n    # image: ${ref}\n`],
    ["a moving tag beside the right line", `services:\n  vyre:\n    image: ${ref}\n  ts:\n    image: tailscale/tailscale:stable\n`],
    ["a different digest than release.json names", `services:\n  vyre:\n    image: ${other}\n`],
  ]) {
    const r = verify(compose);
    assert.notEqual(r.status, 0, `${why}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /nothing was changed/, why);
  }
});

test("root run: a VYRE_* override in the environment refuses to start, and the stack folder comes from root's own file, not the environment", t => {
  // As root (a fake id), with any override set: update, update-from-request, publish-release and updater all refuse.
  for (const verb of ["update", "update-from-request", "publish-release", "updater"]) {
    const h = harness(t, { text: BUILT, root: true, env: { VYRE_RELEASE_KEY: "x" }, body: `root_guard ${verb}; echo STARTED` });
    const r = h.run();
    assert.notEqual(r.status, 0, `${verb} started: ${r.stdout}`);
    assert.match(r.stderr, /VYRE_RELEASE_KEY is set in the environment of a root run, and a root run reads no override; nothing was changed/);
    assert.ok(!/STARTED/.test(r.stdout));
  }
  // Not for a verb root runs for other reasons, and not for a person's run.
  assert.match(harness(t, { text: BUILT, root: true, env: { VYRE_RELEASE_KEY: "x" }, body: "root_guard up; echo STARTED" }).run().stdout, /STARTED/);
  assert.match(harness(t, { text: BUILT, root: false, env: { VYRE_RELEASE_KEY: "x" }, body: "root_guard update; echo STARTED" }).run().stdout, /STARTED/);
  // VYRE_DIR alone is the one thing the installer passes (to `updater`): allowed by the guard.
  assert.match(harness(t, { text: BUILT, root: true, body: "root_guard updater; echo STARTED" }).run().stdout, /STARTED/);
  // The stack folder: a root run reads root's recorded file and ignores VYRE_DIR; `updater` (the installer's call) takes it from the environment.
  const h = harness(t, { text: BUILT, root: true, body: 'echo "DIR=$DIR"' });
  const other = fs.mkdtempSync(path.join(SCRATCH, "vyre-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, "compose.yml"), "services: {}\n");
  const r = h.run(["publish-release"]);
  assert.match(r.stdout, new RegExp(`DIR=${h.DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  const hostile = spawnSync("sh", [path.join(h.base, "vyre"), "publish-release"], { encoding: "utf8", env: { PATH: `${path.join(h.base, "bin")}:${process.env.PATH}`, HOME: h.base, VYRE_DIR: other } });
  assert.match(hostile.stdout, new RegExp(`DIR=${h.DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), `a root run did not take VYRE_DIR from the environment: ${hostile.stderr}`);
  const upd = spawnSync("sh", [path.join(h.base, "vyre"), "updater"], { encoding: "utf8", env: { PATH: `${path.join(h.base, "bin")}:${process.env.PATH}`, HOME: h.base, VYRE_DIR: other } });
  assert.match(upd.stdout, new RegExp(`DIR=${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "`updater` takes the installer's VYRE_DIR");
});

test("sudo line: a hand-run update asks root to publish with the installed wrapper path and nothing from the caller's environment", () => {
  const line = SOURCE.split("\n").find(l => /publish-release "\$src"/.test(l));
  assert.ok(line, "the sudo line is there");
  assert.match(line, /sudo -n "\$WRAPPER" publish-release "\$src"/);
  assert.ok(!/env |VYRE_|sh "\$WRAPPER"/.test(line), `passes nothing and runs no shell on a named file: ${line}`);
  assert.ok(/WRAPPER=\/usr\/local\/bin\/vyre/.test(BUILT), "and in the release build that path is the constant");
});

// One shared test vector for the release signature (also in anywhere's tests): a fixed key (seed 32 bytes of 0x07), a fixed SHA256SUMS,
// and the signature over "vyre-release-sums\n" + those exact bytes. Ed25519 is deterministic, so it is a constant. The host's own openssl
// checks it now, with no image involved.
const VECTOR = {
  key: "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  sums: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  manifest.json\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  vyre.tgz\n",
  sig: "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==",
};

test("release signature: the box verifies the shared vector with the host's openssl, and refuses the same signature over the bare bytes", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-vec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const check = (sums, sig) => {
    fs.writeFileSync(path.join(dir, "SUMS"), sums); fs.writeFileSync(path.join(dir, "SIG"), sig + "\n");
    return harness(t, { text: SOURCE, env: { VYRE_RELEASE_KEY: VECTOR.key }, body: `sig_ok "${dir}/SUMS" "${dir}/SIG" && echo signed || echo bad` }).run().stdout.trim();
  };
  assert.equal(check(VECTOR.sums, VECTOR.sig), "signed");
  assert.equal(check(VECTOR.sums + "x", VECTOR.sig), "bad", "one more byte");
  const bare = crypto.sign(null, Buffer.from(VECTOR.sums), crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" })).toString("base64");
  assert.equal(check(VECTOR.sums, bare), "bad", "a signature without the prefix is refused");
  // The release build's pinned key is not the vector's: the same vector is refused there.
  fs.writeFileSync(path.join(dir, "SUMS"), VECTOR.sums); fs.writeFileSync(path.join(dir, "SIG"), VECTOR.sig + "\n");
  assert.equal(harness(t, { text: BUILT, env: { VYRE_RELEASE_KEY: VECTOR.key }, body: `sig_ok "${dir}/SUMS" "${dir}/SIG" && echo signed || echo bad` }).run().stdout.trim(), "bad");
});

test("hostile environment, root run: PATH is fixed and DOCKER_*, COMPOSE_*, BASH_ENV and ENV are unset, so a fake docker daemon or context cannot answer the cosign check", t => {
  const evil = { PATH: "/tmp/evilbin:/usr/bin:/bin", DOCKER_HOST: "tcp://127.0.0.1:1", DOCKER_CONTEXT: "evil", DOCKER_CONFIG: "/tmp/evil-docker", DOCKER_TLS_VERIFY: "0", DOCKER_CERT_PATH: "/tmp/evil",
    COMPOSE_FILE: "/tmp/evil.yml", COMPOSE_PROFILES: "all", COMPOSE_PROJECT_NAME: "evil", BASH_ENV: "/tmp/evil.sh", ENV: "/tmp/evil.sh", CDPATH: "/tmp" };
  const body = `echo "PATH=$PATH"; for v in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME BASH_ENV ENV CDPATH; do eval "echo $v=\\\${$v-UNSET}"; done`;
  const root = harness(t, { text: BUILT, root: true, env: evil, body }).run().stdout;
  assert.match(root, /^PATH=.*:\/usr\/bin:\/bin$/m);
  assert.ok(!root.includes("evilbin"), `a root run does not keep the caller's PATH: ${root}`);
  for (const v of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME", "BASH_ENV", "ENV", "CDPATH"]) assert.match(root, new RegExp(`^${v}=UNSET$`, "m"), v);
  // A person's run keeps their own settings (a remote docker is theirs to choose), with the system folders first.
  const person = harness(t, { text: BUILT, root: false, env: evil, body }).run().stdout;
  assert.match(person, /^DOCKER_HOST=tcp:\/\/127\.0\.0\.1:1$/m);
  assert.match(person, new RegExp("^PATH=" + "[^\\n]*:/tmp/evilbin:/usr/bin:/bin$", "m"), "the system folders come first, theirs after");
  // The source (unstripped) is for tests: it does none of this.
  assert.match(harness(t, { text: SOURCE, root: true, env: evil, body }).run().stdout, /^DOCKER_HOST=tcp:/m);
});

test("root run: no function a root run executes calls `docker compose` directly, so every compose call goes through the one that names root's files", () => {
  const body = name => { const a = SOURCE.indexOf(`\n${name}() {`); assert.ok(a >= 0, name); const b = SOURCE.indexOf("\n}\n", a); return SOURCE.slice(a, b); };
  for (const fn of ["update", "update_from_request", "publish_release", "roll_back", "backup_db", "restore_db", "android", "ready", "save_box", "put_box", "sync_run", "prepare_run", "verify_release_images", "unpack_src", "image", "cli", "print_link"]) {
    assert.ok(!/docker compose/.test(body(fn).replace(/#.*$/gm, "")), `${fn} calls docker compose directly`);
  }
  // The one function that does, names every file explicitly in a root run.
  const c = body("compose");
  assert.ok(/--project-directory "\$RUN" --project-name vyre --env-file "\$RUN\/compose\.env" -f "\$RUN\/compose\.yml"/.test(c));
});

test("cosign runs on EVERY ghcr.io/vyre-ai image line of the released compose.yml, not only the two release.json names; a third-party digest is left to the signed release", t => {
  const box = `ghcr.io/vyre-ai/vyre@sha256:${"a".repeat(64)}`, extra = `ghcr.io/vyre-ai/vyre-sidecar@sha256:${"e".repeat(64)}`, ts = `tailscale/tailscale@sha256:${"c".repeat(64)}`;
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-rel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ images: { box: { ref: box } } }));
  fs.writeFileSync(path.join(dir, "compose.yml"), `services:\n  vyre:\n    image: ${box}\n  side:\n    image: ${extra}\n  ts:\n    image: ${ts}\n`);
  const ok = harness(t, { text: BUILT, body: `tmp="${dir}"; verify_release_images` });
  assert.equal(ok.run().status, 0);
  const verified = ok.calls().filter(c => / verify /.test(c)).map(c => c.split(" ").pop());
  assert.deepEqual(verified.sort(), [box, extra].sort(), "both vyre-ai images were checked, the tailscale one was not");
  // The one release.json does not name is unsigned: the update is refused with nothing changed.
  const bad = harness(t, { text: BUILT, env: { FAILREF: "vyre-sidecar" }, body: `tmp="${dir}"; verify_release_images` }).run();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /cosign could not verify ghcr\.io\/vyre-ai\/vyre-sidecar@sha256:e{64} against Vyre's release workflow; nothing was changed/);
});

test("computers image: every VYRE_COMPUTERS_IMAGE default in the released compose.yml must be the signed computers ref", t => {
  const box = `ghcr.io/vyre-ai/vyre@sha256:${"a".repeat(64)}`, comp = `ghcr.io/vyre-ai/vyre-computer@sha256:${"b".repeat(64)}`, evil = `ghcr.io/vyre-ai/vyre-computer@sha256:${"d".repeat(64)}`;
  const verify = lines => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-rel-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ images: { box: { ref: box }, computer: { ref: comp } } }));
    fs.writeFileSync(path.join(dir, "compose.yml"), `services:\n  vyre:\n    image: ${box}\n    environment:\n${lines.map(d => `      - VYRE_COMPUTERS_IMAGE=\${VYRE_COMPUTERS_IMAGE:-${d}}\n`).join("")}`);
    return harness(t, { text: BUILT, body: `tmp="${dir}"; verify_release_images` }).run();
  };
  assert.equal(verify([comp, comp]).status, 0, "several services reading it, all the signed ref");
  const bad = verify([comp, evil]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /every default of VYRE_COMPUTERS_IMAGE in the release's compose\.yml must be/);
  assert.notEqual(verify([]).status, 0, "no default at all is refused too");
});
