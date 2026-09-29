// @ts-check
// assistant: the one assistant's own tools (ADR 0031, docs/design/assistant.md, section 2a).
//
// Two things, both read-only and both built before any delegated power: a daily digest and
// triage (assistant.brief), and pattern-noticing from what memory already surfaces about
// corrections and conflicts (assistant.patterns). Neither writes anything, anywhere. The digest
// runs once a day only when the person turns it on, and only at the device's own local start of
// day, never the server's: it rides context.now's tz/localTime/day fields (core/context), never
// a timer of its own, so it costs nothing while no surface is reporting.
//
// It owns no data other than the one date it last fired for. Everything it shows comes from
// other modules' own tools, called as this module (never as a person, never as an agent): the
// same path core/waiting already uses to read across four owners into one list.

const STATE_KEY = "last_digest_day";
const MIGRATIONS = [`CREATE TABLE assistant_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`];

/** A caller allowed to ask for the digest or the patterns: the person's own surfaces, their own
 * Claude Code session, or the assistant itself. Never a project-scoped agent: this is the
 * person's day, not a project's. @param {string} caller @param {(tool: string, input?: any) => Promise<any>} call */
export async function allowed(caller, call) {
  const c = String(caller || "");
  if (["cli", "local", "deck", "capsule"].includes(c) || /^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(c)) return true;
  const m = /^mcp:agent:(.+)$/.exec(c);
  if (!m) return false;
  const r = await call("agents.list", {});
  if (r.error) return false;
  const list = Array.isArray(r.data) ? r.data : (r.data && r.data.agents) || [];
  const a = list.find(x => x && x.name === m[1]);
  return Boolean(a && a.kind === "assistant");
}

/**
 * Patterns worth a line, from the main graph's own facts: memory already carries `conflict`
 * (two rooms believe different things, unresolved) and `correction` (the newest correction that
 * made or kept the fact, with its own age) on every fact it returns (core/memory/graph.js
 * `fact()`). This reads only that, through memory.facts, exactly as any owner surface would; it
 * never reads memory.corrections, which stays the person's own surfaces only.
 * @param {(tool: string, input?: any) => Promise<any>} call
 */
/** Whether `fact().correction.age` (e.g. "3 days", "2 weeks") names the last 7 days or less. */
export function recent(age) {
  const m = /^(\d+) (minute|hour|day|week|month|year)s?$/.exec(String(age || ""));
  if (!m) return false;
  return m[2] === "minute" || m[2] === "hour" || (m[2] === "day" && Number(m[1]) <= 7);
}

export async function patterns(call, { limit = 100 } = {}) {
  const r = await call("memory.facts", { limit: Math.min(200, Math.max(1, limit)) });
  if (r.error || !r.data || !Array.isArray(r.data.facts)) return [];
  const out = [];
  for (const f of r.data.facts) {
    if (f.conflict) out.push({ kind: "conflict", text: `${f.text} is unresolved: more than one project believes something different.`, fact: f.id });
    else if (f.correction && ["wrong", "replace"].includes(f.correction.action) && recent(f.correction.age)) {
      out.push({ kind: "corrected", text: `${f.text} was corrected recently.`, fact: f.id });
    }
  }
  return out;
}

/** One paragraph, never a dashboard. @param {{ waiting: any, agentsBusy: number, patterns: any[] }} d */
export function phrase(d) {
  const parts = [];
  if (d.waiting && d.waiting.count) {
    const kinds = Object.entries(d.waiting.by_kind || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
    parts.push(`${d.waiting.count} thing${d.waiting.count === 1 ? "" : "s"} waiting on you${kinds.length ? ` (${kinds.join(", ")})` : ""}.`);
  } else parts.push("Nothing waiting on you.");
  if (d.agentsBusy) parts.push(`${d.agentsBusy} agent${d.agentsBusy === 1 ? "" : "s"} working.`);
  for (const p of d.patterns.slice(0, 3)) parts.push(p.text);
  return parts.join(" ");
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const getState = k => { const r = db.prepare("SELECT v FROM assistant_state WHERE k = ?").get(k); return r ? r.v : null; };
    const setState = (k, v) => db.prepare("INSERT INTO assistant_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    let stopped = false;

    /** waiting, agents and patterns, whichever answer; a source that fails is just left out. */
    const gather = async () => {
      const [w, a, p] = await Promise.all([
        ctx.call("waiting.count", {}).catch(() => null),
        ctx.call("agents.list", {}).catch(() => null),
        patterns((tool, input) => ctx.call(tool, input)).catch(() => []),
      ]);
      const waiting = w && !w.error ? w.data : null;
      const agentsBusy = a && !a.error && Array.isArray(a.data) ? a.data.filter(x => x && x.doing === "working").length : 0;
      return { waiting, agentsBusy, patterns: Array.isArray(p) ? p : [] };
    };

    const brief = async () => {
      const d = await gather();
      return { text: phrase(d), waiting: d.waiting, agents_busy: d.agentsBusy, patterns: d.patterns, at: Date.now() };
    };

    ctx.tool("assistant.brief", {
      description: "One paragraph: what's waiting on you, how many agents are working, and any pattern memory noticed (a fact still in conflict, or corrected in the last week). Never a dashboard. Works whether or not the daily digest setting is on; that setting only controls whether this also fires once a day on its own.",
      input: { type: "object", properties: {} },
      run: async (_, meta = {}) => {
        if (!(await allowed(meta.caller, (tool, input) => ctx.call(tool, input)))) throw Object.assign(new Error("the brief is for the person and the assistant"), { code: "denied" });
        return brief();
      },
    });

    ctx.tool("assistant.patterns", {
      description: "Patterns memory already surfaces, read-only: facts still in conflict between two projects, and facts corrected in the last week. Never reads memory.corrections directly, which stays the person's own surfaces; this reads only what memory.facts already carries on every fact.",
      input: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
      run: async (input = {}, meta = {}) => {
        if (!(await allowed(meta.caller, (tool, i) => ctx.call(tool, i)))) throw Object.assign(new Error("patterns are for the person and the assistant"), { code: "denied" });
        return { patterns: await patterns((tool, i) => ctx.call(tool, i), input) };
      },
    });

    // The scheduled digest: no timer of its own. It rides context.changed, which only fires when
    // some surface actually reports (SPEC principle 8: nothing runs while nothing is happening).
    // A restart forgets nothing that matters: the fired-for day lives in assistant_state, so a
    // second device crossing midnight later the same day never fires it twice.
    const maybeFire = async () => {
      if (stopped) return;
      try {
        const s = await ctx.call("settings.get", { key: "assistant.digest_enabled" });
        if (s.error || !s.data || !s.data.value) return;
        const now = await ctx.call("context.now", {});
        if (now.error || !now.data || !now.data.day) return;
        const day = now.data.day;
        if (getState(STATE_KEY) === day) return;
        setState(STATE_KEY, day);
        const b = await brief();
        ctx.events.emit("assistant.briefed", { day, text: b.text });
      } catch (e) { ctx.log(`assistant: could not run the daily digest: ${/** @type {Error} */ (e).message}`); }
    };
    const off = ctx.events.on("context.changed", e => {
      if (Array.isArray(e && e.payload && e.payload.changed) && (e.payload.changed.includes("localTime") || e.payload.changed.includes("tz"))) maybeFire();
    });

    return { async stop() { stopped = true; off(); } };
  },
};
