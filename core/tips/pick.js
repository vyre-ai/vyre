// @ts-check
// pick: which one tip a surface shows now, or none and why. Pure and deterministic (no clock, no
// randomness of its own), so every rule below is pinned by a test. The tips module feeds it the
// declared tips, what has been shown, and what the person has used.
//
// The no-nag rules come first, in this order, and any one of them means no tip:
//   off (tips.enabled false), busy (an ask, a prompt, a running turn or typing on that surface),
//   gap (this surface showed one less than `gapMinutes` ago), spread (any surface showed one in
//   the last two minutes), cap (six shown in the last 24 hours, across every surface).
// Then the first tier with an eligible tip wins:
//   1. current: the module the person is in (context.module), trigger on-use. While they have
//      used it fewer than three times only first-use tips; after that power tips first.
//   2. new-module: only when idle, never-used tips about modules they have not touched, taking
//      the module that went longest without a tip first, then by name.
//   3. update: only when idle, tips newer than the version they last saw (and every after-update
//      tip of that release).
//   4. idle: only when idle, idle tips about modules they have used.
// Within a tier, manifest order decides. A tip is eligible when it names this surface, is not
// dismissed, was shown fewer than `maxShows` times, and is not newer than what runs.

import { compareVersions } from "./check.js";

export const DEFAULTS = { enabled: true, gapMinutes: 30, perDay: 6, spreadMinutes: 2, maxShows: 2, learnedAfter: 3 };
const MIN = 60_000, DAY = 86_400_000;

/**
 * @param {{
 *   tips: import("./check.js").Tip[],
 *   surface: string,
 *   context?: { module?: string, idle?: boolean, busy?: boolean },
 *   now: number,
 *   settings?: Partial<typeof DEFAULTS>,
 *   shown: Map<string, { shows: number, last: number, dismissed: boolean }>,
 *   used: Map<string, number>,
 *   log: { surface: string, at: number }[],
 *   lastTipAt?: Map<string, number>,
 *   running: (tip: import("./check.js").Tip) => string,
 *   seenVersion: (tip: import("./check.js").Tip) => string | null,
 * }} s
 * @returns {{ tip: import("./check.js").Tip | null, why: string }}
 */
export function pick(s) {
  const o = { ...DEFAULTS, ...(s.settings || {}) };
  const ctx = s.context || {};
  if (!o.enabled) return { tip: null, why: "off" };
  if (ctx.busy) return { tip: null, why: "busy" };
  const recent = s.log.filter(l => s.now - l.at < DAY);
  const mine = recent.filter(l => l.surface === s.surface).reduce((m, l) => Math.max(m, l.at), -Infinity);
  if (s.now - mine < o.gapMinutes * MIN) return { tip: null, why: "gap" };
  if (recent.some(l => s.now - l.at < o.spreadMinutes * MIN)) return { tip: null, why: "spread" };
  if (recent.length >= o.perDay) return { tip: null, why: "cap" };

  const ok = s.tips.filter(t => {
    const st = s.shown.get(t.id);
    return t.surfaces.includes(s.surface) && !(st && (st.dismissed || st.shows >= o.maxShows))
      && compareVersions(t.since, s.running(t)) <= 0;
  });
  const byOrder = (/** @type {import("./check.js").Tip} */ a, /** @type {import("./check.js").Tip} */ b) => a.module.localeCompare(b.module) || a.order - b.order;
  const uses = (/** @type {string} */ m) => s.used.get(m) || 0;
  const isNew = (/** @type {import("./check.js").Tip} */ t) => { const v = s.seenVersion(t); return v !== null && compareVersions(t.since, v) > 0; };

  // 1. The module the person is in.
  if (ctx.module) {
    const here = ok.filter(t => t.about === ctx.module && t.trigger === "on-use").sort(byOrder);
    const levels = uses(ctx.module) < o.learnedAfter ? ["first-use"] : ["power", "first-use"];
    for (const lv of levels) { const t = here.find(x => x.level === lv); if (t) return { tip: t, why: "current" }; }
  }
  if (!ctx.idle) return { tip: null, why: "none" };

  // 2. Modules they have not tried.
  const fresh = ok.filter(t => t.trigger === "never-used" && uses(t.about) === 0 && t.about !== ctx.module);
  if (fresh.length) {
    const last = (/** @type {string} */ m) => (s.lastTipAt && s.lastTipAt.get(m)) || 0;
    fresh.sort((a, b) => last(a.about) - last(b.about) || a.about.localeCompare(b.about) || a.order - b.order);
    return { tip: fresh[0], why: "new-module" };
  }

  // 3. New in this update.
  const upd = ok.filter(t => isNew(t)).sort((a, b) => compareVersions(b.since, a.since) || byOrder(a, b));
  if (upd.length) return { tip: upd[0], why: "update" };

  // 4. Idle tips for what they already use.
  const idle = ok.filter(t => t.trigger === "idle" && uses(t.about) > 0).sort(byOrder);
  if (idle.length) return { tip: idle[0], why: "idle" };
  return { tip: null, why: "none" };
}
