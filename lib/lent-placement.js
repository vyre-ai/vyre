// @ts-check
// Where a chat's agent process runs: the home's placement book says (team/contracts/lent-spawn.md). The switchboard asks here; a lib file, so the module boundary stays as it was.

/**
 * The lender's spawn for a chat the home's book places on a computer (`where: "mac"`), or null: a chat with no row is the server's, and so is any Space this daemon is not the home of. The row's own person is the chat's own person.
 * @param {any} kernel the module's kernel handle @param {{ thread: string, chat: string | null, native: string }} q
 * @returns {((command: string, args: string[], env: any, cwd?: string, o?: any) => any) | null}
 */
export function lentSpawnFor(kernel, q) {
  /** @type {any} */ let host = null;
  try { host = kernel && typeof kernel.runnerHost === "function" ? kernel.runnerHost() : null; } catch { host = null; }
  const places = host && host.placements;
  if (!host || typeof host.lentSpawn !== "function" || !places) return null;
  for (const space of places.spaces()) {
    const row = [q.chat, q.native, q.thread].filter(Boolean).map(k => places.find(space, String(k))).find(Boolean);
    if (row && row.where === "mac") return (command, args, _env, _cwd, o) => host.lentSpawn(space, { session: row.session, chat: row.chat || q.chat || null, person: row.person, command, args, ...(o && o.signal ? { signal: o.signal } : {}) });
  }
  return null;
}
