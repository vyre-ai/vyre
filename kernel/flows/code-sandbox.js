// @ts-check
// kernel/flows/code-sandbox.js: the `sandbox` port of the Flow runner (a Code step, kind `fn`). One OS-sandboxed Node process per call, built from the module sandbox's own command line
// (kernel/modules/sandbox.js: no network, a bare file view, no child process, no worker, a heap cap), with the step's source and inputs as read-only files in a fresh folder, a wall-clock
// limit that kills the process, and a cap on what it may print. It is refused unless the module supervisor's self-test has shown the sandbox holds on this machine: no proof, no run.
// Declared `needs` are powers the sandbox has none of, so a step that names one is refused rather than run without it.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxCommand } from "../modules/sandbox.js";
import { createSupervisor } from "../modules/supervisor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_OUT = 256 * 1024;
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ timeoutMs?: number, platform?: NodeJS.Platform, execPath?: string, spawn?: typeof nodeSpawn, supervisor?: { selfTest(): Promise<any>, available(): boolean, proof(): any } }} [o]
 * @returns {(req: { language: string, source: string, hash: string, inputs: any, outputs: string[], needs: string[] }) => Promise<{ outputs: Record<string, any> }>}
 */
export function createCodeSandbox(o = {}) {
  const timeoutMs = o.timeoutMs ?? 5000;
  const spawn = o.spawn || nodeSpawn;
  const supervisor = o.supervisor || createSupervisor({ platform: o.platform, execPath: o.execPath });
  /** @type {Promise<any> | null} */ let proved = null;
  const prove = () => (proved ||= (supervisor.available() ? Promise.resolve(supervisor.proof()) : supervisor.selfTest()));

  return async req => {
    if (req.language !== "js") throw fail("bad_input", "only js code runs");
    if (req.needs && req.needs.length) throw fail("unavailable", `the code sandbox grants no powers (${req.needs.join(", ")}), so this step cannot run`);
    const p = await prove();
    if (!p || p.ok !== true) throw fail("unavailable", `this machine cannot prove a code sandbox (${(p && p.why) || "no proof"}), so a Code step does not run`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-code-"));
    try {
      const dir = path.join(tmp, "module"); fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "source.txt"), req.source);
      fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify(req.inputs ?? null));
      const probe = sandboxCommand({ platform: o.platform, execPath: o.execPath, dir, entry: "source.txt", script: path.join(HERE, "code-child.js"), args: [] });
      if (!probe) throw fail("unavailable", "no OS sandbox on this platform");
      // inside bwrap the folder is /module; under the macOS profile it is the real path
      const inside = probe.mechanism === "bwrap" ? "/module" : fs.realpathSync(dir);
      const cmd = sandboxCommand({ platform: o.platform, execPath: o.execPath, dir, entry: "source.txt", script: path.join(HERE, "code-child.js"), args: [inside] });
      if (!cmd) throw fail("unavailable", "no OS sandbox on this platform");
      const line = await new Promise((resolve, reject) => {
        const c = spawn(cmd.cmd, cmd.args, { stdio: ["ignore", "pipe", "ignore"], env: {} });
        let buf = "", over = false, done = false;
        const end = (/** @type {() => void} */ f) => { if (done) return; done = true; clearTimeout(t); f(); };
        const t = setTimeout(() => { c.kill("SIGKILL"); end(() => reject(fail("timeout", `the code ran longer than ${timeoutMs} ms and was stopped`))); }, timeoutMs);
        c.stdout.on("data", d => { buf += d; if (buf.length > MAX_OUT) { over = true; c.kill("SIGKILL"); } });
        c.on("error", e => end(() => reject(fail("unavailable", `the code sandbox did not start: ${e.message}`))));
        c.on("exit", (code, sig) => end(() => over ? reject(fail("bad_output", "the code printed too much"))
          : sig ? reject(fail("failed", `the code was stopped (${sig}), most likely out of memory`)) : resolve(buf.trim().split("\n").pop() || "")));
      });
      let r; try { r = JSON.parse(String(line)); } catch { throw fail("failed", "the code gave no answer (it may have run out of memory)"); }
      if (!r.ok) throw fail("failed", `the code failed: ${r.error}`);
      return { outputs: r.outputs };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}
