// @ts-check
// models: the model registry (R031-84) and the new-model eval card (R031-87). One list every picker and every eval reads; it never holds a key.
//
//   Sources (lib/model-registry.js SOURCE_RANK):
//     api         each provider's own /models, fetched by the switchboard with the account's key (threads.models-fetch: it returns the answer, never the key)
//     cli         what a CLI or a subscription login reported when a session started (sessions.providers.snapshot): Claude Code, Codex with a ChatGPT login, the Grok CLI
//     openrouter  openrouter.ai/api/v1/models, public and keyless: price, context and capabilities, joined to an entry by id
//     fallback    the aliases the Claude CLI takes, only when nothing else is known
//   A refresh runs daily and on demand (at most once a minute). A source that fails keeps its last rows and the failure is on `models.status`. The first fill is silent; a model first seen after it
//   is `models.new`, and writes ONE pending eval proposal for the owner. Approving writes a queue; nothing here runs an eval or spends anything.

import { isPerson } from "../../lib/caller.js";
import { httpFetch } from "../../lib/http.js";
import { PERSON_SURFACES } from "../../lib/person-surfaces.js";
import { normalizeApi, mergeSource, joinOpenRouter, ageMissing, proposeEvals, EVAL_TYPES, keyOf, PROVIDERS } from "../../lib/model-registry.js";

const DAY = 24 * 3600_000;
const FIRST_LOOK_MS = 3 * 60_000;
const MIN_ASK_MS = 60_000;
const str = { type: "string" };
/** Who may read the registry: the person's surfaces, a module (the approvals queue reads the proposals) and an assistant. Answering a proposal is a person's surface only. */
const WHO = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];
const PEOPLE = [...PERSON_SURFACES, "device"];
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const MIGRATIONS = [
  `CREATE TABLE models_entries (k TEXT PRIMARY KEY, body TEXT NOT NULL)`,
  `CREATE TABLE models_sources (name TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT, rows INTEGER NOT NULL DEFAULT 0, body TEXT)`,
  `CREATE TABLE models_evals (model TEXT PRIMARY KEY, state TEXT NOT NULL, proposal TEXT NOT NULL, types TEXT, cap_usd REAL, by TEXT, at INTEGER NOT NULL, decided_at INTEGER)`,
  `CREATE TABLE models_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = () => Date.now();
    const meta = (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM models_meta WHERE k = ?").get(k)); return r ? String(r.v) : null; };
    const setMeta = (/** @type {string} */ k, /** @type {string} */ v) => db.prepare("INSERT INTO models_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    const load = () => new Map(/** @type {any[]} */ (db.prepare("SELECT k, body FROM models_entries").all()).map((r) => [String(r.k), JSON.parse(String(r.body))]));
    const save = (/** @type {Map<string, any>} */ entries) => {
      const up = db.prepare("INSERT INTO models_entries (k, body) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body");
      for (const [k, e] of entries) up.run(k, JSON.stringify(e));
    };
    const noteSource = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string | null} */ error, /** @type {number} */ rows, /** @type {any} */ body) =>
      db.prepare("INSERT INTO models_sources (name, at, ok, error, rows, body) VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, ok = excluded.ok, error = excluded.error, rows = excluded.rows, body = COALESCE(excluded.body, body)")
        .run(name, now(), ok ? 1 : 0, error, rows, body === undefined ? null : JSON.stringify(body));
    const quiet = async (/** @type {() => Promise<any>} */ go) => { try { const r = await go(); return r && !r.error ? r.data : null; } catch { return null; } };
    const openrouterUrl = () => (process.env.VYRE_OPENROUTER_API || "https://openrouter.ai/api/v1").replace(/\/$/, "") + "/models";

    const minAsk = ctx.config && ctx.config.models && Number.isFinite(Number(ctx.config.models.min_ask_ms)) ? Number(ctx.config.models.min_ask_ms) : MIN_ASK_MS;
    let looking = /** @type {Promise<any> | null} */ (null);
    let lastAsk = 0;

    /** One refresh of every source. @returns {Promise<{ added: string[], seen: number }>} */
    async function refresh() {
      const at = now();
      let entries = load();
      /** @type {Set<string>} */ const seen = new Set();
      /** @type {string[]} */ let added = [];
      const merge = (/** @type {string} */ provider, /** @type {string} */ source, /** @type {any[]} */ rows) => {
        const r = mergeSource(entries, provider, source, rows, at);
        entries = r.entries; added.push(...r.added);
        for (const row of rows) seen.add(keyOf(provider, row.id));
      };
      // cli: what each provider's sessions reported
      const snap = await quiet(() => ctx.call("sessions.providers.snapshot", {}));
      if (Array.isArray(snap)) {
        let n = 0;
        for (const p of snap) { if (!p || !PROVIDERS.hasOwnProperty(String(p.id))) continue; const rows = (Array.isArray(p.models) ? p.models : []).filter((/** @type {any} */ m) => m && typeof m.id === "string").map((/** @type {any} */ m) => ({ id: String(m.id).slice(0, 120), label: String(m.label || m.id).slice(0, 120), context: null, price: null, capabilities: null })); if (rows.length) { merge(String(p.id), "cli", rows); n += rows.length; } }
        noteSource("cli", true, null, n, undefined);
      } else noteSource("cli", false, "the sessions module did not answer", 0, undefined);
      // api: each provider's own list, fetched where the key is
      const fetched = await quiet(() => ctx.call("threads.models-fetch", {}));
      if (Array.isArray(fetched)) {
        let n = 0; const errors = [];
        for (const f of fetched) {
          if (!f || !PROVIDERS.hasOwnProperty(String(f.provider))) continue;
          if (f.error) { errors.push(`${f.provider}: ${String(f.error).slice(0, 100)}`); continue; }
          const rows = normalizeApi(String(f.provider), f.body);
          if (rows.length) { merge(String(f.provider), "api", rows); n += rows.length; }
        }
        noteSource("api", errors.length === 0, errors.join("; ") || null, n, undefined);
      } else noteSource("api", false, "no way to fetch with the accounts' keys here", 0, undefined);
      // openrouter: public metadata, joined by id; a failure keeps the last rows
      let orRows = /** @type {any[] | null} */ (null);
      try {
        const res = await httpFetch(openrouterUrl(), { headers: { accept: "application/json" }, timeoutMs: 15_000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        orRows = normalizeApi("openrouter", await res.json());
        noteSource("openrouter", true, null, orRows.length, orRows.slice(0, 1500));
      } catch (e) {
        noteSource("openrouter", false, e instanceof Error ? e.message.slice(0, 120) : "could not be read", 0, undefined);
        const last = /** @type {any} */ (db.prepare("SELECT body FROM models_sources WHERE name = 'openrouter'").get());
        try { orRows = last && last.body ? JSON.parse(String(last.body)) : null; } catch { orRows = null; }
      }
      if (orRows && orRows.length) entries = joinOpenRouter(entries, orRows, at);
      // fallback: only when nothing else knows a model
      if (!entries.size) {
        const got = await quiet(() => ctx.call("sessions.models.get", {}));
        const rows = (got && Array.isArray(got.aliases) ? got.aliases : []).filter((/** @type {any} */ m) => m && typeof m.id === "string").map((/** @type {any} */ m) => ({ id: String(m.id), label: String(m.label || m.id), context: null, price: null, capabilities: null }));
        if (rows.length) { const r = mergeSource(entries, "claude", "fallback", rows, at); entries = r.entries; added = []; noteSource("fallback", true, null, rows.length, undefined); }
      }
      // a model no source listed this time has missed one more refresh (only for providers that have a live source)
      const live = new Set([...seen].map((k) => k.split("/")[0]));
      const toAge = new Map([...entries].filter(([, e]) => live.has(e.provider)));
      const aged = ageMissing(toAge, seen);
      for (const [k, e] of aged) entries.set(k, e);
      save(entries);
      // the first fill is silent: everything is new to an empty registry
      const filled = meta("filled") === "1";
      if (!filled && entries.size) setMeta("filled", "1");
      if (filled) for (const k of added) {
        const e = entries.get(k);
        if (!e || db.prepare("SELECT 1 FROM models_evals WHERE model = ?").get(k)) continue;
        const proposal = proposeEvals({ id: e.id, provider: e.provider, label: e.label, price: e.price });
        db.prepare("INSERT INTO models_evals (model, state, proposal, at) VALUES (?, 'pending', ?, ?)").run(k, JSON.stringify(proposal), at);
        try { ctx.events.emit("models.new", { id: e.id, provider: e.provider, model: k }); ctx.events.emit("models.evals-changed", { model: k, state: "pending" }); } catch { /* a notice, never a stop */ }
      }
      setMeta("refreshed_at", String(at));
      try { ctx.events.emit("models.changed", { count: entries.size, added: filled ? added.length : 0 }); } catch { /* as above */ }
      return { added: filled ? added : [], seen: seen.size };
    }
    const refreshOnce = () => { if (!looking) looking = refresh().finally(() => { looking = null; }); return looking; };

    const shape = (/** @type {any} */ e) => ({ id: e.id, provider: e.provider, label: e.label, available: e.available, context: e.context, price: e.price, capabilities: e.capabilities, evals: e.evals || {}, sources: e.sources, first_seen: e.first_seen, last_seen: e.last_seen });
    const all = () => [...load().values()];

    ctx.tool("models.list", {
      effect: "read", callers: WHO,
      description: "Every model Vyre knows: id, provider, label, available, context, price (USD per million tokens), capabilities, evals, sources. Filter with provider or available.",
      input: { type: "object", properties: { provider: str, available: { type: "boolean", description: "true leaves out models no source lists any more." }, limit: { type: "integer" } } },
      run: async (/** @type {any} */ i) => {
        const rows = all().filter((e) => (!i || !i.provider || e.provider === String(i.provider)) && (!i || i.available !== true || e.available)).sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : (b.first_seen - a.first_seen)));
        return { models: rows.slice(0, Math.min(500, Math.max(1, (i && i.limit) || 200))).map(shape), count: rows.length, refreshed_at: Number(meta("refreshed_at")) || null };
      },
    });
    ctx.tool("models.get", {
      effect: "read", callers: WHO,
      description: "One model, by `provider/id` or by its id when only one provider has it.",
      input: { type: "object", required: ["id"], properties: { id: str } },
      run: async (/** @type {any} */ i) => {
        const want = String(i.id);
        const hits = all().filter((e) => keyOf(e.provider, e.id) === want || e.id === want);
        if (!hits.length) throw refuse("no such model (models.list)", "not_found");
        if (hits.length > 1) throw refuse(`more than one provider has ${want}: ${hits.map((e) => keyOf(e.provider, e.id)).join(", ")}`, "bad_input");
        return shape(hits[0]);
      },
    });
    ctx.tool("models.status", {
      effect: "read", callers: WHO,
      description: "When each source was last read and what failed: api, cli, openrouter, fallback.",
      input: { type: "object", properties: {} },
      run: async () => ({ refreshed_at: Number(meta("refreshed_at")) || null, count: all().length,
        sources: /** @type {any[]} */ (db.prepare("SELECT name, at, ok, error, rows FROM models_sources ORDER BY name").all()).map((r) => ({ name: r.name, at: r.at, ok: Boolean(r.ok), ...(r.error ? { error: r.error } : {}), rows: r.rows })) }),
    });
    ctx.tool("models.refresh", {
      effect: "write", callers: WHO,
      description: "Look at every source now instead of waiting for the daily look (at most once a minute), then answer like models.status.",
      input: { type: "object", properties: {} },
      run: async () => {
        if (now() - lastAsk < minAsk && meta("refreshed_at")) return { refreshed: false, reason: "looked a moment ago", ...(await ctx.call("models.status", {}).then((/** @type {any} */ r) => r.data).catch(() => ({}))) };
        lastAsk = now();
        const r = await refreshOnce();
        return { refreshed: true, new: r.added.length, count: all().length };
      },
    });

    // ---- the new-model eval card (R031-87): a proposal, a yes, a queue; nothing here runs an eval ----------------------------------------------------------
    const proposalRow = (/** @type {any} */ r) => ({ model: r.model, state: r.state, ...JSON.parse(String(r.proposal)), ...(r.types ? { approved: JSON.parse(String(r.types)) } : {}), at: r.at, ...(r.decided_at ? { decided_at: r.decided_at } : {}) });
    ctx.tool("models.evals", {
      effect: "read", callers: WHO,
      description: "The evals proposed for new models, with types, cost and state. Answer a pending one with models.eval-approve or models.eval-decline.",
      input: { type: "object", properties: { state: { type: "string", enum: ["pending", "approved", "declined", "done"] } } },
      run: async (/** @type {any} */ i) => ({ evals: /** @type {any[]} */ (db.prepare(i && i.state ? "SELECT * FROM models_evals WHERE state = ? ORDER BY at DESC" : "SELECT * FROM models_evals ORDER BY at DESC").all(...(i && i.state ? [String(i.state)] : []))).map(proposalRow) }),
    });
    ctx.tool("models.eval-approve", {
      effect: "write", callers: PEOPLE,
      description: "The owner says yes to evals for a model: { model, evals?: [type ids], cap_usd? } (all proposed types when none are named). Only Vyre's own standard evals are ever proposed, never one per skill. When the model's price is unknown the cost is unknown, and a hard cap in dollars (cap_usd) is required: a runner never spends past it. Writes them to the queue; nothing runs and nothing is spent here. A person's own.",
      input: { type: "object", required: ["model"], properties: { model: str, evals: { type: "array", items: str }, cap_usd: { type: "number" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ m) => {
        if (!isPerson(m)) throw refuse("only a person approves an eval", "denied");
        const row = /** @type {any} */ (db.prepare("SELECT * FROM models_evals WHERE model = ?").get(String(i.model)));
        if (!row) throw refuse("no eval was proposed for that model (models.evals)", "not_found");
        if (row.state !== "pending") throw refuse(`that proposal is already ${row.state}`, "bad_state");
        const prop = JSON.parse(String(row.proposal));
        const proposed = prop.types.map((/** @type {any} */ t) => t.id);
        const cap = i.cap_usd === undefined ? null : Number(i.cap_usd);
        if (cap !== null && !(cap > 0 && cap <= 1000)) throw refuse("cap_usd is a number of dollars above 0", "bad_input");
        if (!prop.price_known && cap === null) throw refuse("the cost of this model's evals is unknown (no price for it yet): set a hard cap in dollars, cap_usd, and a runner will never spend past it", "bad_input");
        const chosen = Array.isArray(i.evals) && i.evals.length ? i.evals.map(String) : proposed;
        const bad = chosen.filter((/** @type {string} */ t) => !proposed.includes(t));
        if (bad.length) throw refuse(`not an eval proposed for this model: ${bad.join(", ")}; the choices are ${proposed.join(", ")}`, "bad_input");
        db.prepare("UPDATE models_evals SET state = 'approved', types = ?, cap_usd = ?, by = ?, decided_at = ? WHERE model = ?").run(JSON.stringify([...new Set(chosen)]), cap, String((m && m.caller) || "person"), now(), String(i.model));
        ctx.events.emit("models.evals-changed", { model: String(i.model), state: "approved" });
        return { ok: true, model: String(i.model), approved: [...new Set(chosen)], ...(cap !== null ? { cap_usd: cap } : {}), note: "queued; nothing runs until a runner picks it up" };
      },
    });
    ctx.tool("models.eval-decline", {
      effect: "write", callers: PEOPLE,
      description: "The owner says no to evals for a model: it is not proposed again. A person's own.",
      input: { type: "object", required: ["model"], properties: { model: str } },
      run: async (/** @type {any} */ i, /** @type {any} */ m) => {
        if (!isPerson(m)) throw refuse("only a person declines an eval", "denied");
        const row = /** @type {any} */ (db.prepare("SELECT state FROM models_evals WHERE model = ?").get(String(i.model)));
        if (!row) throw refuse("no eval was proposed for that model (models.evals)", "not_found");
        if (row.state !== "pending") throw refuse(`that proposal is already ${row.state}`, "bad_state");
        db.prepare("UPDATE models_evals SET state = 'declined', decided_at = ? WHERE model = ?").run(now(), String(i.model));
        ctx.events.emit("models.evals-changed", { model: String(i.model), state: "declined" });
        return { ok: true, model: String(i.model) };
      },
    });
    ctx.tool("models.eval-queue", {
      effect: "read", callers: WHO,
      description: "The approved evals waiting for a runner: [{ model, types }]. A runner reports scores with models.eval-record.",
      input: { type: "object", properties: {} },
      run: async () => ({ queue: /** @type {any[]} */ (db.prepare("SELECT model, types, cap_usd, decided_at FROM models_evals WHERE state = 'approved' ORDER BY decided_at").all()).map((r) => ({ model: r.model, types: JSON.parse(String(r.types)), ...(r.cap_usd != null ? { cap_usd: r.cap_usd } : {}), approved_at: r.decided_at, runners: Object.fromEntries(EVAL_TYPES.filter((t) => JSON.parse(String(r.types)).includes(t.id)).map((t) => [t.id, t.runner])) })) }),
    });
    ctx.tool("models.eval-record", {
      effect: "write", callers: PEOPLE,
      description: "A runner reports one finished eval: { model, type, score (0 to 1), run? }. It is written into the model's entry (evals.<type>), and the proposal is done once every approved type has a score. A person's own (the owner runs the eval with their own key).",
      input: { type: "object", required: ["model", "type", "score"], properties: { model: str, type: str, score: { type: "number" }, run: str } },
      run: async (/** @type {any} */ i, /** @type {any} */ m) => {
        if (!isPerson(m)) throw refuse("only a person records an eval", "denied");
        const k = String(i.model), row = /** @type {any} */ (db.prepare("SELECT * FROM models_evals WHERE model = ?").get(k));
        if (!row || row.state !== "approved") throw refuse("that eval was not approved (models.eval-queue)", "not_allowed");
        const types = JSON.parse(String(row.types));
        if (!types.includes(String(i.type))) throw refuse(`${i.type} was not approved for this model (models.eval-queue shows what is approved)`, "not_allowed");
        const score = Number(i.score);
        if (!(score >= 0 && score <= 1)) throw refuse("score is a number from 0 to 1", "bad_input");
        const entries = load(), e = entries.get(k);
        if (!e) throw refuse("no such model (models.list shows them)", "not_found");
        e.evals = { ...(e.evals || {}), [String(i.type)]: { score, at: now(), ...(i.run ? { run: String(i.run).slice(0, 80) } : {}) } };
        entries.set(k, e); save(new Map([[k, e]]));
        if (types.every((/** @type {string} */ t) => e.evals[t])) db.prepare("UPDATE models_evals SET state = 'done' WHERE model = ?").run(k);
        ctx.events.emit("models.evals-changed", { model: k, state: types.every((/** @type {string} */ t) => e.evals[t]) ? "done" : "approved" });
        return { ok: true, model: k, type: String(i.type), score };
      },
    });

    // The first look a few minutes after start (a start is never slowed by the network), then daily.
    const first = setTimeout(() => { refreshOnce().catch(() => {}); }, FIRST_LOOK_MS); first.unref();
    const daily = setInterval(() => { refreshOnce().catch(() => {}); }, DAY); daily.unref();
    return { async stop() { clearTimeout(first); clearInterval(daily); try { await looking; } catch { /* stopping */ } } };
  },
};
