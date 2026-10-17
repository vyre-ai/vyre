// @ts-check
// Who finished the first adoption of this server, and when. The pairing module writes it once, at the first adopt; the vault reads it (synchronously, from presence.when) to decide whether the
// space's own vault key may be made without a fresh approval: only by that device, only within ten minutes, only before any vault exists. The file lives in the server's private root; no call input reaches it.

import fs from "node:fs";
import path from "node:path";

export const FIRST_ADOPT_MS = 10 * 60_000;
const fileOf = (/** @type {string} */ root) => path.join(root, "identity", "first-adopt.json");

/** @param {string} root @param {string} device `device:<id>`, as the registry names a paired session @param {number} [at] */
export function noteFirstAdopt(root, device, at = Date.now()) {
  const file = fileOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ v: 1, device: String(device), at }) + "\n", { mode: 0o600 });
}

/** @param {string} root */
export function clearFirstAdopt(root) { try { fs.rmSync(fileOf(root), { force: true }); } catch { /* none */ } }

/** @param {string} root @returns {{ device: string, at: number } | null} */
export function firstAdoptOf(root) {
  try {
    const row = JSON.parse(fs.readFileSync(fileOf(root), "utf8"));
    if (!row || typeof row.device !== "string" || !row.device.startsWith("device:") || !Number.isFinite(row.at)) return null;
    return { device: row.device, at: Number(row.at) };
  } catch { return null; }
}

/**
 * May this call make the space's vault key with no fresh approval? The caller is the device that completed the first adoption (the registry's verified name for it), within the window, for this server's
 * own space. `vaultExists` is decided by the caller of this function from the vault itself.
 * @param {{ root: string, caller: string, space: string, ownSpace: string, now?: number }} q
 */
export function firstRunMayCreate(q) {
  if (!q.root || !q.ownSpace || q.space !== q.ownSpace) return false;
  const seen = firstAdoptOf(q.root);
  const now = q.now ?? Date.now();
  return Boolean(seen && q.caller === seen.device && now >= seen.at && now - seen.at <= FIRST_ADOPT_MS);
}
