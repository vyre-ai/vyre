// @ts-check
// Runs reader.js inside the session's sandbox and parses what it hands out (see reader.js for why).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { plan, launch } from "./sandbox.js";
import { ensureLauncher, prepare as prepareWin } from "./sandbox-win.js";

const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), "reader.js");

export const LIMITS = { maxBytes: 100 * 1024 * 1024, maxFiles: 20000, maxTotal: 512 * 1024 * 1024, deadlineMs: 120_000 };

/**
 * @param {{ platform: "darwin"|"linux"|"win32", space: string, work: string, base: string, node?: string, home?: string, limits?: Partial<typeof LIMITS> }} o
 * @returns {(req: { roots: { dir: string, remote: string }[], have: Record<string, { hash: string, size: number, mtimeMs: number }>, maxBytes?: number }, onFile: (f: { rel: string, hash: string, size: number, len: number, mtimeMs: number, bytes: Buffer|null }) => Promise<void>) => Promise<{ truncated: boolean }>}
 */
export function sandboxReader(o) {
  const node = o.node || process.execPath;
  const lim = { ...LIMITS, ...(o.limits || {}) };
  return (req, onFile) => new Promise((resolve, reject) => {
    let launcher;
    if (o.platform === "win32") { launcher = ensureLauncher(path.join(o.base, "bin")); prepareWin({ launcher, space: o.space, workspace: o.work, readOnly: [path.dirname(node), path.dirname(READER)] }); }
    const p = plan({ platform: o.platform, space: o.space, launcher, workspace: o.work, command: node, args: [READER], readOnly: [path.dirname(node), path.dirname(READER)], proxy: { port: 1, socket: "" }, home: o.home, env: {} });
    const child = launch(p);
    let err = "", buf = Buffer.alloc(0), received = 0, truncated = false, done = false, chain = Promise.resolve();
    const fail = e => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} reject(e); };
    // A reader that runs too long, or sends more than its caps allow, is killed: a hostile session cannot stall or exhaust the runner.
    const timer = setTimeout(() => fail(new Error("the workspace reader took too long")), lim.deadlineMs);
    child.stderr.on("data", d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    child.on("error", fail);
    const drain = () => {
      for (;;) {
        if (!buf.length) return;
        if (buf[0] === 0x45) { truncated = false; return finish(); }
        if (buf[0] === 0x54) { truncated = true; return finish(); }
        if (buf[0] !== 0x48) return fail(new Error("the workspace reader sent something unexpected"));
        const nl = buf.indexOf(0x0a);
        if (nl < 0) { if (buf.length > 8192) return fail(new Error("the workspace reader sent a header that is too long")); return; }
        let h; try { h = JSON.parse(buf.subarray(2, nl).toString()); } catch { return fail(new Error("the workspace reader sent a bad header")); }
        if (h.send && (h.size < 0 || h.size > lim.maxBytes)) return fail(new Error("the workspace reader sent a file over the cap"));
        if (buf.length < nl + 1 + (h.send ? h.size : 0)) return;
        const bytes = h.send ? Buffer.from(buf.subarray(nl + 1, nl + 1 + h.size)) : null;
        buf = buf.subarray(nl + 1 + (h.send ? h.size : 0));
        const f = { rel: h.rel, hash: h.hash, size: h.send ? h.size : 0, len: h.len, mtimeMs: h.mtimeMs, bytes };
        chain = chain.then(() => onFile(f));      // handled one at a time, as each is framed: nothing accumulates
        chain.catch(fail);
      }
    };
    const finish = () => { if (done) return; done = true; clearTimeout(timer); chain.then(() => resolve({ truncated }), reject); };
    child.stdout.on("data", d => {
      received += d.length;
      if (received > lim.maxTotal + lim.maxFiles * 512) return fail(new Error("the workspace reader sent more than its cap"));
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      drain();
    });
    child.on("close", code => { if (!done) { if (buf.length && (buf[0] === 0x45 || buf[0] === 0x54)) return drain(); fail(new Error("the workspace reader ended early" + (code ? `: ${err.trim().slice(0, 200)}` : ""))); } });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...req, maxBytes: req.maxBytes ?? lim.maxBytes, maxFiles: lim.maxFiles, maxTotal: lim.maxTotal }));
  });
}
