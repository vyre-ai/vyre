// @ts-check
// "What the agent is doing now" (docs/design/system/components/glass-mini.md; cohesion's sight,
// ADR 0036): one line per agent computer that is running, on Now, with the step it is on. Tap it
// and Glass opens for that computer. Read only: watching changes nothing and asks for nothing.
//
// This slice draws the pill variant (the status mark and the step line, no picture) on every
// width: the live picture needs a light frame source (sight.frame stills, or a small view-only
// viewer), which the Deck does not open per card yet. Steps are the acting module's own summaries,
// never screen text.
//
//   sight.targets            the agents' computers (kind "agent"), live or not, and who holds the keyboard
//   sight.steps {target}     the last step of each, at start
//   sight.stepped            each new step; a target not seen yet reloads the targets
//   computer.*               a computer started or stopped: reload the targets
//
// Nothing polls. The age ("now", "4 s") is redrawn only when a step or a target changes, and the
// live region announces a new step at most once every 5 s. A box without sight shows nothing.

import { h, put } from "./dom.js";
import { statusMark } from "./status-mark.js";

/** An agent's name from a sight target ("agent:kit"). @param {string} t */
export const agentOf = t => (typeof t === "string" && t.startsWith("agent:") ? t.slice(6) : null);

/** The age beside a step. @param {number} at @param {number} now */
export function age(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 3) return "now";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** A step's status mark: running while it is fresh on a live computer, else done or failed.
 * @param {{ ok?: boolean, at?: number } | null} step @param {boolean} live @param {number} now */
export function stepStatus(step, live, now) {
  if (!step) return live ? "running" : "done";
  if (step.ok === false) return "failed";
  return live && now - (step.at || 0) < 10_000 ? "running" : "done";
}

/**
 * Mount the lines into `el`. Returns stop().
 * @param {HTMLElement} el
 * @param {{ attempt: (name: string, input?: Record<string, any>) => Promise<{ data?: any, error?: any }>,
 *   on: (type: string, fn: (e: any) => void) => () => void, now?: () => number, href?: (agent: string) => string }} deps
 */
export function mountGlassMini(el, { attempt, on, now = Date.now, href = a => `/agents/${encodeURIComponent(a)}/glass` }) {
  /** @type {Map<string, { agent: string, live: boolean, holder: string | null, step: any }>} */
  const shown = new Map();
  let off = false, said = 0, reading = /** @type {Promise<void> | null} */ (null);
  const live = h("div", { class: "gm-say", role: "status", "aria-live": "polite" });

  const draw = () => {
    const t = now();
    const rows = [...shown.values()].filter(c => c.live);
    el.hidden = !rows.length;
    put(el, rows.map(c => {
      const s = c.step;
      const words = s ? String(s.summary || s.action || "") : "Starting its computer";
      return h("a", { class: "gm-pill", href: href(c.agent), "aria-label": `Open Glass for ${c.agent}'s computer`, title: words },
        statusMark(stepStatus(s, c.live, t), { beside: true }),
        h("span", { class: "gm-agent" }, c.agent),
        h("span", { class: "gm-step" }, words),
        h("span", { class: "gm-age" }, c.holder ? `${c.holder} has the keyboard` : s ? `· ${age(s.at, t)}` : ""),
        s && s.ok === false && s.why ? h("span", { class: "gm-why" }, String(s.why)) : null);
    }), live);
  };

  const targets = () => reading ??= (async () => {
    if (off) return;
    const r = await attempt("sight.targets", {});
    if (off) return;
    if (r.error) { if (r.error.code === "no_such_tool" || r.error.code === "unknown_tool") off = true; return; }
    const list = (r.data?.targets || []).filter((/** @type {any} */ x) => x && x.kind === "agent" && agentOf(x.target));
    const keep = new Set(list.map((/** @type {any} */ x) => x.target));
    for (const k of [...shown.keys()]) if (!keep.has(k)) shown.delete(k);
    await Promise.all(list.map(async (/** @type {any} */ x) => {
      const had = shown.get(x.target);
      const c = { agent: /** @type {string} */ (agentOf(x.target)), live: !!x.live, holder: typeof x.holder === "string" ? x.holder : null, step: had?.step || null };
      shown.set(x.target, c);
      if (!had && c.live) {
        const s = await attempt("sight.steps", { target: x.target, limit: 1 });
        if (!s.error && s.data?.steps?.[0]) c.step = s.data.steps[0];
      }
    }));
    draw();
  })().finally(() => { reading = null; });

  const offs = [
    on("sight.stepped", e => {
      const p = e?.payload || {};
      const c = shown.get(p.target);
      if (!c) { if (agentOf(p.target)) void targets(); return; }
      c.step = p;
      draw();
      const t = now();
      if (t - said >= 5000) { said = t; put(live, `${c.agent}: ${p.summary || p.action || "a step"}`); }
    }),
    on("computer.*", () => { void targets(); }),
  ];
  void targets();
  return () => { off = true; for (const f of offs) f(); };
}
