// @ts-check
// The sandbox a session process runs in on a member's computer (DESIGN-local-runner section 2).
//
// It sees only its workspace folder and the tools it was granted. It cannot read the rest of the disk, the
// keychain or another space. Its network reaches one thing: the runner's egress proxy, which forwards to the AI
// provider and to the space (egress.js). Nothing else is reachable, so a tool the model starts cannot phone out.
//
// Built on proven sandboxes, not our own: macOS seatbelt (sandbox-exec) and Linux bubblewrap. Windows is chosen by
// the spike (team/0.3/SPIKE-runner-windows.md) and lives in sandbox-win.js.
//
// plan() is pure: it returns the argv to run and what to clean up, so tests read the profile without running it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planWin } from "./sandbox-win.js";
import { filter as seccompFilter } from "./seccomp.js";

export const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), "shim.js");

/** The variables a sandboxed session may be given. Everything else is dropped (LD_PRELOAD, NODE_OPTIONS, tokens). */
const ENV_KEYS = /^(DEVELOPER_DIR|PATH|LANG|LC_[A-Z]+|TERM|TZ|NO_COLOR|FORCE_COLOR|VYRE_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|DISABLE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY)$/;

/** @param {Record<string, string|undefined>} env */
export function cleanEnv(env = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && ENV_KEYS.test(k)) out[k] = v;
  return out;
}

/** Folders that hold a person's secrets. A folder that has one as a direct child is never bound into a sandbox. */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".netrc", ".git-credentials", ".npmrc", ".claude"];

/**
 * Refuse a folder the sandbox must never see whole: the root, the home folder or any folder above it, or a folder with a secret
 * folder directly in it (reviewer-2 R5, probe Z7). A tool is granted as its own install folder, never a person's home.
 * @param {string} dir @param {string} [home]
 */
export function checkBind(dir, home = process.env.HOME || process.env.USERPROFILE || "") {
  const d = real(dir);
  const root = path.parse(d).root;
  const h = home ? real(home) : "";
  if (d === root || (h && (d === h || h.startsWith(d.endsWith(path.sep) ? d : d + path.sep)))) throw new Error(`the sandbox is never given ${d}: it is a home folder or above it`);
  for (const n of SECRET_DIRS) if (fs.existsSync(path.join(d, n))) throw new Error(`the sandbox is never given ${d}: it holds ${n}`);
  return d;
}

/** The one line a Windows member sees. */
export const WINDOWS_LINE = "Running a space's work on this computer isn't available on Windows yet. Your sessions run on the space's server.";

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const q = s => JSON.stringify(String(s));
const ancestors = p => { const out = []; for (let d = path.dirname(p); d !== p; p = d, d = path.dirname(d)) out.push(d); out.push("/"); return out; };

/**
 * @typedef {object} PlanOpts
 * @property {"darwin"|"linux"|"win32"} platform
 * @property {string} workspace  the mounted, decrypted workspace folder: the only place the session may write
 * @property {string} command    absolute path of the program (the agent)
 * @property {string[]} [args]
 * @property {Record<string, string|undefined>} [env]
 * @property {string[]} [readOnly]  extra folders the tools need to read (the node install, the agent's own folder)
 * @property {{ port?: number, socket?: string }} proxy  where the egress proxy is: a loopback port (macOS) or a unix socket (Linux)
 * @property {{ dir?: string }} [preview]  a dev server the session starts may be previewed: Linux binds `dir` in as /run/preview (the in-sandbox shim listens there and forwards to the server's loopback port); macOS lets the session listen on loopback
 * @property {string} [folder]  a folder of this computer the person approved for chats (core/runner/folders.js): the session works IN it, writing to it directly, and the workspace is not its folder
 * @property {number} [innerPort]  Linux: the loopback port the in-sandbox shim listens on (default 18443)
 * @property {string} [space]  Windows: the space the container is named for
 * @property {string} [launcher]  Windows: path of vyre-sandbox.exe
 * @property {string} [home]  the person's home folder, for the bind check (default: this process's)
 * @property {{ token: string }} [internet]  the Space allows the internet for this session: git, npm and pip reach it through the runner's proxy (HTTPS_PROXY), public addresses only
 * @property {string} [node]  the node binary the Linux shim runs under (default process.execPath)
 * @property {{ socket: string }} [vyre]  the runner's door to Vyre for a chat's session (a unix socket the session's Vyre MCP server speaks to as VYRE_SOCKET); the only socket besides the proxy it may open
 */

/**
 * The seatbelt profile. Deny by default; read the system, read and write the workspace, reach the proxy's port.
 * @param {PlanOpts} o
 */
export function seatbeltProfile(o) {
  const ws = real(o.workspace);
  const ro = [...new Set((o.readOnly || []).map(d => checkBind(d, o.home)))];
  needTool(o.command, ro, ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  const folder = o.folder ? checkBind(o.folder, o.home) : null;
  const meta = new Set(["/", ...ancestors(ws), ...ro.flatMap(ancestors), ...(folder ? [...ancestors(folder), folder] : [])]);
  const lines = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow signal (target self))",
    // No blanket sysctl-read: system.sb already lists the few a node program needs, and a blanket rule can expose other processes'
    // arguments and environment (reviewer-2 R8). The system resolver is denied too: the only address the session needs is a literal loopback one.
    '(deny mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.networkd") (global-name "com.apple.nsurlsessiond") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.pasteboard.1") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd") (global-name "com.apple.windowserver.active") (global-name "com.apple.lsd.open") (global-name "com.apple.coreservices.launchservicesd"))',
    // The system programs and libraries a shell and node need. Never /Users, /Volumes or /private/var/folders.
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library/Frameworks") (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (literal "/private/etc/passwd") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf"))',
    '(allow process-exec (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/sbin") (subpath "/sbin"))',
    // /usr/bin/git and the other developer tools are shims that read the selected toolchain and run it from the Command Line Tools or Xcode
    // (without these, a clone fails with "xcode-select: error", measured on a hosted Mac). Read and run only; nothing is writable.
    '(allow file-read* (subpath "/private/var/select") (literal "/private/var/db/xcode_select_link") (subpath "/Library/Developer/CommandLineTools") (subpath "/Applications/Xcode.app/Contents/Developer"))',
    '(allow process-exec (subpath "/Library/Developer/CommandLineTools") (subpath "/Applications/Xcode.app/Contents/Developer"))',
    `(allow file-read* file-write* (subpath ${q(ws)}))`,
    `(allow process-exec (subpath ${q(ws)}))`,
    ...(folder ? [`(allow file-read* file-write* (subpath ${q(folder)}))`, `(allow process-exec (subpath ${q(folder)}))`] : []),
    ...(o.internet ? [`(allow file-read* (literal ${q(PROXYCMD)}))`] : []),
    ...ro.map(d => `(allow file-read* (subpath ${q(d)}))\n(allow process-exec (subpath ${q(d)}))`),
    ...[...meta].map(d => `(allow file-read-metadata (literal ${q(d)}))`),
  ];
  if (o.proxy.port) lines.push(`(allow network-outbound (remote ip "localhost:${o.proxy.port}"))`);
  // a preview of a dev server the session starts: it may listen on loopback and be reached from loopback, and still reach nothing else (its outbound network is the proxy and the door only)
  if (o.preview) lines.push('(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))');
  if (o.vyre) {
    // The session may open the door and see that it is there: a hook looks at VYRE_SOCKET before it trusts it (harness/lib/vyre.js socketThere), and without this the Harness hooks on a Mac thought Vyre was not set up
    // and did nothing, the security floor among them. Only the socket and the folders on its way: never a listing.
    const sock = real(o.vyre.socket);
    lines.push(`(allow network-outbound (remote unix-socket (path-literal ${q(sock)})))`);
    for (let d = sock; ; d = path.dirname(d)) { lines.push(`(allow file-read-metadata (literal ${q(d)}))`); if (d === path.dirname(d)) break; }
  }
  return lines.join("\n") + "\n";
}

/** The program must be in a granted tool folder or a system one: nothing is bound just because the command lives there. */
function needTool(command, granted, system) {
  const c = real(command);
  const under = (p, d) => p === d || p.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
  if (![...granted, ...system].some(d => under(c, d))) throw new Error(`${command} is not in a granted tool folder: pass its install folder in readOnly`);
}

/** @param {PlanOpts} o */
/** macOS: point the developer-tool shims (git, make, clang) straight at the installed toolchain, so they skip the lookup that reads the person's preferences (slow when the home is denied, and a failure when it is unreadable). */
const developerDir = () => ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"].find(d => fs.existsSync(d));

function planDarwin(o) {
  const ws = real(o.workspace);
  const home = path.join(ws, "home");
  const tmp = path.join(ws, "tmp");
  const base = proxyUrl(o.proxy.port);
  const dd = developerDir();
  const env = { ...cleanEnv(o.env), ...(dd ? { DEVELOPER_DIR: dd } : {}), HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin:" + [...(o.readOnly || [])].map(d => path.join(real(d), "bin")).join(":"), ...proxyEnv(base, o.internet), ...(o.vyre ? { VYRE_SOCKET: real(o.vyre.socket) } : {}) };
  return { argv: ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(o), "/bin/sh", "-c", 'umask 077; exec "$0" "$@"', o.command, ...(o.args || [])], env, cwd: o.folder ? checkBind(o.folder, o.home) : path.join(ws, "files"), cleanup() {}, profile: seatbeltProfile(o) };
}

/**
 * bubblewrap: every namespace unshared (user, ipc, pid, net, uts, cgroup), nothing of the host mounted but the
 * system programs read-only and the workspace read-write. The network namespace holds only loopback; the shim
 * there forwards one port to the proxy's unix socket, which is bound in.
 * @param {PlanOpts} o
 */
function planLinux(o) {
  const ws = real(o.workspace);
  const node = o.node || process.execPath;
  const inner = o.innerPort || 18443;
  const sock = o.proxy.socket || "";
  const sys = d => ["/usr", "/bin", "/lib", "/lib64", "/etc"].includes(d) || d.startsWith("/usr/");
  const ro = [...new Set([...(o.readOnly || []), path.dirname(node)].map(d => real(d)))].filter(d => !sys(d)).map(d => checkBind(d, o.home));
  needTool(o.command, ro, ["/usr"]);
  const home = "/work/home";
  const base = proxyUrl(inner);
  const env = { ...cleanEnv(o.env), HOME: home, TMPDIR: "/work/tmp", PATH: "/usr/local/bin:/usr/bin:/bin:" + ro.map(d => path.join(d, "bin")).join(":"), ...proxyEnv(base, o.internet, "/opt/vyre-proxycmd.js"), ...(o.vyre ? { VYRE_SOCKET: "/run/vyre.sock" } : {}) };
  const argv = [
    "bwrap", "--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--unshare-user", "--cap-drop", "ALL", "--disable-userns",
    ...ro.flatMap(d => ["--ro-bind", d, d]),
    "--ro-bind", SHIM, "/opt/vyre-shim.js", "--ro-bind", PROXYCMD, "/opt/vyre-proxycmd.js", "--ro-bind", fakePasswd(home), "/etc/passwd",
    "--bind", ws, "/work", ...(o.folder ? ["--bind", checkBind(o.folder, o.home), "/work/files"] : []), "--chdir", "/work/files",
    ...(sock ? ["--ro-bind", sock, "/run/egress.sock"] : []),
    ...(o.vyre ? ["--ro-bind", o.vyre.socket, "/run/vyre.sock"] : []),
    ...(o.preview && o.preview.dir ? ["--bind", o.preview.dir, "/run/preview"] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
    node, "/opt/vyre-shim.js", "--listen", String(inner), "--to", "/run/egress.sock", ...(o.preview && o.preview.dir ? ["--preview", "/run/preview/p.sock"] : []), "--", "/bin/sh", "-c", 'umask 077; exec "$0" "$@"', o.command, ...(o.args || []),
  ];
  // The deny-list filter goes in over fd 3 (see launch()).
  const sc = seccompFilter();
  if (!sc) throw new Error(`no seccomp filter for this CPU (${process.arch}): a session is not started without one`);
  argv.splice(1, 0, "--seccomp", "3");
  return { argv, env: {}, cwd: undefined, cleanup() {}, profile: argv.join(" "), fd3: sc || undefined };
}

/**
 * Start a planned sandbox process. Writes the plan's fd 3 payload (the seccomp filter) into a pipe the sandbox reads at start.
 * @param {ReturnType<typeof plan>} p @param {import("node:child_process").SpawnOptions} [opts]
 */
export function launch(p, opts = {}) {
  const stdio = p.fd3 ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
  const child = spawn(p.argv[0], p.argv.slice(1), { env: p.env, cwd: p.cwd, ...opts, stdio: /** @type {any} */ (stdio) });
  if (p.fd3 && child.stdio[3]) { const w = /** @type {any} */ (child.stdio[3]); w.on("error", () => {}); w.end(p.fd3); }
  return child;
}

const proxyUrl = port => `http://127.0.0.1:${port}`;
/** The session talks to the provider and the space through the proxy; the key it is given is a worthless session token. */
/** ssh (git over ssh) cannot use an HTTP proxy by itself: its ProxyCommand does the CONNECT. The node binary and proxycmd.js are in the sandbox (the shim path is bound on Linux). */
/** A one-line /etc/passwd for the sandbox (ssh and some tools want the current user to exist): this user only, no one else's name. */
export function fakePasswd(home) {
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
  const f = path.join(os.tmpdir(), `vyre-passwd-${uid}`);
  const body = `vyre:x:${uid}:${gid}:vyre:${home}:/bin/sh\n`;
  try { if (fs.readFileSync(f, "utf8") !== body) throw 0; } catch { fs.writeFileSync(f, body, { mode: 0o644 }); }
  return f;
}
export const PROXYCMD = path.join(path.dirname(fileURLToPath(import.meta.url)), "proxycmd.js");
export const sshCommand = (base, token, script = PROXYCMD) => `ssh -o StrictHostKeyChecking=accept-new -o ProxyCommand='${process.execPath} ${script} ${base.replace(/^http:\/\//, "")} ${token} %h %p'`;
const proxyEnv = (base, internet, script) => ({ ANTHROPIC_BASE_URL: `${base}/provider`, VYRE_SPACE_URL: `${base}/space`, ...(internet ? { HTTPS_PROXY: `http://vyre:${internet.token}@${base.replace(/^http:\/\//, "")}`, HTTP_PROXY: `http://vyre:${internet.token}@${base.replace(/^http:\/\//, "")}`, NO_PROXY: "", GIT_SSH_COMMAND: sshCommand(base, internet.token, script) } : {}) });

/**
 * @param {PlanOpts} o
 * @returns {{ argv: string[], env: Record<string, string>, cwd?: string, cleanup(): void, profile: string, fd3?: Buffer }}
 */
export function plan(o) {
  if (!path.isAbsolute(o.command)) throw new Error("the sandbox runs an absolute program path");
  if (o.platform === "darwin") return planDarwin(o);
  if (o.platform === "linux") return planLinux(o);
  if (o.platform === "win32") { for (const d of o.readOnly || []) checkBind(d, o.home); return planWin(/** @type {any} */ ({ ...o, cleanEnv })); }
  throw new Error(`no sandbox for ${o.platform} yet`);
}

/** Why a sandbox cannot run here, or "" when it can. Linux needs bwrap and an unprivileged user namespace. */
export function unavailable(platform = process.platform, run = spawnProbe) {
  if (platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec") ? "" : "sandbox-exec is missing";
  if (platform === "linux") {
    if (!seccompFilter()) return `no seccomp filter for this CPU (${process.arch}): a session is not started without one`;
    const r = run("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"]);
    if (r.status === 0) return "";
    if (r.error) return "bubblewrap is not installed (apt install bubblewrap)";
    return /uid map|Permission denied|RTM_NEWADDR|Operation not permitted/.test(r.stderr) ? "this system blocks unprivileged user namespaces for bubblewrap (Ubuntu 24.04 needs the bwrap AppArmor profile, see docs/using/local-runner.md)" : `bubblewrap failed: ${r.stderr.trim().slice(0, 160)}`;
  }
  // Windows lending is out of 0.3 (ruled 4 Oct): the launcher and BitLocker code stay on the branch, unreachable until 0.3.1.
  if (platform === "win32") return process.env.VYRE_WINDOWS_LENDING === "experimental" ? (fs.existsSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe") ? "" : ".NET Framework 4 (csc.exe) is missing") : WINDOWS_LINE;
  return "no sandbox for this system yet";
}

import { spawn, spawnSync } from "node:child_process";
function spawnProbe(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  return { status: r.status, stderr: String(r.stderr || ""), error: r.error };
}
