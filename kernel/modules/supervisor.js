// kernel/modules/supervisor.js: K6, the module supervisor. A module that is not first party runs out of process under kernel/modules/sandbox.js:
// no network, no files beyond its own folder (read only), no child process, no worker. The supervisor starts it, speaks to it over its stdin and
// stdout, gives it no way out except `egress.request`, and proves the sandbox holds before it ever installs one: `selfTest` runs a probe under the
// same command line and requires every attempt (network, write, read outside, child process, worker) to fail. Without that proof `available()` is
// false and the kernel refuses to install such a module (kernel/modules/host.js). One live process per module; a call that takes too long kills it.
import { spawn as nodeSpawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { sandboxCommand, mechanism } from "./sandbox.js";
import { KernelError } from "../core/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALL_MS = 30_000;
/** @type {Map<string, any>} the passes of selfTest in this process */
const PROVEN = new Map();
const EXPECT = ["network", "write_module", "read_outside", "child_process", "worker", "read_passwd", "read_environ", "proc_listing", "root_listing", "signal_other", "dns", "dlopen", "env_extra"];

/**
 * @param {{ platform?: NodeJS.Platform, execPath?: string, spawn?: typeof nodeSpawn, egress?: { request(module: string, url: string, init?: any): Promise<any> }, callMs?: number }} [cfg]
 */
export function createSupervisor(cfg = {}) {
  const spawn = cfg.spawn || nodeSpawn;
  const callMs = cfg.callMs ?? CALL_MS;
  /** @type {{ ok: boolean, mechanism: string | null, results?: Record<string, string>, why?: string } | null} */ let proof = null;
  /** @type {Map<string, any>} */ const running = new Map();
  // What a self-test in progress holds (the probe, the sibling it must not signal, its listener): stopAll ends them, so a daemon that stops while its test is still running leaves nothing alive.
  /** @type {Set<() => void>} */ const probing = new Set();
  /** @type {Promise<any> | null} */ let testing = null;

  const api = {
    mechanism: () => mechanism(cfg.platform),
    /** True only after a self-test that saw every attempt blocked. */
    available: () => proof !== null && proof.ok === true,
    proof: () => proof,

    /** Run the probe under the real sandbox command and require every attempt to fail. Never throws: a sandbox that cannot start is simply not available. */
    /** The sandbox is proved once per process and mechanism: a second home in the same process (a test's, or a restart of the daemon in place) reuses a PASS rather than spend two seconds proving it again. A failure is never reused. */
    selfTest() {
      const key = `${cfg.platform}|${cfg.execPath || process.execPath}|${cfg.spawn ? "custom" : "node"}`;
      const done = cfg.spawn ? null : PROVEN.get(key);
      if (done) { proof = done; return Promise.resolve(proof); }
      const p = this.runSelfTest().then(r => { if (r && r.ok && !cfg.spawn) PROVEN.set(key, r); return r; });
      testing = p; p.finally(() => { if (testing === p) testing = null; }).catch(() => {});
      return p;
    },
    async runSelfTest() {
      const mech = mechanism(cfg.platform);
      if (!mech) { proof = { ok: false, mechanism: null, why: "no OS sandbox on this platform" }; return proof; }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sbx-"));
      const dir = path.join(tmp, "module"); fs.mkdirSync(dir);
      const secret = path.join(tmp, "secret.txt"); fs.writeFileSync(secret, "outside");
      let hits = 0;
      // A process the sandbox must not let the module signal or see.
      const sibling = spawn(cfg.execPath || process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      const srv = net.createServer(s => { hits++; s.destroy(); });
      const stopProbe = () => { try { sibling.kill("SIGKILL"); } catch { /* gone */ } try { srv.close(); } catch { /* closed */ } };
      probing.add(stopProbe);
      await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
      const port = /** @type {any} */ (srv.address()).port;
      try {
        const cmd = sandboxCommand({ platform: cfg.platform, execPath: cfg.execPath, dir, entry: "none.js", script: path.join(HERE, "probe.js"), args: [String(port), secret, String(sibling.pid)] });
        if (!cmd) throw new Error("no command");
        const out = await new Promise((resolve, reject) => {
          const c = spawn(cmd.cmd, cmd.args, { stdio: ["ignore", "pipe", "ignore"], env: {} });
          probing.add(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } });
          let buf = ""; const t = setTimeout(() => { c.kill("SIGKILL"); reject(new Error("probe timed out")); }, 15_000);
          c.stdout.on("data", d => { buf += d; });
          c.on("exit", () => { clearTimeout(t); try { resolve(JSON.parse(buf.trim().split("\n").pop() || "{}")); } catch { reject(new Error("probe gave no answer")); } });
          c.on("error", reject);
        });
        const results = /** @type {Record<string, string>} */ (out);
        const failures = EXPECT.filter(k => results[k] !== "blocked");
        if (hits > 0) failures.push("loopback_listener_was_reached");
        proof = failures.length ? { ok: false, mechanism: mech, results, why: `the sandbox let through: ${failures.join(", ")}` } : { ok: true, mechanism: mech, results };
      } catch (e) { proof = { ok: false, mechanism: mech, why: String(e && /** @type {any} */ (e).message) }; }
      finally { stopProbe(); probing.delete(stopProbe); fs.rmSync(tmp, { recursive: true, force: true }); }
      return proof;
    },

    /**
     * Start a module under the sandbox. Refuses unless the self-test passed.
     * @param {{ name: string, dir: string, entry: string, ctx?: (path: string[], args: any[], io: { push: (id: number, event: any) => void }) => Promise<any> }} m
     */
    async start(m) {
      if (!api.available()) throw new KernelError("supervisor_absent", "the module supervisor cannot prove its sandbox, so this module will not run");
      if (typeof m.ctx !== "function") m = { ...m, ctx: async () => { throw Object.assign(new Error("this module has no ctx here"), { code: "undeclared" }); } };
      if (running.has(m.name)) return running.get(m.name);
      const cmd = sandboxCommand({ platform: cfg.platform, execPath: cfg.execPath, dir: m.dir, entry: m.entry });
      if (!cmd) throw new KernelError("supervisor_absent", "no OS sandbox on this platform");
      const child = spawn(cmd.cmd, cmd.args, { stdio: ["pipe", "pipe", "ignore"], env: {} });
      /** @type {Map<number, { res: (v: any) => void, rej: (e: any) => void, t: NodeJS.Timeout }>} */ const pending = new Map();
      let n = 0, closed = false;
      /** @type {(v: any) => void} */ let ready = () => {};
      const readyP = new Promise((res, rej) => { ready = v => (v.ready ? res(v) : rej(new KernelError("module_failed", v.error || "the module did not start"))); setTimeout(() => rej(new KernelError("module_failed", "the module did not start in time")), 15_000).unref(); });
      const write = (/** @type {any} */ o) => { if (!closed) child.stdin.write(JSON.stringify(o) + "\n"); };
      readline.createInterface({ input: child.stdout }).on("line", async line => {
        let x; try { x = JSON.parse(line); } catch { return; }
        if (x.ready !== undefined) return ready(x);
        if (x.up !== undefined && x.op === "egress") {
          // The module asked for the outside world: the egress proxy decides, and the answer goes back down the same pipe.
          try { write({ down: x.up, ok: true, result: await cfg.egress?.request(m.name, x.url, x.init) }); }
          catch (e) { write({ down: x.up, ok: false, error: { code: /** @type {any} */ (e)?.code || "failed", message: "refused" } }); }
          return;
        }
        if (x.log !== undefined) { try { cfg.log?.(m.name, x.log, x.msg); } catch { /* a log line never stops a module */ } return; }
        if (x.up !== undefined && x.op === "ctx") {
          // A door of the module's ctx: the host's own ctx for this module answers (it holds every declaration), and the answer goes back down the same pipe.
          try { write({ down: x.up, ok: true, result: await m.ctx(x.path, x.args, { push: (/** @type {number} */ id, /** @type {any} */ event) => write({ ev: id, event }) }) }); }
          catch (e) { write({ down: x.up, ok: false, error: { code: /** @type {any} */ (e)?.code || "failed", message: String(/** @type {any} */ (e)?.message || "refused").slice(0, 200) } }); }
          return;
        }
        const p = pending.get(x.id); if (!p) return;
        pending.delete(x.id); clearTimeout(p.t);
        x.ok ? p.res(x.result) : p.rej(new KernelError(x.error?.code || "failed", String(x.error?.message || "the module failed")));
      });
      const fail = (/** @type {string} */ code) => { for (const p of pending.values()) { clearTimeout(p.t); p.rej(new KernelError(code, "the module stopped")); } pending.clear(); };
      child.on("exit", () => { closed = true; running.delete(m.name); fail("module_down"); });
      child.stdin.on("error", () => {});
      const handle = Object.freeze({
        name: m.name,
        ready: readyP,
        call: (/** @type {string} */ method, /** @type {any} */ input, /** @type {any} */ meta) => new Promise((res, rej) => {
          if (closed) return rej(new KernelError("module_down", "the module is not running"));
          const id = ++n, t = setTimeout(() => { pending.delete(id); child.kill("SIGKILL"); rej(new KernelError("timeout", "the module took too long and was stopped")); }, callMs);
          pending.set(id, { res, rej, t });
          write({ id, op: "call", method, input, ...(meta ? { meta } : {}) });
        }),
        stop: () => new Promise(res => { if (closed) return res(undefined); child.once("exit", () => res(undefined)); child.stdin.end(); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }),
        pid: child.pid,
      });
      running.set(m.name, handle);
      try { await readyP; } catch (e) { await handle.stop(); throw e; }
      return handle;
    },
    stopAll: async () => {
      for (const end of probing) end();
      probing.clear();
      await Promise.all([...running.values()].map(h => h.stop()));
      if (testing) await testing.catch(() => {});
    },
  };
  return Object.freeze(api);
}
