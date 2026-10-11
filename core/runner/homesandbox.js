// @ts-check
// The sandbox for a session Vyre starts on the person's OWN computer (platform's L-1 design, reviewer-2's D-1 to D-3). Different from the
// lent-computer sandbox (sandbox.js): there the session sees only a workspace; here the provider's agent must still start, sign in, and
// work in the person's project folders, so the rest of the disk stays visible. What this profile removes is the way back into Vyre:
//   - every unix socket and every loopback connection is refused, except the session's own socket (deny by default, one allow: D-1);
//   - the whole Vyre home (device keys, tokens, cookies, env files, the kernel and sealing folders) is unreadable and unwritable (D-2);
//   - the person's other secret folders (.ssh, .aws, .gnupg, the keychain folder) are unreadable, as in the lent sandbox.
// macOS: seatbelt with (allow default) and later deny rules. Linux: bubblewrap with a private network namespace (loopback and abstract
// sockets are then not the host's), a tmpfs over the Vyre home, and only the session's socket bound back in; the provider is reached
// through the runner's egress proxy like on a lent computer (so the agent's sign-in hosts must be routes the space or person granted).
// Windows: AppContainer with a pipe ACL for the container SID, not built yet; refused with a plain reason.
// selfTest() runs the proof FROM INSIDE the sandbox before the session starts (D-3): a session that fails any probe does not start.

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { launch, sshCommand, fakePasswd } from "./sandbox.js";
import { filter as seccompFilter } from "./seccomp.js";
import { programDirs } from "../../lib/agent-sandbox.js";
import { SHIM, PROXYCMD } from "./sandbox.js";

/** Loopback ports the sandbox itself listens on (its credentialed egress shim): a preview can never be pointed at one. */
export const SANDBOX_PORTS = [18443];
export { startHomeProxy } from "./homeproxy.js";

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const q = s => JSON.stringify(String(s));
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", ".git-credentials", "Library/Keychains"];

/**
 * @typedef {object} HomeOpts
 * @property {"darwin"|"linux"} platform
 * @property {string} command      absolute path of the agent
 * @property {string[]} [args]
 * @property {Record<string,string>} [env]
 * @property {string} home         the person's home folder
 * @property {string} vyreHome     Vyre's own folder (default: <home>/.vyre)
 * @property {string} sessionSocket  the one socket this session may reach
 * @property {string[]} [readOnly] Linux: folders bound read-only besides the system ones (the agent's install folder)
 * @property {string[]} [workdirs] folders the session may read and write (the project)
 * @property {{ command: string, args?: string[], private?: { from: string, env: string, credentialFiles: string[] }, settingsPaths?: string[], foreignSettings?: string[], hosts?: string[], versionArgs?: string[] }} [agent]  the provider's agent. `private` gives each session its OWN config folder holding only the credential files, seeded from the person's real folder `from` (which is never bound), through the env var the provider reads (CLAUDE_CONFIG_DIR). `settingsPaths` is the other accepted shape: folders named by the provider entry, checked on the real path and mounted read-write. `foreignSettings` is the other providers' folders from that same table. A provider with neither `private` nor `settingsPaths` does not start sandboxed. `hosts` are what it needs to reach, `versionArgs` make it print its version
 * @property {{ given: string, real: string, dest: string }[]} [settingsMounts]  filled by planHome after the settings check. Callers leave it unset.
 * @property {string} [temp]  the session's own temp folder (read-write)
 * @property {number[]} [daemonPorts]  the daemon's own TCP ports: refused on every address (macOS)
 * @property {(plan: any) => any} [launch]  starts a planned process (tests: a launcher whose program is missing)
 * @property {string[]} [pathDirs]  folders put first on the session's PATH on Linux (a script agent's interpreter is found by `env`); they must also be bound read-only
 * @property {string[]} [passEnv]  names of environment variables the caller deliberately passes through (a credential the agent needs); everything else not on the allow-list is dropped
 * @property {{ socket?: string, port?: number, token?: string }} [proxy] macOS: a loopback port, the only network the profile allows; Linux: the egress proxy the provider is reached through (a CONNECT tunnel to the agent's hosts only; the token is its password)
 */

/** What a session's environment may hold: the basics, Vyre's own thread variables, and only the credential names the caller lists. No token by default. */
const HOME_ENV = /^(DEVELOPER_DIR|PATH|LANG|LC_[A-Z]+|TERM|TZ|NO_COLOR|FORCE_COLOR|USER|LOGNAME|SHELL|VYRE_[A-Z0-9_]+)$/;
/** @param {Record<string, string|undefined>} env @param {string[]} [pass] */
export function homeEnv(env = {}, pass = []) {
  const ok = new Set(pass);
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && (HOME_ENV.test(k) || ok.has(k))) out[k] = v;
  return out;
}

/** Does `p` equal or lie above `d`? */
const above = (p, d) => d === p || d.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
const protectedPaths = o => { const h = real(o.home), v = real(o.vyreHome || path.join(o.home, ".vyre")); return { h, v, secrets: SECRET_DIRS.map(d => path.join(h, d)) }; };

/**
 * Refuse an entry the allow-back would turn into a hole (reviewer-3 HS-2): one that equals or contains the home folder, or that
 * equals or lies under the Vyre home or a secret folder. A project inside the home is fine.
 * @param {HomeOpts} o
 */
export function checkEntries(o) {
  const { h, v, secrets } = protectedPaths(o);
  for (const [kind, list] of [["workdir", o.workdirs || []], ["read-only folder", o.readOnly || []], ["temp folder", o.temp ? [o.temp] : []]]) {
    for (const e of list) {
      const p = real(e);
      if (p === path.parse(p).root || above(p, h)) throw new Error(`the ${kind} ${p} is the home folder or above it: a session is never given the whole home`);
      // The shared temp places hold other programs' scratch files: a session's own folder is a fresh subfolder, never the place itself or a folder above it (reviewer-2).
      if (kind !== "read-only folder") for (const tmp of [...new Set([real(os.tmpdir()), "/private/tmp", "/private/var/folders", "/tmp", "/var/tmp"].map(real))]) if (above(p, tmp)) throw new Error(`the ${kind} ${p} is, or contains, the shared temp folder ${tmp}: a session gets its own subfolder`);
      for (const prot of [v, ...secrets]) {
        if (above(prot, p)) throw new Error(`the ${kind} ${p} is inside ${prot}, which a session never sees`);
        if (above(p, prot)) throw new Error(`the ${kind} ${p} contains ${prot}, which a session never sees`);
      }
    }
  }
}

/** A path that exists, with symlinks resolved, or null when it does not. @param {string} p */
const realOr = p => { try { return fs.realpathSync(p); } catch { return null; } };
const touches = (a, b) => above(a, b) || above(b, a);

/**
 * Folders a provider cannot move (`settingsPaths`), checked before any profile is built. The list is the provider entry's.
 * Each path is resolved (symlinks first) and must be a folder strictly inside the account's home, and not Vyre's home, a secret
 * folder, or another provider's folder. A failure names a next step. Returns where each folder is mounted: the real directory,
 * and `$HOME/<name>` where the assistant looks for it.
 * @param {HomeOpts} o @returns {{ given: string, real: string, dest: string }[]}
 */
function settingsPlan(o) {
  const agent = o.agent;
  if (!agent) return [];
  const paths = Array.isArray(agent.settingsPaths) ? agent.settingsPaths.filter(s => typeof s === "string" && s) : [];
  if (agent.private && !paths.length) return [];
  if (!paths.length) throw new Error("this assistant can't run sandboxed yet: its provider entry has no config folder to relocate (configDirEnv and credentialFiles). Add a private config or a settings folder to the provider entry, then start the session again.");
  const { h, v, secrets } = protectedPaths(o);
  const secretSeen = secrets.map(s => ({ lexical: s, real: realOr(s) || s, label: SECRET_DIRS.find(d => path.join(h, d) === s) || path.basename(s) }));
  const foreign = [];
  for (const f of agent.foreignSettings || []) {
    if (typeof f !== "string" || !f) continue;
    foreign.push(path.resolve(f));
    const rr = realOr(f); if (rr) foreign.push(rr);
  }
  /** @type {{ given: string, real: string, dest: string }[]} */ const mounts = [];
  for (const given0 of paths) {
    const given = path.resolve(given0);
    const found = realOr(given);
    if (!found) throw new Error("This assistant's settings folder is not there yet. Sign the account in, then start the session again.");
    let st; try { st = fs.statSync(found); } catch { st = null; }
    if (!st || !st.isDirectory()) throw new Error("This assistant's settings folder is not a folder. Point the provider entry at the assistant's own settings folder, then start the session again.");
    if (found === h || above(found, h)) throw new Error("This assistant's settings folder is the whole home or contains it. Name only its own settings folder in the provider entry, then start the session again.");
    if (!above(h, found)) throw new Error("This assistant's settings folder is outside the account's home. Point the provider entry at a folder inside the home, then start the session again.");
    if (above(v, found)) throw new Error("This assistant's settings folder is inside Vyre's home. Point the provider entry at the assistant's own settings folder, outside Vyre, then start the session again.");
    if (above(found, v)) throw new Error("This assistant's settings folder contains Vyre's home. Point the provider entry at the assistant's own settings folder, outside Vyre, then start the session again.");
    for (const s of secretSeen) if (touches(found, s.lexical) || touches(found, s.real)) throw new Error(`This assistant's settings folder points at a secret folder (${s.label}). Point the provider entry at the assistant's own settings folder, then start the session again.`);
    for (const f of foreign) if (touches(found, f)) throw new Error("This assistant's settings folder is another provider's. Point the provider entry at this assistant's own folder, then start the session again.");
    const rel = path.relative(path.resolve(o.home), given);
    const dest = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(h, rel) : path.join(h, path.basename(given));
    mounts.push({ given, real: found, dest });
  }
  return mounts;
}

/**
 * Each session gets its OWN copy of the agent's config folder, holding only the credential files (reviewer-3 HS-1): a session that
 * plants hooks, commands or MCP servers there changes nothing the person's own agent will ever read, and it cannot read other
 * conversations kept in the real folder, which is never bound. Returns the folder and the env var that points the agent at it.
 * @param {HomeOpts} o @returns {{ dir: string, env: Record<string, string> } | null}
 */
export function seedConfig(o) {
  const p = o.agent?.private; if (!p) return null;
  if (!o.temp) throw new Error("a private agent config needs the session's temp folder");
  const dir = path.join(real(o.temp), "agent-config");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of p.credentialFiles) {
    if (/[\\/]/.test(f) || f.startsWith("..")) throw new Error("a credential file is a name inside the agent's folder");
    const src = path.join(p.from, f);
    try { if (fs.lstatSync(src).isFile()) fs.copyFileSync(src, path.join(dir, f)); fs.chmodSync(path.join(dir, f), 0o600); } catch {}
  }
  return { dir, env: { [p.env]: dir } };
}

/** The paths a session may touch besides the system: its project, the agent's own settings, its temp folder, the agent's install folder. @param {HomeOpts} o */
const allowed = o => [...new Set([...(o.workdirs || []), ...(o.temp ? [o.temp] : []), ...(o.readOnly || []), ...(o.settingsMounts || []).map(m => m.real)].map(real))];
/** What the session may WRITE: its project, its temp folder, its private config (inside temp) and a provider folder that cannot be moved. Nothing else on the disk is writable. @param {HomeOpts} o */
const writable = o => [...new Set([...(o.workdirs || []), ...(o.temp ? [o.temp] : []), ...(o.settingsMounts || []).map(m => m.real)].map(real))];
/** This machine's own non-loopback addresses: a daemon port bound to all interfaces is reachable on them, and "localhost" does not cover them (reviewer-2 ES-2). */
const ownV6 = () => Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && a.family === "IPv6").map(a => a.address.replace(/%.*$/, ""));
const lanAddrs = () => Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && a.family === "IPv4").map(a => a.address);
const ancestors = p => { const out = []; for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) out.push(d); return out; };

/**
 * The seatbelt profile: allow by default, then deny the person's whole home and the way back into Vyre, then allow back only what the
 * session needs. Rules listed later win, so the allows come last. @param {HomeOpts} o
 */
export function homeSeatbelt(o) {
  const h = real(o.home), v = real(o.vyreHome || path.join(o.home, ".vyre")), sock = path.join(real(path.dirname(o.sessionSocket)), path.basename(o.sessionSocket));
  const ok = allowed(o);
  return [
    "(version 1)", "(allow default)",
    // Nothing on the disk is writable except what is allowed back below (reviewer-2 ES-1): a user-owned /opt/homebrew, /usr/local, a bundle in
    // /Applications or /private/tmp would otherwise let a session plant a tool that later runs outside the sandbox.
    "(deny file-write*)", '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty") (subpath "/dev/fd"))',
    // The home folder and the places other people's and external files live are denied whole; the Vyre home and secret folders are inside them.
    ...[...new Set([h, v, "/Users", "/Volumes"])].map(d => `(deny file* (subpath ${q(d)}))`),
    ...SECRET_DIRS.map(d => `(deny file* (subpath ${q(path.join(h, d))}))`),
    // The network is closed (reviewer-2, Mac gap 3): the only way out is the runner's egress proxy on one loopback port (public addresses only, the same decision as on Linux),
    // allowed back at the end. Seatbelt cannot name hosts, so without the proxy a session would reach the whole internet and every LAN device.
    "(deny network-outbound)",
    // The person's per-user temp and cache folders and /private/tmp hold other apps' scratch files and caches: unreadable, the session's own folders allowed back below.
    ...["/private/var/folders", "/private/tmp"].map(d => `(deny file-read* (subpath ${q(d)}))`),
    // Every unix socket and every loopback connection is refused...
    "(deny network-outbound (remote unix-socket))",
    '(deny network-outbound (remote ip "localhost:*"))',
    // The daemon's ports are denied on EVERY address directly (an address that appears later, a VPN or a Wi-Fi change, is covered too); the address list is a second layer.
    ...(o.daemonPorts || []).map(p => `(deny network-outbound (remote ip "*:${Number(p)}"))`),
    // (No rule per LAN address: seatbelt accepts only "*" or "localhost" as the host of a network address, so "(remote ip \"192.168.64.4:*\")" is a
    // profile error and nothing starts; measured on a hosted Mac, run 37162622014. The port rule above is what covers every address.)
    // ...then the session gets back only what it needs (these come last, so they win).
    // The blanket `(deny file-write*)` above is not overridden by a later `(allow file* ...)` on macOS 14 (hosted run 37167578152: variant A failed, the same rule with the
    // write operations named, F, passed), so each writable folder gets its write operations spelled out as well.
    // Same for reads: the deny of /private/var/folders and /private/tmp above is not overridden by `file*` alone (hosted diagnosis 37174501495: every write into an allowed folder failed), so the
    // read operations are allowed back by name too.
    ...writable(o).flatMap(d => [`(allow file* (subpath ${q(d)}))`, `(allow file-read* (subpath ${q(d)}))`, `(allow file-write-create file-write-data file-write-unlink file-write-mode file-write-flags file-write-times file-write-xattr (subpath ${q(d)}))`]),
    ...ok.filter(d => !writable(o).includes(d)).map(d => `(allow file-read* (subpath ${q(d)}))`),
    ...[...new Set(ok.flatMap(ancestors))].map(d => `(allow file-read-metadata (literal ${q(d)}))`),
    // The protected places are denied AGAIN after the allows, so no allowed folder can re-open them.
    ...[v, ...SECRET_DIRS.map(d => path.join(h, d))].map(d => `(deny file* (subpath ${q(d)}))`),
    // (Name lookup is closed with the rest of the network: the proxy resolves names itself, so a session needs no DNS of its own.)
    // The way into other processes of the same user: their arguments and environment, signals, and the services that hold the
    // pasteboard, the keychain, Apple events and the window server (the same list the lent-computer profile denies).
    "(deny signal)", "(allow signal (target self) (target children))", "(deny process-info* (target others))", '(deny sysctl-read (sysctl-name "kern.procargs2"))',
    '(deny mach-lookup (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.pasteboard.1") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd") (global-name "com.apple.windowserver.active") (global-name "com.apple.lsd.open") (global-name "com.apple.coreservices.launchservicesd"))',
    // launchd: `launchctl submit` or `bootstrap` asks launchd to run a job, and a launchd job is NOT inside this profile (it could write anywhere the user can). The preferences daemon
    // answers reads of other apps' preferences past the file rules. Denied by name and by prefix, and proved by running them (the self-test).
    '(deny mach-lookup (global-name-prefix "com.apple.xpc.launchd") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.xpc.daemon"))',
    '(deny process-exec (literal "/bin/launchctl"))',
    ...(o.proxy && o.proxy.port ? [`(allow network-outbound (remote ip "localhost:${Number(o.proxy.port)}"))`] : []),
    `(allow network-outbound (remote unix-socket (path-literal ${q(sock)})))`,
    `(allow file-read-metadata (literal ${q(sock)}))`,
  ].join("\n") + "\n";
}

/** @param {HomeOpts} o */
function planDarwin(o) {
  const cfg = seedConfig(o);
  o = { ...o, workdirs: [...(o.workdirs || []), ...(cfg ? [cfg.dir] : [])] };
  const dd = ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"].find(d => fs.existsSync(d));
  // Tools that keep caches or scratch files outside the project would fail with writes denied: point each into the session's own temp folder.
  const t = o.temp ? real(o.temp) : null;
  const redirects = t ? { TMPDIR: path.join(t, "tmp"), XDG_CACHE_HOME: path.join(t, "cache"), npm_config_cache: path.join(t, "npm"), PIP_CACHE_DIR: path.join(t, "pip"), HOMEBREW_CACHE: path.join(t, "brew"), CARGO_HOME: path.join(t, "cargo"), GOCACHE: path.join(t, "gocache") } : {};
  for (const d of Object.values(redirects)) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
  const px = o.proxy && o.proxy.port ? `http://vyre:${o.proxy.token || ""}@127.0.0.1:${o.proxy.port}` : null;
  const proxyEnv = px ? { HTTPS_PROXY: px, HTTP_PROXY: px, https_proxy: px, http_proxy: px, NO_PROXY: "", GIT_SSH_COMMAND: sshCommand(`127.0.0.1:${o.proxy.port}`, o.proxy.token || "", PROXYCMD) } : {};
  // The session's PATH, as on Linux: the program's and its interpreter's folders first (a script agent's `#!/usr/bin/env node` finds node there, whether it lives in Homebrew, nvm, Volta, fnm or a runner's tool cache),
  // then the caller's own PATH folders, then the system's. Without one, `env` falls back to /usr/bin:/bin and a node anywhere else is "No such file" (issue 109).
  const callerPath = String(o.env?.PATH || "").split(path.delimiter).filter(d => d && path.isAbsolute(d));
  const PATH = [...new Set([...(o.pathDirs || []), ...callerPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(path.delimiter);
  const env = { ...homeEnv(o.env, o.passEnv), PATH, ...(dd ? { DEVELOPER_DIR: dd } : {}), ...redirects, ...(cfg ? cfg.env : {}), ...proxyEnv, VYRE_SOCKET: o.sessionSocket };
  return { argv: ["/usr/bin/sandbox-exec", "-p", homeSeatbelt(o), o.command, ...(o.args || [])], env: { ...env, HOME: o.home }, cwd: o.workdirs?.[0], cleanup() {}, profile: homeSeatbelt(o), fd3: undefined, socket: o.sessionSocket };
}

/** @param {HomeOpts} o */
function planLinux(o) {
  const h = real(o.home);
  const cfg = seedConfig(o);
  const sock = "/run/vyre-session.sock", inner = SANDBOX_PORTS[0];
  const sc = seccompFilter(); if (!sc) throw new Error(`no seccomp filter for this CPU (${process.arch}): a session is not started without one`);
  // With the egress proxy the session starts under Vyre's own shim, run by THIS process's node (process.execPath): that program's folder is bound read-only too, or a node that lives under a
  // person's folder (an npm or nvm install, /home/<user>/node24/bin) is "No such file" inside the sandbox. (Under /usr it is already there.)
  const shimNode = o.proxy?.socket ? [path.dirname(real(process.execPath))] : [];
  const ro = [...new Set([...(o.readOnly || []), ...shimNode])].map(real);
  const rw = [...new Set([...(o.workdirs || []), ...(o.temp ? [o.temp] : []), ...(cfg ? [cfg.dir] : [])])].map(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} return real(d); });
  const env = { ...homeEnv(o.env, o.passEnv), ...(cfg ? cfg.env : {}), VYRE_SOCKET: sock, HOME: h, PATH: [...new Set([...(o.pathDirs || []), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"), ...(o.proxy ? { HTTPS_PROXY: `http://vyre:${o.proxy.token || ""}@127.0.0.1:${inner}`, HTTP_PROXY: `http://vyre:${o.proxy.token || ""}@127.0.0.1:${inner}`, NO_PROXY: "", GIT_SSH_COMMAND: sshCommand(`127.0.0.1:${inner}`, o.proxy.token || "", "/opt/vyre-proxycmd.js") } : {}) };
  const argv = [
    "bwrap", "--seccomp", "3", "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--cap-drop", "ALL", "--disable-userns", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives", "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp", "--ro-bind", fakePasswd(h), "/etc/passwd",
    // The home is a fresh empty folder first; then the read-only tools (they may live under the home), the project, the temp folder and a provider's own settings folder come back.
    // A settings folder is the real directory, bound onto $HOME/<name> so the assistant finds it where it looks. The rest of the home stays the empty tmpfs.
    "--tmpfs", h,
    ...ro.flatMap(d => ["--ro-bind", d, d]),
    ...rw.flatMap(d => ["--bind", d, d]),
    ...(o.settingsMounts || []).flatMap(m => {
      const rel = path.relative(h, m.dest);
      const parts = rel.split(path.sep).filter(Boolean);
      /** @type {string[]} */ const args = [];
      let acc = h;
      for (const part of parts) { acc = path.join(acc, part); args.push("--dir", acc); }
      args.push("--bind", m.real, m.dest);
      return args;
    }),
    ...(o.workdirs?.[0] ? ["--chdir", real(o.workdirs[0])] : []),
    ...(fs.existsSync(o.sessionSocket) ? ["--bind", real(o.sessionSocket), sock] : []),
    ...(o.proxy?.socket ? ["--ro-bind", o.proxy.socket, "/run/egress.sock", "--ro-bind", SHIM, "/opt/vyre-shim.js", "--ro-bind", PROXYCMD, "/opt/vyre-proxycmd.js"] : []),
    ...Object.entries(env).flatMap(([k, val]) => ["--setenv", k, val]),
    ...(o.proxy?.socket ? [process.execPath, "/opt/vyre-shim.js", "--listen", String(inner), "--to", "/run/egress.sock", "--"] : []),
    o.command, ...(o.args || []),
  ];
  return { argv, env: {}, cwd: undefined, cleanup() {}, profile: argv.join(" "), fd3: sc, socket: sock };
}

/** @param {HomeOpts} o */
export function planHome(o) {
  if (o.platform !== "darwin" && o.platform !== "linux") throw new Error("sessions on this system are not sandboxed yet (Windows needs the AppContainer pipe rule), so they do not start");
  if (!path.isAbsolute(o.command)) throw new Error("the sandbox runs an absolute program path");
  if (!o.sessionSocket) throw new Error("a session needs its own socket");
  checkEntries(o);
  o = { ...o, settingsMounts: settingsPlan(o) };
  if (o.platform === "darwin") return planDarwin(o);
  if (o.platform === "linux") return planLinux(o);
  throw new Error("sessions on this system are not sandboxed yet (Windows needs the AppContainer pipe rule), so they do not start");
}

/** Throw the session's private config folder away when the session ends (the copy of the credential goes with it). @param {HomeOpts} o */
export function discardConfig(o) {
  if (!o.temp) return false;
  const dir = path.join(real(o.temp), "agent-config");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { return false; }
  return !fs.existsSync(dir);
}

const PROBE = `
const net=require("net"),fs=require("fs");const P=JSON.parse(process.argv[1]);const out={};
const conn=(t)=>new Promise(res=>{const s=typeof t==="number"?net.connect(t,"127.0.0.1"):net.connect(t);let d=false;const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),800)});
(async()=>{
 // The connects run together: a refusal is instant, and a connect that would succeed does so at once, so a short timeout loses nothing.
 const [a,b,c,...ports]=await Promise.all([conn(P.personSocket),conn(P.otherSocket),conn(P.ownSocket),...P.daemonPorts.map(conn)]);
 out.personSocket=a;out.otherSocket=b;out.ownSocket=c;out.daemonPorts=ports;
 out.writes=[];for(const d of P.writable){try{fs.mkdirSync(d,{recursive:true});const f=d+"/.vyre-selftest";fs.writeFileSync(f,"x");fs.readFileSync(f);fs.rmSync(f);out.writes.push("ok")}catch(e){out.writes.push(e.code||"error");(out.writeDetail=out.writeDetail||[]).push([e.code,e.syscall,e.path].join(" "))}}
 out.hosts=[];for(const h of P.hosts){const [host,port]=h.split(":");if(P.proxyPort){out.hosts.push(await new Promise(res=>{const s=net.connect(P.proxyPort,"127.0.0.1");let d=false,b="";const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>s.write("CONNECT "+host+":"+(port||443)+" HTTP/1.1\\r\\nHost: "+host+"\\r\\nProxy-Authorization: Basic "+Buffer.from("vyre:"+P.proxyToken).toString("base64")+"\\r\\n\\r\\n"));s.on("data",x=>{b+=x;if(b.includes("\\r\\n"))f(/ 200 /.test(b.split("\\r\\n")[0])?"connected":"refused")});s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),4000)}));continue}out.hosts.push(await new Promise(res=>{const s=net.connect(Number(port||443),host);let d=false;const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),4000)}))}
 out.noWrite=[];for(const d of (P.mustNotWrite||[])){try{fs.writeFileSync(d+"/.vyre-write-probe","x");fs.rmSync(d+"/.vyre-write-probe",{force:true});out.noWrite.push("WROTE")}catch(e){out.noWrite.push(e.code||"error")}}
 out.addrs=[];for(const [a,p] of (P.addrPorts||[])){out.addrs.push(await new Promise(res=>{const s=net.connect(p,a);let d=false;const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),800)}))}
 if(P.daemonPid){try{process.kill(P.daemonPid,"SIGCONT");out.signal="ok"}catch(e){out.signal=e.code}try{const r=require("child_process").execFileSync("/bin/ps",["eww","-p",String(P.daemonPid)],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});out.psEnv=r.includes(String(P.daemonPid))?"READ":"empty"}catch(e){out.psEnv="refused"}}
 if(P.launchLabel){const cp=require("child_process");try{cp.execFileSync("/bin/launchctl",["submit","-l",P.launchLabel,"--","/usr/bin/touch",P.launchMarker],{stdio:"ignore"});out.launchctl="submitted"}catch(e){out.launchctl="refused"}
  try{const r=cp.execFileSync("/usr/bin/defaults",["read","com.apple.dock"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});out.defaults=r.length>10?"READ":"empty"}catch(e){out.defaults="refused"}}
 if(P.hostTmp){try{fs.readFileSync(P.hostTmp);out.hostTmp="READ"}catch(e){out.hostTmp=e.code}}
 if(P.direct){out.direct=await new Promise(res=>{const s=net.connect(443,P.direct);let d=false;const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),2500)})}
 try{fs.readFileSync(P.homeFile);out.homeFile="READ"}catch(e){out.homeFile=e.code}
 try{fs.readFileSync(P.keyFile);out.keyFile="READ"}catch(e){out.keyFile=e.code}
 try{fs.readdirSync(P.vyreHome);out.vyreHome="LISTED"}catch(e){out.vyreHome=e.code}
 out.foreign=[];for(const d of (P.foreignDirs||[])){try{fs.readdirSync(d);out.foreign.push("LISTED")}catch(e){out.foreign.push(e.code||"error")}}
 if(P.personal){try{const st=fs.statSync(P.personal);if(st.isDirectory()){fs.readdirSync(P.personal);out.personal="LISTED"}else{fs.readFileSync(P.personal);out.personal="READ"}}catch(e){out.personal=e.code||"error"}}
 console.log(JSON.stringify(out));
})();`;

/**
 * D-3: run the proof from inside the sandbox, as the session will run. Every "must fail" probe must fail and the session's own socket
 * must work. A session that fails any of them does not start.
 * @param {HomeOpts & { probes: { personSocket: string, otherSocket: string, daemonPorts: number[], keyFile: string, homeFile?: string, daemonPid?: number }, node?: string }} o
 * @returns {Promise<{ ok: boolean, failures: string[], results: any }>}
 */
const hostConnect = t => new Promise(res => { const s = typeof t === "number" ? net.connect(t, "127.0.0.1") : net.connect(t); const f = v => { try { s.destroy(); } catch {} res(v); }; s.on("connect", () => f(true)); s.on("error", () => f(false)); setTimeout(() => f(false), 3000); });

/**
 * Before the proof runs, check from OUTSIDE the sandbox that every probe target is real and behaves as the probe assumes (reviewer-3
 * HS-3): a stale path would otherwise "fail" every must-fail probe by not existing, and the proof would pass over a hole.
 * @returns {Promise<string[]>} what is stale
 */
const hostConnectAddr = (a, port) => new Promise(res => { const s = net.connect(port, a); const f = v => { try { s.destroy(); } catch {} res(v); }; s.on("connect", () => f(true)); s.on("error", () => f(false)); setTimeout(() => f(false), 1500); });

async function stale(o) {
  const p = o.probes, out = [];
  const home = o.vyreHome || path.join(o.home, ".vyre");
  try { if (!fs.statSync(p.keyFile).isFile()) out.push("the key file is not a file"); } catch { out.push("the key file does not exist"); }
  try { if (!fs.statSync(home).isDirectory()) out.push("the Vyre home is not a folder"); } catch { out.push("the Vyre home does not exist"); }
  if (p.homeFile) { try { fs.statSync(p.homeFile); } catch { out.push("the personal-file probe does not exist"); } }
  for (const [n, s] of [["the person's socket", p.personSocket], ["the other session's socket", p.otherSocket], ["the session's own socket", o.sessionSocket]]) if (!(await hostConnect(s))) out.push(`${n} does not accept a connection from outside`);
  for (const port of p.daemonPorts) if (!(await hostConnect(port))) out.push(`the daemon port ${port} does not accept a connection from outside`);
  if (p.daemonPid) { try { process.kill(p.daemonPid, 0); } catch { out.push("the daemon pid is not running"); } }
  return out;
}

export async function selfTest(o) {
  const node = o.node || process.execPath;
  // The folders the session is given exist before the proof (a missing one cannot be created inside a denied home).
  for (const d of [...(o.workdirs || []), ...(o.temp ? [o.temp] : [])]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
  const ts = Date.now();
  const old = await stale(o);
  const staleMs = Date.now() - ts;
  if (old.length) return { ok: false, failures: ["the self-test is stale: " + old.join("; ")], results: null };
  // A provider that keeps its own folder is checked here, before anything is spawned. The same check runs again inside planHome.
  const mounts = settingsPlan(o);
  o = { ...o, daemonPorts: o.probes.daemonPorts };
  const base = planHome({ ...o, command: node, args: [], readOnly: [...(o.readOnly || []), path.dirname(node)] });
  // The session reaches its socket at the path the sandbox gives it (VYRE_SOCKET), which is not the host path on Linux.
  // Folders a session must NOT be able to write, but this user can: the probe means something only where the writer really could (checked from outside).
  const writableByUser = d => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
  const mustNotWrite = [...new Set([...(o.probes.mustNotWrite || []), ...(o.platform === "darwin" ? [path.dirname(process.execPath), "/private/tmp", "/usr/local/bin", "/opt/homebrew/bin", "/Applications"] : [])])].filter(d => fs.existsSync(d) && writableByUser(d) && !(o.workdirs || []).some(w => real(w).startsWith(real(d))) && !(o.temp && real(o.temp).startsWith(real(d))));
  // The daemon's ports on every address a machine has: loopback, ::1 and the LAN address. Only the ones the host itself can reach are probed.
  const addrPorts = [];
  // Together, not one by one: an address that drops the connect (a link-local v6 with no scope, a bridge) costs its whole timeout, and a machine with a dozen of them took over 30 s per session start.
  const cand = []; for (const port of o.probes.daemonPorts) for (const a of ["::1", ...lanAddrs(), ...ownV6()]) cand.push([a, port]);
  const reach = await Promise.all(cand.map(([a, port]) => hostConnectAddr(a, port)));
  cand.forEach((c, i) => { if (reach[i]) addrPorts.push(c); });
  // macOS: what the profile must keep closed although its text could be wrong (reviewer-2): a launchd job started from inside, another app's preferences through the preferences daemon,
  // the person's per-user temp, and a direct connection to the internet. Each is tried from inside, never read off the profile text.
  const rnd = crypto.randomBytes(4).toString("hex");
  const hostTmpProbe = o.platform === "darwin" ? path.join(os.tmpdir(), `vyre-hosttmp-${rnd}`) : "";
  const launchLabel = o.platform === "darwin" ? `vyre.selftest.${rnd}` : "", launchMarker = o.platform === "darwin" ? `/private/tmp/vyre-escape-${rnd}` : "";
  if (hostTmpProbe) fs.writeFileSync(hostTmpProbe, "host temp");
  // For a provider that keeps its own folder: the folder must be usable, and another provider's folder plus a personal file must not be readable.
  // The other folders are only the foreignSettings list the provider table passed in. This file does not name them. They are only read. Nothing is written there, and a missing folder is not created.
  const ownPaths = new Set(mounts.flatMap(m => [m.real, m.dest, m.given]));
  const givenForeign = (Array.isArray(o.agent?.foreignSettings) ? o.agent.foreignSettings : []).filter(p => typeof p === "string" && p);
  const foreignDirs = mounts.length ? [...new Set(givenForeign.map(p => realOr(p) || path.resolve(p)).filter(p => !ownPaths.has(p)))] : [];
  // A file of our own in the home, outside the settings folder, so the personal probe has a target when the home has no Documents, Desktop or Downloads. Removed when this check ends.
  let personalMade = "";
  let personal = "";
  if (mounts.length) {
    if (o.probes.homeFile) personal = o.probes.homeFile;
    else {
      const made = path.join(real(o.home), `.vyre-probe-${rnd}`);
      try { fs.writeFileSync(made, "probe\n", { flag: "wx" }); }
      catch (e) { return { ok: false, failures: [`the personal-file probe could not be created (${e.code || "error"}). Check that this account can write its home, then start the session again.`], results: null }; }
      personalMade = made;
      personal = made;
    }
  }
  const dropPersonal = () => { if (!personalMade) return; const f = personalMade; personalMade = ""; try { fs.rmSync(f, { force: true }); } catch { /* a leftover probe file is one hidden name in the home */ } };
  try {
  const probes = { ...o.probes, mustNotWrite, addrPorts, direct: o.platform === "darwin" ? "1.1.1.1" : "", ownSocket: base.socket, vyreHome: o.vyreHome || path.join(o.home, ".vyre"), writable: [...(o.temp ? [o.temp] : []), ...(o.workdirs || []), ...mounts.map(m => m.dest)], hosts: o.agent?.hosts || [], proxyPort: o.platform === "linux" && o.proxy ? 18443 : (o.platform === "darwin" && o.proxy?.port ? o.proxy.port : 0), hostTmp: o.platform === "darwin" ? hostTmpProbe : "", launchLabel: o.platform === "darwin" ? launchLabel : "", launchMarker: o.platform === "darwin" ? launchMarker : "", proxyToken: o.proxy?.token || "", foreignDirs, personal };
  const p = planHome({ ...o, command: node, args: ["-e", PROBE, JSON.stringify(probes)], readOnly: [...(o.readOnly || []), path.dirname(node)] });
  // The agent check and the probes run at the same time; the stale check ran first because a stale probe makes the rest meaningless.
  const t0 = Date.now();
  // A throw here (a relative or missing program, a plan that cannot be made) is the AGENT's result, never an unhandled rejection that would end the daemon for every session: it is caught where
  // it happens and read below as "the agent does not start".
  /** @type {any} */ let agentChild = null;
  const agentCheck = !o.agent?.command ? Promise.resolve(null) : (async () => {
    try {
      if (!path.isAbsolute(o.agent.command)) return { code: -1, e2: "the agent's program is not an absolute path" };
      const a = planHome({ ...o, command: o.agent.command, args: o.agent.versionArgs || ["--version"], readOnly: [...new Set([...(o.readOnly || []), ...programDirs(o.agent.command)])], pathDirs: programDirs(o.agent.command) });
      const c = (o.launch || launch)(a); c.__t0 = Date.now(); agentChild = c; let e2 = ""; c.stderr.on("data", d => e2 += d); c.stdout.resume();
      try { if (c.stdin) { c.stdin.on("error", () => {}); c.stdin.end(); } } catch { /* the check reads no input: a program that waits on stdin must see the end of it, not hang the start */ }
      c.on("error", e => { e2 += String(e && e.message); });
      const code = await new Promise(r => { const t = setTimeout(() => { c.kill("SIGKILL"); r(-1); }, 20000); c.on("close", x => { clearTimeout(t); r(x); }); c.on("exit", x => { setTimeout(() => { clearTimeout(t); r(x === null ? -1 : x); }, 300).unref?.(); }); c.on("error", () => { clearTimeout(t); r(-1); }); });
      return { code, e2 };
    } catch (e) { return { code: -1, e2: String(e && e.message || e) }; }
  })();
  const child = (o.launch || launch)(p); child.__t0 = Date.now();
  // sessions' limit on the whole self-test (lib/agent-sandbox.js): on abort both children are killed, so nothing it started outlives the failed start.
  const stop = () => { for (const c of [child, agentChild]) { if (!c) continue; const age = Date.now() - (c.__t0 || 0); setTimeout(() => { try { if (c.exitCode === null) c.kill("SIGKILL"); } catch {} }, Math.max(0, 400 - age)).unref?.(); } };
  if (o.signal) { if (o.signal.aborted) stop(); else o.signal.addEventListener("abort", stop, { once: true }); }
  let out = "", err = "";
  child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
  // A program that cannot be started (no bwrap in the image) is an "error" event: unhandled, it ends the daemon for every session. It is this start's failure, with its reason.
  child.on("error", e => { err += String(e && e.message || e); });
  // Bounded: a probe that never ends must fail the start with a reason, not leave the session "starting" for ever.
  await new Promise(r => { const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(undefined); }, 45_000); child.on("close", () => { clearTimeout(t); r(undefined); }); child.on("exit", () => { setTimeout(() => { clearTimeout(t); r(undefined); }, 300).unref?.(); }); });
  const agent = await agentCheck;
  try { if (agentChild && agentChild.exitCode === null) agentChild.kill("SIGKILL"); } catch {}   // nothing of a failed check is left running
  const probeMs = Date.now() - t0;
  let res; try { res = JSON.parse(out.trim().split("\n").pop() || ""); } catch { dropPersonal(); return { ok: false, failures: ["the self-test did not run: " + err.trim().slice(0, 200)], results: null }; }
  if (hostTmpProbe) fs.rmSync(hostTmpProbe, { force: true });
  let escaped = false;
  if (launchLabel) {
    if (res.launchctl === "submitted") await new Promise(r => setTimeout(r, 2500));   // a job that was really started has time to run
    escaped = fs.existsSync(launchMarker);
    try { spawnSync("/bin/launchctl", ["remove", launchLabel], { stdio: "ignore" }); } catch {}
    fs.rmSync(launchMarker, { force: true });
  }
  const failures = [];
  if (escaped) failures.push("a launchd job started from inside the session ran outside the sandbox");
  if (res.defaults === "READ") failures.push("the session can read another app's preferences through the preferences daemon");
  if (res.hostTmp === "READ") failures.push("the person's per-user temp folder can be read");
  if (res.direct === "connected") failures.push("the session reaches the internet directly, not through the proxy");
  if (res.personSocket === "connected") failures.push("the person's own socket is reachable");
  if (res.otherSocket === "connected") failures.push("another session's socket is reachable");
  res.daemonPorts.forEach((r, i) => { if (r === "connected") failures.push(`the daemon's loopback port ${o.probes.daemonPorts[i]} is reachable`); });
  (res.noWrite || []).forEach((w, i) => { if (w === "WROTE") failures.push(`the session can write to ${probes.mustNotWrite[i]}, outside its own folders`); });
  (res.addrs || []).forEach((r, i) => { if (r === "connected") failures.push(`the daemon port ${probes.addrPorts[i][1]} is reachable at ${probes.addrPorts[i][0]}`); });
  if (res.signal === "ok") failures.push("the session can signal the daemon's process");
  if (res.psEnv === "READ") failures.push("the session can read the daemon's process arguments and environment");
  if (res.keyFile === "READ") failures.push("a key file in the Vyre home can be read");
  if (res.homeFile === "READ") failures.push("a file in the person's home outside the allowed paths can be read");
  if (res.vyreHome === "LISTED") failures.push("the Vyre home can be listed");
  if (mounts.length) (res.foreign || []).forEach((r, i) => { if (r === "LISTED") failures.push(`another provider's settings folder can be read (${probes.foreignDirs[i]}). Point the provider entry at this assistant's own settings folder, then start the session again.`); });
  if (mounts.length && (res.personal === "READ" || res.personal === "LISTED") && res.homeFile !== "READ") failures.push("a personal file outside this assistant's settings folder can be read. Point the provider entry at this assistant's own settings folder, then start the session again.");
  if (res.ownSocket !== "connected") failures.push(`the session's own socket does not work (${res.ownSocket})`);
  // The other half of the proof: the provider's agent can still start and sign in.
  const settingDests = new Set(mounts.map(m => m.dest));
  (res.writes || []).forEach((w, i) => { if (w !== "ok") { const detail = res.writeDetail?.[i] ? ": " + res.writeDetail[i] : ""; failures.push(settingDests.has(probes.writable[i]) ? `this assistant's settings folder cannot be read and written (${w}${detail}). Sign the account in, then start the session again.` : `the agent cannot use ${probes.writable[i]} (${w}${detail})`); } });
  (res.hosts || []).forEach((h, i) => { if (h !== "connected") failures.push(`the agent cannot reach ${probes.hosts[i]} (${h})`); });
  if (agent && agent.code !== 0) failures.push(`the agent does not start inside the sandbox (exit ${agent.code}${agent.e2 ? ": " + agent.e2.trim().slice(0, 120) : ""})`);
  dropPersonal();
  return { ok: failures.length === 0, failures, results: res, timings: { staleMs, probeMs } };
  } finally { dropPersonal(); }
}
