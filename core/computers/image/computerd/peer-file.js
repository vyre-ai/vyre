// @ts-check
// peer-file: computerd tells agentd's screen relay which address is vyred. The pin lives in computerd's gate; the relay is another process under another uid, so the pinned
// address is written to a file the relay can read (not a secret: an address) and no agent can change (owned by vyre, 0644, in a folder only vyre can write to).

import fs from "node:fs";
import path from "node:path";
import { plainAddr } from "./gate.js";

export const PEER_FILE = "/var/lib/vyre/vyred-peer";

/** Write the pinned address when it is new. Never throws: a failed write leaves the relay refusing everyone, which is the safe side. @param {string | null} addr @param {string} [file] */
export function publishPeer(addr, file = PEER_FILE) {
  if (!addr) return false;
  const want = plainAddr(addr);
  try {
    if (fs.readFileSync(file, "utf8").trim() === want) return true;
  } catch { /* none yet */ }
  try {
    const tmp = path.join(path.dirname(file), `.vyred-peer.${process.pid}`);
    fs.writeFileSync(tmp, `${want}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
