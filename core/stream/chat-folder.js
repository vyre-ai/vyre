// @ts-check
// Where a chat's run works when the chat names no folder (a team chat never does). On a box the spawner starts a session only under the shared work folder (or an account's own home), so the chat's folder
// is there, one per Space and chat, open to the group the sessions share; anywhere else it is under the stream module's own folder, as before.
import fs from "node:fs";
import path from "node:path";
import { workDir } from "../config/index.js";

/**
 * @param {{ root: string, role?: string, space?: string | null, grp: string }} o `root`: the stream module's own folder; `role`: the machine's role; `space`: the team Space the chat belongs to (none: the home's)
 * @returns {string} the folder, made
 */
export function chatFolderFor(o) {
  const work = workDir();
  if (o.role === "box" && fs.existsSync(work)) {
    const dirs = [path.join(work, "chats"), path.join(work, "chats", o.space || "home"), path.join(work, "chats", o.space || "home", o.grp), path.join(work, "chats", o.space || "home", o.grp, "work")];
    for (const d of dirs) {
      fs.mkdirSync(d, { recursive: true });
      try { fs.chmodSync(d, 0o2775); } catch { /* not ours to change: it is open already, or the run says so */ }
    }
    return dirs[dirs.length - 1];
  }
  const d = path.join(String(o.root), "chats", o.grp, "work");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
