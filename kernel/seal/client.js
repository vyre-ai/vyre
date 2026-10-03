// kernel/seal/client.js: the kernel's side of the sealing process. It spawns the process with the Node permission model
// on (no network, no child processes, no workers, reads only its own folder, writes only the vault and egress folders),
// speaks the line protocol of serve.js, and mints a ticket for each sensitive call. The vault key and the ticket key are
// handed over once on stdin and never put in an argument or the environment.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { canonical } from "../core/canonical.js";
import { KernelError } from "../core/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The Node permission flags the sealing process runs under: no network, no child processes, no workers; it reads its own code and vault, writes the vault and egress folders. */
export function sealFlags(/** @type {{ dir?: string, egress_dir?: string }} */ cfg) {
  const base = path.resolve(HERE, "..", "..");
  return ["--permission", `--allow-fs-read=${path.join(base, "kernel")}`, ...(cfg.dir ? [`--allow-fs-read=${cfg.dir}`, `--allow-fs-write=${cfg.dir}`] : []), ...(cfg.egress_dir ? [`--allow-fs-write=${cfg.egress_dir}`] : [])];
}

/**
 * @param {{ vault_key: Buffer, dir?: string, egress_dir?: string, command?: string[], clock?: () => number, ticket_ttl_ms?: number, timeout_ms?: number }} cfg
 *   command: the process to run (default: this folder's serve.js under `node --permission`); any program that speaks the protocol works.
 */
export function createSealClient(cfg) {
  const clock = cfg.clock || Date.now;
  const ticketKey = randomBytes(32);
  const ttl = cfg.ticket_ttl_ms ?? 10_000;
  const timeout = cfg.timeout_ms ?? 15_000;
  for (const d of [cfg.dir, cfg.egress_dir]) if (d) fs.mkdirSync(d, { recursive: true });
  const flags = sealFlags(cfg);
  const command = cfg.command || [process.execPath, ...flags, path.join(HERE, "serve.js")];
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH || "" } });
  let stderr = "";
  child.stderr.on("data", d => { stderr = (stderr + d).slice(-400); });
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout }>} */ const pending = new Map();
  let seq = 0, dead = null;
  const fail = (/** @type {any} */ why) => { dead = dead || why; for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new KernelError("unavailable", "the sealing process is not running", String(why))); } pending.clear(); };
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new KernelError(m.error.code, m.error.message));
  });
  child.on("exit", code => fail(`exited ${code}: ${stderr.trim()}`));
  child.on("error", e => fail(e.message));
  child.stdin.on("error", () => {});

  const send = (/** @type {string} */ op, /** @type {any} */ args, /** @type {any} */ ticket) => new Promise((resolve, reject) => {
    if (dead) return reject(new KernelError("unavailable", "the sealing process is not running", String(dead)));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new KernelError("unavailable", "the sealing process did not answer")); }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, op, args, ...(ticket ? { ticket } : {}) }) + "\n");
  });
  const ticket = (/** @type {string} */ op, /** @type {any} */ args) => {
    const nonce = randomBytes(16).toString("base64url"), exp = clock() + ttl;
    return { nonce, exp, mac: createHmac("sha256", ticketKey).update(canonical({ op, args, nonce, exp })).digest("base64url") };
  };
  const ready = send("init", { key: cfg.vault_key.toString("base64url"), ticket_key: ticketKey.toString("base64url"), ...(cfg.dir ? { dir: cfg.dir } : {}), ...(cfg.egress_dir ? { egress_dir: cfg.egress_dir } : {}) });

  return Object.freeze({
    ready,
    put: async (/** @type {any} */ a) => { await ready; return send("put", a); },
    meta: async (/** @type {any} */ a) => { await ready; return send("meta", a); },
    use: async (/** @type {any} */ a) => { await ready; return send("use", a, ticket("use", a)); },
    reveal: async (/** @type {any} */ a) => { await ready; return send("reveal", a, ticket("reveal", a)); },
    check: async (/** @type {any} */ a) => { await ready; return send("check", a); },
    stash: async (/** @type {any} */ a) => { await ready; return send("stash", a); },
    stashed: async (/** @type {any} */ a) => { await ready; return send("stashed", a); },
    endSession: async (/** @type {any} */ a) => { await ready; return send("endSession", a); },
    forget: async (/** @type {any} */ a) => { await ready; return send("forget", a); },
    stats: async () => { await ready; return send("stats", {}); },
    /** Send a raw request, with an optional hand-made ticket. For tests of the process's own refusals. */
    raw: async (/** @type {string} */ op, /** @type {any} */ args, /** @type {any} */ t) => { await ready; return send(op, args, t); },
    /** Mint a ticket for a call (kernel-internal). */
    ticket,
    close: () => new Promise(res => { if (dead) return res(undefined); child.once("exit", () => res(undefined)); child.stdin.end(); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }),
    kill: () => child.kill("SIGKILL"),
    pid: child.pid,
  });
}
