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
 * @param {{ person: (meta: any, what: string) => Promise<string | null>, hostOf: () => any, runners: Map<string, any>, readSettings: () => Promise<typeof SETTING_DEFAULTS>, titles: Map<string, string>, platform?: string }} d
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
    const { person } = await who(meta, i.space);
    const hit = find(thread, i.space, person);
    if (!hit) {
      if (i.to === "server") return answer(null);
      // a chat that began on the server: its whole turns go to a ready computer of the person's, which carries it on from there
      const p0 = placements();
      if (typeof p0.adopt !== "function") throw refuse("Coming in this release: a chat that began on the server cannot be moved to a computer yet; leave it on the server for now", "unavailable");
      const space = i.space || p0.spaces()[0];
      if (!space) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
      if (!(await mineChat((await who(meta, space)).chain, thread))) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
      try { await p0.adopt(space, { thread, person }); } catch (e) { throw refuse(String(/** @type {any} */ (e).message || "that chat cannot move now"), /** @type {any} */ (e).code === "conflict" ? "conflict" : "unavailable"); }
      const placed = find(thread, space, person);
      return answer(placed ? placed.row : null);
    }
    if (hit.row.person !== person) throw refuse("no such chat (work.chat.list shows the ones you may see)", "not_found");
    const p = placements();
    if (i.to === "server" && typeof p.resumable === "function" && !p.resumable(hit.space)) throw refuse("Coming in this release: moving a chat from a computer to the server. It keeps running where it is: leave it there.", "unavailable");
    const row = i.to === "server" ? p.askRelease(hit.space, hit.row.session, "you", person) : p.bringBack(hit.space, hit.row.session, person);
    return answer(row);
  };

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
