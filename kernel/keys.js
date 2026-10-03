// kernel/keys.js: the kernel's own secret and where it lives (K-3). The kernel seals its grants events, the chains it stores for jobs and the session tokens
// it hands out under one key. That key must not be a file the daemon's user can read: an assistant running as the same user could forge any of them. So it is
// DERIVED inside the sealing process (`kernel.mac`, keyed by the sealing master that only that process holds, one derivation per Space) and held in the
// daemon's memory for the life of the process; it is never written to disk. Where the sealing process cannot run safely (a desktop whose sealing master would be a
// file the same user reads, see kernel/seal `hostCheck`) the kernel refuses to start, unless a developer opts into a file key (`VYRE_KERNEL_FILE_KEY=1`), which
// is loud and never the default.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KernelError } from "./core/errors.js";

/** The kernel key for a Space, derived inside the sealing process. @param {{ kernel: { mac(i: { purpose: string, data: string }): Promise<string> } }} sealer @param {string} space @returns {Promise<Buffer>} */
export async function deriveKernelKey(sealer, space) {
  const mac = await sealer.kernel.mac({ purpose: "kernel-key-v1", data: space });
  if (typeof mac !== "string" || mac.length < 20) throw new KernelError("key_custody", "the sealing process gave no kernel key");
  return crypto.createHash("sha256").update("vyre-kernel-key-v1\n" + mac).digest();
}

/** The developer-only file key (the old behaviour): 0600, 32 bytes, made on first use. @param {string} dir */
export function fileKernelKey(dir) {
  const keyFile = path.join(dir, "kernel.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  if (key.length !== 32) throw new KernelError("key_custody", "the kernel key file is not 32 bytes");
  return key;
}
