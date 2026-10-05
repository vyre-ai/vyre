// @ts-check
// The Space helper (box/vyre `space-helper-run`, `space-helper`, `admin`; team/archive/work-journals/space-helper.md Revision 2): the root side of a Space's Twenty store.
// Run with sh against a temp folder standing in for /var/lib/vyre-spaces. docker, nsenter (with a tiny iptables that keeps one rule list per pid, the
// container's namespace) and the other host tools are fakes on PATH; the compose file is the REAL one, from stores/twenty/provision.js. Linux only (stat -c).
// A request from another uid and a real iptables owner match need a real box: see team/archive/work-journals/space-helper.md for the box test list.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";
import { TWENTY_TESTED_REF, composeFile } from "../stores/twenty/provision.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_SRC = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
const LINUX = process.platform === "linux";

const DOCKER = `
const fs = require("fs"), cp = require("child_process");
const F = "__F__", REPO = "__REPO__";
const a = process.argv.slice(2);
fs.appendFileSync(F + "/calls", a.join(" ") + "\\n");
const has = n => fs.existsSync(F + "/" + n);
const rd = (n, d = "") => has(n) ? fs.readFileSync(F + "/" + n, "utf8").trim() : d;
const out = s => { process.stdout.write(s + "\\n"); process.exit(0); };
const nameOf = s => (/vyre-([a-z0-9-]+?)-twenty/.exec(s) || [])[1];
const CTR = "vyre-vyre-1";
if (a[0] === "inspect") {
  const fmt = a[2], name = a[3];
  if (name === CTR) {
    if (fmt === "{{.State.Pid}}") out(rd("ctr-pid", "4242"));
    if (fmt === "{{.Image}}") out("sha256:" + "a".repeat(64));
    if (fmt === "{{.Id}}") out(rd("ctr-id", "abcdef012345") + "0".repeat(52));
    if (fmt === "{{.State.StartedAt}}") out(rd("ctr-start", "2026-10-04T10:00:00.123456789Z"));
    if (fmt.includes(".Mounts") && fmt.includes("|")) out(has("no-mounts") ? "" : "/work|/var/lib/docker/volumes/w/_data\\n/home/vyre/.vyre|" + F + "/lend");
    if (fmt.includes(".Destination}} {{end}}")) out(has("no-state-mount") ? "/work /home/vyre/.vyre " : "/work /home/vyre/.vyre /run/vyre-spaces /run/vyre-spaces-state ");
    out(rd("joined").split("\\n").join(" ") + " ");
  }
  if (name === "srv1") out(fmt.includes("Global") ? "invalid IP" : (fmt.includes("IPAddress") ? "172.30.4.2" : ""));
  process.exit(1);
}
if (a[0] === "events") { if (has("events")) { const lines = rd("events"); fs.rmSync(F + "/events"); out(lines); } process.exit(0); }
if (a[0] === "pull") {
  const ref = a[a.length - 1];
  // as the real docker: a reference that still holds a compose variable is not an image name
  if (ref.includes("\${")) { process.stderr.write("invalid reference format\\n"); process.exit(1); }
  fs.appendFileSync(F + "/pulled", ref + "\\n");
  if (has("pull-fails")) { process.stderr.write("Error response from daemon: pull access denied for " + ref + "\\n"); process.exit(1); }
  process.exit(0);
}
if (a[0] === "image" && a[1] === "inspect") { const nm = a[a.length - 1].split(":")[0]; out(nm + "@sha256:" + require("crypto").createHash("sha256").update(rd("digest-salt", "x") + nm).digest("hex")); }
if (a[0] === "ps") { const n = nameOf(a.join(" ")); out(n && has("running-" + n) ? "srv1" : ""); }
if (a[0] === "network") {
  if (a[1] === "inspect") {
    const net = a[a.length - 1], n = nameOf(net);
    if (!has("net-" + n)) process.exit(1);
    out(a.includes("-f") ? "172.30.4.0/24 " : "{}");
  }
  if (a[1] === "connect") { fs.appendFileSync(F + "/joined", a[a.length - 2] + "\\n"); process.exit(0); }
  if (a[1] === "disconnect") { fs.writeFileSync(F + "/joined", rd("joined").split("\\n").filter(l => l !== a[a.length - 2]).join("\\n")); process.exit(0); }
}
if (a[0] === "compose") {
  const n = nameOf(a[a.indexOf("--project-name") + 1]);
  const sub = a[a.indexOf("-f") + 2];
  if (sub === "create") { if (has("create-fails")) process.exit(1); fs.writeFileSync(F + "/net-" + n, "1"); try { fs.copyFileSync(a[a.indexOf("-f") + 1], F + "/compose-at-create-" + n); fs.copyFileSync(a[a.indexOf("--env-file") + 1], F + "/env-at-create-" + n); } catch {} process.exit(0); }
  if (sub === "up") { fs.writeFileSync(F + "/db-volume-" + n, "1"); if (has("up-fails")) process.exit(1); fs.writeFileSync(F + "/running-" + n, "1"); process.exit(0); }
  if (sub === "exec") { if (has("exec-fails")) process.exit(1); out(has("core-empty-" + n) ? "" : "core.\\"user\\""); }
  if (sub === "stop") { fs.rmSync(F + "/running-" + n, { force: true }); process.exit(0); }
  if (sub === "down") { fs.rmSync(F + "/running-" + n, { force: true }); fs.rmSync(F + "/net-" + n, { force: true }); if (a.includes("-v")) { fs.appendFileSync(F + "/purged", n + "\\n"); fs.rmSync(F + "/db-volume-" + n, { force: true }); fs.rmSync(F + "/core-empty-" + n, { force: true }); } process.exit(0); }
  process.exit(0);
}
if (a[0] === "volume" && a[1] === "inspect") process.exit(has("db-volume-" + nameOf(a[2])) ? 0 : 1);
if (a[0] === "volume" && a[1] === "rm") { fs.rmSync(F + "/vol-content", { force: true }); fs.appendFileSync(F + "/vol-rm", a.join(" ") + "\\n"); process.exit(0); }
if (a[0] === "run" && a[a.indexOf("--network") + 1] === "none" && !a.includes("-e")) {
  // publish-fill: the throwaway container. The last argument is the shell command it runs.
  const cmd = a[a.length - 1];
  if (cmd.startsWith("cp -R")) { if (has("fill-hangs")) { fs.appendFileSync(F + "/hung", "1"); setTimeout(() => {}, 60000); return; } if (has("fill-fails")) process.exit(1); fs.writeFileSync(F + "/vol-content", "/srv/index.html"); fs.appendFileSync(F + "/filled", a.join(" ") + "\\n"); process.exit(0); }
  if (cmd.includes("-links +1")) out(has("post-dirty") ? "/srv/x" : "");
  out(rd("vol-content"));
}
if (a[0] === "create") { fs.appendFileSync(F + "/created", "1\\n"); out("ctr-golden"); }
if (a[0] === "cp") { const src = a[1].replace(/^[^:]*:/, ""); if (has("cp-fails")) process.exit(1); fs.copyFileSync(src, a[2]); process.exit(0); }
if (a[0] === "rm") process.exit(0);
if (a[0] === "run") {
  const i = a.indexOf("-e");
  let t = cp.execFileSync("node", ["-e", a[i + 1].replace("/opt/vyre", REPO), ...a.slice(i + 2)], { encoding: "utf8", env: { ...process.env, ...(has("golden-dir") ? { VYRE_TWENTY_GOLDEN_DIR: rd("golden-dir") } : {}) } });
  if (has("bad-restore")) t = t.replace("$" + "{GOLDEN_DUMP:-./golden.dump}", "/etc/shadow");
  if (has("bad-compose")) t = t.replace("  server:\\n", "  server:\\n    privileged: true\\n");
  if (has("bad-image")) t = t.replace("redis:7", "redis:evil");
  process.stdout.write(t);
  process.exit(0);
}
process.exit(0);
`;

const NSENTER = `
const fs = require("fs");
const F = "__F__";
const a = process.argv.slice(2);
fs.appendFileSync(F + "/calls", "nsenter " + a.join(" ") + "\\n");
const has = n => fs.existsSync(F + "/" + n);
const pid = a[1];
const cmd = a.slice(3);
const rulesFile = F + "/fw-" + pid;
const rules = () => fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, "utf8").split("\\n").filter(Boolean) : [];
const save = r => fs.writeFileSync(rulesFile, r.join("\\n") + (r.length ? "\\n" : ""));
const norm = args => args.join(" ").replace(/ --reject-with \\S+$/, "").replace(/"/g, "");
if (cmd[0] === "iptables" || cmd[0] === "ip6tables") {
  const rest = cmd.slice(2);   // after -w
  const r = rules();
  if (rest[0] === "-C") process.exit(r.includes(norm(rest.slice(2))) ? 0 : 1);
  if (rest[0] === "-I") { if (has("fw-add-fails")) process.exit(1); r.unshift(norm(rest.slice(3))); save(r); process.exit(0); }
  if (rest[0] === "-D") { if (has("fw-del-fails")) process.exit(1); const x = norm(rest.slice(2)); const i = r.indexOf(x); if (i < 0) process.exit(1); r.splice(i, 1); save(r); process.exit(0); }
  if (rest[0] === "-S") { for (const l of r) console.log("-A OUTPUT " + l.replace(/--comment (\S+)/, '--comment "$1"') + " --reject-with icmp-port-unreachable"); process.exit(0); }
  process.exit(1);
}
if (cmd[0] === "setpriv") {
  const uid = cmd.find(x => x.startsWith("--reuid=")).slice(8);
  const daemon = fs.readFileSync(F + "/daemon-uid", "utf8").trim();
  if (has("store-dead")) process.exit(uid === daemon ? 1 : 124);
  if (uid === daemon) process.exit(0);
  // A rule blocks a uid when the uid is inside its range; the daemon's uid is inside none of the helper's two ranges.
  const inRange = (l, u) => { const m = /--uid-owner (\\d+)-(\\d+)/.exec(l); return !!m && Number(u) >= Number(m[1]) && Number(u) <= Number(m[2]); };
  const blocked = !has("fw-ineffective") && rules().some(l => l.includes("-d 172.30.4.0/24") && inRange(l, uid));
  process.exit(blocked ? 1 : 0);
}
process.exit(0);
`;

/** @param {import("node:test").TestContext} t */
function rig(t) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "sh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const F = path.join(root, "fake"), BIN = path.join(F, "bin"), SP = path.join(root, "sp"), UNITS = path.join(root, "units");
  for (const d of [BIN, UNITS]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(F, "daemon-uid"), String(process.getuid()));
  const shim = (/** @type {string} */ name, /** @type {string} */ src) => {
    fs.writeFileSync(path.join(F, name + ".cjs"), src.replaceAll("__F__", F).replaceAll("__REPO__", REPO));
    fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\nexec node "${F}/${name}.cjs" "$@"\n`, { mode: 0o755 });
  };
  shim("docker", DOCKER); shim("nsenter", NSENTER);
  fs.writeFileSync(path.join(BIN, "systemctl"), `#!/bin/sh\necho "systemctl $*" >>"${F}/calls"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, "findmnt"), `#!/bin/sh\necho "$(cat "${F}/fstype" 2>/dev/null || echo ext4) /dev/vda1"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, "tune2fs"), `#!/bin/sh\necho "tune2fs $*" >>"${F}/calls"\n[ "$1" = -l ] && echo "Filesystem features: $(cat "${F}/features" 2>/dev/null || echo has_journal)"\nexit 0\n`, { mode: 0o755 });
  const WRAPPER = path.join(root, "bin", "vyre");
  fs.mkdirSync(path.dirname(WRAPPER));
  fs.writeFileSync(WRAPPER, WRAPPER_SRC, { mode: 0o755 });
  const uid = String(process.getuid());
  fs.mkdirSync(path.join(root, "srv"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "box/compose.yml"), path.join(root, "srv", "compose.yml"));
  const env = (/** @type {Record<string,string>} */ extra = {}) => ({
    PATH: `${BIN}:${process.env.PATH}`, HOME: root, TMPDIR: SCRATCH, VYRE_WRAPPER: WRAPPER, VYRE_SPACES_ROOT: SP, VYRE_ROOT_UID: uid, VYRE_DAEMON_UID: uid,
    VYRE_CHAIN_TOP: root, VYRE_SYSTEMD_DIR: UNITS, VYRE_UPDATE_ROOT: path.join(root, "upd"), VYRE_DIR: path.join(root, "srv"), ...extra,
  });
  const run = (/** @type {string[]} */ args, /** @type {Record<string,string>} */ extra = {}, /** @type {string} */ input = "") => new Promise(resolve => {
    const c = spawn("sh", [WRAPPER, ...args], { env: env(extra), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", d => { out += d; });
    c.stderr.on("data", d => { out += d; });
    c.stdin.on("error", () => {});
    c.stdin.end(input);
    c.on("close", code => resolve({ code, out }));
  });
  // The dirs as `space-helper install` makes them (without the unit), plus the recorded image.
  const prime = async (keep = false) => {
    const r = /** @type {any} */ (await run(["space-helper", "install"]));
    assert.equal(r.code, 0, r.out);
    if (!keep) fs.writeFileSync(path.join(F, "calls"), "");
  };
  const spool = (/** @type {string} */ id) => path.join(SP, "spool", "req-" + id);
  const hex = () => crypto.randomBytes(16).toString("hex");
  /** Write a request the way the daemon does (0600, now). @returns {string} the id */
  const ask = (/** @type {string | Buffer} */ text, { mode = 0o600, age = 0 } = {}) => {
    const id = hex();
    fs.writeFileSync(spool(id), text, { mode });
    fs.chmodSync(spool(id), mode);
    if (age) { const t = new Date(Date.now() - age * 1000); fs.utimesSync(spool(id), t, t); }
    return id;
  };
  const status = (/** @type {string} */ id) => { try { return JSON.parse(fs.readFileSync(path.join(SP, "status", "status-" + id), "utf8")); } catch { return null; } };
  const calls = () => (fs.existsSync(path.join(F, "calls")) ? fs.readFileSync(path.join(F, "calls"), "utf8") : "");
  const flag = (/** @type {string} */ n, /** @type {string} */ v = "1") => fs.writeFileSync(path.join(F, n), v);
  const rules = (pid = "4242") => { try { return fs.readFileSync(path.join(F, "fw-" + pid), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const helper = () => run(["space-helper-run"]);
  return { root, F, SP, UNITS, WRAPPER, run, prime, ask, status, calls, flag, rules, helper, spool, hex, env };
}

const UID = process.getuid();
const ranges = (/** @type {string} */ n) => [`-d 172.30.4.0/24 -m owner --uid-owner 0-${UID - 1} -m comment --comment vyre:${n} -j REJECT`, `-d 172.30.4.0/24 -m owner --uid-owner ${UID + 1}-4294967294 -m comment --comment vyre:${n} -j REJECT`].sort();
const opts = { skip: !LINUX && "the helper's stat -c and the fakes are Linux only" };

test("space helper: up makes root-only secrets, a linted compose, the join and the rule BEFORE the store starts, and proves the firewall", opts, async t => {
  const r = rig(t);
  await r.prime();
  const id = r.ask("up harlow\n");
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  const st = r.status(id);
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.equal(st.id, id);
  const d = path.join(r.SP, "private", "spaces", "harlow");
  assert.equal(fs.statSync(path.join(d, "secrets.env")).mode & 0o777, 0o600, "secrets are root-only");
  assert.match(fs.readFileSync(path.join(d, "secrets.env"), "utf8"), /^PG_PASSWORD=[0-9a-f]{64}\nREDIS_PASSWORD=[0-9a-f]{64}\nAPP_SECRET=[0-9a-f]{64}\nENCRYPTION_KEY=[0-9a-f]{64}\n$/);
  const compose = fs.readFileSync(path.join(d, "compose.yml"), "utf8");
  assert.ok(!/env_file|privileged|ports:|network_mode|unless-stopped/.test(compose));
  assert.match(compose, /^    restart: "no"$/m, "RH-7: a store never starts by itself");
  assert.ok(compose.match(/^    image: .*$/gm).every(l => /@sha256:[0-9a-f]{64}$/.test(l)), "every image in root's copy is by digest: " + compose.match(/^    image: .*$/gm));
  assert.deepEqual(r.rules().sort(), ranges("harlow"));
  const calls = r.calls();
  // The order: create, join, then the store starts; the proof comes after.
  const at = (/** @type {RegExp} */ re) => calls.search(re);
  assert.ok(at(/compose .* create/) < at(/network connect --alias vyre-harlow vyre-harlow-twenty_store vyre-vyre-1/), calls);
  assert.ok(at(/network connect/) < at(/compose .* up -d --wait/), "joined before the store starts");
  assert.ok(at(/ -I OUTPUT 1 /) < at(/compose .* up -d --wait/), "the rule is in before the store starts");
  assert.match(calls, /setpriv --reuid=2000/, "the agent probe ran");
  assert.match(calls, new RegExp(`setpriv --reuid=${process.getuid()}`), "and the control");
  assert.ok(/--env-file \S*private\/spaces\/harlow\/secrets.env/.test(calls) && !/vyre-spaces\/spool/.test(calls), "compose reads root's own copy, never the daemon's folder");
  assert.ok(!fs.existsSync(r.spool(id)) && fs.readdirSync(path.join(r.SP, "private", "claim")).length === 0, "the request was consumed");
  // The same up again keeps the secrets and leaves one rule.
  const before = fs.readFileSync(path.join(d, "secrets.env"), "utf8");
  const id2 = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(id2).state, "ok");
  assert.equal(fs.readFileSync(path.join(d, "secrets.env"), "utf8"), before);
  assert.equal(r.rules().length, 2, "applying twice leaves the same two rules");
});

test("space helper: every request that is not exactly `<verb> <name>` is refused before anything runs", opts, async t => {
  const r = rig(t);
  await r.prime();
  const bad = {
    "an extra word": "up harlow now\n", "a path in the name": "up ../etc\n", "a name with a dot": "up har.low\n", "an unknown verb": "purge-space harlow\n",
    "fscrypt-enable is not a verb": "fscrypt-enable harlow\n", "a capital verb": "UP harlow\n", "two lines": "up harlow\nup northwind\n", "a CR": "up harlow\r\n",
    "a NUL": Buffer.from("up harlow\0\n"), "a trailing space": "up harlow \n", "a leading space": " up harlow\n", "no newline": "up harlow",
    "a name of 32 characters": "up a" + "b".repeat(31) + "\n", "a name that collides by prefix": "up foo-twenty-bar\n", "a digit first": "up 9harlow\n",
    "over 64 bytes": "up " + "a".repeat(80) + "\n", "empty": "\n",
  };
  const ids = Object.entries(bad).map(([k, v]) => [k, r.ask(/** @type {any} */ (v))]);
  const mode = r.ask("up harlow\n", { mode: 0o666 });
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  for (const [k, id] of [...ids, ["a request with mode 0666", mode]]) {
    const st = r.status(/** @type {string} */ (id));
    assert.equal(st && st.state, "failed", `${k}: ${JSON.stringify(st)}`);
  }
  assert.ok(!/compose|network|nsenter/.test(r.calls()), "nothing was run for any of them: " + r.calls());
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces")) || fs.readdirSync(path.join(r.SP, "private", "spaces")).length === 0, "no Space was made");
});

test("space helper: a link, a FIFO, a hard link and a stale request are refused after the claim, and the helper does not block", opts, async t => {
  const r = rig(t);
  await r.prime();
  const secret = path.join(r.root, "root-file"); fs.writeFileSync(secret, "up harlow\n");
  const lnk = r.hex(); fs.symlinkSync(secret, r.spool(lnk));
  const fifo = r.hex(); assert.equal(spawnSync("mkfifo", [r.spool(fifo)]).status, 0);
  const hard = r.ask("up harlow\n"); fs.linkSync(r.spool(hard), path.join(r.root, "hardlink"));
  const stale = r.ask("up harlow\n", { age: 3600 });
  const junk = path.join(r.SP, "spool", "not-a-request"); fs.mkdirSync(junk); fs.writeFileSync(path.join(junk, "x"), "x");
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  for (const [k, id] of [["symlink", lnk], ["FIFO", fifo], ["hard link", hard], ["stale", stale]]) assert.equal(r.status(id)?.state, "failed", `${k}: ${JSON.stringify(r.status(id))}`);
  assert.match(r.status(stale).message, /stale/);
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "spool")), [], "the spool is left empty, junk included, so the path unit cannot loop on it");
  assert.ok(!/compose/.test(r.calls()));
});

test("space helper: stop, down and firewall-del for a Space root does not know are refused; a request left claimed by a crash is answered interrupted", opts, async t => {
  const r = rig(t);
  await r.prime();
  const ids = ["stop", "down", "firewall-del", "firewall-add"].map(v => r.ask(`${v} ghost\n`));
  const old = r.hex(); fs.mkdirSync(path.join(r.SP, "private", "claim"), { recursive: true }); fs.writeFileSync(path.join(r.SP, "private", "claim", "req-" + old), "up ghost\n");
  await r.helper();
  for (const id of ids) { assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /no such Space/); }
  assert.equal(r.status(old).message, "interrupted");
  assert.ok(!/compose/.test(r.calls()));
});

test("space helper: two requests before root reads the first are both answered, each by its own id", opts, async t => {
  const r = rig(t);
  await r.prime();
  const a = r.ask("up harlow\n"), b = r.ask("up northwind\n");
  await r.helper();
  assert.equal(r.status(a).state, "ok"); assert.equal(r.status(b).state, "ok");
  assert.equal(r.rules().length, 4, "two rules (two uid ranges) for each of the two Spaces");
});

test("space helper: the Space cap, the up rate and one-at-a-time answer busy or refuse instead of running", opts, async t => {
  const r = rig(t);
  await r.prime();
  const capped = [r.ask("up aa\n"), r.ask("up bb\n"), r.ask("up cc\n")];
  await r.helper();
  const states = capped.map(id => r.status(id)).sort((x, y) => x.state.localeCompare(y.state)).map(s => s.state);
  assert.deepEqual(states.filter(s => s === "ok").length + states.filter(s => s === "failed").length, 3);
  const cap = /** @type {any} */ (await r.run(["space-helper-run"], { VYRE_SPACES_CAP: "2", VYRE_SPACES_UP_PER_MIN: "100" }));
  assert.equal(cap.code, 0);
  const extra = r.ask("up dd\n");
  await r.run(["space-helper-run"], { VYRE_SPACES_CAP: "2", VYRE_SPACES_UP_PER_MIN: "100" });
  assert.equal(r.status(extra).state, "failed"); assert.match(r.status(extra).message, /too many Spaces/);
  const rate = [r.ask("up aa\n"), r.ask("up aa\n")];
  await r.run(["space-helper-run"], { VYRE_SPACES_UP_PER_MIN: "1" });
  assert.ok(rate.some(id => r.status(id).state === "busy"), JSON.stringify(rate.map(id => r.status(id))));
  // A Space whose lock is held answers busy.
  fs.mkdirSync(path.join(r.SP, "private", "lock-aa"));
  const held = r.ask("stop aa\n");
  await r.helper();
  assert.equal(r.status(held).state, "busy");
});

test("space helper: a lock whose run is gone is taken over at once, and a fresh install clears what an earlier install left (locks, claims, the up-rate window, old answers) and keeps every Space", opts, async t => {
  const r = rig(t);
  await r.prime();
  const first = r.ask("up aa\n"); await r.helper();
  assert.equal(r.status(first).state, "ok");
  const priv = path.join(r.SP, "private");
  // a lock left by a run that no longer exists: not busy
  fs.mkdirSync(path.join(priv, "lock-aa")); fs.writeFileSync(path.join(priv, "lock-aa", "pid"), "999999\n");
  const again = r.ask("stop aa\n"); await r.helper();
  assert.equal(r.status(again).state, "ok", JSON.stringify(r.status(again)));
  assert.equal(fs.existsSync(path.join(priv, "lock-aa")), false, "the lock is released at the end of the request");
  // what an earlier install left: a lock with no owner, a claim, a full rate window, an old answer
  fs.mkdirSync(path.join(priv, "lock-bb")); fs.mkdirSync(path.join(priv, "claim"), { recursive: true }); fs.writeFileSync(path.join(priv, "claim", "req-" + "a".repeat(32)), "up bb\n");
  fs.writeFileSync(path.join(priv, "rate-up"), `${Math.floor(Date.now() / 60000)} 1000\n`);
  const old = path.join(r.SP, "status", "status-" + "b".repeat(32)); fs.writeFileSync(old, "{}"); const past = new Date(Date.now() - 3600_000); fs.utimesSync(old, past, past);
  const recent = path.join(r.SP, "status", "status-" + "c".repeat(32)); fs.writeFileSync(recent, "{}");
  const inst = /** @type {any} */ (await r.run(["space-helper", "install"]));
  assert.equal(inst.code, 0, inst.out);
  for (const gone of ["lock-bb", "rate-up", path.join("claim", "req-" + "a".repeat(32))]) assert.equal(fs.existsSync(path.join(priv, gone)), false, `${gone} was cleared`);
  assert.equal(fs.existsSync(old), false, "an answer nobody waits for is cleared"); assert.equal(fs.existsSync(recent), true, "a recent answer is kept");
  assert.ok(fs.existsSync(path.join(priv, "spaces", "aa", "record")), "the Space is kept");
  const up = r.ask("up bb\n"); await r.helper();
  assert.equal(r.status(up).state, "ok", JSON.stringify(r.status(up)));
});

test("space helper: a flood is cut at the spool cap, and a stop still runs afterwards", opts, async t => {
  const r = rig(t);
  await r.prime();
  await (async () => { r.ask("up harlow\n"); await r.helper(); })();
  const flood = Array.from({ length: 200 }, () => r.ask("up harlow\n"));
  const h = /** @type {any} */ (await r.run(["space-helper-run"], { VYRE_SPACES_SPOOL_CAP: "5", VYRE_SPACES_UP_PER_MIN: "1000" }));
  assert.equal(h.code, 0, h.out);
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "spool")), [], "everything beyond the cap is deleted, not left to loop");
  assert.ok(flood.filter(id => r.status(id)).length <= 5, "no more than the cap were answered");
  const stop = r.ask("stop harlow\n");
  await r.helper();
  assert.equal(r.status(stop).state, "ok");
  assert.ok(fs.statSync(path.join(r.SP, "private", "log")).size < 262144 + 1000, "the log is capped");
});

test("space helper: the cleanup lane runs stop, down and firewall-del before an up in the same batch", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.ask("up northwind\n"); r.ask("stop harlow\n");
  await r.helper();
  const calls = r.calls().split("\n");
  const stopAt = calls.findIndex((l, i) => /compose .* stop/.test(l) && /harlow/.test(l) && i > calls.findIndex(x => /harlow.* up -d/.test(x)));
  const upAt = calls.findIndex(l => /northwind.* create/.test(l));
  assert.ok(stopAt > 0 && upAt > 0 && stopAt < upAt, `stop at ${stopAt}, up at ${upAt}`);
});

test("space helper: firewall-del is refused while the project runs, then removes exactly that Space's rule; down keeps the data and the rule until asked", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); r.ask("up northwind\n"); await r.helper();
  assert.equal(r.rules().length, 4);
  const early = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(early).state, "failed"); assert.match(r.status(early).message, /running/);
  assert.equal(r.rules().length, 4);
  const down = r.ask("down harlow\n"); await r.helper();
  assert.equal(r.status(down).state, "ok");
  assert.match(r.status(down).message, /data is kept/);
  assert.ok(!/ -v/.test(r.calls().split("\n").filter(l => /harlow.* down/.test(l)).join("\n")), "down never takes the volumes");
  assert.equal(r.rules().length, 4, "the rules stay until firewall-del");
  const del = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(del).state, "ok");
  assert.deepEqual(r.rules().sort(), ranges("northwind"), "only harlow's rules are gone");
});

test("space helper RH-3: a recreated vyre container has no join and no rule; up re-applies with a fresh pid and proves it; a rule that does not block fails the up and stops the store", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  assert.equal(r.rules("4242").length, 2);
  // The container is recreated: new pid, no network joins, an empty namespace.
  r.flag("ctr-pid", "5151"); fs.writeFileSync(path.join(r.F, "joined"), "");
  assert.deepEqual(r.rules("5151"), []);
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "ok");
  assert.equal(r.rules("5151").length, 2, "the rules went into the NEW namespace");
  assert.match(r.calls(), /nsenter -t 5151 /, "the pid is read fresh");
  // The rule is accepted but does not block (RH-4): the probe sees the agent connect, so the up fails and the store is stopped.
  r.flag("ctr-pid", "6262"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const bad = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(bad).state, "failed"); assert.match(r.status(bad).message, /uid \d+ can reach the store/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "stopped, not left running unfirewalled");
  fs.rmSync(path.join(r.F, "fw-ineffective"));
  // A dead store (RH-4 control): the agent probe times out, and the control fails first, so it does not read as a pass.
  r.flag("ctr-pid", "7373"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("store-dead");
  const dead = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(dead).state, "failed"); assert.match(r.status(dead).message, /control connect/);
  fs.rmSync(path.join(r.F, "store-dead"));
  // A rule that cannot be added fails before the store starts.
  r.flag("ctr-pid", "8484"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-add-fails");
  fs.rmSync(path.join(r.F, "running-harlow"), { force: true });
  const nofw = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(nofw).state, "failed"); assert.match(r.status(nofw).message, /could not be added/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "the store never started");
});

test("space helper: `space-helper reattach` joins and firewalls again a Space that still runs after the container was recreated, and stops one it cannot prove", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.flag("ctr-pid", "9191"); fs.writeFileSync(path.join(r.F, "joined"), "");
  const ok = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(r.rules("9191").length, 2);
  r.flag("ctr-pid", "9292"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const bad = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.match(bad.out, /the Space harlow was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")));
});

test("space helper: a regenerated compose file with a forbidden key or an unrecorded image is refused and nothing is started", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.flag("bad-compose");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "failed"); assert.match(r.status(a).message, /refused: lint: service key privileged/);
  fs.rmSync(path.join(r.F, "bad-compose")); r.flag("bad-image");
  const b = r.ask("up harlow\n"); await r.helper();
  assert.match(r.status(b).message, /an image root did not record/);
  assert.ok(!/ create/.test(r.calls()), "compose never ran on either: " + r.calls());
});

test("space helper: the log and the status carry no path, no secret and no request text beyond a matched verb", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); r.ask("up /etc/passwd\n"); await r.helper();
  const log = fs.readFileSync(path.join(r.SP, "private", "log"), "utf8");
  const secrets = fs.readFileSync(path.join(r.SP, "private", "spaces", "harlow", "secrets.env"), "utf8").split("\n").map(l => l.split("=")[1]).filter(Boolean);
  for (const s of secrets) assert.ok(!log.includes(s));
  assert.ok(!log.includes("/etc/passwd") && !log.includes(r.root), log);
  for (const f of fs.readdirSync(path.join(r.SP, "status"))) { const txt = fs.readFileSync(path.join(r.SP, "status", f), "utf8"); assert.ok(!txt.includes(r.root) && !secrets.some(s => txt.includes(s))); }
});

test("space helper: it refuses to run when the folders are not as it needs them", opts, async t => {
  const r = rig(t);
  await r.prime();
  fs.chmodSync(path.join(r.SP, "private"), 0o770);
  const id = r.ask("up harlow\n");
  const h = /** @type {any} */ (await r.helper());
  assert.match(h.out, /not as the Space helper needs it/);
  assert.equal(r.status(id), null);
  assert.ok(fs.existsSync(r.spool(id)), "the request is left alone");
  fs.chmodSync(path.join(r.SP, "private"), 0o700);
  fs.chmodSync(path.join(r.SP, "spool"), 0o777);
  assert.match(/** @type {any} */ ((await r.helper())).out, /not as the Space helper needs it/);
});

test("space helper: install writes a path unit on the spool with the start limits off, and the compose mounts the two folders", opts, async t => {
  const r = rig(t);
  await r.prime(true);
  const p = fs.readFileSync(path.join(r.UNITS, "vyre-spaces.path"), "utf8"), s = fs.readFileSync(path.join(r.UNITS, "vyre-spaces.service"), "utf8");
  assert.match(p, /DirectoryNotEmpty=.*\/spool/); assert.match(p, /TriggerLimitIntervalSec=0/); assert.match(p, /StartLimitIntervalSec=0/);
  assert.match(s, /StartLimitIntervalSec=0/); assert.match(s, /ExecStart=.*space-helper-run/);
  assert.equal(fs.readFileSync(path.join(r.SP, "private", "image"), "utf8").trim(), "sha256:" + "a".repeat(64));
  const images = fs.readFileSync(path.join(r.SP, "private", "images"), "utf8").trim().split("\n").map(l => l.split(" "));
  const written = images.map(i => i[0]);
  for (const want of [/postgres/, /redis/, /twentycrm\/twenty/]) assert.ok(written.some(w => want.test(w)), `${want} is recorded: ${written.join(", ")}`);
  const pulled = fs.readFileSync(path.join(r.F, "pulled"), "utf8").trim().split("\n");
  assert.ok(pulled.every(p => !p.includes("${")), `every pull names a real reference, never a compose template: ${pulled.join(", ")}`);
  assert.ok(pulled.some(p => /^twentycrm\/twenty:v[0-9.]+(@sha256:[0-9a-f]{64})?$/.test(p)), `Twenty is pulled by its pinned tag and digest: ${pulled.join(", ")}`);
  for (const [, dg] of images) assert.match(dg, /^[a-z0-9\/]+@sha256:[0-9a-f]{64}$/, "every image is recorded by digest");
  assert.equal(fs.statSync(path.join(r.SP, "private")).mode & 0o777, 0o700);
  assert.match(r.calls(), /systemctl enable --now vyre-spaces\.path/);
  const compose = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
  assert.match(compose, /VYRE_SPACES_ROOT:-\/var\/lib\/vyre-spaces\}\/spool:\/run\/vyre-spaces\n/);
  assert.match(compose, /VYRE_SPACES_ROOT:-\/var\/lib\/vyre-spaces\}\/status:\/run\/vyre-spaces-state:ro\n/);
});

test("space helper RH-2: purge and fscrypt-enable are only `vyre admin`, which needs a terminal and the exact typed word", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.ask("down harlow\n"); await r.helper();
  // A pipe is not a terminal.
  let a = /** @type {any} */ (await r.run(["admin", "purge-space", "harlow"], {}, "purge-space harlow\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  assert.ok(!fs.existsSync(path.join(r.F, "purged")));
  // The test seam stands in for the terminal: a wrong word does nothing, the exact one purges and removes the record and the secrets.
  a = /** @type {any} */ (await r.run(["admin", "purge-space", "harlow"], { VYRE_ADMIN_NO_TTY: "1" }, "y\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not the word/);
  assert.ok(fs.existsSync(path.join(r.SP, "private", "spaces", "harlow", "record")));
  a = /** @type {any} */ (await r.run(["admin", "purge-space", "harlow"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-space harlow\n"));
  assert.equal(a.code, 0, a.out); assert.match(a.out, /It cannot be undone/);
  assert.equal(fs.readFileSync(path.join(r.F, "purged"), "utf8").trim(), "harlow");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces", "harlow")));
  assert.equal(r.rules().length, 0, "its firewall rule is removed with it");
  a = /** @type {any} */ (await r.run(["admin", "purge-space", "ghost"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-space ghost\n"));
  assert.match(a.out, /no Space named ghost/);
  // fscrypt: only on ext4 with a block device, skipped when the feature is already there, exactly tune2fs -O encrypt.
  // Root finds the lent-workspace folder itself, from Docker's mounts of the vyre container; nothing the daemon writes is read.
  r.flag("no-mounts");
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /could not find the folder/);
  fs.rmSync(path.join(r.F, "no-mounts"));
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.equal(a.code, 0, a.out); assert.match(a.out, /cannot be undone, and it changes nothing else/);
  assert.match(r.calls(), /^tune2fs -O encrypt \/dev\/vda1$/m);
  r.flag("features", "has_journal encrypt");
  const before = r.calls();
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.match(a.out, /already on/); assert.equal((r.calls().match(/tune2fs -O encrypt/g) || []).length, (before.match(/tune2fs -O encrypt/g) || []).length);
  r.flag("fstype", "btrfs");
  a = /** @type {any} */ (await r.run(["admin", "fscrypt-enable"], { VYRE_ADMIN_NO_TTY: "1" }, "fscrypt\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not ext4/);
  // And nothing in the spool grammar can ask for either.
  const ids = [r.ask("purge-space harlow\n"), r.ask("fscrypt-enable\n")]; await r.helper();
  for (const id of ids) assert.equal(r.status(id).state, "failed");
});

test("space helper RH-6: the rule refuses every uid but the daemon's, so nothing else can reach Twenty's first-user signup", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  assert.deepEqual(r.rules().sort(), ranges("harlow"), "two positive ranges, either side of the daemon uid: a negated match would drop the kernel's own REJECT reply");
  assert.ok(!r.rules().some(l => l.includes("!")));
  // The sessions uid connecting is a failure of the proof, like an agent's.
  assert.match(r.calls(), new RegExp(`--reuid=${UID + 1} `));
});

test("space helper RH-7: `space-helper watch` reattaches after the vyre container starts again outside the wrapper, and stops a Space it cannot prove", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  // docker restart vyre-vyre-1: a new pid, no joins, an empty namespace; the watcher sees the start event.
  r.flag("ctr-pid", "3131"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("events", "start\n");
  const ok = /** @type {any} */ (await r.run(["space-helper", "watch"], { VYRE_SPACES_WATCH_ONCE: "1" }));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(r.rules("3131").length, 2, "the rules are back in the new namespace");
  assert.match(r.calls(), /events --filter container=vyre-vyre-1 --filter event=start/);
  r.flag("ctr-pid", "3232"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-add-fails");
  const bad = /** @type {any} */ (await r.run(["space-helper", "watch"], { VYRE_SPACES_WATCH_ONCE: "1" }));
  assert.match(bad.out, /the Space harlow was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "stopped, not left running with no rule");
  assert.match(fs.readFileSync(path.join(r.UNITS, "vyre-spaces-watch.service"), "utf8"), /ExecStart=.*space-helper watch\nRestart=always/);
});

test("space helper: `admin wipe` needs a terminal and the typed word, and says what it destroys, before it touches anything", opts, async t => {
  const r = rig(t);
  await r.prime();
  let a = /** @type {any} */ (await r.run(["admin", "wipe"], {}, "wipe\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  a = /** @type {any} */ (await r.run(["admin", "wipe"], { VYRE_ADMIN_NO_TTY: "1" }, "yes\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /destroys everything on this server/); assert.match(a.out, /not the word/);
  assert.ok(!/compose/.test(r.calls()), "no word, no docker call");
});

test("space helper SH-2 and SH-3: a family the network lacks (`invalid IP`) is ignored; firewall-del matches the quoted comment real iptables prints, and never reports success while a rule remains", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const stopped = r.ask("stop harlow\n"); await r.helper();
  assert.equal(r.status(stopped).state, "ok");
  // The listing shows the quoted form: the delete still finds it and removes it.
  const del = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(del).state, "ok", JSON.stringify(r.status(del)));
  assert.deepEqual(r.rules(), []);
  assert.ok(!/harlow/.test(fs.readFileSync(path.join(r.SP, "status", "subnets"), "utf8")), "the container's wall list forgets it");
  // A rule the helper cannot delete (the fake refuses -D) is a failure, not a success.
  r.ask("up harlow\n"); await r.helper();
  r.ask("stop harlow\n"); await r.helper();
  r.flag("fw-del-fails");
  const stuck = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(stuck).state, "failed"); assert.match(r.status(stuck).message, /still there/);
  assert.equal(r.rules().length, 2);
});

test("space helper SH-1, SH-4, SH-5: the host writes a marker that names this START of the container; the entry holds the daemon back until its own start's marker is there, and fails closed", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const list = path.join(r.SP, "status", "subnets");
  assert.equal(fs.readFileSync(list, "utf8").trim(), "harlow 172.30.4.0/24");
  const bin = fs.mkdtempSync(path.join(SCRATCH, "wallbin-")); t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // The entry reads the container's own hostname and start time: a fake `hostname` on PATH and VYRE_WALL_TEST_START stand in for Docker's id and PID 1's start.
  const as = (/** @type {string} */ host, /** @type {number} */ start) => { fs.writeFileSync(path.join(bin, "hostname"), `#!/bin/sh\necho ${host}\n`, { mode: 0o755 }); return spawnSync("sh", [path.join(REPO, "core/spawner/space-wall.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, VYRE_SPACES_STATE: path.join(r.SP, "status"), VYRE_WALL_WAIT: "2", VYRE_WALL_TEST_START: String(start) }, encoding: "utf8" }); };
  const epoch = (/** @type {string} */ s) => Math.floor(Date.parse(s) / 1000);
  const S1 = epoch("2026-10-04T10:00:00Z");
  // A container started and no marker yet: the daemon does not start.
  let w = as("abcdef012345", S1);
  assert.equal(w.status, 1); assert.match(w.stderr, /the daemon is not starting/);
  assert.ok(!/cannot open/.test(w.stderr), "a marker that is not there yet is waited for quietly: " + w.stderr);
  // The helper proves the rules for the running container and names this start.
  const ok = /** @type {any} */ (await r.run(["space-helper", "reattach"])); assert.equal(ok.code, 0, ok.out);
  assert.equal(fs.readFileSync(path.join(r.SP, "status", "wall-ready"), "utf8").trim(), `abcdef012345 ${S1}`);
  assert.equal(as("abcdef012345", S1).status, 0);
  // SH-4: a docker restart keeps the id and starts a new process. The old marker names the old start, so it does not pass.
  w = as("abcdef012345", S1 + 600);
  assert.equal(w.status, 1, "the same container id, a later start: the earlier marker must not pass");
  // The helper sees the new start and writes the new marker.
  r.flag("ctr-start", "2026-10-04T10:10:00Z");
  assert.equal((/** @type {any} */ (await r.run(["space-helper", "reattach"]))).code, 0);
  assert.equal(as("abcdef012345", S1 + 600).status, 0, "after the host proved this start");
  assert.equal(as("abcdef012345", S1).status, 1, "and the earlier start no longer matches");
  // A different container (another id) with the same start time does not pass either.
  assert.equal(as("fedcba543210", S1 + 600).status, 1);
  // The marker goes when the container dies or stops: nothing is left for a later start to find.
  r.flag("events", "die\n");
  assert.equal((/** @type {any} */ (await r.run(["space-helper", "watch"], { VYRE_SPACES_WATCH_ONCE: "1" }))).code, 0);
  assert.ok(!fs.existsSync(path.join(r.SP, "status", "wall-ready")), "removed on die");
  // SH-5: the helper is installed (status/ready) and the list of firewalled stores is missing: closed. An empty list: nothing to wait for. No helper: nothing to wait for.
  const saved = fs.readFileSync(list);
  fs.rmSync(list);
  w = as("abcdef012345", S1); assert.equal(w.status, 1); assert.match(w.stderr, /list of firewalled stores is missing/);
  fs.writeFileSync(list, "");
  assert.equal(as("abcdef012345", S1).status, 0);
  fs.writeFileSync(list, saved);
  fs.rmSync(path.join(r.SP, "status", "ready"));
  assert.equal(as("abcdef012345", S1).status, 0, "no helper on this server");
});

test("space helper SH-5: an `up` is refused when the vyre container does not mount the helper's state folder, because its entry would then have no wall to wait for", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.flag("no-state-mount");
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /does not mount the helper state folder/);
  assert.ok(!fs.existsSync(path.join(r.F, "running-harlow")), "the store never started");
});

test("space helper: the vyre container's compose is never privileged and keeps NET_ADMIN only for the entry step, which drops it before the daemon runs", async () => {
  const compose = fs.readFileSync(path.join(REPO, "box/compose.yml"), "utf8");
  const vyre = compose.slice(compose.indexOf("\n  vyre:"), compose.indexOf("\n  docker-api:") > 0 ? compose.indexOf("\n  docker-api:") : undefined);
  assert.ok(!/privileged:\s*true/.test(compose), "no service is privileged");
  assert.ok(!/network_mode:\s*host|pid:\s*host/.test(vyre));
  const entry = fs.readFileSync(path.join(REPO, "core/spawner/wall-entry.sh"), "utf8");
  assert.match(entry, /--bounding-set=-net_admin/, "NET_ADMIN leaves the bounding set before the spawner runs");
  assert.match(entry, /space-wall\.sh"?\s*\|\|\s*exit 1/, "the entry waits for the host's marker and stops when it does not come");
});

test("space helper: the images are pulled and recorded by digest at install; a failed pull stops the install; a refreshed record (an update) changes what `up` runs", opts, async t => {
  const r = rig(t);
  r.flag("pull-fails");
  const bad = /** @type {any} */ (await r.run(["space-helper", "install"]));
  assert.notEqual(bad.code, 0); assert.match(bad.out, /could not pull [a-z0-9]\S*: Error response from daemon: pull access denied/, "the real reference and the registry's reason");
  assert.doesNotMatch(bad.out, /\$\{/, "never the raw compose template");
  fs.rmSync(path.join(r.F, "pull-fails"));
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const d1 = fs.readFileSync(path.join(r.SP, "private", "spaces", "harlow", "compose.yml"), "utf8").match(/redis@sha256:[0-9a-f]{64}/)[0];
  r.flag("digest-salt", "moved");
  const rec = /** @type {any} */ (await r.run(["space-helper", "install"])); assert.equal(rec.code, 0, rec.out);
  r.ask("up harlow\n"); await r.helper();
  const d2 = fs.readFileSync(path.join(r.SP, "private", "spaces", "harlow", "compose.yml"), "utf8").match(/redis@sha256:[0-9a-f]{64}/)[0];
  assert.notEqual(d1, d2);
});

test("space helper RH-8: a writer that holds the request open and rewrites it after the checks never gets a second line, a path or anything but one valid request through (up to 4000 tries or 40 s)", { ...opts, timeout: 150_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "race-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The two functions, as they are in the wrapper, run in one sh against a file a node process keeps rewriting through its own open descriptor.
  const src = WRAPPER_SRC;
  const fnText = (/** @type {string} */ name, /** @type {string} */ until) => { const a = src.indexOf(`\n${name}() {`); const b = src.indexOf(until, a); return src.slice(a, b); };
  const funcs = fnText("sp_name_ok", "# sp_do ID VERB NAME:");
  const file = path.join(dir, "claimed");
  fs.mkdirSync(path.join(dir, "priv"));
  fs.writeFileSync(file, "up abc\n", { mode: 0o600 });
  const racer = spawn("node", ["-e", `
    const fs = require("fs"); const fd = fs.openSync(process.argv[1], "r+");
    const A = Buffer.from("up abc\\n"), B = Buffer.from("up abc\\n../../zzz\\nup x\\n"), C = Buffer.from("up abc\\n\\n");
    let i = 0; const stop = Date.now() + 25000;
    while (Date.now() < stop) { const b = [A, B, C][i++ % 3]; fs.ftruncateSync(fd, 0); fs.writeSync(fd, b, 0, b.length, 0); }
  `, file], { stdio: "ignore" });
  t.after(() => racer.kill());
  const script = `
    SP_PRIV='${path.join(dir, "priv")}'; DAEMON_UID=${UID}; SP_NAME_RE='[a-z][a-z0-9-]{0,30}'
    ${funcs}
    i=0; ok=0; bad=0; end=$(( $(date +%s) + 40 ))
    while [ $i -lt 4000 ] && [ "$(date +%s)" -lt "$end" ]; do
      i=$((i + 1)); LINE=""; MSG=""
      if sp_read_claimed '${file}'; then
        ok=$((ok + 1))
        case "$LINE" in "up abc") ;; *) bad=$((bad + 1)); printf 'ACCEPTED %s\\n' "$LINE" >&2 ;; esac
        case "$LINE" in *"
"*) bad=$((bad + 1)); echo "ACCEPTED A NEWLINE" >&2 ;; esac
      fi
    done
    echo "tries=$i accepted=$ok bad=$bad"
    [ "$bad" = 0 ]`;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 100_000 });
  racer.kill();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const tries = Number(/tries=(\d+)/.exec(r.stdout)?.[1]);
  assert.ok(tries >= 500, `only ${tries} tries ran: ${r.stdout}`);
  assert.match(r.stdout, /bad=0/);
});

test("space helper RH-8: names that could reach another path are refused wherever a name is used (a slash, dots, a newline, a NUL, a space, a capital, 32 characters)", opts, async t => {
  const r = rig(t);
  await r.prime();
  const bad = ["up ../../etc", "up a/b", "up ..", "up .", "up a b", "up A", "up -x", "up a\nup b", "up " + "a".repeat(32)];
  const ids = bad.map(x => r.ask(x + "\n"));
  ids.push(r.ask(Buffer.from("up a\0b\n")));
  await r.helper();
  for (const id of ids) assert.equal(r.status(id).state, "failed");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces")) || fs.readdirSync(path.join(r.SP, "private", "spaces")).length === 0);
  assert.ok(!/compose|network/.test(r.calls()));
  // And a queue entry built by anything else is refused at the top of sp_do: the function is only ever given validated words, and checks again.
  assert.match(WRAPPER_SRC, /Everything is checked again here/);
});

test("space helper RH-9: a directory or a link named like a request is removed, never moved, and cannot swallow the next request", opts, async t => {
  const r = rig(t);
  await r.prime();
  const d1 = r.hex(); fs.mkdirSync(r.spool(d1)); fs.writeFileSync(path.join(r.spool(d1), "inner"), "x");
  const good = r.ask("up harlow\n");
  fs.mkdirSync(path.join(r.SP, "private", "claim"), { recursive: true });
  const stuck = r.hex(); fs.mkdirSync(path.join(r.SP, "private", "claim", "req-" + stuck)); fs.writeFileSync(path.join(r.SP, "private", "claim", "req-" + stuck, "f"), "x");
  await r.helper();
  assert.equal(r.status(good).state, "ok");
  assert.equal(r.status(stuck).message, "interrupted");
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "private", "claim")), [], "nothing is left in claim");
  assert.deepEqual(fs.readdirSync(path.join(r.SP, "spool")), []);
});

// publish-fill: the root half of publishing a static site (reviewer-3's conditions, team/0.3/reviews/publish-edge.md).
const SPC = "spc_abcdefghijkl", SITE = "site-aBc123", SLUG = "0123456789abcdef", VOL = `vyre-publish-${SPC}_site-${SLUG}`;
const REQ = `publish-fill ${SPC} ${SITE} ${SLUG}\n`;
/** The daemon's site folder under the fake home (the folder the helper finds from Docker's mount record). @param {ReturnType<typeof rig>} r */
function site(r, /** @type {Record<string, string>} */ files = { "index.html": "<h1>hi</h1>" }) {
  const dir = path.join(r.F, "lend", "publish", SPC, "sites", SITE);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c, { mode: 0o444 }); }
  return dir;
}
const fillCalls = (/** @type {ReturnType<typeof rig>} */ r) => r.calls().split("\n").filter(l => l.startsWith("run ") && l.includes("--network none"));

test("space helper publish-fill: the folder is claimed, checked as root, copied by a throwaway container with the volume name rebuilt from the tokens, checked after, and put back", opts, async t => {
  const r = rig(t);
  await r.prime();
  const dir = site(r, { "index.html": "<h1>hi</h1>", "a/b.css": "x" });
  const id = r.ask(REQ);
  const h = /** @type {any} */ (await r.helper());
  assert.equal(h.code, 0, h.out);
  assert.equal(r.status(id).state, "ok", JSON.stringify(r.status(id)));
  const fills = fs.readFileSync(path.join(r.F, "filled"), "utf8");
  assert.match(fills, new RegExp(`-v ${VOL}:/srv `), "the volume name is the rebuilt one");
  assert.match(fills, /--network none --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE/);
  assert.match(fills, /-v \S*private\/publish-claim\/fill:\/in:ro/, "the copy reads root's claimed folder, never the daemon's");
  assert.ok(!fills.includes(r.F + "/lend"), "no daemon path reaches the container");
  assert.equal(fillCalls(r).length, 3, "looked at, filled, checked");
  assert.ok(!fs.existsSync(dir), "PF-2: the folder is not moved back through the daemon's path");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "publish-claim", "fill")), "nothing is left in the claim folder");
  assert.ok(!fs.existsSync(r.spool(id)), "the request was consumed");
  // Asked again, the volume already holds the files: nothing is copied twice, the check still runs.
  site(r);
  const id2 = r.ask(REQ); await r.helper();
  assert.equal(r.status(id2).state, "ok");
  assert.equal(fs.readFileSync(path.join(r.F, "filled"), "utf8").split("\n").filter(Boolean).length, 1, "one copy only");
});

test("space helper publish-fill: only the exact three tokens pass; a path, a volume, a capital, an extra word or another verb's shape never runs a container", opts, async t => {
  const r = rig(t);
  await r.prime();
  site(r);
  const bad = {
    "a path": `publish-fill ${SPC} ../x ${SLUG}\n`, "a path in the space id": `publish-fill ../${SPC} ${SITE} ${SLUG}\n`, "a volume name": `publish-fill ${SPC} ${SITE} ${VOL}\n`,
    "a capital in the slug": `publish-fill ${SPC} ${SITE} 0123456789ABCDEF\n`, "a short slug": `publish-fill ${SPC} ${SITE} 0123\n`, "an extra word": `publish-fill ${SPC} ${SITE} ${SLUG} /etc\n`,
    "no space id": `publish-fill ${SITE} ${SLUG}\n`, "a site name of 7 characters": `publish-fill ${SPC} site-aBc1234 ${SLUG}\n`, "a mount option": `publish-fill ${SPC} ${SITE} ${SLUG}:/etc\n`,
    "two lines": REQ + REQ, "a trailing space": `publish-fill ${SPC} ${SITE} ${SLUG} \n`,
  };
  for (const [why, text] of Object.entries(bad)) {
    const id = r.ask(text);
    await r.helper();
    assert.equal(r.status(id).state, "failed", why);
  }
  assert.equal(fillCalls(r).length, 0, "no container was started for any of them");
});

test("space helper publish-fill: a link, a second hard link, a swapped-in link or a folder that is not the daemon's is refused, nothing is copied, and the claim is deleted", opts, async t => {
  const r = rig(t);
  await r.prime();
  // a symlink inside the site
  let dir = site(r);
  fs.symlinkSync("/etc/passwd", path.join(dir, "link"));
  let id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /not a plain file or folder/);
  assert.ok(!fs.existsSync(dir), "the claim was deleted, not put back");
  fs.rmSync(dir, { recursive: true, force: true });
  // a file with a second link
  dir = site(r);
  fs.linkSync(path.join(dir, "index.html"), path.join(r.F, "outside"));
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /second link/);
  fs.rmSync(dir, { recursive: true, force: true });
  // the site folder itself is a link to another folder
  const other = fs.mkdtempSync(path.join(r.root, "other-")); fs.writeFileSync(path.join(other, "index.html"), "x");
  fs.mkdirSync(path.join(r.F, "lend", "publish", SPC, "sites"), { recursive: true });
  fs.symlinkSync(other, path.join(r.F, "lend", "publish", SPC, "sites", SITE));
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /no such site folder/);
  fs.rmSync(path.join(r.F, "lend", "publish", SPC, "sites", SITE));
  // no such folder at all
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed");
  assert.equal(fs.existsSync(path.join(r.F, "filled")), false, "nothing was ever copied");
});

test("space helper publish-fill: a copy that fails, or a volume that does not pass its check, leaves no volume in use", opts, async t => {
  const r = rig(t);
  await r.prime();
  site(r);
  r.flag("fill-fails");
  let id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /could not be copied/);
  assert.match(fs.readFileSync(path.join(r.F, "vol-rm"), "utf8"), new RegExp(VOL), "the volume was removed");
  fs.rmSync(path.join(r.F, "fill-fails"));
  site(r);
  r.flag("post-dirty");
  id = r.ask(REQ); await r.helper();
  assert.equal(r.status(id).state, "failed"); assert.match(r.status(id).message, /did not pass its check, so it was removed/);
  assert.ok(!fs.existsSync(path.join(r.F, "lend", "publish", SPC, "sites", SITE)), "the claim is gone");
});

test("space helper: `vyre uninstall` removes the helper's units too, so nothing keeps running a wrapper that is gone", opts, async t => {
  const r = rig(t);
  await r.prime();
  assert.ok(fs.existsSync(path.join(r.UNITS, "vyre-spaces.path")), "installed");
  const u = /** @type {any} */ (await r.run(["uninstall", "--delete-data", "--yes"], { VYRE_SYSTEMD_SEAM: "1" }));
  assert.ok(!fs.existsSync(path.join(r.UNITS, "vyre-spaces.path")), u.out);
  assert.ok(!fs.existsSync(path.join(r.UNITS, "vyre-spaces-watch.service")), u.out);
});

test("space helper PF-1: a copy that hangs is stopped at the time limit, the container is removed by name, the lock is released and the next request runs", opts, async t => {
  const r = rig(t);
  await r.prime();
  site(r);
  r.flag("fill-hangs");
  const id = r.ask(REQ);
  const h = /** @type {any} */ (await r.run(["space-helper-run"], { VYRE_PUBLISH_TIMEOUT: "2" }));
  assert.equal(h.code, 0, h.out);
  assert.equal(r.status(id).state, "failed");
  assert.match(r.calls(), /rm -f vyre-publish-fill/, "removed by its fixed name");
  assert.match(r.calls(), /--name vyre-publish-fill/);
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "lock-publish-fill")), "the lock is released");
  const id2 = r.ask("firewall-add harlow\n"); await r.helper();
  assert.notEqual(r.status(id2), null, "the next request was handled");
});

/** A saved database for the pinned Twenty image, as the vyre image carries it: the fake `docker run` of the generator reads it from this folder. */
const goldenIn = (/** @type {ReturnType<typeof rig>} */ r) => {
  const g = path.join(r.F, "golden-src"); fs.mkdirSync(g, { recursive: true });
  const tag = TWENTY_TESTED_REF.split("@")[0].split(":").pop();
  fs.writeFileSync(path.join(g, `${tag}.dump`), "PGDMP-fake");
  fs.writeFileSync(path.join(g, `${tag}.json`), JSON.stringify({ image: TWENTY_TESTED_REF, email: "service@golden.vyre.invalid", workspaceId: "w", builtAt: "t", sha256: crypto.createHash("sha256").update("PGDMP-fake").digest("hex") }));
  r.flag("golden-dir", g);
  return g;
};

test("space helper golden: a NEW Space starts from the saved database in the image; the dump is taken out once, read-only, and every Space's restore reads it from there; the password stays root's and the daemon's", opts, async t => {
  const r = rig(t); await r.prime(); goldenIn(r);
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "ok", JSON.stringify(r.status(id)));
  const priv = path.join(r.SP, "private"), d = path.join(priv, "spaces", "harlow");
  assert.equal(fs.statSync(path.join(priv, "golden", "golden.dump")).mode & 0o777, 0o444, "one read-only copy for every Space");
  const envAtCreate = fs.readFileSync(path.join(r.F, "env-at-create-harlow"), "utf8");
  const pw = /ADMIN_PASSWORD=([0-9a-f]{64})/.exec(envAtCreate)?.[1];
  assert.ok(pw && envAtCreate.includes(`GOLDEN_DUMP=${path.join(priv, "golden", "golden.dump")}`), "the first start's secrets carry the password and the dump path: " + envAtCreate.replace(/=[0-9a-f]{64}/g, "=<secret>"));
  const sec = fs.readFileSync(path.join(d, "secrets.env"), "utf8");
  assert.ok(!/ADMIN_PASSWORD|GOLDEN_DUMP/.test(sec), "and once the restore is over they are gone from root's copy: " + sec.replace(/=[0-9a-f]{64}/g, "=<secret>"));
  assert.match(sec, /^PG_PASSWORD=[0-9a-f]{64}\nREDIS_PASSWORD=[0-9a-f]{64}\nAPP_SECRET=[0-9a-f]{64}\nENCRYPTION_KEY=[0-9a-f]{64}\n$/, "the Space's own secrets are untouched");
  const adm = path.join(r.SP, "status", "admin-harlow");
  assert.equal(fs.readFileSync(adm, "utf8").trim(), pw, "the daemon can read the one password it signs in with");
  assert.equal(fs.statSync(adm).mode & 0o777, 0o600, "and only the daemon's uid can");
  const atCreate = fs.readFileSync(path.join(r.F, "compose-at-create-harlow"), "utf8");
  assert.match(atCreate, /\n  restore:\n/, "the first start restores the saved database");
  assert.match(atCreate, /^      - \$\{GOLDEN_DUMP:-\.\/golden\.dump\}:\/golden\.dump:ro$/m);
  assert.ok(!/ports:/.test(atCreate), "and still publishes no port");
  const after = fs.readFileSync(path.join(d, "compose.yml"), "utf8");
  assert.ok(!/restore/.test(after), "after it the compose file has no restore step");
  assert.match(after, /DISABLE_DB_MIGRATIONS: "true"/, "and the server skips its migration steps");
  assert.ok(fs.existsSync(path.join(d, "migrated")) && !fs.existsSync(path.join(d, "golden")));
  // a second Space reuses the one dump: the image is asked and copied from once
  const id2 = r.ask("up northwind\n"); await r.helper();
  assert.equal(r.status(id2).state, "ok", JSON.stringify(r.status(id2)));
  assert.equal(fs.readFileSync(path.join(r.F, "created"), "utf8").trim().split("\n").length, 1, "the dump was taken out of the image once");
  assert.notEqual(/ADMIN_PASSWORD=([0-9a-f]{64})/.exec(fs.readFileSync(path.join(r.F, "env-at-create-northwind"), "utf8"))?.[1], pw, "each Space has its own password");
  // the same up again is a plain up: no second password, no restore
  const id3 = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id3).state, "ok");
  assert.equal(fs.readFileSync(path.join(d, "secrets.env"), "utf8"), sec, "an existing Space is not given a new password or a restore");
});

test("space helper golden: an image with no saved database, or a copy that fails, is the slow path: a plain compose file and no password", opts, async t => {
  const r = rig(t); await r.prime();
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "ok");
  const d = path.join(r.SP, "private", "spaces", "harlow");
  assert.ok(!/restore|golden/i.test(fs.readFileSync(path.join(d, "compose.yml"), "utf8")) && !/ADMIN_PASSWORD/.test(fs.readFileSync(path.join(d, "secrets.env"), "utf8")));
  assert.ok(!fs.existsSync(path.join(r.SP, "status", "admin-harlow")) && !fs.existsSync(path.join(d, "golden")));
  assert.ok(!/DISABLE_DB_MIGRATIONS/.test(fs.readFileSync(path.join(d, "compose.yml"), "utf8").split("\n  worker:")[0]), "the server migrates as before");
  goldenIn(r); r.flag("cp-fails");
  const b = r.ask("up northwind\n"); await r.helper();
  assert.equal(r.status(b).state, "ok", "a failed copy does not stop the Space coming up: " + JSON.stringify(r.status(b)));
  assert.ok(!fs.existsSync(path.join(r.SP, "status", "admin-northwind")) && !fs.existsSync(path.join(r.SP, "private", "spaces", "northwind", "golden")));
});

test("space helper golden: the lint allows the restore step's one mount and nothing else; a mount of another path is refused and nothing is started", opts, async t => {
  const r = rig(t); await r.prime(); goldenIn(r); r.flag("bad-restore");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "failed");
  assert.match(r.status(a).message, /refused: lint: a volume entry/);
  assert.ok(!/ create/.test(r.calls()), "compose never ran: " + r.calls());
});

test("space helper golden: the admin password file is removed after ten minutes", opts, async t => {
  const r = rig(t); await r.prime(); goldenIn(r);
  const a = r.ask("up harlow\n"); await r.helper();
  const adm = path.join(r.SP, "status", "admin-harlow");
  assert.ok(fs.existsSync(adm));
  const old = new Date(Date.now() - 11 * 60 * 1000); fs.utimesSync(adm, old, old);
  await r.helper();
  assert.ok(!fs.existsSync(adm), "a password nobody read does not stay");
  void a;
});

test("space helper: a Space that a request is bringing up is left alone by the watcher's reattach (its server is not running yet while a restore comes first); without the lock it is stopped as before", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  r.flag("ctr-pid", "9393"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const lock = path.join(r.SP, "private", "lock-harlow"); fs.mkdirSync(lock);
  const held = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.ok(!/was stopped/.test(held.out), held.out);
  assert.ok(fs.existsSync(path.join(r.F, "running-harlow")), "still running: the request that holds the lock proves it");
  fs.rmdirSync(lock);
  const free = /** @type {any} */ (await r.run(["space-helper", "reattach"]));
  assert.match(free.out, /the Space harlow was stopped/);
});

test("space helper: a lock left by a run that is gone does not leave its Space unwatched; a lock whose run is alive, or one with no run named that is fresh, still does", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  const lock = path.join(r.SP, "private", "lock-harlow");
  const again = async () => { r.flag("ctr-pid", String(9000 + Math.floor(Math.random() * 900))); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective"); fs.writeFileSync(path.join(r.F, "running-harlow"), "1"); return /** @type {any} */ (await r.run(["space-helper", "reattach"])); };
  // a live run (this test's own process) holds it: left alone
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  assert.ok(!/was stopped/.test((await again()).out), "a live run's lock is respected");
  // a run that is gone (a pid nothing has): the Space is watched again, and stopped when it cannot be proved
  fs.writeFileSync(path.join(lock, "pid"), "2147483646");
  assert.match((await again()).out, /the Space harlow was stopped/, "a dead run's lock does not count");
  // no run named: fresh counts, two hours old does not
  fs.rmSync(path.join(lock, "pid"));
  assert.ok(!/was stopped/.test((await again()).out), "a fresh lock with no pid is respected");
  const old = new Date(Date.now() - 3 * 3600 * 1000); fs.utimesSync(lock, old, old);
  assert.match((await again()).out, /the Space harlow was stopped/, "a lock older than two hours does not count");
});

test("space helper #90: a first start cut off midway leaves a database with an empty core schema; the next up removes that empty database and starts again, with no manual step", opts, async t => {
  const r = rig(t);
  await r.prime();
  const d = path.join(r.SP, "private", "spaces", "harlow");
  // the first start is cut off: the store never became healthy, and what is left is a database with no core user table
  r.flag("up-fails");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "failed");
  assert.ok(!fs.existsSync(path.join(d, "ready")), "no completion mark after a start that did not finish");
  fs.rmSync(path.join(r.F, "up-fails")); r.flag("core-empty-harlow");
  // the next up (the daemon's retry) finds it, removes it and starts again
  const b = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(b).state, "ok", JSON.stringify(r.status(b)));
  assert.match(fs.readFileSync(path.join(r.F, "purged"), "utf8"), /harlow/, "the empty database's volumes were removed");
  assert.match(fs.readFileSync(path.join(r.SP, "private", "log"), "utf8"), /repair: empty core schema from a cut off first start/, "the log says what was repaired");
  assert.ok(fs.existsSync(path.join(d, "ready")), "and the Space has its mark now");
  assert.ok(!fs.existsSync(path.join(r.F, "core-empty-harlow")));
});

test("space helper #90: a Space with its mark is never touched, a Space with data and no mark is marked and kept, and a Space that cannot be looked at is left as it is", opts, async t => {
  const r = rig(t);
  await r.prime();
  const d = path.join(r.SP, "private", "spaces", "harlow");
  const a = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(a).state, "ok");
  assert.ok(fs.existsSync(path.join(d, "ready")));
  // marked: even a database that looks empty (it is not asked about) keeps its volumes
  r.flag("core-empty-harlow");
  const b = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(b).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "purged")), "a Space with its mark is never purged");
  // data and no mark (a Space made before the mark existed): kept, and marked after it starts
  fs.rmSync(path.join(d, "ready")); fs.rmSync(path.join(r.F, "core-empty-harlow"));
  const c = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(c).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "purged")) && fs.existsSync(path.join(d, "ready")));
  // no mark and the database cannot be asked: left alone, and nothing is purged
  fs.rmSync(path.join(d, "ready")); r.flag("core-empty-harlow"); r.flag("exec-fails");
  const e = r.ask("up harlow\n"); await r.helper();
  assert.ok(!fs.existsSync(path.join(r.F, "purged")), "a Space that cannot be looked at is not purged");
  void e;
});
