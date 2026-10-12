// @ts-check
// A joined member's app has no stream of the team's events, so the Store's "something changed, read again" signal comes from asking: every POLL_MS, while the app is visible and a joined team is showing, one
// `records.events` call through the door (filtered for her by the door like every read) after the last event this poll saw. A new event makes `onEvent` fire once (the Store refetches). The cursor lives HERE, not
// in the door session, so the session closing after its idle minute loses nothing. The first look only learns where the log is: it fires nothing.
export const POLL_MS = 5000;

/**
 * @param {{ spaceNow: () => Promise<string | null>, ask: (space: string, input: Record<string, unknown>) => Promise<any>, onEvent: (e: any) => void, visible?: () => boolean,
 *   sleep?: (ms: number) => Promise<void>, pollMs?: number }} o
 * @returns {() => void} stop
 */
export function startEventPoll(o) {
  const sleep = o.sleep || ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const visible = o.visible || (() => true);
  const pollMs = o.pollMs ?? POLL_MS;
  /** @type {Map<string, { seq: number | null, last: string }>} */ const marks = new Map();
  let stopped = false;
  const seqOf = (/** @type {any} */ e) => (Number.isInteger(e?.seq) ? e.seq : Number.isInteger(e?.n) ? e.n : null);
  const idOf = (/** @type {any} */ e) => String(e?.id ?? e?.eid ?? `${e?.time ?? e?.at ?? ""}|${e?.type ?? ""}|${e?.subject ?? ""}`);
  void (async () => {
    while (!stopped) {
      await sleep(pollMs);
      if (stopped || !visible()) continue;
      let space = null;
      try { space = await o.spaceNow(); } catch { /* none */ }
      if (!space) continue;
      const mark = marks.get(space);
      try {
        const r = await o.ask(space, mark && mark.seq !== null ? { since: mark.seq, limit: 200 } : { limit: 200 });
        const events = Array.isArray(r) ? r : Array.isArray(r?.events) ? r.events : [];
        const newest = events.length ? events[events.length - 1] : null;
        if (!mark) { marks.set(space, { seq: newest ? seqOf(newest) : 0, last: newest ? idOf(newest) : "" }); continue; }
        const at = events.findIndex((/** @type {any} */ e) => idOf(e) === mark.last);
        const fresh = mark.seq !== null ? events.filter((/** @type {any} */ e) => { const s = seqOf(e); return s === null || s > /** @type {number} */ (mark.seq); }) : at >= 0 ? events.slice(at + 1) : events;
        if (newest) marks.set(space, { seq: seqOf(newest) ?? mark.seq, last: idOf(newest) });
        for (const e of fresh) { try { o.onEvent(e); } catch { /* a screen's redraw */ } }
      } catch { /* the next look tries again; a refusal in words is shown by the screens' own reads */ }
    }
  })();
  return () => { stopped = true; };
}
