// @ts-check
// lib/mac-runtime: the Mac server's Colima VM is sized by the account's own `vyre-runtime` helper (scripts/install-mac-server.sh puts it in ~/.vyre-server/bin; the formula
// lives only there): 2 GiB plus 2.5 GiB per space, capped at half the Mac's RAM, 2 CPUs (4 on 8 or more cores), 40 GiB of sparse disk. This is the thin caller space setup uses.
//   const room = await roomFor(3);          // { ok, spaces, cpus, memory_gib, max_spaces, message }
//   if (!room.ok) tell the person room.message and offer their server
//   await makeRoom(3, { onProgress });      // prints "Making room for a new space" through onProgress, restarts Colima at the new size
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** @param {Record<string, string | undefined>} [env] */
export const helperPath = (env = process.env) => path.join(env.VYRE_SERVER_DIR || path.join(env.HOME || os.homedir(), ".vyre-server"), "bin", "vyre-runtime");

/** @param {string} file @param {string[]} args @param {Record<string, string | undefined>} env @param {number} timeout @returns {Promise<{ code: number, out: string }>} */
function run(file, args, env, timeout) {
  return new Promise(resolve => {
    execFile(file, args, { env: /** @type {any} */ (env), timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (/** @type {any} */ (err)).code === "number" ? /** @type {any} */ (err).code : 1) : 0;
      resolve({ code, out: String(stdout || "") + (err && !stdout ? String(stderr || "") : "") });
    });
  });
}

/** The JSON object on the last line that holds one. @param {string} out */
function lastJson(out) {
  for (const line of out.split("\n").reverse()) { const t = line.trim(); if (t.startsWith("{")) { try { return JSON.parse(t); } catch { /* keep looking */ } } }
  return null;
}

/**
 * Whether this Mac can host `spaces` spaces (a read: nothing changes).
 * @param {number} spaces @param {{ env?: Record<string, string | undefined> }} [o]
 * @returns {Promise<{ ok: boolean, spaces: number, cpus: number, memory_gib: number, max_spaces: number, message: string }>}
 */
export async function roomFor(spaces, { env = process.env } = {}) {
  const r = await run(helperPath(env), ["room", String(spaces)], env, 15_000);
  const j = lastJson(r.out);
  if (!j) return { ok: false, spaces, cpus: 0, memory_gib: 0, max_spaces: 0, message: "This Mac's runtime could not be asked how much room it has. Put this space on your server instead." };
  return j;
}

/**
 * Make room for `spaces` spaces: resize the VM (a short restart). `onProgress` gets "Making room for a new space" when the restart begins.
 * @param {number} spaces @param {{ env?: Record<string, string | undefined>, onProgress?: (line: string) => void }} [o]
 * @returns {Promise<{ ok: boolean, message: string, memory_gib?: number, max_spaces?: number }>}
 */
export async function makeRoom(spaces, { env = process.env, onProgress = () => {} } = {}) {
  const r = await run(helperPath(env), ["resize", String(spaces)], env, 300_000);
  for (const line of r.out.split("\n")) if (line.startsWith("Making room")) onProgress(line.trim());
  const j = lastJson(r.out);
  if (!j) return { ok: false, message: "This Mac could not make room for a new space. Put it on your server instead." };
  return { ok: Boolean(j.ok) && r.code === 0, message: String(j.message || ""), memory_gib: j.memory_gib, max_spaces: j.max_spaces };
}
