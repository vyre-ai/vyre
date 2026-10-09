// @ts-check
import { clean, at, opt, DETAIL_MAX } from "../../lib/waiting-text.js";
// waiting: one "waiting on you" (docs/adr/0036-one-system.md, section 4).
//
// What waits on the person is held in three places now: the approvals queue (the Gate's held drafts, a session's asks and the vault's pending requests are cards in it, core/approvals/items.js),
// the Planner's ringing reminders and the link's pairing requests. Every surface used to read some of
// them and miss the rest. This module reads those and hands back one list, so the Capsule, the Deck,
// the phone, push and the status line count the same things, and one answer clears every device.
//
// It owns nothing. Answering stays with the owner: each row's `answer` names the owner's tool and
// the input it already knows, and `fill` names what the person still has to give (a decision, or
// the code on the Mac's screen). It never polls: it recomputes after the owners' own events,
// coalesced, and says waiting.changed only when the count or the kinds moved. A source that fails
// or is not running here leaves its rows out and its name in `partial`; the rest still show.
// Titles are the owners' own summaries, capped, and dropped whole when one looks like a secret.

const DEBOUNCE_MS = 300;
const LIMIT_MAX = 500;
/** How long a pairing request lives on the box (core/link/box.js TTL): link.pending gives only its expiry. */
const PAIR_TTL_MS = 10 * 60_000;

export const KINDS = /** @type {const} */ (["approval", "ask", "draft", "access", "run", "reminder", "pairing"]);

// Owners' events that can change what waits. planner.* is narrowed: added, removed and schedule
// never ring or stop a ring by themselves.
const WATCH = [
  ["approvals.*", t => t === "approvals.changed"],
  ["planner.*", t => t === "planner.fired" || t === "planner.acked" || t === "planner.changed"],
  ["link.*", t => t === "link.pair-requested" || t === "link.paired" || t === "link.unpaired"],
];

export { clean };

/** planner.ringing rows, shaped like planner.fired. `at` is when it was due. */
export const fromRinging = rows => rows.map(r => ({
  id: `planner:${r.firing}`, kind: "reminder", title: clean(r.title) || `A ${clean(r.kind, 20) || "reminder"} is ringing`,
  ...opt("detail", r.missed ? "missed" : ""), at: at(r.due), source: "planner",
  answer: { tool: "planner.done", input: { firing: r.firing }, fill: [] } }));

/** link.pending rows. The code is on the Mac's screen only, so the person types it in. `created` is
 * the request's real timestamp (core/link/box.js); a box that has not shipped it yet falls back to
 * the fixed TTL subtracted from `expires`, which only holds while both sides agree on the TTL. */
export const fromPending = rows => rows.map(p => {
  const name = clean(p.name, 80);
  return { id: `link:${p.id}`, kind: "pairing", title: name ? `Pair the Mac "${name}"` : "Pair a new Mac",
    ...opt("detail", clean([p.node, p.login].filter(Boolean).join(" · "), DETAIL_MAX)),
    at: at(typeof p.created === "number" ? p.created : typeof p.expires === "number" ? p.expires - PAIR_TTL_MS : 0), source: "link",
    answer: { tool: "link.pair.approve", input: {}, fill: ["code"] } };
});

/** The approvals queue's cards are already rows; the owners it could not read are named like a source of ours. */
const fromCards = data => (data && Array.isArray(data.items) ? data.items.filter(x => x && typeof x === "object").map(({ state: _state, ...row }) => row) : []);

const SOURCES = /** @type {const} */ ([
  ["approvals", "approvals.items", fromCards],
  ["planner", "planner.ringing", fromRinging],
  ["link", "link.pending", fromPending],
]);

/** @param {any[]} rows */
export const tally = rows => {
  const by_kind = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const r of rows) by_kind[r.kind]++;
  return { count: rows.length, by_kind };
};

/** Newest first; the id breaks ties so the order never flickers. */
const order = (a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    /** @type {{ rows: any[], count: number, by_kind: Record<string, number>, partial: string[] } | null} */
    let cache = null;
    let said = JSON.stringify(tally([])), timer = null, running = null, again = false, stopped = false;

    /** One source's rows, or null when it failed, is refused or is not running here. The approvals queue also names the owners it could not read (`partial`). */
    const read = async (tool, map) => {
      try {
        const r = await ctx.call(tool, {});
        if (!r || r.error) return null;
        if (tool === "approvals.items") return r.data && typeof r.data === "object" ? Object.assign(map(r.data), { partial: Array.isArray(r.data.partial) ? r.data.partial.map(String) : [] }) : null;
        if (!Array.isArray(r.data)) return null;
        return map(r.data.filter(x => x && typeof x === "object"));
      } catch { return null; }
    };

    // On a Mac the planner is the box's, reached over the link: a Mac's vyred never asks its box
    // on its own (test/federation-reads.test.js), and the Mac hears rings through the link's events.
    const sources = ctx.config && ctx.config.role === "box" ? SOURCES : SOURCES.filter(([name]) => name !== "planner");
    const compute = async () => {
      const got = await Promise.all(sources.map(([, tool, map]) => read(tool, map)));
      const partial = [...sources.filter((_, i) => got[i] === null).map(([name]) => name), ...got.flatMap(g => (g && Array.isArray(/** @type {any} */ (g).partial) ? /** @type {any} */ (g).partial : []))];
      const rows = got.flatMap(g => g || []).sort(order);
      return { rows, ...tally(rows), partial };
    };

    const publish = next => {
      cache = next;
      const key = JSON.stringify({ count: next.count, by_kind: next.by_kind });
      if (stopped || key === said) return;
      said = key;
      try { ctx.events.emit("waiting.changed", { count: next.count, by_kind: next.by_kind }); } catch (e) { ctx.log(`could not say waiting.changed: ${/** @type {Error} */ (e).message}`); }
    };

    /** One computation at a time; a call during one runs once more after it. */
    const refresh = async () => {
      if (running) { again = true; return running; }
      running = (async () => {
        let next;
        do { again = false; next = await compute(); publish(next); } while (again && !stopped);
        return /** @type {any} */ (next);
      })();
      try { return await running; } finally { running = null; }
    };

    /** Coalesce a burst of owner events into one computation, DEBOUNCE_MS after the first. */
    const schedule = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => { timer = null; refresh().catch(() => {}); }, DEBOUNCE_MS);
      timer.unref();
    };
    /** Now, instead of when the timer fires. */
    const now = () => { if (timer) { clearTimeout(timer); timer = null; } return refresh(); };

    const offs = WATCH.map(([pattern, keep]) => ctx.events.on(pattern, e => { if (keep(e.type)) schedule(); }));

    const callers = ["cli", "local", "deck", "capsule", "module"];
    const int = { type: "integer", minimum: 1, maximum: LIMIT_MAX };

    ctx.tool("waiting.list", {
      description: "Everything waiting on the user, newest first: yes waiting on the phone (approval), session asks (ask), held drafts (draft), the vault's pending requests (access), Flow runs that stopped or are stuck (run), ringing reminders (reminder) and pairing requests (pairing). The asks, drafts and vault requests are read from the approvals queue. Each row: id, kind, title, detail?, project?, thread?, at, source, and answer {tool, input, fill}: the owner's tool that settles it, the input it already has, and what the person still gives. Also count and by_kind over all rows, and partial: the sources that could not be read.",
      input: { type: "object", properties: { limit: int } },
      effect: "read",
      callers,
      run: async (input = {}) => {
        const r = await now();
        const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, LIMIT_MAX) : LIMIT_MAX;
        return { rows: r.rows.slice(0, limit), count: r.count, by_kind: r.by_kind, ...(r.partial.length ? { partial: r.partial } : {}) };
      },
    });

    ctx.tool("waiting.count", {
      description: "How many things wait on the user, and how many of each kind (approval, ask, draft, access, run, reminder, pairing).",
      input: { type: "object", properties: {} },
      effect: "read",
      callers,
      run: async () => {
        const r = cache && !timer && !running ? cache : await now();
        return { count: r.count, by_kind: r.by_kind };
      },
    });

    schedule();
    return { async stop() { stopped = true; for (const off of offs) off(); if (timer) clearTimeout(timer); try { if (running) await running; } catch {} } };
  },
};
