// @ts-check
// wall: what stops a sandboxed child from reaching anything but its parent. The mediated fetch is
// only a rule the child's code could ignore (it can `import net`); the wall makes the rule true.
//
// A wall starts the child with: no network (no loopback, no unix socket, nothing), a view of the
// filesystem that holds the watcher's folder, the node binary and the system libraries and nothing
// of the person's home or run directories, no sight of other processes, and no signal to them.
//   bwrap         bubblewrap (Linux): user, net, mount, pid, ipc, uts and cgroup namespaces over a
//                 minimal root; --die-with-parent; no fds but stdin, stdout, stderr
//   sandbox-exec  a profile on macOS: network denied (unix sockets included), signals to others
//                 denied, writes denied, reads of the home and temp and run areas denied except the
//                 watcher's folder and the runtime
// No root and no install beyond bubblewrap itself on Linux. Each wall is probed for real before it
// is trusted: a child started through it must FAIL to reach a TCP listener, a unix-socket listener
// and a file in the home directory, and to signal a process of the same user, and must SUCCEED in
// reading the folder it was given. If no wall passes there is none, and the caller refuses to run
// a watcher (fail closed, never unisolated).

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

/** @typedef {{ ro?: string[], cwd?: string }} WrapOpts */
/**
 * A wall is either a wrapper that turns argv into a command (bwrap, sandbox-exec), or a launcher that
 * starts the child itself (the box's spawner), returning something shaped like a ChildProcess. A
 * launched child cannot read the person's folders, so `materialize` says the watcher's files are handed
 * to it over its channel and written into its own private TMPDIR, and `workGlob` names where it may
 * read and write (a path ending in /*, for node's permission flags).
 * @typedef {{ kind: string, wrap?: (argv: string[], o?: WrapOpts) => { cmd: string, args: string[] },
 *   launch?: (argv: string[], o?: WrapOpts) => Promise<any>, materialize?: boolean, workGlob?: string }} Candidate */
/** @typedef {Candidate & { why: string }} Wall */

const first = paths => paths.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const sb = s => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The bwrap arguments for a minimal root: the system libraries, the given read-only paths, a private /proc, /dev and /tmp. */
export function bwrapArgs(argv, { ro = [], cwd } = {}, host = { exists, isLink: p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }, readLink: p => fs.readlinkSync(p) }) {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"];
  for (const dir of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
    if (!host.exists(dir)) continue;
    if (dir !== "/usr" && host.isLink(dir)) args.push("--symlink", host.readLink(dir), dir);
    else args.push("--ro-bind", dir, dir);
  }
  for (const f of ["/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/alternatives"]) if (host.exists(f)) args.push("--ro-bind", f, f);
  // A private /tmp first; read-only binds after it, so a folder under /tmp (a temp home) is still seen.
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  const seen = new Set();
  for (const p of ro) { const r = real(p); if (!seen.has(r) && !/^\/(usr|lib|lib64|bin|sbin|proc|dev)(\/|$)/.test(r)) { seen.add(r); args.push("--ro-bind", r, r); } }
  if (cwd) args.push("--chdir", real(cwd));
  return [...args, "--", ...argv];
}

/** The sandbox-exec profile for a child that may read `ro` and talk only to its parent. */
export function macProfile(ro = [], home = os.homedir()) {
  const deny = [...new Set(["/Users", "/private/var/folders", "/private/tmp", "/private/var/run", "/var/root", "/Library/Application Support", home].map(p => real(p)))];
  const lines = ["(version 1)", "(allow default)", "(deny network*)", "(deny signal)", "(allow signal (target self))", "(deny process-info* (target others))",
    "(deny file-write* (subpath \"/\"))", "(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\") (literal \"/dev/tty\"))",
    `(deny file-read* ${deny.map(d => `(subpath ${sb(d)})`).join(" ")})`];
  const allow = [...new Set(ro.map(p => real(p)))];
  if (allow.length) {
    lines.push(`(allow file-read* ${allow.map(p => `(subpath ${sb(p)})`).join(" ")})`);
    // Node walks every parent of a path it opens, so the parents may be looked at (their names, never their contents).
    const parents = new Set();
    for (const a of allow) for (let d = path.dirname(a); d && d !== "/" && !parents.has(d); d = path.dirname(d)) parents.add(d);
    if (parents.size) lines.push(`(allow file-read-metadata ${[...parents].map(p => `(literal ${sb(p)})`).join(" ")})`);
  }
  return lines.join("\n");
}

/** @param {{ platform?: string, find?: (paths: string[]) => string|undefined }} [o] @returns {Candidate[]} */
export function candidates({ platform = process.platform, find = first } = {}) {
  /** @type {Candidate[]} */
  const out = [];
  if (platform === "linux") {
    const bwrap = find(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]);
    if (bwrap) out.push({ kind: "bwrap", wrap: (argv, o) => ({ cmd: bwrap, args: bwrapArgs(argv, o) }) });
  }
  if (platform === "darwin") {
    const sbx = find(["/usr/bin/sandbox-exec"]);
    if (sbx) out.push({ kind: "sandbox-exec", wrap: (argv, o) => ({ cmd: sbx, args: ["-p", macProfile(o && o.ro), ...argv] }) });
  }
  return out;
}

/** What a wrapped child tries, as one line of JSON. Everything but the folder read must fail. */
const PROBE = ({ port, sock, file, pid, readable }) => `
const net=require("node:net"),fs=require("node:fs");const out={};
const tcp=new Promise(r=>{const s=net.connect(${port},"127.0.0.1");s.on("connect",()=>{out.tcp="connected";r()});s.on("error",e=>{out.tcp="blocked:"+e.code;r()});setTimeout(()=>{out.tcp="blocked:TIMEOUT";r()},2500)});
const unix=new Promise(r=>{const s=net.connect(${JSON.stringify(sock)});s.on("connect",()=>{out.unix="connected";r()});s.on("error",e=>{out.unix="blocked:"+e.code;r()});setTimeout(()=>{out.unix="blocked:TIMEOUT";r()},2500)});
try{fs.readFileSync(${JSON.stringify(file)});out.file="read"}catch(e){out.file="blocked:"+e.code}
try{process.kill(${pid},0);out.signal="sent"}catch(e){out.signal="blocked:"+e.code}
try{${readable === null ? `const d=process.env.TMPDIR;fs.writeFileSync(d+"/p","folder-readable");out.folder=fs.readFileSync(d+"/p","utf8")` : `out.folder=fs.readFileSync(${JSON.stringify(readable)},"utf8")`}}catch(e){out.folder="blocked:"+e.code}
Promise.all([tcp,unix]).then(()=>{console.log(JSON.stringify(out));process.exit(0)});`;

/** Run argv through a launcher and collect what it prints, shaped like run(). */
const runLaunched = (launch, argv) => new Promise(resolve => {
  let out = "", err = "", done = false;
  const finish = ok => { if (!done) { done = true; clearTimeout(timer); resolve({ ok, stdout: out.trim(), stderr: err.trim(), err: ok ? null : new Error(err.trim() || "failed") }); } };
  const timer = setTimeout(() => finish(false), 10000);
  Promise.resolve(launch(argv, { ro: [], cwd: undefined })).then(child => {
    child.stdout && child.stdout.on("data", c => { out += c; });
    child.stderr && child.stderr.on("data", c => { err += c; });
    child.on("error", e => { err += String(e && e.message || e); finish(false); });
    child.on("exit", code => finish(code === 0));
    try { child.stdin && child.stdin.end(); } catch {}
  }, e => { err += String(e && e.message || e); finish(false); });
});

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { encoding: "utf8", timeout: 10000, env: {} }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), err }));
});

/**
 * Probe one candidate for real, with the child's own attempts. The control (the same child with no
 * wrapper) must reach everything, so a listener that was never reachable cannot make a useless
 * wall look good.
 * @param {Candidate} c
 * @param {string} [node]
 * @returns {Promise<{ ok: boolean, why: string }>}
 */
export async function probe(c, node = process.execPath) {
  const tag = crypto.randomBytes(6).toString("hex");
  const sock = path.join(os.homedir(), `.vyre-wall-probe-${tag}.sock`);
  const file = path.join(os.homedir(), `.vyre-wall-probe-${tag}.txt`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-wall-"));
  const readable = c.launch ? null : path.join(folder, "ok.txt");
  if (readable) fs.writeFileSync(readable, "folder-readable");
  fs.writeFileSync(file, "home-secret", { mode: 0o600 });
  const tcp = net.createServer(s => s.end()), uds = net.createServer(s => s.end());
  const sleeper = spawn(node, ["-e", "setTimeout(()=>{},15000)"], { stdio: "ignore", env: {} });
  try {
    await new Promise(r => tcp.listen(0, "127.0.0.1", () => r(undefined)));
    await new Promise(r => uds.listen(sock, () => r(undefined)));
    const code = PROBE({ port: /** @type {any} */ (tcp.address()).port, sock, file, pid: sleeper.pid, readable });
    const control = await run(node, ["-e", code]);
    let ctl; try { ctl = JSON.parse(control.stdout); } catch { ctl = null; }
    if (!ctl || ctl.tcp !== "connected" || ctl.unix !== "connected" || ctl.file !== "read" || ctl.signal !== "sent") return { ok: false, why: "the probe's own targets were not reachable even without a wall" };
    let walled;
    if (c.launch) walled = await runLaunched(c.launch, [node, "-e", code]);
    else { const w = /** @type {NonNullable<Candidate["wrap"]>} */ (c.wrap)([node, "-e", code], { ro: [folder, node, path.dirname(real(node))] }); walled = await run(w.cmd, w.args); }
    if (!walled.ok) return { ok: false, why: `${c.kind} could not start a child: ${(walled.stderr || String(walled.err && walled.err.message)).split("\n")[0].slice(0, 200)}` };
    let got; try { got = JSON.parse(walled.stdout); } catch { return { ok: false, why: `${c.kind} started a child that gave no usable answer` }; }
    const leaks = [];
    if (!String(got.tcp).startsWith("blocked")) leaks.push("a loopback socket");
    if (!String(got.unix).startsWith("blocked")) leaks.push("a unix socket");
    if (!String(got.file).startsWith("blocked")) leaks.push("a file in the home directory");
    if (!String(got.signal).startsWith("blocked")) leaks.push("another process");
    if (leaks.length) return { ok: false, why: `${c.kind} started a child that could still reach ${leaks.join(", ")}` };
    if (got.folder !== "folder-readable") return { ok: false, why: `${c.kind} started a child that could not read the folder it was given` };
    return { ok: true, why: `${c.kind}: a child cannot reach a socket, the home directory or another process` };
  } finally {
    sleeper.kill("SIGKILL"); tcp.close(); uds.close();
    for (const p of [sock, file]) { try { fs.rmSync(p, { force: true }); } catch {} }
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** The plain-words reason a Linux machine has no wall, with the one fix. */
export function linuxHint({ platform = process.platform, readFile = p => fs.readFileSync(p, "utf8"), has = exists } = {}) {
  if (platform !== "linux") return "";
  let restricted = false;
  try { restricted = readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() === "1"; } catch {}
  if (!has("/usr/bin/bwrap") && !has("/bin/bwrap") && !has("/usr/local/bin/bwrap")) return " Install bubblewrap (sudo apt install bubblewrap), which watchers run inside.";
  return restricted ? " This system restricts unprivileged user namespaces (Ubuntu 23.10 and later): bubblewrap needs the AppArmor profile that allows it (the bubblewrap package ships one; `sudo vyre up --system` installs it if it is missing), or run sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0." : "";
}

/** @type {Promise<{ wall: Wall|null, why: string }>|null} */
let cached = null;

/**
 * The first candidate that passes its probe, or null with why. Probed once per process.
 * @param {{ candidates?: Candidate[], node?: string, fresh?: boolean }} [o]
 * @returns {Promise<{ wall: Wall|null, why: string }>}
 */
export function getWall({ candidates: list = candidates(), node = process.execPath, fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const p = (async () => {
    const reasons = [];
    for (const c of list) {
      const r = await probe(c, node);
      if (r.ok) return { wall: { kind: c.kind, why: r.why, wrap: c.wrap, launch: c.launch, materialize: c.materialize, workGlob: c.workGlob }, why: r.why };
      reasons.push(r.why);
    }
    const base = reasons.length ? reasons.join("; ") : `this machine (${process.platform}) has no way to start a child without a network`;
    return { wall: null, why: base + (list.length === 0 || reasons.length ? linuxHint() : "") };
  })();
  if (!fresh) cached = p;
  return p;
}

/** For tests: forget the probed wall. */
export function forgetWall() { cached = null; }
