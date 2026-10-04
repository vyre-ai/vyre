// @ts-check
// own-folder: a plain model session (a bare `mcp` or `harness`, no agent behind it, or one Vyre started with no agent) counts a file operation as its own work only inside the folder it runs in. The folder
// is what vyred measured, never what the call says: the thread's own cwd (a session Vyre started) or meta.peerCwd (the kernel's reading of the Claude process that connected). No folder known: nowhere.
import fs from "node:fs";

/** Is this call a plain model session's (no named agent)? @param {any} meta */
export const isPlainModel = meta => /^(mcp|harness)(?::thread:.+)?$/.test(String((meta && meta.caller) || "")) && !(meta && meta.agent);

/** The folder this plain session runs in, or null. @param {any} ctx @param {any} meta @returns {Promise<string | null>} */
export async function sessionFolder(ctx, meta) {
  if (meta && typeof meta.peerCwd === "string" && meta.peerCwd) return meta.peerCwd;
  if (meta && typeof meta.thread === "string" && meta.thread) {
    try { const r = await ctx.call("threads.get", { thread: meta.thread, limit: 1 }); const c = r && r.data && r.data.thread && r.data.thread.cwd; return typeof c === "string" && c ? c : null; } catch { return null; }
  }
  return null;
}

/** Is `p` (followed through every link) inside the folder `dir` (also followed)? A path that does not resolve is not. @param {string} p @param {string | null} dir */
export function insideFolder(p, dir) {
  if (!dir) return false;
  try {
    const real = fs.realpathSync(p), base = fs.realpathSync(dir).replace(/\/+$/, "");
    return real === base || real.startsWith(base + "/");
  } catch { return false; }
}
