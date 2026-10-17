// @ts-check
// The tools that say where a session runs and let the person change it (team/contracts/runner.md). Two halves, one set of words:
//   the HOME answers for a session (placement, move, whyNot): it owns the placement book, and the chat on any screen asks it;
//   the COMPUTER answers for itself (here, settings, settings.set, pauseAll, resumeAll): what runs on it now and the limits the person set for it.
// Nothing here decides a place on its own; the book (placement-book.js) records it and the lender's state machine (mover.js) asks for moves.
import os from "node:os";
import { placementOf } from "./placement-book.js";

const str = { type: "string" };
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** What a session uses, in the words of a list row. @param {number} cpuPercent @param {number} memoryMb @param {string} state */
export const hereLine = (cpuPercent, memoryMb, state) => `${state === "paused" ? "Paused" : state === "waiting" ? "Waiting for you" : "Running"}, ${cpuPercent}% processor, ${memoryMb >= 1024 ? `${Math.round(memoryMb / 102.4) / 10} GB` : `${memoryMb} MB`}`;

/** The limits a person may set for a computer (the Settings page's ranges; the same numbers are declared in module.json). */
export const LIMITS = Object.freeze({ cpuPercent: [10, 100], memoryMb: [512, 65536] });
export const SETTING_KEYS = Object.freeze({ enabled: "runner.enabled", pluggedInOnly: "runner.plugged_in_only", cpuPercent: "runner.cpu_percent", memoryMb: "runner.memory_mb" });
export const SETTING_DEFAULTS = Object.freeze({ enabled: false, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 });
/** What an enabled computer does on its own (`enabled` is the master switch: Never is off). "always" starts new chats here and takes sessions back after a steady stretch of being well; "ask" takes only what the person puts on it.
 *  Read and written through the settings tools like any setting; not part of the runner.settings contract, which stays the four limits. */
export const MODE_KEY = "runner.mode";
export const MODES = Object.freeze(["always", "ask"]);

/**
 * What a computer's limits are, read through the one settings mechanism (core/settings): a key the settings module cannot give now reads as its default, so a daemon without it still answers.
 * @param {(key: string) => Promise<any>} get the settings module's read of one key (the caller names the tool with a literal)
 */
export function settingsReader(get) {
  /** The last good value of each key: a read that fails changes nothing, so a hiccup of the settings module can never read as "switched off". @type {Partial<typeof SETTING_DEFAULTS>} */
  const last = {};
  let known = false;
  const read = async () => {
    for (const [name, key] of Object.entries(SETTING_KEYS)) {
      try {
        const r = await get(key); const v = r && r.data && r.data.value;
        if (r && r.data) known = true;
        if (v !== undefined && v !== null && typeof v === typeof /** @type {any} */ (SETTING_DEFAULTS)[name]) /** @type {any} */ (last)[name] = v;
      } catch { /* the last good value stands */ }
    }
    return { ...SETTING_DEFAULTS, ...last };
  };
  /** Whether the settings module has ever answered: a daemon without it has no master switch to honour, and nothing moves for want of one. */
  return Object.assign(read, { known: () => known });
}

/**
 * @param {any} ctx the module's context
 * @param {{ person: (meta: any, what: string) => Promise<string | null>, hostOf: () => any, runners: Map<string, any>, readSettings: () => Promise<typeof SETTING_DEFAULTS>, titles: Map<string, string>, platform?: string, groupWaitMs?: number }} d
 */
export function registerPlaceTools(ctx, d) {
  /** The one person a call is, in a Space, or a refusal: the home tells a person about their own chats only. */
  const who = async (/** @type {any} */ meta, /** @type {string | undefined} */ space) => {
    const chain = await (typeof ctx.kernel?.chainIn === "function" && space ? ctx.kernel.chainIn(space, meta) : ctx.kernel.chain(meta));
    const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (hops.length !== 1 || !hops[0].actor || hops[0].actor.kind !== "person") throw refuse("only a person sees or changes where their chats run", "denied");
    return { chain, person: String(hops[0].actor.id) };
  };
  const placements = () => { const h = d.hostOf(); const p = h && h.placements; if (!p) throw refuse("this computer does not keep where sessions run: ask the Space's server", "unavailable"); return p; };
  /** Computers by device id, for the name a chip shows. */
  const names = async () => {
    const devs = /** @type {any} */ (await ctx.call("relay.devices.all", {}).catch(() => null));
    const list = devs && devs.data && Array.isArray(devs.data.devices) ? devs.data.devices : [];
    return (/** @type {string | null} */ id) => { const x = list.find((/** @type {any} */ y) => y.id === id); return x && x.name ? String(x.name) : null; };
  };
  /** Find a thread's row (a chat or a session id) in the Spaces this home serves. @returns {{ space: string, row: any } | null} */
  const find = (/** @type {string} */ thread, /** @type {string | undefined} */ space, /** @type {string} */ person) => {
    const p = placements();
    for (const sp of space ? [space] : p.spaces()) { const row = p.find(sp, thread, person); if (row) return { space: sp, row }; }
    return null;
  };
  const mineChat = async (/** @type {any} */ chain, /** @type {string} */ thread) => {
    const mine = typeof ctx.kernel?.chats?.mine === "function" ? new Set((await ctx.kernel.chats.mine(chain)).map((/** @type {any} */ c) => String(c.chat || c.id))) : new Set();
    return mine.has(thread);
  };
  const threadOf = (/** @type {any} */ i) => { const t = i && i.thread; if (typeof t !== "string" || !/^[A-Za-z0-9_:.-]{1,100}$/.test(t)) throw refuse("name the chat or the session", "bad_input"); return t; };
  /** The answer every placement tool gives. */
  const answer = async (/** @type {any} */ row) => { const nameOf = await names(); return placementOf(row, { computer: row ? nameOf(row.device) : null }); };

  ctx.tool("runner.placement", {
    description: "Where a chat's session runs now: on a computer or on the server, its state, why it moved, the epoch, and whether it may be brought back. Input: thread (chat or session id).",
    input: obj({ thread: str, space: str }, ["thread"]),
    run: async (i, meta) => {
      const thread = threadOf(i);
      const { chain, person } = await who(meta, i.space);
      const hit = find(thread, i.space, person);
      if (!hit) {
        // a session the server runs itself has no row: it is the server's, and only the chat's own people are told so
        if (!(await mineChat(chain, thread))) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
        return answer(null);
      }
      if (hit.row.person !== person) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
      return answer(hit.row);
    },
  });

  ctx.tool("runner.folders.available", {
    description: "The folders of your computers a chat can be given, each { id, label, device, computer }: only computers that are ready now. A chat given one works in it on that computer and stays there. Input: space (optional).",
    input: obj({ space: str }),
    run: async (i, meta) => {
      const { person } = await who(meta, i.space);
      const p = placements(), nameOf = await names();
      const spaces = i.space ? [i.space] : p.spaces();
      return { folders: spaces.flatMap((/** @type {string} */ sp) => (typeof p.foldersOf === "function" ? p.foldersOf(sp, person) : []).map((/** @type {any} */ f) => ({ id: f.id, label: f.label, device: f.device, computer: nameOf(f.device), space: sp }))) };
    },
  });

  ctx.tool("runner.preview", {
    description: "Preview the dev server a chat started on its computer: the chat's program runs on one of your computers, and this gives the server there a preview card here. Input: thread, port (1024 to 65535), title (optional), space (optional). Answers { preview } with the card's id.",
    input: obj({ thread: str, port: { type: "integer" }, title: str, space: str }, ["thread", "port"]),
    run: async (i, meta) => {
      const thread = threadOf(i);
      const { person } = await who(meta, i.space);
      const p = placements();
      if (typeof p.openPreview !== "function") throw refuse("previews of a chat on a computer are not available on this server: ask the owner of this server to update it", "unavailable");
      const space = i.space || (p.spaces().find((/** @type {string} */ sp) => p.find(sp, thread, person)) || p.spaces()[0]);
      if (!space) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
      /** the preview this bridge is for, known once previews.open answers: a header the front made for another preview is not this one's (trust row 44) */
      /** @type {{ id: string | null }} */ const mine = { id: null };
      let bridge; try { bridge = await p.openPreview(space, { thread, port: Number(i.port), person, viewer: async (/** @type {string} */ header) => { if (!mine.id) return false; const r = /** @type {any} */ (await ctx.call("previews.viewer-ok", { header, preview: mine.id })); return Boolean(r && r.data && r.data.ok === true); } }); } catch (e) { throw refuse(String(/** @type {any} */ (e).message || "that chat cannot be previewed now"), /** @type {any} */ (e).code === "bad_input" ? "bad_input" : /** @type {any} */ (e).code === "quota" ? "quota" : "not_found"); }
      const r = /** @type {any} */ (await ctx.call("previews.open", { title: String(i.title || "Preview").slice(0, 80), port: bridge.port, thread }));
      if (r && r.error) throw refuse(String(r.error.message || "the preview could not be opened"), "unavailable");
      mine.id = r && r.data && typeof r.data.id === "string" ? r.data.id : null;
      return { preview: r && r.data && (r.data.id || r.data.preview || r.data) };
    },
  });

  ctx.tool("runner.why-not", {
    description: "Why a chat's session is not running on a computer: one reason code, or null when it runs where it was meant to. Input: thread.",
    input: obj({ thread: str, space: str }, ["thread"]),
    run: async (i, meta) => {
      const thread = threadOf(i);
      const { person } = await who(meta, i.space);
      const hit = find(thread, i.space, person);
      if (!hit || hit.row.person !== person) return { reason: null };
      return { reason: hit.row.where === "server" ? hit.row.reason : null };
    },
  });

  /** The home side of runner.move: ask the lender to hand the session over, or allow it to come back. */
  d.moveThread = async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const thread = threadOf(i);
    if (i.to !== "server" && i.to !== "mac") throw refuse("move to mac or to server", "bad_input");
    const { person, chain } = await who(meta, i.space);
    const hit = find(thread, i.space, person);
    // a chat that began on the server, or one that came back to it from a computer, goes out (a session offered back after its computer got well is the computer's to start again, not a move out) to a computer: its whole turns go to a ready computer of the person's, which carries it on from there
    const goingOut = i.to === "mac" && (!hit || (hit.row.person === person && hit.row.where === "server" && hit.row.offer !== "mac"));
    if (!hit || goingOut) {
      if (i.to === "server") return answer(null);
      const p0 = placements();
      if (typeof p0.adopt !== "function") throw refuse("Coming in this release: a chat that began on the server cannot be moved to a computer yet; leave it on the server for now", "unavailable");
      const space = i.space || p0.spaces()[0];
      if (!space) throw refuse("no computer of yours is set up to run this Space's chats yet: turn on Run on this computer on the Mac, then move the chat", "unavailable");
      const named = /** @type {any} */ (await ctx.call("threads.chat-thread", { thread }).catch(() => null));
      const at = named && named.data;
      if (!at) throw refuse("this chat has not run on this server yet, so there is nothing to carry to a computer: send it a message, then move it", "unavailable");
      if (!(await mineChat(chain, String(at.chat || thread)))) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
      // the chat's process on this server ends first (refused while it is working), so its next turn starts on the computer
      { const left = /** @type {any} */ (await ctx.call("threads.leave-box", { thread: at.thread }).catch((/** @type {any} */ e) => ({ error: { message: e && e.message } }))); if (left && left.error) throw refuse(String(left.error.message || "that chat is busy: let it finish, then move it"), "conflict"); }
      try { await p0.adopt(space, { thread: String(at.thread), chat: at.chat ? String(at.chat) : null, person }); } catch (e) { throw refuse(String(/** @type {any} */ (e).message || "that chat cannot move now"), /** @type {any} */ (e).code === "conflict" ? "conflict" : "unavailable"); }
      const placed = find(String(at.thread), space, person);
      return answer(placed ? placed.row : null);
    }
    if (hit.row.person !== person) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
    const p = placements();
    if (i.to === "server" && typeof p.resumable === "function" && !p.resumable(hit.space)) throw refuse("Coming in this release: moving a chat from a computer to the server. It keeps running where it is: leave it there.", "unavailable");
    const row = i.to === "server" ? p.askRelease(hit.space, hit.row.session, "you", person) : p.bringBack(hit.space, hit.row.session, person);
    return answer(row);
  };

  // After another person's turn took the chat to the server (reason another-person), the chat's own person gets it back on their own computer by default: their next turn asks here, and the chat goes out again with
  // the server's whole turns. Only for the row's own person (the Switchboard names the verified asker of the turn), and only for that reason: a chat the person handed over themself stays where they put it.
  ctx.tool("runner.offer-back", {
    description: "Put a chat back on its own person's computer after another person's turn took it to the server. Internal: the Switchboard, on that person's next turn. Input: thread, person. Answers { moved }.",
    internal: true, callers: ["module"],
    input: obj({ thread: str, person: str }, ["thread", "person"]),
    run: async (i, meta) => {
      if (!meta || meta.caller !== "module:threads") throw refuse("only the chat engine puts a chat back on its person's computer, when that person sends their next message: send a message in the chat", "denied");
      const thread = threadOf(i), person = String(i.person);
      const hit = find(thread, undefined, person);
      if (!hit || hit.row.person !== person || hit.row.where !== "server") return { moved: false };
      const p0 = placements();
      // A chat another person's turn took away comes back to its person on their next turn. A chat that left because its computer's condition cleared (lid, sleep, battery, offline) comes back the same way only by the person's standing choice
      // (Always allow) and only once that computer has stayed well: the home's own check (mayReturn), so a computer that comes and goes never gets a session back. The person's next turn is the boundary: never inside a turn, never on a timer.
      const policy = hit.row.reason !== "another-person";
      if (policy && !(typeof p0.mayReturn === "function" && p0.mayReturn(hit.space, hit.row.session, person))) return { moved: false };
      if (typeof p0.adopt !== "function") return { moved: false };
      const named = /** @type {any} */ (await ctx.call("threads.chat-thread", { thread }).catch(() => null));
      const at = named && named.data;
      if (!at) return { moved: false };
      { const left = /** @type {any} */ (await ctx.call("threads.leave-box", { thread: at.thread }).catch((/** @type {any} */ e) => ({ error: { message: e && e.message } }))); if (left && left.error) return { moved: false, why: "busy" }; }
      try { await p0.adopt(hit.space, { thread: String(at.thread), chat: at.chat ? String(at.chat) : null, person, ...(policy ? { policy: true } : {}) }); } catch (e) { return { moved: false, ...(policy ? {} : { why: String(/** @type {any} */ (e).message || "not ready") }) }; }
      return { moved: true };
    },
  });

  // A chat with more than one person always runs on the space's server. When a person is about to be added to a chat that runs on a computer, the chat says so in one line, the computer hands it over, and only then does the work module
  // add the person: no question, no tap. A chat working in a folder of the computer cannot move, so people are not added to it.
  ctx.tool("runner.group-move", {
    description: "Move a chat to the server before people are added to it. Internal: the work module, just before work.chat.change adds someone. Input: chat, person (the one adding), names (who is joining). Answers { moved }.",
    internal: true, callers: ["module"],
    input: obj({ chat: str, person: str, names: { type: "array", items: str } }, ["chat", "person"]),
    run: async (i, meta) => {
      if (!meta || meta.caller !== "module:work") throw refuse("only the work module moves a chat to the server so people can join: add people with work.chat.change", "denied");
      const chat = threadOf({ thread: i.chat }), person = String(i.person);
      const hit = find(chat, undefined, person);
      if (!hit || hit.row.where !== "mac") return { moved: false };
      if (hit.row.folder) throw refuse("This chat works in a folder on your computer, so it stays there. Start a new chat to talk with others.", "conflict");
      const p = placements();
      const names = (Array.isArray(i.names) ? i.names.map((/** @type {any} */ n) => String(n).trim()).filter(Boolean) : []).slice(0, 5);
      const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "someone";
      await ctx.call("threads.notice", { thread: hit.row.session, text: `This chat moves to the server so ${who} can join.` }).catch(() => null);
      p.askRelease(hit.space, hit.row.session, "you", person);
      const until = Date.now() + (Number.isInteger(d.groupWaitMs) ? Number(d.groupWaitMs) : 90_000);
      const left = () => { const now = p.find(hit.space, hit.row.session, person); return !now || now.where !== "mac"; };
      while (Date.now() < until && !left()) await new Promise(r => setTimeout(r, 100));
      // a computer that did not hand it over in time is overruled, as the sweep would: the server carries on from the last synced turn
      if (!left() && typeof p.takeBack === "function") await p.takeBack(hit.space, hit.row.session, "you").catch(() => null);
      if (!left()) throw refuse("This chat could not move to the server yet, so nobody was added. Try again in a moment.", "unavailable");
      return { moved: true };
    },
  });

  ctx.tool("runner.settings", {
    description: "This computer's limits for running a space's sessions: enabled, pluggedInOnly, cpuPercent, memoryMb.",
    input: obj(),
    run: async (_i, meta) => { await d.person(meta, "this computer's limits"); return d.readSettings(); },
  });

  ctx.tool("runner.settings.set", {
    description: "Change this computer's limits for running sessions: any of enabled, pluggedInOnly, cpuPercent (10 to 100), memoryMb (512 to 65536). Answers the limits now in effect.",
    input: obj({ enabled: { type: "boolean" }, pluggedInOnly: { type: "boolean" }, cpuPercent: { type: "integer" }, memoryMb: { type: "integer" } }),
    run: async (i, meta) => {
      await d.person(meta, "this computer's limits");
      for (const k of /** @type {const} */ (["cpuPercent", "memoryMb"])) {
        if (i[k] === undefined) continue;
        const [lo, hi] = LIMITS[k];
        if (!Number.isInteger(i[k]) || i[k] < lo || i[k] > hi) throw refuse(`${k === "cpuPercent" ? "The processor limit" : "The memory limit"} is a whole number from ${lo} to ${hi}.`, "bad_input");
      }
      for (const k of /** @type {const} */ (["enabled", "pluggedInOnly"])) if (i[k] !== undefined && typeof i[k] !== "boolean") throw refuse(`${k} is true or false`, "bad_input");
      for (const [name, key] of Object.entries(SETTING_KEYS)) if (i[name] !== undefined) {
        const r = /** @type {any} */ (await ctx.call("settings.write", { key, value: i[name] }));
        if (r && r.error) throw refuse(String(r.error.message || "that setting could not be saved"), r.error.code === "bad_input" ? "bad_input" : "failed");
      }
      return d.readSettings();
    },
  });

  ctx.tool("runner.here", {
    description: "The sessions running on this computer now, each with its chat, title, state and what it uses: rows of { thread, title, computer, state, cpuPercent, memoryMb, line, cpu }.",
    input: obj(),
    run: async (_i, meta) => {
      await d.person(meta, "the sessions on this computer");
      const computer = String((ctx.config && ctx.config.name) || os.hostname()).replace(/\.local$/, "");
      const sessions = [];
      for (const r of d.runners.values()) for (const x of r.info()) sessions.push({ thread: x.chat || x.session, title: d.titles.get(x.session) || "A session", computer, state: x.paused ? "paused" : "running", cpuPercent: x.cpuPercent, memoryMb: x.memoryMb, line: hereLine(x.cpuPercent, x.memoryMb, x.paused ? "paused" : "running"), cpu: `${x.cpuPercent}%` });
      return { sessions };
    },
  });

  for (const [name, verb] of /** @type {const} */ ([["runner.pause-all", "pause"], ["runner.resume-all", "resume"]])) {
    ctx.tool(name, {
      description: verb === "pause" ? "Freeze every session running on this computer until resume-all. They keep their place; nothing is lost." : "Let the sessions frozen by pause-all carry on.",
      input: obj(),
      run: async (_i, meta) => {
        await d.person(meta, "the sessions on this computer");
        // Windows has no way to freeze a process the way a Mac or Linux does (a stop signal there ends it), so Pause all would say "paused" over sessions that are running or gone
        if (verb === "pause" && (d.platform || process.platform) === "win32") throw refuse("Pausing sessions is not available on Windows yet. Stop a session from its chat instead.", "unavailable");
        let n = 0; for (const r of d.runners.values()) { n += r.info().length; r[verb](); }
        return { [verb === "pause" ? "paused" : "resumed"]: n };
      },
    });
  }
}
