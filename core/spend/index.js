// @ts-check
// spend: one ledger, and a daily cap per provider (team/archive/work-journals/iq.md, plan 3.9).
//
// What it keeps: a row per UTC day, provider, account, purpose and agent, with dollars, tokens and
// calls; `estimated` when the figure is tokens times a price, not a cost the provider reported.
// Whatever spends calls spend.record (memory's reader and answers do; a thread's turns are read here
// from thread.finished). The cap is a setting per provider (spend.<provider>.daily_usd, USD, each
// UTC day; config.spend.<provider>.dailyUsd is the fallback; empty is no cap).
//
// Hands-free: nothing asks on a call. At the cap the spending thread is halted with one line that
// says what happened and how to raise it, and spend.capped carries the same line and a raise-it
// action (spend.raise) for any surface to show. The event comes once a day per provider. A caller
// that is about to spend asks spend.check first; memory answers from facts and search while capped.

export const PROVIDERS = ["claude", "codex", "gemini", "grok", "kimi"];
/** The cap over every provider together, whichever they are (openrouter and the rest included). */
export const ALL = "all";
const PEOPLE = ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent"];

const SCHEMA = `
  CREATE TABLE spend (
    day_utc TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '', usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day_utc, provider, account, purpose, agent)
  );
  CREATE TABLE spend_capped (day_utc TEXT NOT NULL, provider TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day_utc, provider));`;

/** @param {number} t */
export const dayUtc = t => new Date(t).toISOString().slice(0, 10);
const usd = (/** @type {number} */ n) => `$${n.toFixed(2)}`;
const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });

/** The one line, for a thread's note and the event. @param {string} provider @param {number} spent @param {number} cap @param {string} [who] */
export const capLine = (provider, spent, cap, who = "") =>
  provider === ALL
    ? `${who ? `${who}'s ` : ""}Spend across every provider today reached ${usd(spent)} of the ${usd(cap)} daily cap, so this is paused. Raise it: vyre spend raise all <dollars>`
    : `${who ? `${who}'s ` : ""}${provider[0].toUpperCase()}${provider.slice(1)} spend today reached ${usd(spent)} of the ${usd(cap)} daily cap, so this is paused. Raise it: vyre spend raise ${provider} <dollars>`;

export default {
  /** @param {any} ctx */
  async start(ctx) {
    ctx.store.migrate([SCHEMA]);
    const db = ctx.store.db;
    const now = () => (ctx.now ? ctx.now() : Date.now());
    const q = {
      add: db.prepare(`INSERT INTO spend (day_utc, provider, account, purpose, agent, usd, tokens_in, tokens_out, calls, estimated)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (day_utc, provider, account, purpose, agent) DO UPDATE SET
        usd = round(usd + excluded.usd, 6), tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
        calls = calls + excluded.calls, estimated = MAX(estimated, excluded.estimated)`),
      day: db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE day_utc = ? AND provider = ?"),
      all: db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE day_utc = ?"),
      rows: db.prepare("SELECT * FROM spend WHERE day_utc = ? ORDER BY provider, purpose, account, agent"),
      noted: db.prepare("SELECT 1 FROM spend_capped WHERE day_utc = ? AND provider = ?"),
      note: db.prepare("INSERT OR IGNORE INTO spend_capped (day_utc, provider, at) VALUES (?,?,?)"),
      forget: db.prepare("DELETE FROM spend_capped WHERE day_utc = ? AND provider = ?"),
    };
    const provider = (/** @type {unknown} */ p) => {
      const v = String(p || "claude").toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(v)) throw bad("provider is a name like claude or codex");
      return v;
    };
    const spentToday = (/** @type {string} */ p, t = now()) => num(/** @type {any} */ (p === ALL ? q.all.get(dayUtc(t)) : q.day.get(dayUtc(t), p)).usd);

    // The five providers have a setting each; any other provider name (openrouter, a module's) shares spend.other.daily_usd, a cap for each of them.
    const keyOf = (/** @type {string} */ p) => `spend.${p === ALL || PROVIDERS.includes(p) ? p : "other"}.daily_usd`;
    /** The provider's daily cap in USD, or null for none: the setting, else config. @param {string} p */
    const capOf = async p => {
      try {
        const r = await ctx.call("settings.get", { key: keyOf(p) });
        const d = r && r.data !== undefined ? r.data : r;
        const v = d && d.value;
        if (typeof v === "number" && v > 0) return v;
        if (v === 0) return null;
      } catch { /* no settings hub: config below */ }
      const c = ctx.config && ctx.config.spend && (ctx.config.spend[p] || (p !== ALL && !PROVIDERS.includes(p) ? ctx.config.spend.other : null));
      const v = c && (c.dailyUsd ?? c.daily_usd);
      return typeof v === "number" && v > 0 ? v : null;
    };

    /**
     * Where a provider stands: its own cap, then the cap over every provider. The first one reached wins.
     * @param {string} p @returns {Promise<{ capped: boolean, scope: string, spent: number, cap: number | null }>}
     */
    const stand = async p => {
      for (const scope of p === ALL ? [ALL] : [p, ALL]) {
        const cap = await capOf(scope), spent = spentToday(scope);
        if (cap != null && spent >= cap) return { capped: true, scope, spent, cap };
      }
      const cap = await capOf(p);
      return { capped: false, scope: p, spent: spentToday(p), cap };
    };

    /** Say once a day that a provider is at its cap. Returns the line, or null when already said. */
    const announce = (/** @type {string} */ p, /** @type {number} */ spent, /** @type {number} */ cap, /** @type {{ agent?: string, thread?: string, purpose?: string, account?: string }} */ who) => {
      const day = dayUtc(now());
      if (q.noted.get(day, p)) return null;
      q.note.run(day, p, now());
      const line = capLine(p, spent, cap);
      ctx.events.emit("spend.capped", { provider: p, day, spent: Math.round(spent * 1e4) / 1e4, cap, line,
        ...(who.agent ? { agent: who.agent } : {}), ...(who.thread ? { thread: who.thread } : {}), ...(who.purpose ? { purpose: who.purpose } : {}),
        action: { label: "Raise it", tool: "spend.raise", input: { provider: p, to: Math.ceil(cap * 2) } } });
      return line;
    };

    /**
     * Put one spend in the ledger; then, if it took the provider to its cap, say so and, when it
     * came from a thread, pause that thread.
     * @param {{ provider?: string, account?: string, purpose: string, agent?: string, thread?: string, usd?: number, tokens_in?: number, tokens_out?: number, calls?: number, estimated?: boolean }} i
     */
    const record = async i => {
      const p = provider(i.provider);
      if (p === ALL) throw bad("a spend belongs to a provider; all is the cap over every provider");
      const cost = Math.max(0, num(i.usd));
      q.add.run(dayUtc(now()), p, String(i.account || ""), String(i.purpose || "other").slice(0, 60), String(i.agent || ""),
        cost, Math.max(0, Math.floor(num(i.tokens_in))), Math.max(0, Math.floor(num(i.tokens_out))), Math.max(1, Math.floor(num(i.calls)) || 1), i.estimated ? 1 : 0);
      const at = await stand(p);
      if (!at.capped) return { capped: false, spent: at.spent, cap: at.cap };
      announce(at.scope, at.spent, at.cap, i);
      if (i.thread) {
        try { await ctx.call("threads.halt", { thread: i.thread, reason: "spend", text: capLine(at.scope, at.spent, at.cap, i.agent) }); } catch { /* not running here */ }
      }
      return { capped: true, spent: at.spent, cap: at.cap, scope: at.scope };
    };

    // A thread's turns, from the Switchboard's own event: the ledger sees every provider's threads
    // without each one having to report. Only turns that cost something.
    ctx.events.on("thread.finished", async e => {
      try {
        const cost = Number(e.payload && e.payload.cost_usd) || 0;
        if (!(cost > 0) || !e.thread) return;
        /** @type {any} */
        let run = null;
        try { run = db.prepare("SELECT agent, provider, account, purpose FROM threads_runs WHERE id = ?").get(e.thread); }
        catch { try { run = db.prepare("SELECT agent FROM threads_runs WHERE id = ?").get(e.thread); } catch { /* no switchboard table */ } }
        const tk = (e.payload && e.payload.tokens) || {};
        await record({ provider: run && run.provider ? run.provider : "claude", account: run && run.account || "", purpose: run && run.purpose || "thread",
          agent: run && run.agent || "", thread: e.thread, usd: cost, tokens_in: num(tk.input), tokens_out: num(tk.output), calls: 1 });
      } catch { /* the ledger never breaks a thread */ }
    });

    ctx.tool("spend.record", {
      description: "Put one spend in the ledger: { provider, account?, purpose, agent?, thread?, usd, tokens_in?, tokens_out?, calls?, estimated? }. Returns { capped, spent, cap }. At the provider's cap it says so once a day (spend.capped) and pauses the thread it names. For Vyre's own modules.",
      internal: true,
      input: { type: "object", required: ["purpose"], properties: { provider: { type: "string" }, account: { type: "string" }, purpose: { type: "string" }, agent: { type: "string" }, thread: { type: "string" },
        usd: { type: "number" }, tokens_in: { type: "integer" }, tokens_out: { type: "integer" }, calls: { type: "integer" }, estimated: { type: "boolean" } } },
      run: async (i, { caller, firstParty } = {}) => {
        // Vyre's own modules only: a recorded spend can pause a thread, so an added module may not forge one.
        if (!String(caller || "").startsWith("module:") || firstParty !== true) throw Object.assign(new Error("recording a spend is for Vyre's own modules (spend.summary shows what is spent)"), { code: "denied" });
        return record(i);
      },
    });

    ctx.tool("spend.check", {
      effect: "read",
      description: "Whether a provider may spend now: { ok, capped, left, line? }. Ask before a costly call; at the cap, answer from what is known.",
      input: { type: "object", properties: { provider: { type: "string" } } },
      run: async i => {
        const p = provider(i.provider);
        const at = await stand(p);
        const round = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4;
        return { ok: !at.capped, capped: at.capped, scope: at.scope, spent: round(at.spent), cap: at.cap, left: at.cap == null ? null : Math.max(0, round(at.cap - at.spent)),
          ...(at.capped && at.cap != null ? { line: capLine(at.scope, at.spent, at.cap) } : {}) };
      },
    });

    ctx.tool("spend.summary", {
      effect: "read",
      description: "Spend per provider with its cap, and the rows behind it, plus the all-provider total against spend.all.daily_usd. Today in UTC unless day is given.",
      input: { type: "object", properties: { day: { type: "string", description: "YYYY-MM-DD for an earlier day; default today (UTC)" } } },
      run: async i => {
        const day = i.day ? String(i.day) : dayUtc(now());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad("day is YYYY-MM-DD");
        const rows = /** @type {any[]} */ (q.rows.all(day));
        const names = [...new Set([...PROVIDERS.filter(p => rows.some(r => r.provider === p)), ...rows.map(r => String(r.provider))])];
        const providers = [];
        for (const p of names) {
          const mine = rows.filter(r => r.provider === p), spent = mine.reduce((n, r) => n + num(r.usd), 0), cap = await capOf(p);
          providers.push({ provider: p, spent: Math.round(spent * 1e4) / 1e4, cap, left: cap == null ? null : Math.max(0, Math.round((cap - spent) * 1e4) / 1e4),
            capped: cap != null && spent >= cap, calls: mine.reduce((n, r) => n + num(r.calls), 0), estimated: mine.some(r => r.estimated) });
        }
        const every = rows.reduce((n, r) => n + num(r.usd), 0), allCap = await capOf(ALL);
        const all = { spent: Math.round(every * 1e4) / 1e4, cap: allCap, left: allCap == null ? null : Math.max(0, Math.round((allCap - every) * 1e4) / 1e4), capped: allCap != null && every >= allCap };
        return { day, all, providers, rows };
      },
    });

    ctx.tool("spend.raise", {
      effect: "write",
      description: "Raise a provider's daily cap (provider: all is the cap over every provider together): to (new cap in USD) or by (add this much), or off: true for no cap. The person's own surfaces only. Takes effect at once; a paused thread goes on when it is resumed, and the cap says again tomorrow if reached.",
      callers: PEOPLE,
      input: { type: "object", properties: { provider: { type: "string" }, to: { type: "number" }, by: { type: "number" }, off: { type: "boolean" } } },
      run: async i => {
        const p = provider(i.provider);
        const was = await capOf(p);
        let next;
        if (i.off === true) next = null;
        else if (typeof i.to === "number") next = i.to;
        else if (typeof i.by === "number") next = (was ?? spentToday(p)) + i.by;
        else throw bad("say to, by or off");
        if (next != null && !(next > 0)) throw bad("a cap is more than zero; off: true removes it");
        // Kept by the hub as this module's own setting (settings.write, modules only); no value clears it.
        const w = await ctx.call("settings.write", next == null ? { key: keyOf(p) } : { key: keyOf(p), value: Math.round(next * 100) / 100 });
        if (w && w.error) throw Object.assign(new Error(`could not set the cap: ${w.error.message || w.error.code}`), { code: w.error.code || "failed" });
        // A cap that is now above what is spent may say again if it is reached again today.
        if (next == null || spentToday(p) < next) q.forget.run(dayUtc(now()), p);
        ctx.events.emit("spend.raised", { provider: p, cap: next, was });
        return { provider: p, cap: next, was, spent: spentToday(p) };
      },
    });

    return { stop() {} };
  },
};
