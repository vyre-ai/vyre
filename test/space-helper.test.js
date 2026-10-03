// @ts-check
// The Space helper (box/vyre `space-helper-run`, `space-helper`, `admin`; docs/work/space-helper.md Revision 2): the root side of a Space's Twenty store.
// Run with sh against a temp folder standing in for /var/lib/vyre-spaces. docker, nsenter (with a tiny iptables that keeps one rule list per pid, the
// container's namespace) and the other host tools are fakes on PATH; the compose file is the REAL one, from stores/twenty/provision.js. Linux only (stat -c).
// A request from another uid and a real iptables owner match need a real box: see docs/work/space-helper.md for the box test list.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";

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
    out(rd("joined").split("\\n").join(" ") + " ");
  }
  if (name === "srv1") out(fmt.includes("Global") ? "" : (fmt.includes("IPAddress") ? "172.30.4.2" : ""));
  process.exit(1);
}
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
  if (sub === "create") { if (has("create-fails")) process.exit(1); fs.writeFileSync(F + "/net-" + n, "1"); process.exit(0); }
  if (sub === "up") { if (has("up-fails")) process.exit(1); fs.writeFileSync(F + "/running-" + n, "1"); process.exit(0); }
  if (sub === "stop") { fs.rmSync(F + "/running-" + n, { force: true }); process.exit(0); }
  if (sub === "down") { fs.rmSync(F + "/running-" + n, { force: true }); fs.rmSync(F + "/net-" + n, { force: true }); if (a.includes("-v")) fs.appendFileSync(F + "/purged", n + "\\n"); process.exit(0); }
  process.exit(0);
}
if (a[0] === "run") {
  const i = a.indexOf("-e");
  let t = cp.execFileSync("node", ["-e", a[i + 1].replace("/opt/vyre", REPO), a[i + 2], a[i + 3]], { encoding: "utf8" });
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
const norm = args => args.join(" ").replace(/ --reject-with \\S+$/, "");
if (cmd[0] === "iptables" || cmd[0] === "ip6tables") {
  const rest = cmd.slice(2);   // after -w
  const r = rules();
  if (rest[0] === "-C") process.exit(r.includes(norm(rest.slice(2))) ? 0 : 1);
  if (rest[0] === "-I") { if (has("fw-add-fails")) process.exit(1); r.unshift(norm(rest.slice(3))); save(r); process.exit(0); }
  if (rest[0] === "-D") { const x = norm(rest.slice(2)); const i = r.indexOf(x); if (i < 0) process.exit(1); r.splice(i, 1); save(r); process.exit(0); }
  if (rest[0] === "-S") { for (const l of r) console.log("-A OUTPUT " + l + " --reject-with icmp-port-unreachable"); process.exit(0); }
  process.exit(1);
}
if (cmd[0] === "setpriv") {
  const uid = cmd.find(x => x.startsWith("--reuid=")).slice(8);
  const daemon = fs.readFileSync(F + "/daemon-uid", "utf8").trim();
  if (has("store-dead")) process.exit(uid === daemon ? 1 : 124);
  if (uid === daemon) process.exit(0);
  const blocked = !has("fw-ineffective") && rules().some(l => l.includes("-d 172.30.4.0/24"));
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
  assert.ok(!/env_file|privileged|ports:|network_mode/.test(compose));
  assert.deepEqual(r.rules(), ["-d 172.30.4.0/24 -m owner --uid-owner 2000-2063 -m comment --comment vyre:harlow -j REJECT"]);
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
  assert.equal(r.rules().length, 1, "applying twice leaves one rule");
});

test("space helper: every request that is not exactly `<verb> <name>` is refused before anything runs", opts, async t => {
  const r = rig(t);
  await r.prime();
  const bad = {
    "an extra word": "up harlow now\n", "a path in the name": "up ../etc\n", "a name with a dot": "up har.low\n", "an unknown verb": "purge harlow\n",
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
  assert.equal(r.rules().length, 2);
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
  assert.equal(r.rules().length, 2);
  const early = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(early).state, "failed"); assert.match(r.status(early).message, /running/);
  assert.equal(r.rules().length, 2);
  const down = r.ask("down harlow\n"); await r.helper();
  assert.equal(r.status(down).state, "ok");
  assert.match(r.status(down).message, /data is kept/);
  assert.ok(!/ -v/.test(r.calls().split("\n").filter(l => /harlow.* down/.test(l)).join("\n")), "down never takes the volumes");
  assert.equal(r.rules().length, 2, "the rule stays until firewall-del");
  const del = r.ask("firewall-del harlow\n"); await r.helper();
  assert.equal(r.status(del).state, "ok");
  assert.deepEqual(r.rules(), ["-d 172.30.4.0/24 -m owner --uid-owner 2000-2063 -m comment --comment vyre:northwind -j REJECT"], "only harlow's rule is gone");
});

test("space helper RH-3: a recreated vyre container has no join and no rule; up re-applies with a fresh pid and proves it; a rule that does not block fails the up and stops the store", opts, async t => {
  const r = rig(t);
  await r.prime();
  r.ask("up harlow\n"); await r.helper();
  assert.equal(r.rules("4242").length, 1);
  // The container is recreated: new pid, no network joins, an empty namespace.
  r.flag("ctr-pid", "5151"); fs.writeFileSync(path.join(r.F, "joined"), "");
  assert.deepEqual(r.rules("5151"), []);
  const id = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(id).state, "ok");
  assert.equal(r.rules("5151").length, 1, "the rule went into the NEW namespace");
  assert.match(r.calls(), /nsenter -t 5151 /, "the pid is read fresh");
  // The rule is accepted but does not block (RH-4): the probe sees the agent connect, so the up fails and the store is stopped.
  r.flag("ctr-pid", "6262"); fs.writeFileSync(path.join(r.F, "joined"), ""); r.flag("fw-ineffective");
  const bad = r.ask("up harlow\n"); await r.helper();
  assert.equal(r.status(bad).state, "failed"); assert.match(r.status(bad).message, /agent uid can reach/);
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
  assert.equal(r.rules("9191").length, 1);
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
  assert.match(fs.readFileSync(path.join(r.SP, "private", "images"), "utf8"), /^postgres:16\nredis:7\ntwentycrm\/twenty:\$\{TWENTY_TAG:-v[0-9.]+\}\n$/);
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
  let a = /** @type {any} */ (await r.run(["admin", "purge", "harlow"], {}, "purge harlow\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  assert.ok(!fs.existsSync(path.join(r.F, "purged")));
  // The test seam stands in for the terminal: a wrong word does nothing, the exact one purges and removes the record and the secrets.
  a = /** @type {any} */ (await r.run(["admin", "purge", "harlow"], { VYRE_ADMIN_NO_TTY: "1" }, "y\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not the word/);
  assert.ok(fs.existsSync(path.join(r.SP, "private", "spaces", "harlow", "record")));
  a = /** @type {any} */ (await r.run(["admin", "purge", "harlow"], { VYRE_ADMIN_NO_TTY: "1" }, "purge harlow\n"));
  assert.equal(a.code, 0, a.out); assert.match(a.out, /It cannot be undone/);
  assert.equal(fs.readFileSync(path.join(r.F, "purged"), "utf8").trim(), "harlow");
  assert.ok(!fs.existsSync(path.join(r.SP, "private", "spaces", "harlow")));
  assert.equal(r.rules().length, 0, "its firewall rule is removed with it");
  a = /** @type {any} */ (await r.run(["admin", "purge", "ghost"], { VYRE_ADMIN_NO_TTY: "1" }, "purge ghost\n"));
  assert.match(a.out, /no Space named ghost/);
  // fscrypt: only on ext4 with a block device, skipped when the feature is already there, exactly tune2fs -O encrypt.
  fs.writeFileSync(path.join(r.SP, "private", "lending-base"), path.join(r.root, "lend") + "\n");
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
  const ids = [r.ask("purge harlow\n"), r.ask("fscrypt-enable\n")]; await r.helper();
  for (const id of ids) assert.equal(r.status(id).state, "failed");
});
