// @ts-check
// waiting: one "waiting on you" (docs/adr/0036-one-system.md, section 4).
//
// Four modules each hold something only the person can settle: the Switchboard's asks, the Gate's
// held drafts, the Planner's ringing reminders and the link's pairing requests. Every surface used
// to read some of them and miss the rest. This module reads all four and hands back one list, so
// the Capsule, the Deck, the phone, push and the status line count the same things, and one
// answer clears every device.
//
// It owns nothing. Answering stays with the owner: each row's `answer` names the owner's tool and
// the input it already knows, and `fill` names what the person still has to give (a decision, or
// the code on the Mac's screen). It never polls: it recomputes after the owners' own events,
// coalesced, and says waiting.changed only when the count or the kinds moved. A source that fails
// or is not running here leaves its rows out and its name in `partial`; the rest still show.
// Titles are the owners' own summaries, capped, and dropped whole when one looks like a secret.

const DEBOUNCE_MS = 300;
const TITLE_MAX = 120;
const DETAIL_MAX = 160;
const LIMIT_MAX = 500;
export const KINDS = /** @type {const} */ (["ask", "draft", "reminder"]);

// Owners' events that can change what waits. planner.* is narrowed: added, removed and schedule
// never ring or stop a ring by themselves.
const WATCH = [
  ["ask.*", () => true],
  ["gate.*", () => true],
  ["planner.*", t => t === "planner.fired" || t === "planner.acked" || t === "planner.changed"],
];

// A title reaches every device and the lock screen. The owners redact what they store, but a
// Bash ask's summary is the command as typed, so a line shaped like a credential goes whole.
const SECRET = [
  /(sk-|ghp_|gho_|xox[abprs]-|AKIA|-----BEGIN)/,
  /[A-Za-z0-9_+/=-]{32,}/,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]/i,
];
const one = (/** @type {unknown} */ s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** @param {unknown} s @param {number} n @returns {string} empty when it looks like a secret */
export const clean = (s, n = TITLE_MAX) => { const t = one(s); return t && !SECRET.some(r => r.test(t)) ? cap(t, n) : ""; };

const at = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const opt = (k, v) => (v ? { [k]: v } : {});

/** threads.asks rows. A question is answered with a decision and its answers; a permission with a decision. */
export const fromAsks = rows => rows.map(a => {
  const question = a.kind === "question";
  const first = question && Array.isArray(a.questions) && a.questions[0] ? a.questions[0].question : "";
  const title = clean(a.summary) || clean(first) || (question ? "A question from a session" : `Allow ${clean(a.tool, 40) || "a tool"}?`);
  const who = [clean(a.agent, 40), clean(a.thread_name, 80)].filter(Boolean).join(" in ");
  // An ask from a session on the paired Mac is answered on that Mac: the box cannot forward an
  // answer yet (threads.answer {machine} arrives with federation, after 0.1.0). Until then the
  // row names the machine and its answer has no tool, so a surface says "Answer it on <mac>".
  const mac = a.source === "mac";
  const machine = mac && a.machine ? clean(a.machine, 80) : "";
  return { id: `threads:${a.id}`, kind: "ask", title, ...opt("detail", cap(who, DETAIL_MAX)), ...opt("project", a.project), ...opt("thread", a.thread),
    ...(mac ? { machine: machine || "your Mac" } : {}), at: at(a.at), source: "threads",
    answer: mac ? { tool: null, input: null, fill: [], on: machine || "your Mac" }
      : { tool: "threads.answer", input: { ask: a.id }, fill: question ? ["decision", "answers"] : ["decision"] } };
});

/** gate.held rows. Only the sender's own summary and where it goes, never the draft. */
export const fromHeld = rows => rows.map(h => {
  const to = (Array.isArray(h.to) ? h.to : [h.to]).map(x => one(x)).filter(Boolean).join(", ");
  const via = clean(h.via, 40);
  const title = clean(h.summary) || `A ${clean(h.kind, 20) || "draft"}${via ? ` via ${via}` : ""}`;
  const detail = clean([via, to && `to ${to}`].filter(Boolean).join(" "), DETAIL_MAX);
  return { id: `gate:${h.id}`, kind: "draft", title, ...opt("detail", detail), ...opt("project", h.project), ...opt("thread", h.thread),
    at: at(h.at), source: "gate", answer: { tool: "gate.approve", input: { id: h.id }, fill: [] } };
});

/** planner.ringing rows, shaped like planner.fired. `at` is when it was due. */
export const fromRinging = rows => rows.map(r => ({
  id: `planner:${r.firing}`, kind: "reminder", title: clean(r.title) || `A ${clean(r.kind, 20) || "reminder"} is ringing`,
  ...opt("detail", r.missed ? "missed" : ""), at: at(r.due), source: "planner",
  answer: { tool: "planner.done", input: { firing: r.firing }, fill: [] } }));

const SOURCES = /** @type {const} */ ([
  ["threads", "threads.asks", fromAsks],
  ["gate", "gate.held", fromHeld],
  ["planner", "planner.ringing", fromRinging],
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

    /** One source's rows, or null when it failed, is refused or is not running here. */
    const read = async (tool, map) => {
      try {
        const r = await ctx.call(tool, {});
        if (!r || r.error || !Array.isArray(r.data)) return null;
        return map(r.data.filter(x => x && typeof x === "object"));
      } catch { return null; }
    };

    // On a Mac the planner is the box's, reached over the link: a Mac's vyred never asks its box
    // on its own (test/federation-reads.test.js), and the Mac hears rings through the link's events.
    const sources = ctx.config && ctx.config.role === "box" ? SOURCES : SOURCES.filter(([name]) => name !== "planner");
    const compute = async () => {
      const got = await Promise.all(sources.map(([, tool, map]) => read(tool, map)));
      const partial = sources.filter((_, i) => got[i] === null).map(([name]) => name);
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
      description: "Everything waiting on the user, newest first: session asks (ask), held drafts (draft), ringing reminders (reminder) and pairing requests (pairing). Each row: id, kind, title, detail?, project?, thread?, at, source, and answer {tool, input, fill}: the owner's tool that settles it, the input it already has, and what the person still gives. Also count and by_kind over all rows, and partial: the sources that could not be read.",
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
      description: "How many things wait on the user, and how many of each kind (ask, draft, reminder, pairing).",
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
