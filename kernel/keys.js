// kernel/keys.js: the kernel's own secret and where it lives (K-3). The kernel seals its grants events, the chains it stores for jobs and the session tokens
// it hands out under one key. That key must not be a file the daemon's user can read: an assistant running as the same user could forge any of them. So it is
// NOT HELD at all: the grants store and the chain builder ask the sealing process to MAC and verify (`kernel.mac`, `kernel.verify`, kernel/core/seal.js), so the key never
// leaves it. Where the sealing process cannot run safely (a desktop whose sealing master would be a
// file the same user reads, see kernel/seal `hostCheck`) the kernel refuses to start, unless a developer opts into a file key (`VYRE_KERNEL_FILE_KEY=1`), which
// is loud and never the default.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KernelError } from "./core/errors.js";

/** The developer-only file key (the old behaviour): 0600, 32 bytes, made on first use. @param {string} dir */
export function fileKernelKey(dir) {
  const keyFile = path.join(dir, "kernel.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  if (key.length !== 32) throw new KernelError("key_custody", "the kernel key file is not 32 bytes");
  return key;
}
