// @ts-check
// Where a chat's run works when the chat names no folder (a team chat never does). On a box the spawner starts a session only under the shared work folder (or an account's own home), so the chat's folder
// is there, one per Space and chat, open to the group the sessions share; anywhere else it is under the stream module's own folder, as before.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { workDir } from "../config/index.js";

/**
 * @param {{ root: string, role?: string, space?: string | null, grp: string }} o `root`: the stream module's own folder; `role`: the machine's role; `space`: the team Space the chat belongs to (none: the home's)
 * @returns {string} the folder, made
 */
export function chatFolderFor(o) {
  const work = workDir();
  if (o.role === "box" && fs.existsSync(work)) {
    // CONTAINMENT, not enforcement: every session account shares the work folder's group, so the group can walk through /work/chats and /work/chats/<space> but not list them (mode 0710), and a chat's folder is
    // named by a keyed hash of its id (the key stays in the stream's own folder, out of every account's reach): a session that was not given the path cannot find another chat's folder. A session that learned
    // the path can still use it; the per-chat group made by the spawner is the real fix (BACKLOG 0.3.4).
    const name = hidden(String(o.root), o.grp);
    const space = o.space || "home";
    const dirs = [[path.join(work, "chats"), 0o2710], [path.join(work, "chats", space), 0o2710], [path.join(work, "chats", space, name), 0o2770], [path.join(work, "chats", space, name, "work"), 0o2770]];
    for (const [d, mode] of dirs) {
      fs.mkdirSync(d, { recursive: true });
      // (setgid keeps the work folder's group on what is made inside: without it the sessions' group is shut out of the parents, as the first walk with the sandbox on showed)
      try { fs.chownSync(d, -1, fs.statSync(work).gid); } catch { /* the group is already the work folder's, or not ours to set */ }
      try { fs.chmodSync(d, mode); } catch { /* not ours to change: it is open already, or the run says so */ }
    }
    return dirs[dirs.length - 1][0];
  }
  const d = path.join(String(o.root), "chats", o.grp, "work");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A chat's folder name: a keyed hash of its id, the key made once in the stream's own folder (0600). @param {string} root @param {string} grp */
function hidden(root, grp) {
  const file = path.join(root, "chat-folder.key");
  let key;
  try { key = fs.readFileSync(file); } catch {
    fs.mkdirSync(root, { recursive: true });
    key = crypto.randomBytes(32);
    try { fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" }); } catch { key = fs.readFileSync(file); }
  }
  return crypto.createHmac("sha256", key).update(grp).digest("hex").slice(0, 24);
}
