// @ts-check
// core: manages one Wink core instance, a Vyre-owned userspace tailscaled (spec 4.7, EC-8, EC-9,
// EC-10, EC-2, EC-4, EC-11). Nothing here ever touches a Tailscale the person installed.
//
// Which binaries: VYRE_WINK_CORE_BIN (the daemon) and VYRE_WINK_CLI_BIN (its CLI), or the pair
// Vyre ships in <home>/bin. There is no PATH lookup and no search for another install, and under
// node --test there is none unless the test sets the variables to a fake.
//
// The exact prefs this module holds the core to (ENFORCED_PREFS below; `tailscale debug prefs`
// names them). Anything else seen at any check is drift, reported as an error event, re-applied
// once, and if it will not stay applied the core is stopped (fail closed):
//   ControlURL                 the local pinning shim, never what control says (EC-8)
//   RouteAll false             no subnet routes from peers
//   CorpDNS false              no DNS settings, MagicDNS or resolver override
//   RunSSH false               no SSH server
//   RunWebClient false         no web client
//   ExitNodeID/ExitNodeIP ""   no exit node
//   AdvertiseRoutes empty      no routes offered
//   AdvertiseServices empty    no services (serve, funnel)
//   AdvertiseTags              exactly the tags given to start() (none by default; EC-7)
//   DriveShares empty          no Taildrive shares
//   AutoUpdate.Check/Apply false, AppConnector.Advertise false, PostureChecking false
//   Hostname                   as given
// In userspace mode there is no interface, no route and no resolver change on the host at all.
// The control plane can still push a Taildrop capability to the node; no client pref turns it
// off, so the daemon runs with --state=<file> and never --statedir. tailscaled then has no
// storage directory and refuses to receive ("Taildrop disabled; no storage directory").
//
// Files: everything under <home> (0700): state/ (0700, tailscaled.state 0600), run/ (0700, the
// local API socket, chmod 0600; the directory is what keeps other uids out, EC-2), log/. The
// pre-auth key is read only from a 0600 file owned by the service user, passed as `file:PATH`
// (the key itself is never in argv or the environment), and the file is deleted right after
// `tailscale up` succeeds (EC-4).

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { startShim as realStartShim } from "./shim.js";
import { isTailnet } from "../../../lib/netguard.js";

/** The prefs the core is held to; `AdvertiseTags` is filled from start()'s tags. */
export const ENFORCED_PREFS = Object.freeze({
  RouteAll: false, CorpDNS: false, RunSSH: false, RunWebClient: false, ExitNodeID: "", ExitNodeIP: "",
  AdvertiseRoutes: [], AdvertiseServices: [], DriveShares: [],
  AutoUpdateCheck: false, AutoUpdateApply: false, AppConnectorAdvertise: false, PostureChecking: false,
});

const HOST = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;

export class WinkCoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "WinkCoreError"; this.code = code; }
}

/** True for an address inside the tailnet ranges. @param {string} ip */
export const isTailnetIp = isTailnet;

const nonEmpty = (/** @type {any} */ a) => Array.isArray(a) && a.length > 0;

/**
 * Compare `tailscale debug prefs` JSON with what we enforce.
 * @param {any} prefs @param {{ controlUrl: string, hostname: string, tags: string[] }} want
 * @returns {{ pref: string, want: any, got: any }[]}
 */
export function prefsDrift(prefs, want) {
  const d = /** @type {{ pref: string, want: any, got: any }[]} */ ([]);
  const chk = (/** @type {string} */ pref, /** @type {any} */ w, /** @type {any} */ g, bad = w !== g) => { if (bad) d.push({ pref, want: w, got: g }); };
  const p = prefs || {};
  chk("ControlURL", want.controlUrl, p.ControlURL);
  chk("RouteAll", false, p.RouteAll);
  chk("CorpDNS", false, p.CorpDNS);
  chk("RunSSH", false, p.RunSSH);
  chk("RunWebClient", false, p.RunWebClient);
  chk("ExitNodeID", "", p.ExitNodeID || "");
  chk("ExitNodeIP", "", p.ExitNodeIP || "");
  chk("AdvertiseRoutes", [], p.AdvertiseRoutes || [], nonEmpty(p.AdvertiseRoutes));
  chk("AdvertiseServices", [], p.AdvertiseServices || [], nonEmpty(p.AdvertiseServices));
  chk("DriveShares", [], p.DriveShares || [], nonEmpty(p.DriveShares));
  const tags = [...(p.AdvertiseTags || [])].sort();
  chk("AdvertiseTags", [...want.tags].sort(), tags, JSON.stringify(tags) !== JSON.stringify([...want.tags].sort()));
  chk("AutoUpdate.Check", false, p.AutoUpdate?.Check ?? false);
  chk("AutoUpdate.Apply", false, p.AutoUpdate?.Apply ?? false);
  chk("AppConnector.Advertise", false, p.AppConnector?.Advertise ?? false);
  chk("PostureChecking", false, p.PostureChecking ?? false);
  chk("Hostname", want.hostname, p.Hostname);
  return d;
}

/**
 * What the control plane may not have done, read from `tailscale status --json`: a login URL,
 * an exit node in use, a default or non-host route on a peer is reported, never acted on.
 * @param {any} s
 */
export function statusFindings(s) {
  const out = /** @type {{ code: string, detail: string }[]} */ ([]);
  if (s && s.AuthURL) out.push({ code: "login-url", detail: "the control plane offered a login URL; it is never opened" });
  if (s && s.ExitNodeStatus) out.push({ code: "exit-node", detail: "an exit node is in use" });
  for (const p of Object.values(/** @type {any} */ (s && s.Peer) || {})) {
    const bad = ((/** @type {any} */ (p)).AllowedIPs || []).filter((/** @type {string} */ c) => !/\/(32|128)$/.test(c));
    if (bad.length) out.push({ code: "peer-routes-ignored", detail: `a peer advertises ${bad.slice(0, 3).join(", ")}; routes are not accepted` });
  }
  return out;
}

/** Map `tailscale status --json` to Vyre's four states. @param {any} s */
export function shapeState(s) {
  const b = s && s.BackendState;
  if (b === "Running") {
    const peers = Object.values(/** @type {any} */ (s.Peer) || {}).filter((/** @type {any} */ p) => p.Online);
    if (peers.length && !peers.some((/** @type {any} */ p) => p.CurAddr)) return { state: "relayed", why: "every peer is reached through the relay" };
    return { state: "connected", why: null };
  }
  if (b === "Starting" || b === "NeedsLogin" || b === "NeedsMachineAuth") return { state: "joining", why: b === "NeedsLogin" ? "not signed in yet" : b === "NeedsMachineAuth" ? "waiting for approval" : "starting" };
  return { state: "offline", why: b ? `backend ${b}` : "no answer from the core" };
}

function defaultDetect() {
  /** @type {string[]} */ const found = [];
  for (const sock of ["/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock", "/var/run/tailscaled.socket"]) {
    try { if (fs.statSync(sock).isSocket()) found.push("a Tailscale service socket at " + sock); } catch { /* none */ }
  }
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && isTailnetIp(a.address)) found.push("an interface with a 100.64/10 address");
  } catch { /* none */ }
  return { systemTailscale: found.length > 0, why: found[0] || null };
}

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * A core manager. Every outside effect is injectable so unit tests use a fake binary and fake time.
 * @param {{ env?: NodeJS.ProcessEnv, exec?: (file: string, args: string[], o: { timeout: number }) => Promise<{ code: number, out: string, err: string }>,
 *   spawn?: typeof nodeSpawn, detect?: () => { systemTailscale: boolean, why: string | null }, sleep?: (ms: number) => Promise<void>,
 *   startShim?: typeof realStartShim, onEvent?: (e: any) => void, now?: () => number, watchMs?: number, uid?: number | null }} [deps]
 */
export function createCore(deps = {}) {
  const env = deps.env || process.env;
  const emit = (/** @type {any} */ e) => { try { deps.onEvent?.({ at: (deps.now || Date.now)(), ...e }); } catch { /* reporter must not break the core */ } };
  const wait = deps.sleep || sleep;
  const startShim = deps.startShim || realStartShim;
  const detect = deps.detect || defaultDetect;
  const spawnFn = deps.spawn || nodeSpawn;
  const uid = deps.uid === undefined ? (process.getuid ? process.getuid() : null) : deps.uid;
  const scrubbed = (/** @type {string} */ home) => ({ PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: home, LANG: "C", TS_NO_LOGS_NO_SUPPORT: "true" });
  const exec = deps.exec || ((file, args, o) => new Promise(resolve => {
    execFile(file, args, { timeout: o.timeout, maxBuffer: 8 * 1024 * 1024, env: scrubbed(os.tmpdir()) }, (e, out, err) => {
      const code = !e ? 0 : /** @type {any} */ (e).code === "ENOENT" ? 127 : Number(/** @type {any} */ (e).code) || 1;
      resolve({ code, out: String(out), err: String(err) });
    });
  }));

  /** @type {null | { home: string, sock: string, cli: string, shim: any, child: any, adopted: boolean, want: { controlUrl: string, hostname: string, tags: string[] },
   *   since: number | null, last: string, timer: any, stopping: boolean }} */
  let cur = null;

  function bins(/** @type {string} */ home) {
    const pick = (/** @type {string} */ v, /** @type {string} */ name) => {
      if (env[v]) return /** @type {string} */ (env[v]);
      const own = path.join(home, "bin", name + (process.platform === "win32" ? ".exe" : ""));
      return fs.existsSync(own) ? own : null;
    };
    const core = pick("VYRE_WINK_CORE_BIN", "tailscaled"), cli = pick("VYRE_WINK_CLI_BIN", "tailscale");
    if (!core || !cli) throw new WinkCoreError("no-binary", "no Wink core binary: set VYRE_WINK_CORE_BIN and VYRE_WINK_CLI_BIN, or install the pair in <home>/bin");
    return { core, cli };
  }

  function mkprivate(/** @type {string} */ dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") return;
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new WinkCoreError("bad-home", `${dir} is not a plain directory`);
    if (uid != null && st.uid !== uid) throw new WinkCoreError("bad-home", `${dir} belongs to another user`);
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }

  function checkKeyFile(/** @type {string} */ f) {
    const st = fs.lstatSync(f);
    if (!st.isFile()) throw new WinkCoreError("bad-key-file", "the key file is not a plain file");
    if (process.platform !== "win32") {
      if (uid != null && st.uid !== uid) throw new WinkCoreError("bad-key-file", "the key file belongs to another user");
      if ((st.mode & 0o077) !== 0) throw new WinkCoreError("bad-key-file", "the key file is readable by others; it must be 0600");
    }
  }

  const cliRun = (/** @type {NonNullable<typeof cur>} */ c, /** @type {string[]} */ args, timeout = 20_000) => exec(c.cli, [`--socket=${c.sock}`, ...args], { timeout });

  async function readJson(/** @type {NonNullable<typeof cur>} */ c, /** @type {string[]} */ args) {
    const r = await cliRun(c, args);
    if (r.code !== 0) return null;
    try { return JSON.parse(r.out); } catch { return null; }
  }

  // Tags are set by `up` only (`tailscale set` has no such flag), so a tag drift cannot be repaired here and stops the core.
  function setArgs(/** @type {{ hostname: string }} */ w) {
    return ["set", "--accept-routes=false", "--accept-dns=false", "--ssh=false", "--exit-node=", "--advertise-routes=", "--advertise-exit-node=false",
      "--advertise-connector=false", "--update-check=false", "--auto-update=false", "--webclient=false", "--report-posture=false", "--hostname=" + w.hostname];
  }

  /** Check prefs and what control did; report, re-apply once, stop the core if it will not hold. */
  async function check() {
    const c = cur;
    if (!c || c.stopping) return { ok: false, drift: [], findings: [] };
    const prefs = await readJson(c, ["debug", "prefs"]);
    let drift = prefs ? prefsDrift(prefs, c.want) : [{ pref: "(all)", want: "readable prefs", got: null }];
    const status = await readJson(c, ["status", "--json"]);
    const findings = statusFindings(status);
    for (const f of findings) emit({ type: "error", code: f.code, detail: f.detail });
    if (drift.length) {
      emit({ type: "error", code: "prefs-drift", drift });
      await cliRun(c, setArgs(c.want));
      const again = await readJson(c, ["debug", "prefs"]);
      drift = again ? prefsDrift(again, c.want) : drift;
      if (drift.length) {
        emit({ type: "error", code: "prefs-drift-persistent", drift });
        await stop();
        return { ok: false, drift, findings };
      }
    }
    return { ok: drift.length === 0 && findings.length === 0, drift, findings };
  }

  /**
   * Start the core: shim, daemon, join, enforce.
   * @param {{ home: string, controlUrl: string, pinnedKeyPin: string, authKeyFile?: string, hostname: string, tags?: string[], mode?: "userspace" | "system" }} o
   */
  async function start(o) {
    if (cur) return status();
    if (!o || !path.isAbsolute(o.home)) throw new WinkCoreError("bad-input", "home must be an absolute path");
    if (!HOST.test(o.hostname || "")) throw new WinkCoreError("bad-input", "hostname must be lowercase letters, digits and dashes");
    const tags = o.tags || [];
    if (tags.some(t => !TAG.test(t))) throw new WinkCoreError("bad-input", "a tag must look like tag:name");
    const mode = o.mode || "userspace";
    const sys = detect();
    if (sys.systemTailscale && mode !== "userspace") throw new WinkCoreError("existing-tailscale", `Tailscale is already running here (${sys.why}); Wink stays in userspace mode or uses the relay on this machine`);
    const { core, cli } = bins(o.home);
    mkprivate(o.home);
    const stateDir = path.join(o.home, "state"), runDir = path.join(o.home, "run"), logDir = path.join(o.home, "log");
    for (const d of [stateDir, runDir, logDir]) mkprivate(d);
    const stateFile = path.join(stateDir, "tailscaled.state");
    const sock = path.join(runDir, "ts.sock");
    let enrolled = false;
    try { enrolled = fs.statSync(stateFile).size > 8; } catch { /* none */ }
    const keyFile = o.authKeyFile;
    if (keyFile) { try { checkKeyFile(keyFile); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT" && enrolled) { /* key already used, node enrolled */ } else throw e; } }
    const useKey = !!keyFile && fs.existsSync(keyFile);
    if (!enrolled && !useKey) throw new WinkCoreError("no-key", "no enrolment on disk and no key file to join with");

    const shim = await startShim({ upstream: o.controlUrl, pin: o.pinnedKeyPin, onEvent: e => emit({ type: "error", code: "shim-" + e.type, detail: e }) });
    const c = { home: o.home, sock, cli, shim, child: null, adopted: false, want: { controlUrl: shim.url, hostname: o.hostname, tags }, since: null, last: "joining", timer: null, stopping: false };
    cur = c;
    try {
      // A core this module started earlier and left running (vyred restarted) is adopted, not doubled.
      const alive = (await cliRun(c, ["status", "--json"], 3000)).code === 0;
      if (alive) c.adopted = true;
      else {
        try { fs.unlinkSync(sock); } catch { /* none */ }
        const tun = mode === "userspace" ? "userspace-networking" : process.platform === "darwin" ? "utun" : "wink0";
        const logFd = fs.openSync(path.join(logDir, "core.log"), "a", 0o600);
        // --state=<file> and never --statedir: no storage directory means no Taildrop, whatever control pushes.
        const child = spawnFn(core, [`--tun=${tun}`, `--state=${stateFile}`, `--socket=${sock}`, "--no-logs-no-support", "--port=0"], { stdio: ["ignore", logFd, logFd], env: scrubbed(o.home), cwd: o.home });
        fs.closeSync(logFd);
        c.child = child;
        child.on("exit", (/** @type {any} */ code, /** @type {any} */ sig) => { if (cur === c && !c.stopping) { c.last = "offline"; emit({ type: "state", state: "offline", why: `the core exited (${sig || code})` }); } });
        if (child.pid) fs.writeFileSync(path.join(runDir, "core.pid"), String(child.pid), { mode: 0o600 });
        let up = false;
        for (let i = 0; i < 300 && !up; i++) { try { up = fs.statSync(sock).isSocket(); } catch { await wait(50); } }
        if (!up) throw new WinkCoreError("core-not-started", "the core did not open its local socket");
      }
      if (process.platform !== "win32") fs.chmodSync(sock, 0o600); // tailscaled creates it 0666; the 0700 directory and this keep other uids out (EC-2)
      const upArgs = ["up", `--login-server=${shim.url}`, `--hostname=${o.hostname}`, "--accept-routes=false", "--accept-dns=false", "--ssh=false", "--exit-node=", "--reset", ...(tags.length ? [`--advertise-tags=${tags.join(",")}`] : [])];
      if (useKey) upArgs.push(`--auth-key=file:${keyFile}`);
      const r = await cliRun(c, upArgs, 90_000);
      if (r.code !== 0) throw new WinkCoreError("up-failed", "the core could not join: " + (r.err || r.out).trim().split("\n")[0].slice(0, 200));
      if (useKey) { try { fs.unlinkSync(/** @type {string} */ (keyFile)); } catch { /* gone */ } } // EC-4: single use, gone now
      const s = await cliRun(c, setArgs(c.want));
      if (s.code !== 0) throw new WinkCoreError("set-failed", "could not apply the safe prefs: " + (s.err || s.out).trim().split("\n")[0].slice(0, 200));
      const res = await check();
      if (!cur) throw new WinkCoreError("drift", "the control plane changed the core's settings and they would not stay applied");
      if (res.drift.length) throw new WinkCoreError("drift", "the core's settings do not match what Wink enforces");
      c.since = (deps.now || Date.now)();
      c.timer = setInterval(() => { check().catch(() => {}); }, Math.max(60_000, deps.watchMs ?? 60_000));
      c.timer.unref?.();
      emit({ type: "state", state: "connected" });
      return await status();
    } catch (e) {
      await stop();
      throw e;
    }
  }

  /** Stop the core and the shim; keep the enrolment so the next start() rejoins with no key. */
  async function stop() {
    const c = cur;
    if (!c) return;
    c.stopping = true;
    if (c.timer) clearInterval(c.timer);
    cur = null;
    let pid = c.child && c.child.pid;
    if (!pid && c.adopted) { try { pid = Number(fs.readFileSync(path.join(c.home, "run", "core.pid"), "utf8")) || null; } catch { /* none */ } }
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); await wait(50); } catch { pid = null; break; } }
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    try { fs.unlinkSync(c.sock); } catch { /* gone */ }
    try { fs.unlinkSync(path.join(c.home, "run", "core.pid")); } catch { /* gone */ }
    try { await c.shim.close(); } catch { /* gone */ }
  }

  /**
   * @returns {Promise<{ state: "connected" | "relayed" | "offline" | "joining", why: string | null, since: number | null,
   *   self: { nodeKey: string, stableId: string, ips: string[] } | null,
   *   peers: { nodeKey: string, stableId: string, ips: string[], tags: string[], online: boolean, direct: boolean }[] }>}
   */
  async function status() {
    const c = cur;
    if (!c) return { state: "offline", why: "the core is not running", since: null, self: null, peers: [] };
    const s = await readJson(c, ["status", "--json"]);
    if (!s) return { state: "offline", why: "no answer from the core", since: null, self: null, peers: [] };
    const sh = shapeState(s);
    if (sh.state === "offline" || sh.state === "joining") c.since = null;
    else if (c.since == null) c.since = (deps.now || Date.now)();
    if (sh.state !== c.last) { c.last = sh.state; emit({ type: "state", state: sh.state, why: sh.why }); }
    const peers = Object.values(s.Peer || {}).map((/** @type {any} */ p) => ({ nodeKey: String(p.PublicKey), stableId: String(p.ID), ips: p.TailscaleIPs || [], tags: p.Tags || [], online: !!p.Online, direct: !!p.CurAddr }));
    const self = s.Self ? { nodeKey: String(s.Self.PublicKey), stableId: String(s.Self.ID), ips: s.Self.TailscaleIPs || [] } : null;
    return { state: sh.state, why: sh.why, since: c.since, self, peers };
  }

  /**
   * Who owns a tailnet address, from the core's own state. The node's name is client-controlled
   * and is not returned. @param {string} ip
   */
  async function whois(ip) {
    const c = cur;
    if (!c) throw new WinkCoreError("not-running", "the core is not running");
    if (!isTailnetIp(ip)) throw new WinkCoreError("bad-input", "not a tailnet address");
    const w = await readJson(c, ["whois", "--json", ip]);
    const n = w && w.Node;
    if (!n || !n.Key || !n.StableID) return null;
    return { nodeKey: String(n.Key), stableId: String(n.StableID), tags: n.Tags || [], tagged: !!(w.UserProfile && w.UserProfile.LoginName === "tagged-devices") };
  }

  /** Sign out of the network, stop, and delete the state (both keys, EC-11). With no core running, pass { home }. */
  async function leave(/** @type {{ home?: string }} */ o = {}) {
    const c = cur;
    if (c) { await cliRun(c, ["logout"], 15_000).catch(() => {}); }
    const home = (c && c.home) || o.home;
    await stop();
    if (home) for (const d of ["state", "run"]) fs.rmSync(path.join(home, d), { recursive: true, force: true });
  }

  return { start, stop, status, whois, leave, check };
}

const def = createCore();
export const { start, stop, status, whois, leave, check } = def;
