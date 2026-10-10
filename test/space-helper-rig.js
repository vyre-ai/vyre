// @ts-check
// The Space helper tests' rig (fakes for docker and nsenter, the wrapper, the folders), shared by test/space-helper.test.js and test/space-helper-2.test.js: one file ran past the per-file limit.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";
import { TWENTY_TESTED_REF, composeFile } from "../stores/twenty/provision.js";
// The Space helper (box/vyre `space-helper-run`, `space-helper`, `admin`; team/archive/work-journals/space-helper.md Revision 2): the root side of a Space's Twenty store.
// Run with sh against a temp folder standing in for /var/lib/vyre-spaces. docker, nsenter (with a tiny iptables that keeps one rule list per pid, the
// container's namespace) and the other host tools are fakes on PATH; the compose file is the REAL one, from stores/twenty/provision.js. Linux only (stat -c).
// A request from another uid and a real iptables owner match need a real box: see team/archive/work-journals/space-helper.md for the box test list.

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WRAPPER_SRC = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
export const LINUX = process.platform === "linux";

export const DOCKER = `
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

export const NSENTER = `
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
export function rig(t) {
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

export const UID = process.getuid();
export const ranges = (/** @type {string} */ n) => [`-d 172.30.4.0/24 -m owner --uid-owner 0-${UID - 1} -m comment --comment vyre:${n} -j REJECT`, `-d 172.30.4.0/24 -m owner --uid-owner ${UID + 1}-4294967294 -m comment --comment vyre:${n} -j REJECT`].sort();
export const opts = { skip: !LINUX && "the helper's stat -c and the fakes are Linux only" };
