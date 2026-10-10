// @ts-check
// Where a chat's agent process runs: the home's placement book says (team/contracts/lent-spawn.md). The switchboard asks here; a lib file, so the module boundary stays as it was.

/**
 * The lender's spawn for a chat the home's book places on a computer (`where: "mac"`), or null: a chat with no row is the server's, and so is any Space this daemon is not the home of. The row's own person is the chat's own
 * person. A chat that is being created (`fresh`) and has no row is placed once, now: a ready computer of the owner's gets the row (`placeNew`), none ready leaves it on the box.
 * @param {any} kernel the module's kernel handle @param {{ thread: string, chat: string | null, native: string, title?: string | null, fresh?: boolean, asker?: string | null }} q
 * @returns {Promise<((command: string, args: string[], env: any, cwd?: string, o?: any) => any) | null>}
 */
export async function lentSpawnFor(kernel, q) {
  /** @type {any} */ let host = null;
  try { host = kernel && typeof kernel.runnerHost === "function" ? kernel.runnerHost() : null; } catch { host = null; }
  const places = host && host.placements;
  if (!host || typeof host.lentSpawn !== "function" || !places) return null;
  const title = q.title ? { title: String(q.title).slice(0, 120) } : {};
  const find = () => { for (const space of places.spaces()) { const row = [q.chat, q.native, q.thread].filter(Boolean).map(k => places.find(space, String(k))).find(Boolean); if (row) return { space, row }; } return null; };
  let hit = find();
  // A new chat of the home's owner, once: the first start is its creation. The session id is the thread's own id: it must equal the thread the switchboard opens its socket under, because the home finds the route to Vyre's tools by it (contracts/lent-spawn.md). Another person's chat, or one that already ran, is never placed here.
  const owner = kernel.owner || (kernel.id && kernel.id.owner);
  if (!hit && q.fresh && typeof host.placeNew === "function" && owner && (!q.asker || q.asker === owner)) {
    const space = host.space || (kernel.id && kernel.id.space);
    if (space) {
      const placed = await host.placeNew(space, { session: q.thread, chat: q.chat || undefined, person: owner }).catch(() => null);
      if (placed && placed.where === "mac") hit = find();
    }
  }
  if (!hit || hit.row.where !== "mac") return null;
  const { space, row } = hit;
  return (command, args, _env, _cwd, o) => host.lentSpawn(space, { session: row.session, thread: q.thread, chat: row.chat || q.chat || null, ...title, person: row.person, command, args, ...(o && o.signal ? { signal: o.signal } : {}) });
}

/**
 * What the chat says while its process starts on the computer: `thread.placing { state: "starting" | "up" | "fallback", computer?, reason? }`. The words are the app's; a fallback means nothing ran there and the box runs it.
 * @param {(command: string, args: string[], env: any, cwd?: string, o?: any) => any} spawn @param {(state: string, extra?: any) => void} say
 */
export function saysPlacing(spawn, say) {
  return (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ env, /** @type {any} */ cwd, /** @type {any} */ o) => {
    const proc = spawn(command, args, env, cwd, o);
    const said = (/** @type {string} */ state, /** @type {any} */ extra = {}) => { try { say(state, extra); } catch { /* a notice, never a stop */ } };
    const computer = () => (proc && proc.lent && proc.lent.computer ? { computer: String(proc.lent.computer) } : {});
    if (proc && typeof proc.on === "function") {
      said("starting", computer());
      proc.on("spawn", () => said("up", computer()));
      proc.on("error", (/** @type {any} */ e) => { if (e && e.code === "lent_unavailable") said("fallback", { ...computer(), reason: "unavailable" }); });
    }
    return proc;
  };
}

/**
 * The lent spawn for a switchboard session: the chat's own placement decides (only a row that says `mac` lends the process; a new chat of the owner is placed once at creation), a claude session only, and the chat says
 * what happens while it starts. Where nothing is lent, or anything fails, the session starts on the box as it always did.
 * @param {any} sb the switchboard @param {string} id the thread @param {any} rec its record
 */
export async function lentOf(sb, id, rec) {
  if (!sb.deps.lentFor || (rec && rec.provider && rec.provider !== "claude")) return undefined;
  try {
    const spawn = await sb.deps.lentFor({ thread: id, chat: sb.chatOf(id), native: sb.nativeOf(id), title: rec && rec.name ? String(rec.name) : null, fresh: !(Number(rec && rec.turns) > 0), asker: sb.turnAsker.get(id) || null });
    return spawn ? saysPlacing(spawn, (state, extra) => sb.emit("thread.placing", { thread: id, state, ...extra }, id, rec && rec.project)) : undefined;
  } catch { return undefined; }
}
