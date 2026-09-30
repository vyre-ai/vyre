// @ts-check
// suggest: one predictive-text tool for every surface (docs/adr/0036-one-system.md, "3. suggest").
//
// Each surface used to rank its own @ list from its own copies of agents, projects and threads.
// This module keeps one set of those lists, cached and refreshed on their owners' events, so a
// keystroke is string work in memory and calls no tool. Other modules add sources with
// suggest.offer at every start, as senders do with gate.offer; those are asked on each keystroke
// under a 25 ms deadline, and one that answers late is dropped from that keystroke and named.
// What the user picks (suggest.picked) is remembered, decayed by age, and raises it next time.
// IQ answers are not suggestions: a surface asks iq.ask when the user pauses, never here.

import { performance } from "node:perf_hooks";
import { quality, prepare, tokenAt, WORD, EXACT } from "./match.js";

export const KINDS = ["mention", "command", "account", "entity", "phrase", "file", "time"];
export const DEADLINE_MS = 25;
/** How long the first query waits for a built-in list it has never loaded. */
const FIRST_LOAD_MS = 250;
/** Events arrive in bursts (a turn ends in several); one reload serves them all. */
const DEBOUNCE_MS = 50;
/** A source whose tool was missing is asked again at most this often, and never awaited. */
const RETRY_MS = 5 * 60_000;
const LIMIT = 8, MAX = 20;
const DAY = 86_400_000;
const PICK_HALF_LIFE = 14 * DAY, PICK_MAX = 8, PICKS_KEPT = 5000;

/** Which offered kinds each lane asks. */
const LANE_KINDS = { mention: ["mention"], command: ["command"], text: ["entity", "phrase", "account", "time", "file"] };
/** Agents first, then projects, threads and people, on an equal match (as the Capsule ranks @). */
const BIAS = { agent: 4, project: 3, thread: 2, person: 1 };

const str = { type: "string" };
const one = (/** @type {unknown} */ s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (/** @type {string} */ s, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const folder = (/** @type {unknown} */ p) => String(p || "").split("/").filter(Boolean).pop() || "";
const list = (/** @type {any} */ d, /** @type {string} */ key) => (Array.isArray(d) ? d : d && Array.isArray(d[key]) ? d[key] : []);

/** "in 2 h", "in 18 min", "now". @param {number} at @param {number} now */
export function when(at, now) {
  const m = Math.round((at - now) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return h < 36 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}

/**
 * A candidate: what a list row becomes once, when the list loads.
 * @typedef {{ kind: string, sub?: string, source: string, id: string, label: string, insert: string, detail?: string,
 *   action?: { tool: string, input: any }, last: number, at?: number, bias: number, idPrefix?: boolean,
 *   p: { lower: string, words: string[], id: string } }} Candidate
 */

/** @returns {Candidate} */
const cand = (/** @type {Omit<Candidate, "p">} */ c) => ({ ...c, p: prepare(c.label, c.id) });

/** The built-in sources: a tool each, the events that change it, and its rows as candidates. */
export const SOURCES = {
  agents: {
    tool: "agents.list", input: () => ({}),
    changes: (/** @type {string} */ t) => /^agents?\./.test(t),
    build: (/** @type {any} */ d) => list(d, "agents").filter(a => a && a.name).map(a => cand({ kind: "mention", sub: "agent", source: "agents",
      id: String(a.name), label: String(a.name), insert: `@${a.name}`, detail: a.kind === "assistant" ? "your assistant" : one(a.doing) || "agent", last: 0, bias: BIAS.agent })),
  },
  projects: {
    tool: "projects.list", input: () => ({}),
    changes: (/** @type {string} */ t) => /^projects?\./.test(t),
    build: (/** @type {any} */ d) => {
      const rows = list(d, "projects").filter(p => p && (p.slug || p.name));
      /** @type {Candidate[]} */ const out = [];
      /** @type {Map<string, { name: string, id: string, in: string[], last: number }>} */ const people = new Map();
      for (const p of rows) {
        const name = one(p.name || p.slug), last = Number(p.last) || 0;
        const parts = [p.org && p.org !== p.name ? one(p.org) : "", Number.isFinite(p.threads) ? `${p.threads} threads` : ""].filter(Boolean);
        out.push(cand({ kind: "mention", sub: "project", source: "projects", id: String(p.slug || name), label: name, insert: `@${p.slug || name}`,
          ...(parts.length ? { detail: parts.join(" · ") } : {}), last, bias: BIAS.project }));
        for (const x of Array.isArray(p.people) ? p.people : []) {
          const pn = one(typeof x === "string" ? x : x && x.name);
          if (!pn) continue;
          const key = pn.toLowerCase();
          const had = people.get(key) || { name: pn, id: String((x && x.email) || pn), in: [], last: 0 };
          if (!had.in.includes(name)) had.in.push(name);
          had.last = Math.max(had.last, last);
          people.set(key, had);
        }
      }
      for (const h of people.values()) out.push(cand({ kind: "mention", sub: "person", source: "people", id: h.id, label: h.name, insert: `@${h.name}`,
        detail: h.in.slice(0, 2).join(", "), last: h.last, bias: BIAS.person }));
      return out;
    },
  },
  threads: {
    tool: "threads.list", input: () => ({}),
    changes: (/** @type {string} */ t) => t === "thread.started" || t === "thread.finished" || t === "thread.stopped",
    build: (/** @type {any} */ d) => list(d, "threads").filter(t => t && t.id).map(t => {
      const id = String(t.id), parts = [one(t.project) || folder(t.cwd), t.status === "working" ? "working" : ""].filter(Boolean);
      return cand({ kind: "mention", sub: "thread", source: "threads", id, label: one(t.name) || id.slice(0, 8), insert: `@${id.slice(0, 8)}`,
        ...(parts.length ? { detail: parts.join(" · ") } : {}), last: Number(t.last) || 0, bias: BIAS.thread, idPrefix: true });
    }),
  },
  planner: {
    tool: "planner.upcoming", input: () => ({ hours: 72 }),
    changes: (/** @type {string} */ t) => t === "planner.added" || t === "planner.changed" || t === "planner.removed",
    build: (/** @type {any} */ d) => {
      /** @type {Map<string, Candidate>} */ const byItem = new Map();
      for (const e of list(d, "entries")) {
        if (!e || !e.item || !one(e.title) || byItem.has(String(e.item))) continue;   // entries come soonest first
        const at = Number(e.start || e.at) || 0;
        byItem.set(String(e.item), cand({ kind: "time", source: "planner", id: String(e.item), label: one(e.title), insert: one(e.title),
          detail: one(e.kind) || "reminder", action: { tool: "planner.get", input: { item: String(e.item) } }, last: at, at, bias: 0 }));
      }
      return [...byItem.values()];
    },
  },
  // ADR 0028 9b, not built everywhere yet: until it is, the call fails and the list is empty.
  vault: {
    tool: "vault.connections.list", input: (/** @type {string} */ surface) => ({ surface }), perSurface: true,
    changes: (/** @type {string} */ t) => /^vault\.connection/.test(t),
    build: (/** @type {any} */ d) => list(d, "connections").filter(c => c && c.id).map(c => {
      const label = one(c.label || c.account || c.provider) || String(c.id);
      const parts = [one(c.provider), c.account && one(c.account) !== label ? one(c.account) : ""].filter(Boolean);
      return cand({ kind: "account", source: "vault", id: String(c.id), label, insert: label, ...(parts.length ? { detail: parts.join(" · ") } : {}),
        ...(c.use && typeof c.use.tool === "string" ? { action: { tool: c.use.tool, input: c.use.input || {} } } : {}),
        // The person's default for some capability first, then the most recently used (vault 9b).
        last: Number(c.last_used) || 0, bias: c.is_default || (Array.isArray(c.default) && c.default.length) ? 1 : 0 });
    }),
  },
};

/** 0 to 0.9: how recent (or, for a time, how soon). Never enough to cross a kind's bias. */
const recency = (/** @type {number} */ last, /** @type {number} */ now) => (last > 0 && Number.isFinite(last) ? 0.9 * Math.exp(-Math.abs(now - last) / (3 * DAY)) : 0);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const db = ctx.store.db;
    ctx.store.migrate([
      `CREATE TABLE suggest_picks (kind TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL, weight REAL NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (kind, source, id))`,
    ]);
    const now = () => Date.now();
    let stopped = false;

    // ---- Picks: loaded once, kept in memory, written through ----------------------------------
    /** @type {Map<string, { weight: number, at: number }>} */
    const picks = new Map();
    const pickKey = (/** @type {string} */ kind, /** @type {string} */ source, /** @type {string} */ id) => `${kind}\u0000${source}\u0000${id}`;
    for (const r of /** @type {any[]} */ (db.prepare("SELECT * FROM suggest_picks").all())) picks.set(pickKey(r.kind, r.source, r.id), { weight: Number(r.weight), at: Number(r.at) });
    const decayed = (/** @type {{ weight: number, at: number }|undefined} */ p, /** @type {number} */ t) => (p ? p.weight * Math.pow(2, -(t - p.at) / PICK_HALF_LIFE) : 0);
    /** 0 to PICK_MAX: one recent pick is worth about a kind's bias, never a whole match tier. */
    const boost = (/** @type {string} */ key, /** @type {number} */ t) => { const w = decayed(picks.get(key), t); return w > 0 ? PICK_MAX * (1 - Math.exp(-w / 2)) : 0; };

    // ---- Built-in lists: loaded on first use, reloaded on their events ------------------------
    /** @typedef {{ name: string, key: string, surface: string, state: "empty"|"ready", items: Candidate[], missing: boolean, failedAt: number,
     *   loading: Promise<void>|null, again: boolean, timer: any }} Entry */
    /** @type {Map<string, Entry>} */
    const cache = new Map();
    const entry = (/** @type {string} */ name, /** @type {string} */ surface) => {
      const key = /** @type {any} */ (SOURCES)[name].perSurface ? `${name}:${surface}` : name;
      let e = cache.get(key);
      if (!e) { e = { name, key, surface, state: "empty", items: [], missing: false, failedAt: 0, loading: null, again: false, timer: null }; cache.set(key, e); }
      return e;
    };
    const load = (/** @type {Entry} */ e) => {
      if (e.loading) { e.again = true; return e.loading; }
      const src = /** @type {any} */ (SOURCES)[e.name];
      e.loading = (async () => {
        do {
          e.again = false;
          let r;
          try { r = await ctx.call(src.tool, src.input(e.surface)); } catch (err) { r = { error: { code: "failed", message: String(err) } }; }
          if (stopped) return;
          if (r && r.error) { e.items = []; e.missing = true; e.failedAt = now(); }
          else { try { e.items = src.build(r ? r.data : null); } catch { e.items = []; } e.missing = false; }
          e.state = "ready";
        } while (e.again && !stopped);
      })().finally(() => { e.loading = null; });
      return e.loading;
    };
    const off = ctx.events.on("*", (/** @type {any} */ ev) => {
      if (stopped || !ev || ev.source === "suggest") return;
      for (const e of cache.values()) {
        if (e.state === "empty" || e.timer || !/** @type {any} */ (SOURCES)[e.name].changes(String(ev.type))) continue;
        e.timer = setTimeout(() => { e.timer = null; if (!stopped) load(e).catch(() => {}); }, DEBOUNCE_MS);
        e.timer.unref?.();
      }
    });

    /** The lists this query reads, loading any never loaded (bounded); names those still loading. */
    const lists = async (/** @type {string[]} */ names, /** @type {string} */ surface, /** @type {string[]} */ late) => {
      const es = names.map(n => entry(n, surface));
      const first = es.filter(e => e.state === "empty").map(e => load(e));
      if (first.length) {
        let timer;
        await Promise.race([Promise.all(first).catch(() => {}), new Promise(r => { timer = setTimeout(r, FIRST_LOAD_MS); })]);
        clearTimeout(timer);
      }
      const t = now();
      for (const e of es) {
        if (e.state === "empty") late.push(e.name);
        // A tool that was missing may have started since; ask again now and then, never awaited.
        else if (e.missing && !e.loading && t - e.failedAt > RETRY_MS) load(e).catch(() => {});
      }
      return es.flatMap(e => e.items);
    };

    // ---- Offered sources ---------------------------------------------------------------------
    /** @type {Map<string, { module: string, tool: string, kinds: string[], pending: Promise<any>|null }>} */
    const offered = new Map();
    const offer = (/** @type {any} */ input, /** @type {string} */ caller) => {
      const m = /^module:(.+)$/.exec(String(caller || ""))?.[1];
      if (!m) throw new Error("only a module offers a suggestion source");
      const tool = String(input.tool || "");
      if (!tool.startsWith(m + ".") || tool.length <= m.length + 1) throw new Error(`${m} may offer only one of its own tools (${m}.<name>)`);
      const kinds = input.kinds;
      if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !KINDS.includes(k))) throw new Error(`kinds must be some of ${KINDS.join(", ")}`);
      offered.set(tool, { module: m, tool, kinds: [...new Set(kinds)], pending: null });
      return { tool, kinds: [...new Set(kinds)] };
    };

    /** One offered source's answer, as candidates already scored for quality. */
    const fromOffer = (/** @type {any} */ o, /** @type {any} */ data, /** @type {string} */ prefix, /** @type {string[]} */ allowed, /** @type {number} */ limit) => {
      const rows = list(data, "items").slice(0, limit);
      const out = [];
      for (const x of rows) {
        if (!x || typeof x !== "object") continue;
        const label = cut(one(x.label));
        const kind = x.kind === undefined ? o.kinds.find((/** @type {string} */ k) => allowed.includes(k)) : x.kind;
        if (!label || !o.kinds.includes(kind) || !allowed.includes(kind)) continue;
        const c = cand({ kind, source: o.tool, id: cut(String(x.id ?? label)), label, insert: typeof x.insert === "string" ? cut(x.insert, 400) : label,
          ...(typeof x.detail === "string" && x.detail.trim() ? { detail: cut(one(x.detail)) } : {}),
          ...(x.action && typeof x.action.tool === "string" ? { action: { tool: x.action.tool, input: x.action.input && typeof x.action.input === "object" ? x.action.input : {} } } : {}),
          last: Number(x.last) || 0, bias: 0 });
        // The source's own 0..1 score, when it gives one, stands for match quality.
        const q = typeof x.score === "number" && Number.isFinite(x.score) ? Math.max(0, Math.min(1, x.score)) * EXACT : Math.max(1, quality(prefix, c.p));
        out.push({ c, q });
      }
      return out;
    };

    // ---- The query -----------------------------------------------------------------------------
    const query = async (/** @type {any} */ input) => {
      const t0 = performance.now();
      const text = String(input.text ?? "");
      const surface = String(input.surface || "unknown");
      const limit = Math.max(1, Math.min(MAX, Number.isInteger(input.limit) ? input.limit : LIMIT));
      const tok = tokenAt(text, input.cursor);
      // In running text, the word without the punctuation around it.
      const prefix = tok.lane === "text" ? tok.prefix.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "") : tok.prefix;
      /** @type {string[]} */ const late = [];

      // Offered sources first, so their 25 ms runs while the lists are read.
      const allowed = LANE_KINDS[tok.lane];
      const ask = { prefix, text, surface, context: input.context && typeof input.context === "object" ? input.context : {}, limit };
      /** @type {Map<string, any>} */ const answered = new Map();
      /** @type {{ o: any, p: Promise<void> }[]} */ const asked = [];
      for (const o of offered.values()) {
        if (!o.kinds.some(k => allowed.includes(k))) continue;
        // Still answering the last keystroke: asking again would only pile calls up.
        if (o.pending) { late.push(o.tool); continue; }
        const p = Promise.resolve().then(() => ctx.call(o.tool, ask)).catch(err => ({ error: { code: "failed", message: String(err) } }));
        o.pending = p;
        p.finally(() => { if (o.pending === p) o.pending = null; });
        asked.push({ o, p: p.then(r => {
          if (r && r.error && r.error.code === "no_such_tool" && offered.get(o.tool) === o) offered.delete(o.tool);
          else if (r && !r.error) answered.set(o.tool, r.data);
        }) });
      }
      let timer;
      const offers = asked.length
        ? Promise.race([Promise.all(asked.map(a => a.p)), new Promise(r => { timer = setTimeout(r, Math.max(0, DEADLINE_MS - (performance.now() - t0))); })]).finally(() => clearTimeout(timer))
        : Promise.resolve();

      const names = tok.lane === "mention" ? ["agents", "projects", "threads"]
        : tok.lane === "text" && prefix.length >= 2 ? ["agents", "projects", "threads", "planner", "vault"] : [];
      const [builtin] = await Promise.all([names.length ? lists(names, surface, late) : Promise.resolve([]), offers]);

      const t = now();
      /** @type {Map<string, any>} */ const best = new Map();
      const put = (/** @type {Candidate} */ c, /** @type {number} */ q, /** @type {string} */ insert) => {
        const score = q * 10 + c.bias + recency(c.last, t) + boost(pickKey(c.kind, c.source, c.id), t);
        const k = `${c.kind}\u0000${c.p.lower}`;
        const had = best.get(k);
        if (had && had.score >= score) return;
        const detail = c.kind === "time" && c.at ? [c.detail, when(c.at, t)].filter(Boolean).join(", ") : c.detail;
        best.set(k, { kind: c.kind, ...(c.sub ? { sub: c.sub } : {}), label: c.label, insert, ...(detail ? { detail } : {}), ...(c.action ? { action: c.action } : {}),
          source: c.source, id: c.id, score: Math.round(score * 1000) / 1000 });
      };
      for (const c of builtin) {
        if (c.kind === "time" && c.at && c.at < t) continue;
        const q = quality(prefix, c.p, { idPrefix: c.idPrefix });
        if (!q) continue;
        if (tok.lane === "mention") { put(c, q, c.insert); continue; }
        // In running text only a name's start counts, and a name typed out whole needs no help.
        if (q < WORD || (c.kind === "mention" && c.p.lower === prefix)) continue;
        put(c, q, c.kind === "mention" ? c.label : c.insert);
      }
      for (const a of asked) {
        if (!answered.has(a.o.tool)) { late.push(a.o.tool); continue; }
        for (const { c, q } of fromOffer(a.o, answered.get(a.o.tool), prefix, allowed, limit)) put(c, q, c.insert);
      }
      const items = [...best.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
      const ms = Math.round((performance.now() - t0) * 100) / 100;
      return { items, ms, ...(late.length ? { late: [...new Set(late)] } : {}) };
    };

    const picked = (/** @type {any} */ i) => {
      const kind = String(i.kind || ""), source = cut(String(i.source || "")), id = cut(String(i.id || ""));
      if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
      if (!source || !id) throw new Error("picked needs a source and an id, as suggest.query gave them");
      const t = now(), key = pickKey(kind, source, id);
      const weight = decayed(picks.get(key), t) + 1;
      picks.set(key, { weight, at: t });
      db.prepare("INSERT INTO suggest_picks (kind, source, id, weight, at) VALUES (?,?,?,?,?) ON CONFLICT (kind, source, id) DO UPDATE SET weight = excluded.weight, at = excluded.at")
        .run(kind, source, id, weight, t);
      if (picks.size > PICKS_KEPT) {
        const old = [...picks.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, picks.size - PICKS_KEPT + 500);
        const del = db.prepare("DELETE FROM suggest_picks WHERE kind = ? AND source = ? AND id = ?");
        for (const [k] of old) { picks.delete(k); del.run(...k.split("\u0000")); }
      }
      return { kind, source, id, weight: Math.round(weight * 1000) / 1000 };
    };

    const people = ["cli", "local", "deck", "capsule", "module"];
    ctx.tool("suggest.query", {
      description: "What the user may be typing, at the cursor: names after @ (agents, projects, threads, people), commands after /, and otherwise entities, phrases, accounts and upcoming times for the last word. Answers from cached lists in a few ms; a module's offered source that misses 25 ms is named in late. Returns { items: [{ kind, sub?, label, insert, detail?, action?, source, id, score }], ms, late? }; insert replaces the token at the cursor.",
      input: { type: "object", required: ["text", "surface"], properties: { text: str, cursor: { type: "integer" }, surface: str, context: { type: "object" }, limit: { type: "integer" } } },
      callers: people,
      run: async (/** @type {any} */ input) => query(input),
    });
    ctx.tool("suggest.offer", {
      internal: true,
      description: "A module adds a suggestion source: tool, one of its own tools (<module>.<name>), and the kinds it answers. The tool gets { prefix, text, surface, context, limit } and has 25 ms; it returns items [{ label, kind?, insert?, detail?, action?, id?, score? (0 to 1), last? }]. Offer again at every start; it replaces the last.",
      input: { type: "object", required: ["tool", "kinds"], properties: { tool: str, kinds: { type: "array", items: { type: "string", enum: KINDS } } } },
      run: (/** @type {any} */ input, /** @type {any} */ { caller }) => offer(input, caller),
    });
    ctx.tool("suggest.picked", {
      description: "The user chose a suggestion: its kind, source and id as suggest.query gave them. It ranks higher next time; the lift fades over weeks.",
      input: { type: "object", required: ["kind", "source", "id"], properties: { kind: { type: "string", enum: KINDS }, source: str, id: str } },
      callers: people,
      run: async (/** @type {any} */ input) => picked(input),
    });

    // Modules that started first offer their sources again now (memory's names, for one).
    ctx.events.emit("suggest.ready", {});
    return {
      async stop() {
        stopped = true; off();
        for (const e of cache.values()) if (e.timer) clearTimeout(e.timer);
        await Promise.allSettled([...cache.values()].map(e => e.loading).filter(Boolean));
      },
    };
  },
};
