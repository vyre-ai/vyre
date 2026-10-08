// @ts-check
// headscale: supervises ONE Headscale per space (SPEC-wink-network 4.2, 4.3).
//
// vyred writes the configuration, starts the daemon, keeps it healthy, mints pre-auth keys over the
// admin unix socket with the daemon's own CLI, lists and deletes nodes, and reloads the access
// policy. The person never sees Headscale. This file is the only place that runs the binary.
//
// What the configuration pins (all of it measured on a real v0.29.4 in the spike):
//   - a random /24 inside 100.64.0.0/10 that overlaps no prefix the caller names, no IPv6 key,
//     MagicDNS off, no OIDC, no web UI, no API key ever, logtail, Taildrop and update checks off;
//   - policy mode "file" (reload is SIGHUP; `headscale policy set` is refused in file mode);
//   - the admin socket is a unix socket, mode 0600, in a 0700 directory;
//   - the public listener binds loopback only: the gate (gate.js) is the front door;
//   - the default DERP map points at Tailscale, so derp.urls is emptied and a dummy region file
//     stands in unless the embedded DERP is on (which needs TLS on the listener);
//   - the embedded DERP verifies clients (relay only for registered node keys, EC-5);
//   - metrics have no off switch: they bind 127.0.0.1 on a random port and are never proxied.
//
// A key is returned only in memory or written to a 0600 file. It is never in an argv (the CLI
// takes none), a log line, an event or an error message: everything that leaves here goes through
// redact().
//
// Which binary: VYRE_HEADSCALE_BIN wins; under node --test there is none unless VYRE_WINK_REAL=1,
// so no test reaches a real Headscale by accident.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { compilePolicy, applyPolicy } from "./policy.js";

export function headscaleBin() {
  if (process.env.VYRE_HEADSCALE_BIN) return process.env.VYRE_HEADSCALE_BIN;
  if (process.env.NODE_TEST_CONTEXT && process.env.VYRE_WINK_REAL !== "1") return null;
  return "headscale";
}

const KEY_RE = /\b(hskey|tskey|nodekey|privkey)[-:][A-Za-z0-9_:-]{6,}/g;
/** Anything that looks like a key becomes a marker. Applied to every log line, event and error. @param {string} s */
export function redact(s) { return String(s).replace(KEY_RE, "[redacted-key]"); }

// ---- addresses ----

/** @param {string} a */
function toInt(a) {
  const o = a.split(".").map(Number);
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}
/** @param {string} c @returns {[number, number]|null} */
function range(c) {
  const [a, b] = String(c).split("/");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) return null;
  const bits = b === undefined ? 32 : Number(b);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits), start = Math.floor(toInt(a) / size) * size;
  return [start, start + size - 1];
}

/** The IPv4 prefixes of this machine's own interfaces, as CIDRs. A new network avoids them. */
export function localPrefixes() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    if (i.family === "IPv4" && i.cidr) out.push(i.cidr);
  }
  return out;
}

/**
 * A random /24 inside 100.64.0.0/10 that overlaps none of `used`. Throws when every one is taken.
 * @param {string[]} [used] CIDRs (any size) that are already in use on this machine or network
 * @param {(max: number) => number} [rand]
 */
export function pickPrefix(used = [], rand = max => crypto.randomInt(max)) {
  const taken = used.map(range).filter(Boolean);
  const free = (/** @type {number} */ start) => taken.every(r => !(start <= /** @type {number[]} */ (r)[1] && start + 255 >= /** @type {number[]} */ (r)[0]));
  for (let i = 0; i < 4096; i++) {
    const second = 64 + rand(64), third = rand(256);
    const start = ((100 * 256 + second) * 256 + third) * 256;
    if (free(start)) return `100.${second}.${third}.0/24`;
  }
  throw new Error("headscale: no free /24 left inside 100.64.0.0/10");
}

/** A free loopback TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => resolve(p)); });
  });
}

// ---- configuration ----

const q = (/** @type {string} */ s) => JSON.stringify(String(s)); // a JSON string is a YAML string

/**
 * The Headscale configuration for one space.
 * @param {{ dir: string, serverUrl: string, prefix: string, listenPort: number, metricsPort: number, grpcPort: number,
 *   policyPath?: string, socketPath?: string, host?: string, trustedProxies?: string[],
 *   derp?: { enabled: boolean, stunPort?: number, ipv4?: string, tlsCert?: string, tlsKey?: string },
 *   logLevel?: string }} o
 */
export function buildConfig(o) {
  const host = o.host || "127.0.0.1";
  const d = o.dir;
  const derp = o.derp && o.derp.enabled ? o.derp : null;
  if (derp && !(derp.tlsCert && derp.tlsKey)) throw new Error("headscale: the embedded DERP needs a TLS certificate and key on the listener");
  if (!range(o.prefix) || !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(o.prefix)) throw new Error("headscale: the prefix must be inside 100.64.0.0/10");
  const L = [
    `server_url: ${q(o.serverUrl)}`,
    `listen_addr: ${q(`${host}:${o.listenPort}`)}`,
    `metrics_listen_addr: ${q(`127.0.0.1:${o.metricsPort}`)}`,
    `grpc_listen_addr: ${q(`127.0.0.1:${o.grpcPort}`)}`,
    `grpc_allow_insecure: false`,
    `trusted_proxies: [${(o.trustedProxies || ["127.0.0.1/32"]).map(q).join(", ")}]`,
    ...(derp ? [`tls_cert_path: ${q(/** @type {string} */ (derp.tlsCert))}`, `tls_key_path: ${q(/** @type {string} */ (derp.tlsKey))}`] : []),
    `noise:`, `  private_key_path: ${q(path.join(d, "noise_private.key"))}`,
    `prefixes:`, `  v4: ${q(o.prefix)}`, `  allocation: sequential`,
    `derp:`,
    `  server:`,
    `    enabled: ${derp ? "true" : "false"}`,
    `    region_id: 999`, `    region_code: "wink"`, `    region_name: "Wink DERP"`,
    `    verify_clients: true`,
    `    stun_listen_addr: ${q(`${derp ? "0.0.0.0" : "127.0.0.1"}:${(derp && derp.stunPort) || 3478}`)}`,
    `    private_key_path: ${q(path.join(d, "derp_server_private.key"))}`,
    `    automatically_add_embedded_derp_region: true`,
    ...(derp && derp.ipv4 ? [`    ipv4: ${q(derp.ipv4)}`] : []),
    `  urls: []`,
    `  paths: [${derp ? "" : q(path.join(d, "derp-dummy.yaml"))}]`,
    `  auto_update_enabled: false`,
    `disable_check_updates: true`,
    `node:`, `  expiry: 0`, `  ephemeral:`, `    inactivity_timeout: 30m`,
    `database:`, `  type: sqlite`, `  sqlite:`, `    path: ${q(path.join(d, "db.sqlite"))}`, `    write_ahead_log: true`,
    `log:`, `  level: ${o.logLevel || "info"}`, `  format: text`,
    `policy:`, `  mode: file`, `  path: ${q(o.policyPath || path.join(d, "policy.hujson"))}`,
    `dns:`, `  magic_dns: false`, `  override_local_dns: false`, `  base_domain: "wink.internal"`, `  nameservers:`, `    global: []`,
    `unix_socket: ${q(o.socketPath || path.join(d, "headscale.sock"))}`,
    `unix_socket_permission: "0600"`,
    `logtail:`, `  enabled: false`,
    `taildrop:`, `  enabled: false`,
  ];
  return L.join("\n") + "\n";
}

// A region file with one unreachable node: stands in for the default DERP map, which names Tailscale.
const DERP_DUMMY = `regions:
  900:
    regionid: 900
    regioncode: none
    regionname: none
    nodes:
      - name: 900a
        regionid: 900
        hostname: derp.invalid
        stunport: -1
        stunonly: false
        derpport: 443
`;

// ---- the supervisor ----

const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const TAG_RE = /^tag:[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {{ id: number, name: string, givenName: string, nodeKey: string, machineKey: string, ips: string[],
 *   tags: string[], user: string|null, online: boolean, createdAt: string|null, lastSeen: string|null, stableId: string }} Node
 * @typedef {{ type: string, [k: string]: any }} HsEvent
 */

/**
 * @param {{ dir: string, serverUrl: string, bin?: string, uid?: number, gid?: number, usedPrefixes?: string[],
 *   prefix?: string, listenPort?: number, derp?: { enabled: boolean, stunPort?: number, ipv4?: string, tlsCert?: string, tlsKey?: string },
 *   trustedProxies?: string[], userName?: string, env?: Record<string, string>, startTimeoutMs?: number, healthMs?: number, supervise?: boolean,
 *   onLog?: (line: string) => void, onEvent?: (e: HsEvent) => void, now?: () => number }} opts
 */
export function createHeadscale(opts) {
  const dir = path.resolve(opts.dir);
  const cfgPath = path.join(dir, "config.yaml");
  const policyPath = path.join(dir, "policy.hujson");
  const socketPath = path.join(dir, "headscale.sock");
  const metaPath = path.join(dir, "wink.json");
  const userName = opts.userName || "wink";
  const startTimeout = opts.startTimeoutMs ?? 20_000;
  const healthMs = opts.healthMs ?? 60_000;
  const supervise = opts.supervise !== false;
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0 && opts.uid != null;
  const ids = asRoot ? { uid: opts.uid, gid: opts.gid ?? opts.uid } : {};
  const now = opts.now || Date.now;
  if (Buffer.byteLength(socketPath) > 100) throw new Error("headscale: the admin socket path is too long for a unix socket; use a shorter state directory");

  /** @type {import("node:child_process").ChildProcess|null} */ let child = null;
  let state = "stopped", since = now(), restarts = 0, failures = 0, lastError = /** @type {string|null} */ (null);
  let stopping = false, userId = /** @type {number|null} */ (null), timer = /** @type {any} */ (null), backoff = null;
  /** @type {{ prefix: string, listenPort: number, metricsPort: number, grpcPort: number }|null} */ let meta = null;

  const emit = (/** @type {HsEvent} */ e) => { try { opts.onEvent && opts.onEvent({ ...e, at: now() }); } catch { /* a listener never breaks the supervisor */ } };
  const setState = (/** @type {string} */ s, /** @type {string|null} */ why = null) => { if (state !== s) { state = s; since = now(); } if (why) lastError = redact(why); };
  const binPath = () => {
    const b = opts.bin || headscaleBin();
    if (!b) throw new Error("headscale: no binary (set VYRE_HEADSCALE_BIN)");
    return b;
  };
  const chown = (/** @type {string} */ p) => { if (asRoot) try { fs.chownSync(p, /** @type {number} */ (ids.uid), /** @type {number} */ (ids.gid)); } catch { /* best effort */ } };
  const env = () => ({ PATH: process.env.PATH || "/usr/bin:/bin", HOME: dir, LANG: "C", TMPDIR: dir, ...(opts.env || {}) });

  async function prepare() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    chown(dir);
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { meta = null; }
    if (!meta || (opts.prefix && meta.prefix !== opts.prefix)) {
      meta = {
        prefix: opts.prefix || pickPrefix(opts.usedPrefixes || []),
        listenPort: opts.listenPort || await freePort(), metricsPort: await freePort(), grpcPort: await freePort(),
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
      chown(metaPath);
    } else if (opts.listenPort && meta.listenPort !== opts.listenPort) {
      meta.listenPort = opts.listenPort;
      fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
    }
    fs.writeFileSync(cfgPath, buildConfig({ dir, serverUrl: opts.serverUrl, ...meta, policyPath, socketPath, trustedProxies: opts.trustedProxies, derp: opts.derp }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "derp-dummy.yaml"), DERP_DUMMY, { mode: 0o600 });
    // Deny everything until vyred compiles rows into a policy: a policy that exists and names nothing.
    if (!fs.existsSync(policyPath)) fs.writeFileSync(policyPath, compilePolicy({ rows: [], hubPort: 1, jobPort: 1 }).text, { mode: 0o600 });
    for (const f of [cfgPath, policyPath, path.join(dir, "derp-dummy.yaml")]) chown(f);
  }

  function spawnDaemon() {
    const c = spawn(binPath(), ["-c", cfgPath, "serve"], { stdio: ["ignore", "pipe", "pipe"], env: env(), cwd: dir, ...ids });
    child = c;
    for (const s of [c.stdout, c.stderr]) {
      let buf = "";
      s && s.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = redact(buf.slice(0, i)); buf = buf.slice(i + 1);
          try { opts.onLog && opts.onLog(line); } catch { /* ignore */ }
        }
        if (buf.length > 16384) buf = "";
      });
    }
    c.on("error", e => { setState("failed", e.message); emit({ type: "error", message: redact(e.message) }); });
    c.on("exit", (code, sig) => {
      if (child === c) child = null;
      if (stopping) return;
      setState("crashed", `exited ${sig || code}`);
      emit({ type: "exited", code, signal: sig });
      if (supervise) scheduleRestart();
    });
    return c;
  }

  function scheduleRestart() {
    if (backoff || stopping) return;
    failures++;
    if (failures > 10) { setState("failed", "too many restarts"); emit({ type: "failed" }); return; }
    const ms = Math.min(30_000, 1000 * 2 ** (failures - 1));
    emit({ type: "restarting", inMs: ms });
    backoff = setTimeout(async () => {
      backoff = null;
      if (stopping) return;
      restarts++;
      try { await boot(); } catch (e) { setState("crashed", /** @type {Error} */ (e).message); scheduleRestart(); }
    }, ms);
    backoff.unref && backoff.unref();
  }

  function httpHealthy() {
    return new Promise(resolve => {
      if (!meta) return resolve(false);
      const r = http.get({ host: "127.0.0.1", port: meta.listenPort, path: "/health", timeout: 2000 }, res => { res.resume(); resolve(res.statusCode === 200); });
      r.on("timeout", () => { r.destroy(); resolve(false); });
      r.on("error", () => resolve(false));
    });
  }
  function socketUp() {
    return new Promise(resolve => {
      const c = net.connect(socketPath);
      c.on("connect", () => { c.destroy(); resolve(true); });
      c.on("error", () => resolve(false));
    });
  }
  /** Healthy means the listener answers /health and the admin socket accepts. */
  async function healthy() { return (await httpHealthy()) && (await socketUp()); }

  async function boot() {
    setState("starting");
    await prepare();
    const c = spawnDaemon();
    const deadline = now() + startTimeout;
    for (;;) {
      if (child !== c) throw new Error(`headscale exited while starting${lastError ? ": " + lastError : ""}`);
      if (await healthy()) break;
      if (now() > deadline) { try { c.kill("SIGKILL"); } catch { /* gone */ } throw new Error("headscale did not become healthy in time"); }
      await wait(100);
    }
    try { fs.chmodSync(socketPath, 0o600); } catch { /* the daemon set it */ }
    setState("running");
    if (userId === null) userId = await ensureUser();
    emit({ type: "started", pid: c.pid });
    armHealth();
  }

  function armHealth() {
    if (timer || !supervise) return;
    timer = setInterval(async () => {
      if (state !== "running" || stopping) return;
      if (await healthy()) { failures = 0; return; }
      if (await wait(2000).then(healthy)) return; // one slow answer is not a failure
      emit({ type: "unhealthy" });
      setState("unhealthy", "health check failed");
      try { child && child.kill("SIGKILL"); } catch { /* gone */ }
    }, Math.max(healthMs, 1000));
    timer.unref && timer.unref();
  }

  /**
   * Run the CLI over the admin socket. No argument is ever a secret: a key only comes back on stdout.
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  function cli(args) {
    return new Promise((resolve, reject) => {
      const c = spawn(binPath(), ["-c", cfgPath, ...args, "-o", "json", "--force"], { stdio: ["ignore", "pipe", "pipe"], env: env(), ...ids });
      let out = "", err = "";
      const t = setTimeout(() => c.kill("SIGKILL"), 15_000);
      c.stdout.on("data", d => { out += d; if (out.length > 8_000_000) c.kill("SIGKILL"); });
      c.stderr.on("data", d => { err += d; if (err.length > 64_000) err = err.slice(-32_000); });
      c.on("error", e => { clearTimeout(t); reject(new Error(redact(e.message))); });
      c.on("close", code => {
        clearTimeout(t);
        if (code === 0) return resolve(out);
        let msg = err.trim() || out.trim();
        try { msg = JSON.parse(msg).error || msg; } catch { /* plain text */ }
        reject(Object.assign(new Error(`headscale ${args[0]}${args[1] ? " " + args[1] : ""} failed: ${redact(msg).split("\n")[0].slice(0, 300)}`), { code }));
      });
    });
  }
  const json = async (/** @type {string[]} */ args) => { const o = await cli(args); try { return JSON.parse(o); } catch { throw new Error(`headscale ${args[0]}: unreadable answer`); } };

  async function ensureUser() {
    const list = await json(["users", "list"]);
    const have = (Array.isArray(list) ? list : []).find((/** @type {any} */ u) => u.name === userName);
    if (have) return Number(have.id);
    const made = await json(["users", "create", userName]);
    return Number(made.id);
  }

  /** @param {any} n @returns {Node} */
  function shapeNode(n) {
    const id = Number(n.id);
    return {
      id, name: String(n.name || n.given_name || ""), givenName: String(n.given_name || n.givenName || n.name || ""),
      nodeKey: String(n.node_key || n.nodeKey || ""), machineKey: String(n.machine_key || n.machineKey || ""),
      ips: n.ip_addresses || n.ipAddresses || [],
      tags: n.tags || n.forced_tags || n.forcedTags || [],
      user: n.user ? String(n.user.name || n.user) : null, online: !!n.online,
      /** The pre-auth key this node joined with (Headscale records it on the node): what binds a node to the device the key was minted for. */
      preAuthKeyId: (n.pre_auth_key || n.preAuthKey) && Number.isFinite(Number((n.pre_auth_key || n.preAuthKey).id)) ? Number((n.pre_auth_key || n.preAuthKey).id) : null,
      createdAt: n.created_at || n.createdAt || null, lastSeen: n.last_seen || n.lastSeen || null,
      stableId: String(id),
    };
  }

  return {
    dir, socketPath, policyPath, configPath: cfgPath,
    get pid() { return child ? child.pid ?? null : null; },
    get prefix() { return meta ? meta.prefix : null; },
    get listen() { return meta ? { host: "127.0.0.1", port: meta.listenPort } : null; },

    async start() {
      if (state === "running" && child) return this.status();
      stopping = false; failures = 0;
      try { await boot(); } catch (e) { setState("failed", /** @type {Error} */ (e).message); try { child && child.kill("SIGKILL"); } catch { /* gone */ } throw e; }
      return this.status();
    },
    async stop() {
      stopping = true;
      if (backoff) { clearTimeout(backoff); backoff = null; }
      if (timer) { clearInterval(timer); timer = null; }
      const c = child;
      if (c && c.exitCode === null && c.signalCode === null) {
        await new Promise(resolve => {
          const k = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
          c.once("exit", () => { clearTimeout(k); resolve(null); });
          c.kill("SIGTERM");
        });
      }
      child = null;
      setState("stopped");
      emit({ type: "stopped" });
    },
    async restart() { await this.stop(); return this.start(); },

    healthy,
    async status() {
      const h = state === "running" ? await healthy() : false;
      return {
        state: state === "running" && !h ? "unhealthy" : state, healthy: h, pid: child ? child.pid ?? null : null,
        since, restarts, prefix: meta ? meta.prefix : null, port: meta ? meta.listenPort : null, error: lastError,
      };
    },

    /**
     * A single-use pre-auth key that lasts minutes. Returns the key in memory, or, with `file`, writes
     * it to a new 0600 file and returns the path instead. The caller seals it to the device and deletes it.
     * @param {{ tags?: string[], ttlMs?: number, file?: string }} [o]
     * @returns {Promise<{ key?: string, file?: string, id: number|null, expiresAt: number, tags: string[] }>}
     */
    async createPreauthKey(o = {}) {
      const tags = [...new Set(o.tags || [])];
      for (const t of tags) if (!TAG_RE.test(t)) throw new Error("headscale: bad tag");
      const ttl = Math.min(3_600_000, Math.max(30_000, o.ttlMs ?? 300_000));
      if (userId === null) userId = await ensureUser();
      const args = ["preauthkeys", "create", "-u", String(userId), "-e", `${Math.round(ttl / 1000)}s`];
      if (tags.length) args.push("--tags", tags.join(","));
      let obj = await json(args);
      const key = obj && typeof obj.key === "string" ? obj.key : null;
      const id = obj && Number.isFinite(Number(obj.id)) ? Number(obj.id) : null;
      obj = null;
      if (!key) throw new Error("headscale: no key in the answer");
      const base = { id, expiresAt: now() + ttl, tags };
      if (o.file) {
        const fd = fs.openSync(o.file, "wx", 0o600);
        try { fs.writeSync(fd, key); } finally { fs.closeSync(fd); }
        return { file: o.file, ...base };
      }
      return { key, ...base };
    },

    /** @returns {Promise<Node[]>} */
    async listNodes() {
      const l = await json(["nodes", "list"]);
      return (Array.isArray(l) ? l : []).map(shapeNode);
    },
    /** @param {number|string} id */
    async deleteNode(id) {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1) throw new Error("headscale: bad node id");
      await cli(["nodes", "delete", "-i", String(n)]);
    },

    /** Replace the access policy and ask the daemon to re-read it. @param {string} text */
    setPolicy(text) { return applyPolicy(policyPath, child ? child.pid : null, text); },
  };
}
