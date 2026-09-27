// @ts-check
// "What the agent is doing now" (docs/design/system/components/glass-mini.md; cohesion's sight,
// ADR 0036): one line per agent computer that is running, on Now, with the step it is on. Tap it
// and Glass opens for that computer. Read only: watching changes nothing and asks for nothing.
//
// Each is the card variant: a still of the agent's screen (sight.frame, a JPEG) with the Live
// badge, and the step line under it. The still is read again when that computer takes a step
// (sight.stepped), never on a timer: its screen only changes in a way worth showing when it acts.
// While a person signs in on it (the shield) the picture pauses, dimmed, until
// computer.unshielded. A box without sight.frame draws the pill (the step line alone). The one
// live view (sight.watch) stays in Glass, which the card opens. Steps are the acting module's own
// summaries, never screen text.
//
//   sight.targets            the agents' computers (kind "agent"), live or not, and who holds the keyboard
//   sight.steps {target}     the last step of each, at start
//   sight.stepped            each new step, and a fresh still of that screen; a target not seen yet reloads the targets
//   sight.frame {target}     the still, at 480 wide (640 on a phone)
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
  if (m < 60) return `${m} min`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr} h` : `${Math.round(hr / 24)} d`;
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
 *   on: (type: string, fn: (e: any) => void) => () => void, now?: () => number, href?: (agent: string) => string, width?: () => number }} deps
 */
export function mountGlassMini(el, { attempt, on, now = Date.now, href = a => `/agents/${encodeURIComponent(a)}/glass`, width = () => 480 }) {
  /** @typedef {{ agent: string, live: boolean, holder: string | null, step: any, still: string | null, paused: string | null, busy: boolean, again: boolean }} Card */
  /** @type {Map<string, Card>} */
  const shown = new Map();
  let off = false, stills = true, said = 0, reading = /** @type {Promise<void> | null} */ (null);

  /** Read one screen's still; a read already going runs once more after it. @param {string} target */
  const still = async target => {
    const c = shown.get(target);
    if (!c || !c.live || !stills || off) return;
    if (c.busy) { c.again = true; return; }
    c.busy = true;
    try {
      do {
        c.again = false;
        const r = await attempt("sight.frame", { target, maxWidth: width() });
        if (off) return;
        if (r.error) {
          if (r.error.code === "no_such_tool" || r.error.code === "unknown_tool") { stills = false; break; }
          c.paused = /sign/i.test(String(r.error.message || "")) ? "Picture paused while a person signs in" : "Picture paused · steps still live";
        } else if (typeof r.data?.image === "string") {
          c.still = `data:${r.data.mime || "image/jpeg"};base64,${r.data.image}`;
          c.paused = null;
        }
      } while (c.again && !off);
    } finally { c.busy = false; }
    draw();
  };
  const live = h("div", { class: "gm-say", role: "status", "aria-live": "polite" });

  const draw = () => {
    const t = now();
    const rows = [...shown.values()].filter(c => c.live);
    el.hidden = !rows.length;
    put(el, rows.map(c => {
      const s = c.step;
      const words = s ? String(s.summary || s.action || "") : "Starting its computer";
      const line = [statusMark(stepStatus(s, c.live, t), { beside: true }),
        h("span", { class: "gm-agent" }, c.agent),
        h("span", { class: "gm-step" }, words),
        h("span", { class: "gm-age" }, c.holder ? `${c.holder} has the keyboard` : s ? `· ${age(s.at, t)}` : ""),
        s && s.ok === false && s.why ? h("span", { class: "gm-why" }, String(s.why)) : null];
      const label = `Open Glass for ${c.agent}'s computer`;
      // No still (a box without sight.frame, or none read yet): the pill.
      if (!stills || (!c.still && !c.paused)) return h("a", { class: "gm-pill", href: href(c.agent), "aria-label": label, title: words }, line);
      return h("a", { class: "gm-card", href: href(c.agent), "aria-label": label, title: words },
        h("div", { class: "gm-frame" + (c.paused ? " paused" : "") },
          c.still ? h("img", { src: c.still, alt: "", "aria-hidden": "true" }) : null,
          c.paused ? null : h("span", { class: "gm-live" }, "Live")),
        c.paused ? h("span", { class: "gm-paused" }, c.paused) : null,
        h("div", { class: "gm-line" }, line));
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
      // The same card object stays (a still being read writes into it); only its state moves.
      /** @type {Card} */
      const c = had || { agent: /** @type {string} */ (agentOf(x.target)), live: false, holder: null, step: null, still: null, paused: null, busy: false, again: false };
      c.live = !!x.live;
      c.holder = typeof x.holder === "string" ? x.holder : null;
      shown.set(x.target, c);
      if (!had && c.live) {
        const s = await attempt("sight.steps", { target: x.target, limit: 1 });
        if (!s.error && s.data?.steps?.[0]) c.step = s.data.steps[0];
      }
      if (c.live && !c.still && !c.paused) void still(x.target);
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
      void still(p.target);
      const t = now();
      if (t - said >= 5000) { said = t; put(live, `${c.agent}: ${p.summary || p.action || "a step"}`); }
    }),
    on("computer.*", e => {
      // The shield is down: the paused picture comes back.
      if (e?.type === "computer.unshielded") for (const [k, c] of shown) if (c.paused) void still(k);
      void targets();
    }),
  ];
  void targets();
  return () => { off = true; for (const f of offs) f(); };
}
