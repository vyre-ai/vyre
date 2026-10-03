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
import { spawn } from "node:child_process";
import { launch } from "./sandbox.js";
import { filter as seccompFilter } from "./seccomp.js";
import { SHIM } from "./sandbox.js";

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
 * @property {{ command: string, args?: string[], settingsPaths?: string[], hosts?: string[], versionArgs?: string[] }} [agent]  the provider's agent: its own sign-in and settings paths (read-write), the hosts it needs, and the args that make it print its version
 * @property {string} [temp]  the session's own temp folder (read-write)
 * @property {{ socket?: string, port?: number, token?: string }} [proxy] Linux: the egress proxy the provider is reached through (a CONNECT tunnel to the agent's hosts only; the token is its password)
 */

/** The paths a session may touch besides the system: its project, the agent's own settings, its temp folder, the agent's install folder. @param {HomeOpts} o */
const allowed = o => [...new Set([...(o.workdirs || []), ...(o.agent?.settingsPaths || []), ...(o.temp ? [o.temp] : []), ...(o.readOnly || [])].map(real))];
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
    // The home folder and the places other people's and external files live are denied whole; the Vyre home and secret folders are inside them.
    ...[...new Set([h, v, "/Users", "/Volumes"])].map(d => `(deny file* (subpath ${q(d)}))`),
    ...SECRET_DIRS.map(d => `(deny file* (subpath ${q(path.join(h, d))}))`),
    // Every unix socket and every loopback connection is refused...
    "(deny network-outbound (remote unix-socket))",
    '(deny network-outbound (remote ip "localhost:*"))',
    // ...then the session gets back only what it needs (these come last, so they win).
    ...ok.map(d => `(allow file* (subpath ${q(d)}))`),
    ...[...new Set(ok.flatMap(ancestors))].map(d => `(allow file-read-metadata (literal ${q(d)}))`),
    `(allow network-outbound (remote unix-socket (path-literal ${q(sock)})))`,
    `(allow file-read-metadata (literal ${q(sock)}))`,
  ].join("\n") + "\n";
}

/** @param {HomeOpts} o */
function planDarwin(o) {
  const env = { ...(o.env || {}), VYRE_SOCKET: o.sessionSocket };
  return { argv: ["/usr/bin/sandbox-exec", "-p", homeSeatbelt(o), o.command, ...(o.args || [])], env: { ...env, HOME: o.home }, cwd: undefined, cleanup() {}, profile: homeSeatbelt(o), fd3: undefined, socket: o.sessionSocket };
}

/** @param {HomeOpts} o */
function planLinux(o) {
  const v = real(o.vyreHome || path.join(o.home, ".vyre")), h = real(o.home);
  const sock = "/run/vyre-session.sock", inner = 18443;
  const sc = seccompFilter(); if (!sc) throw new Error(`no seccomp filter for this CPU (${process.arch}): a session is not started without one`);
  const ro = [...new Set(o.readOnly || [])].map(real);
  const rw = [...new Set([...(o.workdirs || []), ...(o.agent?.settingsPaths || []), ...(o.temp ? [o.temp] : [])])].map(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} return real(d); });
  const env = { ...(o.env || {}), VYRE_SOCKET: sock, HOME: h, PATH: "/usr/local/bin:/usr/bin:/bin", ...(o.proxy ? { HTTPS_PROXY: `http://vyre:${o.proxy.token || ""}@127.0.0.1:${inner}`, HTTP_PROXY: `http://vyre:${o.proxy.token || ""}@127.0.0.1:${inner}`, NO_PROXY: "" } : {}) };
  const argv = [
    "bwrap", "--seccomp", "3", "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--cap-drop", "ALL", "--disable-userns", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives", "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp",
    ...ro.flatMap(d => ["--ro-bind", d, d]),
    // The home is a fresh empty folder first, then only the project, the agent's own settings and the session's temp folder come back.
    "--tmpfs", h,
    ...rw.flatMap(d => ["--bind", d, d]),
    ...(fs.existsSync(o.sessionSocket) ? ["--bind", real(o.sessionSocket), sock] : []),
    ...(o.proxy?.socket ? ["--ro-bind", o.proxy.socket, "/run/egress.sock", "--ro-bind", SHIM, "/opt/vyre-shim.js"] : []),
    ...Object.entries(env).flatMap(([k, val]) => ["--setenv", k, val]),
    ...(o.proxy?.socket ? [process.execPath, "/opt/vyre-shim.js", "--listen", String(inner), "--to", "/run/egress.sock", "--"] : []),
    o.command, ...(o.args || []),
  ];
  void v;
  return { argv, env: {}, cwd: undefined, cleanup() {}, profile: argv.join(" "), fd3: sc, socket: sock };
}

/** @param {HomeOpts} o */
export function planHome(o) {
  if (o.platform !== "darwin" && o.platform !== "linux") throw new Error("sessions on this system are not sandboxed yet (Windows needs the AppContainer pipe rule), so they do not start");
  if (!path.isAbsolute(o.command)) throw new Error("the sandbox runs an absolute program path");
  if (!o.sessionSocket) throw new Error("a session needs its own socket");
  if (o.platform === "darwin") return planDarwin(o);
  if (o.platform === "linux") return planLinux(o);
  throw new Error("sessions on this system are not sandboxed yet (Windows needs the AppContainer pipe rule), so they do not start");
}

const PROBE = `
const net=require("net"),fs=require("fs");const P=JSON.parse(process.argv[1]);const out={};
const conn=(t)=>new Promise(res=>{const s=typeof t==="number"?net.connect(t,"127.0.0.1"):net.connect(t);let d=false;const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),2500)});
(async()=>{
 out.personSocket=await conn(P.personSocket); out.otherSocket=await conn(P.otherSocket); out.ownSocket=await conn(P.ownSocket);
 out.daemonPorts=[];for(const p of P.daemonPorts)out.daemonPorts.push(await conn(p));
 out.writes=[];for(const d of P.writable){try{fs.mkdirSync(d,{recursive:true});const f=d+"/.vyre-selftest";fs.writeFileSync(f,"x");fs.readFileSync(f);fs.rmSync(f);out.writes.push("ok")}catch(e){out.writes.push(e.code||"error")}}
 out.hosts=[];for(const h of P.hosts){const [host,port]=h.split(":");if(P.proxyPort){out.hosts.push(await new Promise(res=>{const s=net.connect(P.proxyPort,"127.0.0.1");let d=false,b="";const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>s.write("CONNECT "+host+":"+(port||443)+" HTTP/1.1\\r\\nHost: "+host+"\\r\\nProxy-Authorization: Basic "+Buffer.from("vyre:"+P.proxyToken).toString("base64")+"\\r\\n\\r\\n"));s.on("data",x=>{b+=x;if(b.includes("\\r\\n"))f(/ 200 /.test(b.split("\\r\\n")[0])?"connected":"refused")});s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),4000)}));continue}out.hosts.push(await new Promise(res=>{const s=net.connect(Number(port||443),host);let d=false;const f=v=>{if(!d){d=true;try{s.destroy()}catch{}res(v)}};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),4000)}))}
 try{fs.readFileSync(P.homeFile);out.homeFile="READ"}catch(e){out.homeFile=e.code}
 try{fs.readFileSync(P.keyFile);out.keyFile="READ"}catch(e){out.keyFile=e.code}
 try{fs.readdirSync(P.vyreHome);out.vyreHome="LISTED"}catch(e){out.vyreHome=e.code}
 console.log(JSON.stringify(out));
})();`;

/**
 * D-3: run the proof from inside the sandbox, as the session will run. Every "must fail" probe must fail and the session's own socket
 * must work. A session that fails any of them does not start.
 * @param {HomeOpts & { probes: { personSocket: string, otherSocket: string, daemonPorts: number[], keyFile: string, homeFile?: string }, node?: string }} o
 * @returns {Promise<{ ok: boolean, failures: string[], results: any }>}
 */
export async function selfTest(o) {
  const node = o.node || process.execPath;
  const base = planHome({ ...o, command: node, args: [], readOnly: [...(o.readOnly || []), path.dirname(node)] });
  // The session reaches its socket at the path the sandbox gives it (VYRE_SOCKET), which is not the host path on Linux.
  const probes = { ...o.probes, ownSocket: base.socket, vyreHome: o.vyreHome || path.join(o.home, ".vyre"), writable: [...(o.agent?.settingsPaths || []), ...(o.temp ? [o.temp] : []), ...(o.workdirs || [])], hosts: o.agent?.hosts || [], proxyPort: o.platform === "linux" && o.proxy ? 18443 : 0, proxyToken: o.proxy?.token || "" };
  const p = planHome({ ...o, command: node, args: ["-e", PROBE, JSON.stringify(probes)], readOnly: [...(o.readOnly || []), path.dirname(node)] });
  const child = launch(p);
  let out = "", err = "";
  child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
  await new Promise(r => child.on("close", r));
  let res; try { res = JSON.parse(out.trim().split("\n").pop() || ""); } catch { return { ok: false, failures: ["the self-test did not run: " + err.trim().slice(0, 200)], results: null }; }
  const failures = [];
  if (res.personSocket === "connected") failures.push("the person's own socket is reachable");
  if (res.otherSocket === "connected") failures.push("another session's socket is reachable");
  res.daemonPorts.forEach((r, i) => { if (r === "connected") failures.push(`the daemon's loopback port ${o.probes.daemonPorts[i]} is reachable`); });
  if (res.keyFile === "READ") failures.push("a key file in the Vyre home can be read");
  if (res.homeFile === "READ") failures.push("a file in the person's home outside the allowed paths can be read");
  if (res.vyreHome === "LISTED") failures.push("the Vyre home can be listed");
  if (res.ownSocket !== "connected") failures.push(`the session's own socket does not work (${res.ownSocket})`);
  // The other half of the proof: the provider's agent can still start and sign in.
  (res.writes || []).forEach((w, i) => { if (w !== "ok") failures.push(`the agent cannot use ${probes.writable[i]} (${w})`); });
  (res.hosts || []).forEach((h, i) => { if (h !== "connected") failures.push(`the agent cannot reach ${probes.hosts[i]} (${h})`); });
  if (o.agent?.command) {
    const a = planHome({ ...o, command: o.agent.command, args: o.agent.versionArgs || ["--version"], readOnly: [...(o.readOnly || []), path.dirname(o.agent.command)] });
    const c = launch(a); let e2 = ""; c.stderr.on("data", d => e2 += d); c.stdout.resume();
    const code = await new Promise(r => { const t = setTimeout(() => { c.kill("SIGKILL"); r(-1); }, 20000); c.on("close", x => { clearTimeout(t); r(x); }); });
    if (code !== 0) failures.push(`the agent does not start inside the sandbox (exit ${code}${e2 ? ": " + e2.trim().slice(0, 120) : ""})`);
  }
  return { ok: failures.length === 0, failures, results: res };
}
