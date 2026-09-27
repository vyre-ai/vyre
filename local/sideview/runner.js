// @ts-check
// runner: one vyre-tile run per request. The helper answers one JSON line and exits, so nothing
// of the side view is alive between calls.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { responsibleApp, grantMessage } from "../screen-mac/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BIN = path.join(HERE, "bin", "vyre-tile");
export const BUILD = path.join(HERE, "build.sh");

export class SideviewError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {{ bin?: string, timeoutMs?: number, platform?: string, env?: NodeJS.ProcessEnv, responsible?: () => string }} [o]
 * @returns {{ request: (req: Record<string, unknown>) => Promise<any> }}
 */
export function makeTile({ bin = DEFAULT_BIN, timeoutMs = 5000, platform = process.platform, env = process.env, responsible = responsibleApp } = {}) {
  return {
    request: req => new Promise((ok, no) => {
      if (platform !== "darwin") return no(new SideviewError("unsupported", "the side view works only on macOS"));
      if (!fs.existsSync(bin)) return no(new SideviewError("not_built", `the side view helper is not built; run ${BUILD}`));
      const c = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env });
      let buf = "", done = false;
      const finish = (/** @type {any} */ err, /** @type {any} */ val) => {
        if (done) return; done = true; clearTimeout(timer);
        if (err) no(err); else ok(val);
      };
      const timer = setTimeout(() => { c.kill("SIGKILL"); finish(new SideviewError("timeout", `the side view helper did not answer within ${timeoutMs} ms`)); }, timeoutMs);
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", d => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i < 0) return;
        let body;
        try { body = JSON.parse(buf.slice(0, i)); } catch { return finish(new SideviewError("helper_failed", "the side view helper said something that is not JSON")); }
        if (body.error) {
          if (body.code === "not_trusted") return finish(new SideviewError("not_trusted", grantMessage(responsible())));
          return finish(new SideviewError(body.code || "helper_failed", String(body.error)));
        }
        finish(null, body);
      });
      c.stderr.resume();
      c.stdin.on("error", () => {});
      c.on("error", e => finish(new SideviewError("helper_failed", e.message)));
      c.on("close", code => finish(new SideviewError("helper_failed", `the side view helper exited (${code}) without answering; rebuild it with ${BUILD}`)));
      c.stdin.end(JSON.stringify(req) + "\n");
    }),
  };
}
