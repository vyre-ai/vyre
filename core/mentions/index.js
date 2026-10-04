// @ts-check
// mentions: the # tag. A module offers a kind in its manifest (`mentions: [{ kind, label, icon,
// search, resolve }]`, built in only), and this module fans one question out to every provider and
// gives back names grouped by kind. The provider's search runs as the person who asked, so it
// decides what that person sees (a locked vault has nothing to show); resolve is for sessions and
// the assistant alone, since what a tag grants is decided from the person's own turn.
// Names only: nothing a provider returns beyond id, name, hint and icon survives, and no value.

import { SURFACE_LABELS } from "../modules/index.js";

/** Who may ask: the person's own surfaces and the owner's devices (a model, an agent or a guest never). */
const PERSON = [...SURFACE_LABELS, "mobile", "tailnet", "device", "space", "agent"];

/** The order kinds are drawn in; any other kind follows by name. */
const FIRST = ["vault", "drive", "artifact", "github"];
/** Time a provider gets to answer a search before its group is dropped. */
export const SEARCH_MS = 400;
const DEFAULT_LIMIT = 6, MAX_LIMIT = 20;
/** The most a resolved tag's context may carry. */
const CONTEXT_MAX = 8000;
/** Kinds whose text is Vyre's own (a vault item's name and hosts); any other kind's text is outside text, third-party words sessions frames as data. */
const INSIDE = new Set(["vault"]);

/**
 * A grant cut to the shape sessions understands: { use, hosts, read, access }, small.
 * @param {any} g @returns {Record<string, any> | null}
 */
export function cleanGrant(g) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  /** @type {Record<string, any>} */ const out = {};
  if (typeof g.use === "boolean") out.use = g.use;
  if (Array.isArray(g.hosts)) out.hosts = g.hosts.filter((/** @type {any} */ h) => typeof h === "string").slice(0, 20).map((/** @type {string} */ h) => h.slice(0, 200));
  if (typeof g.read === "string") out.read = g.read.slice(0, 200);
  if (typeof g.access === "string") out.access = g.access.slice(0, 20);
  return Object.keys(out).length && JSON.stringify(out).length <= 2000 ? out : null;
}

/** Modules that may resolve a tag: the person's own turn is theirs to read. */
const RESOLVERS = ["module:sessions", "module:assistant"];

/**
 * The providers, first-party and running, in draw order.
 * @param {any[]} status rows from ctx.modules.status()
 */
export function providers(status) {
  const out = [];
  for (const m of status) {
    if (m.state !== "running" || !Array.isArray(m.mentions)) continue;
    for (const e of m.mentions) if (e && typeof e.kind === "string") out.push({ module: m.name, kind: e.kind, label: String(e.label || e.kind), icon: e.icon ? String(e.icon) : "", search: String(e.search), resolve: String(e.resolve) });
  }
  const rank = (/** @type {string} */ k) => { const i = FIRST.indexOf(k); return i < 0 ? FIRST.length : i; };
  return out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

/** @param {any} v @param {number} max */
const text = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/**
 * One provider item, cut to the four things a picker shows.
 * @param {any} it @returns {{ id: string, name: string, hint?: string, icon?: string } | null}
 */
export function cleanItem(it) {
  const id = it && typeof it.id === "string" ? it.id.slice(0, 200) : "", name = text(it && it.name, 120);
  if (!id || !name) return null;
  const hint = text(it.hint, 120), icon = typeof it.icon === "string" && /^[a-z][a-z0-9-]{0,24}$/.test(it.icon) ? it.icon : undefined;
  return { id, name, ...(hint ? { hint } : {}), ...(icon ? { icon } : {}) };
}

/** @param {Promise<any>} p @param {number} ms */
const within = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("late")), ms);
  p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("mentions.kinds", {
      callers: PERSON,
      description: "The kinds the # picker offers: { kinds: [{ kind, label, icon, module }] }, in draw order.",
      input: { type: "object", properties: {} },
      run: async () => ({ kinds: providers(ctx.modules.status()).map(p => ({ kind: p.kind, label: p.label, icon: p.icon, module: p.module })) }),
    });

    ctx.tool("mentions.search", {
      callers: PERSON,
      description: "Names matching what was typed, grouped by kind: { groups: [{ kind, label, icon, items: [{ id, name, hint?, icon? }] }], unavailable: [kind] }. Each provider answers as the person who asked, within 400 ms; one that errors, is locked or is late lands in `unavailable` and never delays the rest. Names only, never a value.",
      input: { type: "object", properties: { q: { type: "string", maxLength: 200 }, kinds: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT } } },
      run: async (input, meta) => {
        const q = String((input && input.q) || "");
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input && input.limit) || DEFAULT_LIMIT));
        const want = Array.isArray(input && input.kinds) && input.kinds.length ? new Set(input.kinds.map(String)) : null;
        const chosen = providers(ctx.modules.status()).filter(p => !want || want.has(p.kind));
        const answers = await Promise.all(chosen.map(async p => {
          try {
            const r = await within(ctx.call(p.search, { q, limit }, { as: meta.caller }), SEARCH_MS);
            if (!r || r.error || (r.data && r.data.error)) return { p, failed: true };
            const d = r.data !== undefined ? r.data : r;
            const raw = Array.isArray(d) ? d : d && Array.isArray(d.items) ? d.items : [];
            return { p, items: raw.map(cleanItem).filter(Boolean).slice(0, limit) };
          } catch { return { p, failed: true }; }
        }));
        return {
          groups: answers.filter(a => !a.failed && a.items && a.items.length).map(a => ({ kind: a.p.kind, label: a.p.label, icon: a.p.icon, items: a.items })),
          unavailable: answers.filter(a => a.failed).map(a => a.p.kind),
        };
      },
    });

    ctx.tool("mentions.resolve", {
      internal: true,
      description: "What one picked tag means for a thread: { kind, id, name, hint?, hosts?, note?, context?, grant? }. Only sessions and the assistant call it, from the person's own turn; the provider's resolve runs as that caller and makes the grant, and answers without a secret.",
      input: { type: "object", required: ["kind", "id"], properties: { kind: { type: "string" }, id: { type: "string", maxLength: 200 }, thread: { type: "string" }, said: { type: "string" } } },
      run: async (input, meta) => {
        const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
        if (!RESOLVERS.includes(String(meta.caller))) throw fail("denied", "only sessions and the assistant resolve a tag, from the person's own turn");
        const p = providers(ctx.modules.status()).find(x => x.kind === input.kind);
        if (!p) throw fail("no_such_kind", `no provider offers ${input.kind}`);
        let r;
        try { r = await within(ctx.call(p.resolve, { id: input.id, ...(input.thread ? { thread: input.thread } : {}), ...(input.said ? { said: input.said } : {}) }, { as: meta.caller }), 2000); }
        catch { throw fail("unavailable", `${p.kind} did not answer`); }
        const bad = !r || r.error || (r.data && r.data.error);
        if (bad) throw fail(((r && r.error) || (r && r.data && r.data.error) || {}).code === "not_found" ? "not_found" : "unavailable", `${p.kind} could not resolve that`);
        const d = r.data !== undefined ? r.data : r;
        let context = d.context !== undefined ? d.context : d.text;
        if (context !== undefined && typeof context !== "string") { try { context = JSON.stringify(context); } catch { context = undefined; } }
        const hosts = Array.isArray(d.hosts) ? d.hosts.filter((/** @type {any} */ h) => typeof h === "string").slice(0, 20) : undefined;
        return { kind: p.kind, id: String(input.id), name: text(d.name, 120) || String(input.id), ...(text(d.hint, 120) ? { hint: text(d.hint, 120) } : {}), ...(hosts && hosts.length ? { hosts } : {}),
          ...(text(d.note, 6000) ? { note: text(d.note, 6000) } : {}), ...(context ? { context: String(context).slice(0, CONTEXT_MAX), outside: d.outside !== undefined ? Boolean(d.outside) : !INSIDE.has(p.kind) } : {}), ...(cleanGrant(d.grant) ? { grant: cleanGrant(d.grant) } : {}) };
      },
    });
    return { async stop() {} };
  },
};
