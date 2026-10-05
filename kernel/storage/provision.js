// kernel/storage/provision.js: a Space's own Drive (versions, conflicts, backups): the pool under `<dir>/drive`, its chunks encrypted under a pool key that belongs to THIS Space only, one directory node on the home that
// serves it; other nodes (a bucket, a computer's folder) attach later (core/wink/storage/pool.js). The home Space and every Space the home hosts get one the same way, so a hosted Space's files are its own and no
// other Space's key opens them: with the sealing process the key is `sealer.poolKey({ owner: <space> })` (derived per owner from the sealing process's master), and with a file-held kernel key (no sealing
// process) it is derived from that Space's own key.
import crypto from "node:crypto";
import path from "node:path";
import { Pool } from "./pool.js";
import { Drive } from "./drive.js";
import { dirBackend } from "./backends.js";

/**
 * @param {{ dir: string, space: string, sealer?: { poolKey(i: { owner: string }): Promise<Buffer> } | null, kernelKey?: Buffer | null }} o
 * @returns {Promise<Drive | null>} null when this Space has neither a sealing process nor a kernel key to derive a pool key from
 */
export async function provisionDrive({ dir, space, sealer, kernelKey }) {
  /** @type {Buffer | null} */ let key = null;
  if (sealer && typeof sealer.poolKey === "function") key = await sealer.poolKey({ owner: space });
  else if (kernelKey && kernelKey.length === 32) key = Buffer.from(crypto.hkdfSync("sha256", kernelKey, space, "vyre pool key v1", 32));
  if (!key) return null;
  const pool = new Pool({ dir: path.join(dir, "drive"), key });
  pool.addNode({ id: "home", backend: dirBackend(path.join(dir, "drive", "node")), home: true });
  return new Drive(pool);
}
