// @ts-check
// core/daemon/wake-timer: one timer that sleeps until the next thing is due, and does nothing at all when nothing is. The Flows host used to wake every minute and ask the record store twice; an idle box
// now makes no records query between events. `poke()` (called when something may have changed: an event) looks again, at most once a second, and sleeps less if the next wake moved up.

/**
 * @param {{ nextWake: () => Promise<number | null>, tick: () => Promise<any>, now: () => number, log?: (m: string) => void,
 *   setTimer?: (f: () => void, ms: number) => any, clearTimer?: (t: any) => void, maxMs?: number, minMs?: number }} o
 */
export function createWakeTimer(o) {
  const setTimer = o.setTimer || ((f, ms) => { const t = setTimeout(f, ms); if (typeof t.unref === "function") t.unref(); return t; });
  const clearTimer = o.clearTimer || (t => clearTimeout(t));
  const maxMs = o.maxMs ?? 12 * 3_600_000, minMs = o.minMs ?? 1000, log = o.log || (() => {});
  /** @type {any} */ let timer = null;
  let stopped = false, planned = Infinity, busy = false, last = -Infinity, later = false;

  /** Look at when the next thing is due and sleep until then (at most `maxMs`: a cheap safety look twice a day when nothing is due). */
  async function arm() {
    if (stopped) return;
    /** @type {number | null} */ let next = null;
    try { next = await o.nextWake(); } catch (e) { log(`no next wake (${/** @type {Error} */ (e).message})`); }
    if (stopped) return;
    const wait = typeof next === "number" ? Math.min(maxMs, Math.max(minMs, next - o.now())) : maxMs;
    planned = o.now() + wait;
    if (timer) clearTimer(timer);
    timer = setTimer(async () => { timer = null; try { await o.tick(); } catch (e) { log(`tick failed (${/** @type {Error} */ (e).message})`); } void arm(); }, wait);
  }

  /** Something may have changed: look again, and sleep less if the next wake moved up. */
  async function poke() {
    if (stopped || busy) return;
    if (o.now() - last < 1000) { if (!later) { later = true; setTimer(() => { later = false; void poke(); }, 1000); } return; }
    busy = true; last = o.now();
    try { const next = await o.nextWake(); if (typeof next === "number" && next < planned - 500) await arm(); } catch { /* the next look finds it */ } finally { busy = false; }
  }

  return { arm, poke, stop() { stopped = true; if (timer) clearTimer(timer); } };
}
