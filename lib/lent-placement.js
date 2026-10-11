// @ts-check
// Where a chat's agent process runs: the home's placement book says (team/contracts/lent-spawn.md). The switchboard asks here; a lib file, so the module boundary stays as it was.

/**
 * The lender's spawn for a chat the home's book places on a computer (`where: "mac"`), or null: a chat with no row is the server's, and so is any Space this daemon is not the home of. The row's own person is the chat's own
 * person. A chat that is being created (`fresh`) and has no row is placed once, now: a ready computer of the person who starts it gets the row (`placeNew`), none ready leaves it on the box. A turn by anyone but the row's person never runs on that person's computer.
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
  // A new chat of the person who starts it, once: the first start is its creation. The session id is the thread's own id: it must equal the thread the switchboard opens its socket under, because the home finds the route to Vyre's tools by it (contracts/lent-spawn.md). Another person's chat, or one that already ran, is never placed here.
  // The turn's person (the first person hop on the call's chain; a call with none runs on the box) is the only one whose computer may run it: a session runs on its own person's computer or on the box,
  // never on someone else's (the product ruling of 10 Oct). A new chat is placed once, for the person who starts it.
  const asker = q.asker || null;   // no person named is never the owner: such a session (an agent's duty, a Flow's thread, a watcher) runs on the box
  if (!hit && q.fresh && typeof host.placeNew === "function" && asker) {
    const space = host.space || (kernel.id && kernel.id.space);
    if (space) {
      const placed = await host.placeNew(space, { session: q.thread, chat: q.chat || undefined, person: asker, ...(q.folder ? { folder: q.folder } : {}) }).catch(e => { if (q.folder) throw e; return null; });
      if (placed && placed.where === "mac") hit = find();
    }
  }
  if (!hit || hit.row.where !== "mac") return null;
  if (!asker || !samePerson(q, hit.row.person, asker)) return null;   // another person's turn in a chat placed on someone's computer runs on the box
  const { space, row } = hit;
  return (command, args, _env, _cwd, o) => host.lentSpawn(space, { session: row.session, thread: q.thread, chat: row.chat || q.chat || null, ...(q.folder ? { folder: q.folder } : {}), ...title, person: row.person, command, args, ...(o && o.signal ? { signal: o.signal } : {}) });
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
    const spawn = await sb.deps.lentFor({ thread: id, chat: sb.chatOf(id), native: sb.nativeOf(id), title: rec && rec.name ? String(rec.name) : null, fresh: !(Number(rec && rec.turns) > 0), asker: sb.turnAsker.get(id) || null, canon: sb.canon ? (/** @type {string} */ x) => sb.canon(x) : undefined });
    return spawn ? saysPlacing(spawn, (state, extra) => sb.emit("thread.placing", { thread: id, state, ...extra }, id, rec && rec.project)) : undefined;
  } catch { return undefined; }
}

/**
 * The session's process ended because the chat moved to the server (the lender handed it over, or the home took it: contracts/lent-spawn.md): the lender's last whole turn is already this chat's transcript here, so the session
 * starts again on the server with `resume`, and a turn that was cut is sent again from its start (the prompt the session was waiting on). A turn that had finished is not repeated. Anything that goes wrong ends the thread as an exit would have.
 * @param {any} sb the switchboard @param {string} id the thread @param {any} st its live state
 */
export async function carryOn(sb, id, st) {
  const cut = st.turn && st.lastPrompt ? String(st.lastPrompt) : "";
  st.switching = true; // this is not an end: the thread carries on
  try {
    const rec = sb.record(id);
    const launch = st.launch || {};
    sb.spawn(id, { ...launch, libraryPlugin: await sb.libraryPlugin(rec, launch), sandboxSpawn: await sb.sandboxFor(id, rec, launch), lentSpawn: await lentOf(sb, id, rec), gitEnv: await sb.gitEnv(rec && rec.project, id), resume: true, lastPrompt: cut || null });
    if (cut) sb.write(id, cut);
    sb.emit("thread.text", { message: "vyre", text: "This chat is carrying on on your server.", done: true, notice: true }, id, rec ? rec.project : null);
    // another person's message that waited while the chat came back is the next turn now: nothing else would hand it over, the chat is idle
    const fresh = sb.live.get(id);
    if (!cut && fresh && sb.db.prepare("SELECT 1 FROM threads_inbox WHERE thread = ? AND delivered_at IS NULL LIMIT 1").get(id)) sb.turnEnded(id, fresh, rec ? rec.project : null);
  } catch (e) {
    st.switching = false;
    sb.live.delete(id);
    sb.set(id, { status: "stopped", pid: null, stopped_reason: `could not carry on on the server: ${String(e && /** @type {any} */ (e).message || e).slice(0, 160)}` });
    sb.emit("thread.stopped", { code: null, reason: "could not carry on on the server" }, id, null);
  }
}

/** Are these two ids one person? The switchboard's canonical form when it gave one (a replaced owner id is the same person), else exact. @param {any} q @param {any} a @param {any} b */
const samePerson = (q, a, b) => (typeof q.canon === "function" ? q.canon(a) === q.canon(b) : a === b);

/**
 * The person whose computer holds a chat's live process: their id, "" when the process says it is on a computer but the home's book has no row (held, nobody may write to it), null when it is not on a computer.
 * Fails closed: only a process that says "box" is the box's; one that says nothing (the cli driver once did not) is judged by the book.
 * @param {any} sb @param {string} id @param {any} st its live state
 * @returns {string | null}
 */
export function lentHolder(sb, id, st) {
  if (!(st && st.proc) || st.proc.where === "box") return null;
  let row = null;
  try { row = typeof sb.deps.lentRow === "function" ? sb.deps.lentRow({ thread: id, chat: sb.chatOf(id), native: sb.nativeOf(id) }) : null; } catch { row = null; }
  if (row && row.where === "mac") return String(row.person);
  return st.proc.where === "lent" ? "" : null;
}

/**
 * May this message NOT go into the chat's live process? True when the process is on a person's computer and the message is not that person's own: the turn's person must be the computer's person; a message with no person
 * (an agent's, a Flow's, a notice) never is. @param {any} sb @param {string} id @param {any} st @param {string | null | undefined} asker
 */
export function lentBlocks(sb, id, st, asker) {
  const holder = lentHolder(sb, id, st);
  if (holder === null) return false;
  return !(holder !== "" && asker && samePerson({ canon: sb.canon ? (/** @type {string} */ x) => sb.canon(x) : undefined }, holder, asker));
}

/**
 * A person's computer runs that person's turns only. When a chat's live process is on a computer and another person's message arrives (or one with no person at all), that message must not reach it: while a turn runs it
 * waits; otherwise the server takes the chat back from the computer (the lender's last whole turn becomes the chat's transcript here, the process ends as a move to the server, the switchboard carries on there) and the message
 * waits as the next turn. If the server cannot take it back now, the message still waits: it never runs on the computer. Answers true when the message is to wait, false when it may go in.
 * @param {any} sb the switchboard @param {string} id the thread @param {any} st its live state @param {string | null | undefined} asker the message's person
 */
export async function lentYield(sb, id, st, asker) {
  if (!lentBlocks(sb, id, st, asker)) return false;
  if (st.turn || !sb.deps.lentTakeBack) return true;
  // the hand-over is waited for in the background: the message is queued at once and is delivered when the chat is on the server (carryOn), never held in the sender's request
  const say = (/** @type {string} */ text) => { try { const rec = sb.record(id); sb.emit("thread.text", { message: "vyre", text, done: true, notice: true }, id, rec ? rec.project : null); } catch { /* a notice, never a stop */ } };
  Promise.resolve().then(() => sb.deps.lentTakeBack({ thread: id, chat: sb.chatOf(id), native: sb.nativeOf(id), asker: asker || null, canon: sb.canon ? (/** @type {string} */ x) => sb.canon(x) : undefined })).then((/** @type {any} */ r) => {
    if (r === "folder") say("This chat works in a folder on its owner's computer, so your message waits until the owner brings the chat back to the server. Ask the chat's owner to move it.");
    else if (r === "taken-offline") say("Continuing from the last saved turn: the computer this chat was on is offline.");
  }).catch(() => { /* it waits anyway */ });
  return true;
}

/**
 * The owner's next turn after another person's turn took the chat to the server: it goes back to their own computer when that is ready (the default where the Space allows it); when it is not, it runs on the server and the
 * chat says so in one line. A chat the person handed over themself is not touched. Answers true when the chat was put back (the live process on the server has ended: the turn starts on the computer).
 * @param {any} sb @param {string} id @param {any} st its live state @param {string | null | undefined} asker
 */
export async function lentReturn(sb, id, st, asker) {
  if (!asker || (st && st.turn) || typeof sb.deps.lentOfferBack !== "function") return false;
  try {
    const r = await sb.deps.lentOfferBack({ thread: id, chat: sb.chatOf(id), native: sb.nativeOf(id), person: asker, canon: sb.canon ? (/** @type {string} */ x) => sb.canon(x) : undefined });
    if (r && r.moved) return true;
    if (r && r.why && r.why !== "busy") { try { const rec = sb.record(id); sb.emit("thread.text", { message: "vyre", text: "Your computer is not ready, so this turn runs on the server. It goes back to your computer when it is ready.", done: true, notice: true }, id, rec ? rec.project : null); } catch { /* a notice */ } }
  } catch { /* the turn runs where the chat is */ }
  return false;
}

/** The home's row for a chat that runs on a computer, or null: synchronous, for the door every write passes. @param {any} kernel @param {{ thread: string, chat: string | null, native: string }} q */
export function lentRowFor(kernel, q) {
  /** @type {any} */ let host = null;
  try { host = kernel && typeof kernel.runnerHost === "function" ? kernel.runnerHost() : null; } catch { host = null; }
  const places = host && host.placements;
  if (!places || typeof places.find !== "function") return null;
  for (const space of places.spaces()) {
    const row = [q.chat, q.native, q.thread].filter(Boolean).map(k => places.find(space, String(k))).find(Boolean);
    if (row && row.where === "mac") return row;
  }
  return null;
}

/**
 * The chat came back to the server while another person's message was on its way into the queue: if the server has already carried on (a fresh process, idle), that message is the next turn now, and nothing else would hand it
 * over. If the carrying on is still to come, carryOn hands the queue over itself.
 * @param {any} sb @param {string} id @param {any} before the live state the message found
 */
export function lentDrain(sb, id, before) {
  const st = sb.live.get(id);
  if (!st || st === before || st.turn || st.switching || lentBlocks(sb, id, st, null)) return;
  if (sb.db.prepare("SELECT 1 FROM threads_inbox WHERE thread = ? AND delivered_at IS NULL LIMIT 1").get(id)) { const rec = sb.record(id); sb.turnEnded(id, st, rec ? rec.project : null); }
}

/**
 * The takeBack behind `lentYield`: "mine" when the chat's row on a computer is the asker's (or there is none), else the server takes the chat back and this says "taken" (or "held" when it could not now).
 * @param {any} kernel the module's kernel handle @param {{ thread: string, chat: string | null, native: string, asker?: string | null, canon?: (x: string) => string }} q
 * @returns {Promise<"mine" | "taken" | "taken-offline" | "held" | "folder">}
 */
export async function takeBackFor(kernel, q) {
  /** @type {any} */ let host = null;
  try { host = kernel && typeof kernel.runnerHost === "function" ? kernel.runnerHost() : null; } catch { host = null; }
  const places = host && host.placements;
  if (!places || typeof places.takeBack !== "function") return "held";
  const asker = q.asker || null;   // no person named is never the owner
  for (const space of places.spaces()) {
    const row = [q.chat, q.native, q.thread].filter(Boolean).map(k => places.find(space, String(k))).find(Boolean);
    if (!row || row.where !== "mac" || (asker && samePerson(q, row.person, asker))) continue;
    // a chat that works in a folder of the computer never moves to the server: the message waits, and the chat says why
    if (row.folder) return "folder";
    // one hand-over wait per session, however many messages arrive meanwhile: later ones share the first
    const key = `${space}/${row.session}`;
    let wait = waits.get(key);
    if (!wait) {
      wait = (async () => {
        // The computer is asked to hand the chat over first: it finishes its last checkpoint and releases, so nothing the owner said last is lost. Only a computer that does not answer in time is taken from.
        // (askRelease's person is the row's own, only to find the row: it grants the asker nothing.)
        if (typeof places.askRelease === "function") {
          try { places.askRelease(space, row.session, "another-person", row.person); } catch { /* it cannot be asked: taken below */ }
          // The other person's message waits for the computer's own end-of-turn checkpoint: the server never answers from a history that is missing the owner's last finished turn. A computer that stops beating is taken by
          // the home's sweep ("offline"), and only then, or after a long silence, does the server carry on from the last saved turn.
          const until = Date.now() + (Number.isInteger(q.waitMs) ? Number(q.waitMs) : RELEASE_WAIT_MS);
          while (Date.now() < until) {
            const now = places.find(space, row.session);
            if (!now || now.where !== "mac") return now && now.reason && now.reason !== "another-person" && now.reason !== "you" ? "taken-offline" : "taken";
            await new Promise(r => setTimeout(r, 100));
          }
        }
        const r = await places.takeBack(space, row.session, "another-person").catch(() => null);
        return r && r.changed ? "taken-offline" : "held";
      })().finally(() => waits.delete(key));
      waits.set(key, wait);
    }
    return wait;
  }
  return "mine";
}
/** @type {Map<string, Promise<"taken" | "taken-offline" | "held">>} the hand-over each session is waiting for now */
const waits = new Map();
const RELEASE_WAIT_MS = 90_000;

/**
 * The row of a chat that another person's turn took to the server and that belongs to this person, or null: the chat is offered back to its own person on their next turn.
 * @param {any} kernel @param {{ thread: string, chat: string | null, native: string, person: string, canon?: (x: string) => string }} q
 */
export function lentOfferedFor(kernel, q) {
  /** @type {any} */ let host = null;
  try { host = kernel && typeof kernel.runnerHost === "function" ? kernel.runnerHost() : null; } catch { host = null; }
  const places = host && host.placements;
  if (!places || typeof places.find !== "function") return null;
  for (const space of places.spaces()) {
    const row = [q.chat, q.native, q.thread].filter(Boolean).map(k => places.find(space, String(k))).find(Boolean);
    if (row && row.where === "server" && row.reason === "another-person" && samePerson(q, row.person, q.person)) return row;
  }
  return null;
}
