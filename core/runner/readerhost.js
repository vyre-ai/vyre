// @ts-check
// Runs reader.js inside the session's sandbox and parses what it hands out (see reader.js for why).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { plan, launch } from "./sandbox.js";
import { ensureLauncher, prepare as prepareWin } from "./sandbox-win.js";

const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), "reader.js");

/**
 * @param {{ platform: "darwin"|"linux"|"win32", space: string, work: string, base: string, node?: string, home?: string }} o
 * @returns {(req: { roots: { dir: string, remote: string }[], have: Record<string, string>, maxBytes: number }) => Promise<{ rel: string, hash: string, size: number, bytes: Buffer|null }[]>}
 */
export function sandboxReader(o) {
  const node = o.node || process.execPath;
  return req => new Promise((resolve, reject) => {
    let launcher;
    if (o.platform === "win32") { launcher = ensureLauncher(path.join(o.base, "bin")); prepareWin({ launcher, space: o.space, workspace: o.work, readOnly: [path.dirname(node), path.dirname(READER)] }); }
    const p = plan({ platform: o.platform, space: o.space, launcher, workspace: o.work, command: node, args: [READER], readOnly: [path.dirname(node), path.dirname(READER)], proxy: { port: 1, socket: "" }, home: o.home, env: {} });
    const child = launch(p);
    /** @type {Buffer[]} */ const chunks = []; let err = "";
    child.stdout.on("data", d => chunks.push(d)); child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("close", code => {
      const buf = Buffer.concat(chunks), out = [];
      let i = 0;
      while (i < buf.length) {
        if (buf[i] === 0x45) break;                                   // "E": end
        if (buf[i] !== 0x48) return reject(new Error("the workspace reader sent something unexpected"));
        const nl = buf.indexOf(0x0a, i); if (nl < 0) return reject(new Error("the workspace reader was cut off"));
        const h = JSON.parse(buf.subarray(i + 2, nl).toString());
        i = nl + 1;
        if (h.send) { if (i + h.size > buf.length) return reject(new Error("the workspace reader was cut off")); out.push({ rel: h.rel, hash: h.hash, size: h.size, bytes: Buffer.from(buf.subarray(i, i + h.size)) }); i += h.size; }
        else out.push({ rel: h.rel, hash: h.hash, size: 0, bytes: null });
      }
      if (code !== 0 && !out.length) return reject(new Error("the workspace reader failed: " + err.trim().slice(0, 200)));
      resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(req));
  });
}
