// @ts-check
// The watcher wall inside the box container (0.2, watchers' spawner contract). A watcher child runs as its own uid
// from a pool (3000 to 3031 here), and a netfilter rule on the container's network namespace refuses every outbound
// connection from those uids, loopback included, so a watcher cannot reach the internet, the tailnet or vyred's own port.
//
// Order, every time the container starts (box/wall-entry.sh runs this before the spawner serves):
//   1. install the rule (iptables and ip6tables, `-m owner --uid-owner MIN-MAX -j REJECT`), once: checked with -C first;
//   2. probe it: as a pool uid, connect to a loopback listener, to a public address, and to a unix socket closed to it;
//      every attempt must be refused;
//   3. write { ok, why, at, ... } to /run/vyre/wall.json (root's file, in a folder vyred reads but cannot write);
//   4. the entry script then drops NET_ADMIN from the bounding set and starts the spawner, which re-probes before every watcher and refuses a
//      watcher spawn while ok is false and refuses outright when it still holds NET_ADMIN.
// The spawner itself never holds NET_ADMIN while it serves; only this one-shot step does.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const POOL = { min: 3000, max: 3031 };
export const STATUS = "/run/vyre/wall.json";
const NET_ADMIN_BIT = 12n;

/** The rule's arguments for one of the two tools. @param {number} min @param {number} max */
export const ruleArgs = (min, max) => ["OUTPUT", "-m", "owner", "--uid-owner", `${min}-${max}`, "-j", "REJECT"];

/**
 * Install the rule in iptables and ip6tables, never twice.
 * @param {{ min?: number, max?: number, run?: (tool: string, args: string[]) => { status: number|null, stderr?: string } }} [o]
 * @returns {{ ok: boolean, why: string }}
 */
export function installRules({ min = POOL.min, max = POOL.max, run } = {}) {
  const exec = run || ((tool, args) => spawnSync(tool, args, { encoding: "utf8" }));
  for (const tool of ["iptables", "ip6tables"]) {
    const have = exec(tool, ["-C", ...ruleArgs(min, max)]);
    if (have.status === 0) continue;
    const put = exec(tool, ["-I", ...ruleArgs(min, max)]);
    if (put.status !== 0) return { ok: false, why: `${tool} would not install the rule: ${String(put.stderr || "").trim().slice(0, 200) || "no output"}` };
    if (exec(tool, ["-C", ...ruleArgs(min, max)]).status !== 0) return { ok: false, why: `${tool} accepted the rule but does not list it` };
  }
  return { ok: true, why: "" };
}

/**
 * Try, as a pool uid, what the wall must stop. Each attempt is a short-lived node child; the verdict is only the
 * error code, never the network's own words. Run as root (it switches uid with setpriv).
 * @param {{ uid?: number, setpriv?: string, node?: string, unixSocket: string, publicHost?: string, abstract?: () => string[], attempt?: (kind: string, target: string) => Promise<string> }} o
 * @returns {Promise<{ ok: boolean, why: string, results: Record<string, string> }>}
 */
export async function probe(o) {
  const uid = o.uid ?? POOL.min;
  const node = o.node || process.execPath;
  const listener = net.createServer(s => s.destroy());
  await new Promise(r => listener.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (listener.address()).port;
  const attempt = o.attempt || ((kind, target) => new Promise(resolve => {
    const code = kind === "unix"
      ? `const s=require("net").connect(${JSON.stringify(target)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",e=>{console.log(e.code||"error");process.exit(0)});setTimeout(()=>{console.log("timeout");process.exit(0)},3000)`
      : `const [h,p]=${JSON.stringify(target)}.split(":");const s=require("net").connect(+p,h);s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",e=>{console.log(e.code||"error");process.exit(0)});setTimeout(()=>{console.log("timeout");process.exit(0)},3000)`;
    const r = spawnSync(o.setpriv || "/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--inh-caps=-all", "--", node, "-e", code], { encoding: "utf8", timeout: 6000 });
    resolve(String(r.stdout || "").trim() || "no answer");
  }));
  /** @type {Record<string, string>} */
  const results = {};
  try {
    results.loopback = await attempt("tcp", `127.0.0.1:${port}`);
    results.public = await attempt("tcp", `${o.publicHost || "1.1.1.1"}:443`);
    results.unix = await attempt("unix", o.unixSocket);
  } finally { listener.close(); }
  // Refused: the rule answers with a reset (ECONNREFUSED) for the two TCP attempts; the unix socket is closed by its mode.
  const refusedTcp = v => v === "ECONNREFUSED";
  const refusedUnix = v => v === "EACCES" || v === "EPERM";
  const bad = [];
  if (!refusedTcp(results.loopback)) bad.push(`loopback: ${results.loopback}`);
  if (!refusedTcp(results.public)) bad.push(`public address: ${results.public}`);
  if (!refusedUnix(results.unix)) bad.push(`unix socket: ${results.unix}`);
  const abstract = (o.abstract || abstractListeners)();
  if (abstract.length) { results.abstract = abstract.slice(0, 3).join(" "); bad.push(`an abstract unix socket listens in this network namespace (${abstract.slice(0, 3).join(", ")}), which a watcher could reach`); }
  return { ok: bad.length === 0, why: bad.length ? `a watcher uid was not stopped (${bad.join("; ")})` : "", results };
}

/**
 * The abstract-namespace unix sockets listening in this network namespace. They belong to the namespace, not to a file, so a watcher
 * uid can connect to any of them whatever the mode of a folder or the iptables rule says; the wall holds only while none listens.
 * /proc/net/unix: Num RefCount Protocol Flags Type St Inode Path, listening sockets carry Flags 00010000 and an abstract path starts with "@".
 * @param {string} [text]
 */
export function abstractListeners(text) {
  let t = text;
  if (t === undefined) { try { t = fs.readFileSync("/proc/net/unix", "utf8"); } catch { return []; } }
  const out = [];
  for (const line of t.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 8 && f[7].startsWith("@") && (parseInt(f[3], 16) & 0x10000) !== 0) out.push(f[7]);
  }
  return out;
}

/** Is NET_ADMIN still in this process's bounding set? @param {string} [statusText] */
export function holdsNetAdmin(statusText) {
  let text = statusText;
  if (text === undefined) { try { text = fs.readFileSync("/proc/self/status", "utf8"); } catch { return false; } }
  const m = /^CapBnd:\s*([0-9a-f]+)/m.exec(text);
  if (!m) return false;
  return ((BigInt("0x" + m[1]) >> NET_ADMIN_BIT) & 1n) === 1n;
}

/** What the spawner reads before it starts a watcher. @param {string} [file] @returns {{ ok: boolean, why: string, at: number }} */
export function readStatus(file = STATUS) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: j.ok === true, why: String(j.why || ""), at: Number(j.at) || 0 };
  } catch { return { ok: false, why: "the wall has not been installed and probed yet", at: 0 }; }
}

/** Write the status file (root's; the folder is vyred's to read, not write). @param {{ ok: boolean, why: string, results?: object }} v @param {string} [file] */
export function writeStatus(v, file = STATUS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.new`;
  fs.writeFileSync(tmp, JSON.stringify({ ...v, at: Math.floor(Date.now() / 1000) }) + "\n", { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * The same probe again, from the serving spawner (root, no NET_ADMIN needed: it only connects as a pool uid), before a watcher is spawned.
 * The rule lives in a network namespace this container shares with another (tailscale's), so it can vanish without this container restarting.
 * It never touches the rule: when it fails the spawn is refused and the next container start reinstalls and re-probes.
 * @param {{ dir?: string, probe?: typeof probe }} [o] @returns {Promise<{ ok: boolean, why: string }>}
 */
export async function recheck({ dir = path.dirname(STATUS), probe: doProbe = probe } = {}) {
  const socket = path.join(dir, `wall-recheck-${process.pid}.sock`);
  let server;
  try {
    try { fs.rmSync(socket, { force: true }); } catch { /* none */ }
    server = net.createServer(c => c.destroy());
    await new Promise((res, rej) => { server.once("error", rej); server.listen(socket, () => res(undefined)); });
    fs.chmodSync(socket, 0o600);
    const p = await doProbe({ unixSocket: socket });
    return { ok: p.ok, why: p.why };
  } catch (e) { return { ok: false, why: `the wall could not be checked: ${/** @type {Error} */ (e).message}` }; }
  finally { try { server?.close(); fs.rmSync(socket, { force: true }); } catch { /* gone */ } }
}

/** The one-shot step, as root with NET_ADMIN: install, probe, record. Never throws; a failure is recorded as not ok. */
export async function install(o = {}) {
  // A status from an earlier start must never stand while this one is unfinished.
  try { fs.rmSync(STATUS, { force: true }); } catch { /* none */ }
  const socket = path.join(path.dirname(STATUS), "wall-probe.sock");
  let server;
  try {
    const rules = installRules();
    if (!rules.ok) { writeStatus({ ok: false, why: rules.why }); return false; }
    // A unix socket closed to the pool (root's, mode 0600): the probe asserts a watcher uid cannot open it.
    try { fs.rmSync(socket, { force: true }); } catch { /* none */ }
    server = net.createServer(s => s.destroy());
    await new Promise((res, rej) => { server.once("error", rej); server.listen(socket, () => res(undefined)); });
    fs.chmodSync(socket, 0o600);
    const p = await probe({ unixSocket: socket, ...o });
    writeStatus({ ok: p.ok, why: p.why, results: p.results });
    return p.ok;
  } catch (e) {
    writeStatus({ ok: false, why: `the wall could not be installed: ${/** @type {Error} */ (e).message}` });
    return false;
  } finally { try { server?.close(); fs.rmSync(socket, { force: true }); } catch { /* gone */ } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv[2] === "install") {
  const ok = await install();
  const s = readStatus();
  process.stderr.write(`wall: ${ok ? "installed and probed" : `NOT in place: ${s.why}`}\n`);
  process.exit(0);
}
