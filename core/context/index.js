// @ts-check
// context: where the user is now, one answer for every surface (ADR 0036, part 2).
//
// Each surface says what it sees with context.report: the Capsule on an app switch, chat when a
// thread opens, the phone when it comes to the front. This module keeps the last report of each
// surface in memory and answers context.now with the newest value of each field across them, so
// no surface has to guess the project or the thread. A restart forgets it all, which is right:
// the next report rebuilds it.
//
// What it keeps is the shape of where the user is, never what they read or type. Text,
// selection and field values are refused at the door, a URL loses its query and fragment before
// it is stored, and the context.changed event names which fields moved without carrying the
// app, window or URL. Nothing here polls: it is idle until a surface reports or asks.

import { ownerDevice } from "../modules/index.js";

/** Fields a surface may report. Anything else in the input is ignored, except REFUSED. */
export const FIELDS = ["project", "cwd", "thread", "view", "app", "window", "url", "tz", "localTime"];
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
// An offset-bearing ISO 8601 timestamp: the device's own clock, never the server's. No bare "Z"
// with no offset info is required of the caller, but the string must carry one so a reader never
// has to guess which zone it was written in.
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
/** What a screen reads that must never reach this module: it would sit in memory and in events. */
export const REFUSED = ["text", "selection", "selected", "value", "focused"];
/** Fields whose values never go into an event. */
const PRIVATE = new Set(["app", "window", "url"]);
const SURFACE = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_LEN = 500;
const MAX_SURFACES = 32;
const INTERVAL_MS = 1000;
// No mcp: a model neither reports where the person is nor reads their front window. Harness modules
// read context.now as module callers and decide what a session may be told.
const CALLERS = ["cli", "local", "module", "deck", "capsule", "tailnet", "device", "space", "agent"];
// Projects' own events, after which a folder may belong to another project (or to none).
const PROJECT_EVENTS = /^(project|projects)\./;

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * A URL without its query, fragment or any user and password in it. Something that does not
 * parse as a URL is cut at the first ? or #.
 * @param {string} url
 */
export function stripUrl(url) {
  try {
    const u = new URL(url);
    u.search = ""; u.hash = ""; u.username = ""; u.password = "";
    return u.toString();
  } catch { return url.split(/[?#]/)[0]; }
}

/**
 * The fields of one report, checked and cleaned. A null clears a field for that surface; an
 * empty string does too.
 * @param {any} input
 * @returns {{ surface: string, device: string|null, fields: Record<string, string|null> }}
 */
export function clean(input) {
  const bad = REFUSED.filter(k => input[k] !== undefined);
  if (bad.length) throw fail("bad_input", `context.report does not take ${bad.join(", ")}: what is on screen stays with the screen`);
  const surface = input.surface;
  if (typeof surface !== "string" || !SURFACE.test(surface)) throw fail("bad_input", "surface must be a short lowercase name such as capsule, chat or phone");
  const device = input.device === undefined || input.device === null ? null : input.device;
  if (device !== null && (typeof device !== "string" || device === "" || device.length > 80)) throw fail("bad_input", "device must be a short string");
  /** @type {Record<string, string|null>} */
  const fields = {};
  for (const k of FIELDS) {
    const v = input[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") throw fail("bad_input", `${k} must be a string or null`);
    let s = v === null || v.trim() === "" ? null : v.trim();
    if (s !== null && k === "cwd" && !s.startsWith("/")) throw fail("bad_input", "cwd must be an absolute path");
    if (s !== null && k === "url") s = stripUrl(s);
    if (s !== null && k === "tz" && !TZ_RE.test(s)) throw fail("bad_input", "tz must be an IANA zone such as America/Los_Angeles or UTC");
    if (s !== null && k === "localTime" && !LOCAL_TIME_RE.test(s)) throw fail("bad_input", "localTime must be an ISO 8601 timestamp with an offset, e.g. 2026-09-28T14:32:00-07:00: the device's own clock, not the server's");
    if (s !== null && s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
    fields[k] = s;
  }
  return { surface, device, fields };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const opts = (ctx.config && ctx.config.context) || {};
    const interval = Number.isFinite(opts.intervalMs) && opts.intervalMs >= 0 ? opts.intervalMs : INTERVAL_MS;
    const now = typeof opts.now === "function" ? opts.now : Date.now;
    let stopped = false;

    /**
     * One record per surface and device. Each field keeps its own time, so a later report of
     * one field does not make the others look newer than they are.
     * @typedef {{ surface: string, device: string|null, at: number, values: Record<string, { v: string|null, at: number }>,
     *   pending: Set<string>, lastEmit: number, timer: any, flushing: boolean, emitted: { project: string|null } }} Rec
     * @type {Map<string, Rec>}
     */
    const surfaces = new Map();
    const keyOf = (/** @type {string} */ s, /** @type {string|null} */ d) => `${s}\u0000${d || ""}`;

    // projects.of per folder. The whole cache goes when a project changes: a folder can move to
    // another project, and a project event is rare next to the reports that read the cache.
    /** @type {Map<string, Promise<string|null>>} */
    let projectOf = new Map();
    const resolve = (/** @type {string} */ cwd) => {
      let p = projectOf.get(cwd);
      if (!p) {
        p = (async () => {
          try {
            const r = await ctx.call("projects.of", { cwd });
            return r && !r.error && r.data && typeof r.data.slug === "string" ? r.data.slug : null;
          } catch { return null; }
        })();
        projectOf.set(cwd, p);
        // A failed or missing projects module is not cached forever: the next ask tries again.
        p.then(slug => { if (slug === null && projectOf.get(cwd) === p) projectOf.delete(cwd); });
      }
      return p;
    };
    const off = ctx.events.on("*", e => { if (e.source !== "context" && PROJECT_EVENTS.test(e.type)) projectOf = new Map(); });

    /**
     * The project a set of field values points at: the one reported, unless a folder was
     * reported after it and that folder belongs to a project.
     * @param {Record<string, { v: string|null, at: number }>} values
     */
    const effectiveProject = async values => {
      const p = values.project, c = values.cwd;
      if (c && c.v && (!p || c.at > p.at)) {
        const slug = await resolve(c.v);
        if (slug) return slug;
      }
      return p ? p.v : null;
    };

    /** Emit what moved on one surface, if anything did, and remember when. @param {Rec} rec */
    const flush = async rec => {
      if (stopped) return;
      const project = await effectiveProject(rec.values);
      if (stopped) return;
      const changed = new Set(rec.pending);
      rec.pending.clear();
      if (project !== rec.emitted.project) changed.add("project");
      if (!changed.size) return;
      rec.emitted.project = project;
      rec.lastEmit = now();
      const thread = rec.values.thread ? rec.values.thread.v : null;
      /** @type {Record<string, any>} */
      const payload = { changed: [...changed].sort(), surface: rec.surface };
      if (project) payload.project = project;
      if (thread) payload.thread = thread;
      if (rec.device) payload.device = rec.device;
      for (const k of PRIVATE) delete payload[k];
      try { ctx.events.emit("context.changed", payload, { ...(project ? { project } : {}), ...(thread ? { thread } : {}) }); }
      catch (e) { ctx.log(`could not emit context.changed: ${/** @type {Error} */ (e).message}`); }
    };

    // One flush at a time per surface: a report that lands while projects.of is being asked
    // waits for the next window instead of racing it into a second event.
    const run = (/** @type {Rec} */ rec) => {
      rec.timer = null;
      rec.flushing = true;
      flush(rec).catch(() => {}).finally(() => { rec.flushing = false; if (rec.pending.size) schedule(rec); });
    };

    /** At most one event per surface per interval: the first at once, the rest folded into one at the window's end. @param {Rec} rec */
    const schedule = rec => {
      if (stopped || rec.timer || rec.flushing) return;
      const wait = Math.max(0, rec.lastEmit + interval - now());
      rec.timer = setTimeout(() => { run(rec); }, wait);
      rec.timer.unref?.();
    };

    ctx.tool("context.report", {
      description: "Say where the user is on this surface: the project, folder (cwd), thread, front app, window title or page URL it sees. Fields not given stay as they were for this surface; null clears one. The URL is kept without its query or fragment. Screen text, selection and field values are refused.",
      input: { type: "object", required: ["surface"], properties: {
        surface: { type: "string", description: "Which surface is reporting: capsule, chat, deck, phone, cli." },
        device: { type: "string", description: "Which device, when a surface runs on more than one." },
        project: { type: ["string", "null"], description: "A project slug." },
        cwd: { type: ["string", "null"], description: "An absolute folder; the project is found from it when none is given." },
        thread: { type: ["string", "null"], description: "The thread (session id) open on this surface." },
        view: { type: ["string", "null"], description: "The module or view the person is in on this surface: planner, vault, chat, glass. Tips and ranking read it." },
        app: { type: ["string", "null"], description: "The front app's name." },
        window: { type: ["string", "null"], description: "The front window's title." },
        url: { type: ["string", "null"], description: "The page open in a browser. Its query and fragment are dropped." },
        tz: { type: ["string", "null"], description: "This device's own IANA time zone, e.g. America/Los_Angeles. Never the server's." },
        localTime: { type: ["string", "null"], description: "This device's own clock right now, ISO 8601 with an offset, e.g. 2026-09-28T14:32:00-07:00. Never the server's." },
      } },
      callers: CALLERS,
      run: async (input, meta) => {
        if (stopped) throw fail("stopped", "context is stopping");
        const { surface, device: said, fields } = clean(input || {});
        // A device paired through the relay is named by its caller; a report need not repeat it.
        const paired = /^device:([a-z2-7]{16})$/.exec(String(meta && meta.caller));
        const device = said || (paired ? paired[1] : null);
        const key = keyOf(surface, device);
        let rec = surfaces.get(key);
        const at = now();
        if (!rec) {
          if (surfaces.size >= MAX_SURFACES) {
            // The quietest surface makes room; a restart would forget it anyway.
            const [oldest] = [...surfaces.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            const o = surfaces.get(oldest);
            if (o && o.timer) clearTimeout(o.timer);
            surfaces.delete(oldest);
          }
          rec = { surface, device, at, values: {}, pending: new Set(), lastEmit: -Infinity, timer: null, flushing: false, emitted: { project: null } };
          surfaces.set(key, rec);
        }
        rec.at = at;
        const changed = [];
        for (const [k, v] of Object.entries(fields)) {
          const was = rec.values[k];
          rec.values[k] = { v, at };
          if ((was ? was.v : null) !== v) { changed.push(k); rec.pending.add(k); }
        }
        if (rec.pending.size) schedule(rec);
        return { surface, ...(device ? { device } : {}), changed, at };
      },
    });

    ctx.tool("context.now", {
      description: "Where the user is now: the newest project, cwd, thread, app, window and url across every surface that reported, the surface and device that reported last (the focus), and the list of surfaces. The project is found from the folder when only a folder is known. tz, localTime and day come from whichever device most recently reported them: the device's own clock, never the server's, and null until some surface has reported one. parts: [\"screen\"] adds what sight sees on this Mac (not over the tailnet).",
      input: { type: "object", properties: {
        parts: { type: "array", items: { type: "string", enum: ["screen"] }, description: "Extra parts: screen." },
        surface: { type: "string", description: "Only this surface's own report (its view, thread and project), not the merge across surfaces." },
      } },
      callers: CALLERS,
      run: async (input, meta = {}) => {
        const parts = Array.isArray(input && input.parts) ? input.parts : [];
        const only = input && typeof input.surface === "string" ? input.surface : null;
        const recs = [...surfaces.values()].filter(r => !only || r.surface === only).sort((a, b) => b.at - a.at);
        /** @type {Record<string, { v: string|null, at: number }>} */
        const latest = {};
        for (const r of recs) for (const [k, f] of Object.entries(r.values)) if (!latest[k] || f.at > latest[k].at) latest[k] = f;
        const focus = recs[0] || null;
        /** @type {Record<string, any>} */
        const out = {
          project: await effectiveProject(latest),
          cwd: latest.cwd ? latest.cwd.v : null,
          thread: latest.thread ? latest.thread.v : null,
          view: latest.view ? latest.view.v : null,
          surface: focus ? focus.surface : null,
          device: focus ? focus.device : null,
          app: latest.app ? latest.app.v : null,
          window: latest.window ? latest.window.v : null,
          url: latest.url ? latest.url.v : null,
          tz: latest.tz ? latest.tz.v : null,
          localTime: latest.localTime ? latest.localTime.v : null,
          // The calendar date in the device's own local time, not the server's: the first 10
          // characters of localTime are already that device's YYYY-MM-DD, offset and all.
          day: latest.localTime && latest.localTime.v ? latest.localTime.v.slice(0, 10) : null,
          at: focus ? focus.at : null,
          surfaces: recs.map(r => ({ surface: r.surface, device: r.device, at: r.at })),
        };
        if (parts.includes("screen")) Object.assign(out, await screen(meta));
        return out;
      },
    });

    /**
     * What sight sees on this Mac. The Mac's screen never leaves it: a caller that came over the
     * tailnet or the relay is refused here, as the screen module refuses it, because sight sees
     * this module's call as a module's and cannot tell.
     * @param {any} meta
     */
    const screen = async meta => {
      if ((meta && meta.peer) || ownerDevice(meta && meta.caller) || /^tailnet/.test(String(meta && meta.caller))) return { screen: null, screen_why: "local_only" };
      try {
        const r = await ctx.call("sight.now", { target: "mac", parts: ["text"] });
        if (r && r.error) return { screen: null, screen_why: r.error.code === "no_such_tool" ? "no_sight" : r.error.code };
        return { screen: r ? r.data : null };
      } catch { return { screen: null, screen_why: "failed" }; }
    };

    return {
      async stop() {
        stopped = true;
        off();
        for (const r of surfaces.values()) if (r.timer) { clearTimeout(r.timer); r.timer = null; }
        surfaces.clear();
        projectOf = new Map();
      },
    };
  },
};
