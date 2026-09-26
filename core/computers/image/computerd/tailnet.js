// @ts-check
// tailnet: the computer's side of joining the tailnet as its own ephemeral, tagged node
// (core/computers/tailnet.js is vyred's side; ADR 0014 part 9).
//
// Three routes, answered only after the same bearer check as the rest of computerd:
//   GET  /tailnet       { ready, why?, running, stableId?, node? }   never takes or returns a key
//   POST /tailnet/up    { authKey, hostname, tag } -> { stableId, node }
//   POST /tailnet/down  {} -> { down: true }                       a clean stop logs the node out
//
// tailscaled runs in userspace (--tun=userspace-networking): no NET_ADMIN, no /dev/net/tun. Its
// state is memory only, so nothing about the node outlives the container, and the key itself is
// ephemeral, so the node is removed soon after the container goes. It offers a SOCKS5 proxy on
// 127.0.0.1:1056, which is how a program in the computer reaches the tailnet, and the node comes
// up with shields up: nothing on the tailnet can open a connection into the computer.
//
// The agent must never read the auth key or tailscaled's socket (whoever holds the socket can
// re-up the node under any name, read the tailnet's peers and send files). So this runs only as
// root, apart from the agent's uid: the socket lives in DIR, 0700 and owned by root, and the key
// is written there at 0600 only for the length of the `tailscale up` call, then deleted. It is
// never in an argument (only its file's path is), an environment variable, a log line or an
// error. As any other uid this refuses to start at all: GET says ready: false and vyred never
// sends the key.
//
// This file does not start a server of its own. Whatever serves it must be a process the agent's
// uid cannot signal, trace or replace (see the report to the lead: computerd itself runs as the
// agent, so today nothing serves these routes, and an image without them answers 404).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY = /^tskey-[A-Za-z0-9-]{8,200}$/;
const HOST = /^vyre-agent-[a-z][a-z0-9-]{0,40}$/;
const TAG = /^tag:[A-Za-z][A-Za-z0-9-]{0,62}$/;

/**
 * @param {{ tailscale?: string, tailscaled?: string, dir?: string, socks?: string, uid?: () => number,
 *   root?: number, startMs?: number }} [o]
 *   dir: the private folder for the socket and the key's brief file. uid: who this runs as.
 *   root: the uid that counts as root, 0 everywhere but a test (which passes its own).
 *   startMs: how long tailscaled may take to answer.
 */
export function createTailnet(o = {}) {
  const bin = { tailscale: o.tailscale || "/usr/local/bin/tailscale", tailscaled: o.tailscaled || "/usr/local/bin/tailscaled" };
  const dir = o.dir || "/run/vyre-tailnet";
  const socket = path.join(dir, "tailscaled.sock");
  const socks = o.socks || "127.0.0.1:1056";
  const uid = o.uid || (() => (typeof process.getuid === "function" ? process.getuid() : -1));
  const root = o.root ?? 0;
  const startMs = o.startMs ?? 10_000;
  /** @type {import("node:child_process").ChildProcess|null} */
  let daemon = null;
  /** One up or down at a time. */
  let chain = Promise.resolve();
  const serial = fn => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  /** Children get PATH and nothing else: none of computerd's secrets ever reaches tailscale. */
  const env = () => ({ PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" });

  /** @returns {Promise<{ code: number, out: string, err: string }>} */
  const tailscale = (args, timeout = 15_000) => new Promise(resolve => {
    const child = spawn(bin.tailscale, [`--socket=${socket}`, ...args], { stdio: ["ignore", "pipe", "pipe"], env: env() });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? -1, out, err: err.trim() }); });
  });

  const ready = () => {
    const me = uid();
    return me === root ? { ready: true } : { ready: false, why: `this runs as uid ${me}, not root, so the agent could read the key and tailscaled's socket` };
  };

  /** DIR, made 0700 and checked: a folder the agent made first, or a symlink, is refused. */
  const privateDir = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== uid() || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a private folder owned by this user`);
  };

  /** tailscale status --json, or null when tailscaled does not answer. */
  const status = async () => {
    const r = await tailscale(["status", "--json"], 5_000);
    if (!r.out) return null;
    try { const j = JSON.parse(r.out); return j && typeof j.BackendState === "string" ? j : null; } catch { return null; }
  };

  /** Start tailscaled if it is not running, and wait until it answers. */
  const start = async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null && (await status())) return;
    privateDir();
    daemon = spawn(bin.tailscaled, [
      "--tun=userspace-networking", "--state=mem:", `--socket=${socket}`, `--socks5-server=${socks}`, "--no-logs-no-support",
    ], { stdio: "ignore", env: env() });
    daemon.on("error", () => {});
    const deadline = Date.now() + startMs;
    while (Date.now() < deadline) {
      if (await status()) return;
      if (daemon.exitCode !== null) throw new Error(`tailscaled exited ${daemon.exitCode}`);
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error("tailscaled did not answer in time");
  };

  /** What GET /tailnet answers. Never starts anything. */
  const describe = async () => {
    const r = ready();
    if (!r.ready) return { ...r, running: false };
    if (!daemon || daemon.exitCode !== null) return { ready: true, running: false };
    const s = await status();
    if (!s || s.BackendState !== "Running" || !s.Self || !s.Self.ID) return { ready: true, running: false };
    return { ready: true, running: true, stableId: String(s.Self.ID), node: String(s.Self.DNSName || "").replace(/\.$/, "") };
  };

  /** @param {any} body */
  const up = body => serial(async () => {
    const r = ready();
    if (!r.ready) throw Object.assign(new Error(r.why), { status: 403 });
    const b = body && typeof body === "object" ? body : {};
    if (typeof b.authKey !== "string" || !KEY.test(b.authKey)) throw Object.assign(new Error("authKey is not a Tailscale auth key"), { status: 400 });
    if (typeof b.hostname !== "string" || !HOST.test(b.hostname)) throw Object.assign(new Error("hostname must be vyre-agent-<agent>"), { status: 400 });
    if (typeof b.tag !== "string" || !TAG.test(b.tag)) throw Object.assign(new Error("tag must be tag:<name>"), { status: 400 });
    const key = b.authKey;
    b.authKey = "";
    await start();
    const file = path.join(dir, `authkey-${crypto.randomBytes(8).toString("hex")}`);
    let res;
    try {
      fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" });
      res = await tailscale(["up", `--auth-key=file:${file}`, `--hostname=${b.hostname}`, `--advertise-tags=${b.tag}`,
        "--shields-up", "--accept-dns=false", "--accept-routes=false", "--timeout=40s"], 45_000);
    } finally {
      fs.rmSync(file, { force: true });
    }
    if (res.code !== 0) throw new Error(`tailscale up failed: ${scrub(res.err, key) || `exit ${res.code}`}`);
    const s = await status();
    if (!s || s.BackendState !== "Running" || !s.Self || !s.Self.ID) throw new Error(`tailscale up finished but the node is ${s ? s.BackendState : "not answering"}`);
    return { stableId: String(s.Self.ID), node: String(s.Self.DNSName || "").replace(/\.$/, "") };
  });

  const down = () => serial(async () => {
    if (!ready().ready || !daemon || daemon.exitCode !== null) return { down: true };
    const r = await tailscale(["logout"], 10_000);
    if (r.code !== 0) throw new Error(`tailscale logout failed: ${r.err || `exit ${r.code}`}`);
    return { down: true };
  });

  return {
    describe, up, down,
    /**
     * One route. The body is parsed JSON (or undefined).
     * @returns {Promise<{ status: number, body: any } | null>} null when the route is not one of these
     */
    async handle(method, pathname, body) {
      try {
        if (method === "GET" && pathname === "/tailnet") return { status: 200, body: await describe() };
        if (method === "POST" && pathname === "/tailnet/up") return { status: 200, body: await up(body) };
        if (method === "POST" && pathname === "/tailnet/down") return { status: 200, body: await down() };
        return null;
      } catch (e) {
        const key = body && typeof body.authKey === "string" ? body.authKey : "";
        const err = /** @type {any} */ (e);
        return { status: err.status || 500, body: { error: { message: scrub(String(err.message || e), key) } } };
      }
    },
    stop() { if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM"); },
  };
}

/** A message with the key taken out, however it got there. */
function scrub(text, key) {
  let t = String(text || "").slice(0, 500);
  if (key) t = t.split(key).join("[key]");
  return t.replace(/tskey-[A-Za-z0-9-]+/g, "[key]");
}
