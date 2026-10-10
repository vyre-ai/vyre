// @ts-check
// What the phone tells you when you are not looking (SPEC-0.3.0 11.8 and 12.8). Vyre sends nothing to a push service: the app asks its own server over the connection it already keeps and
// makes the notice itself. Two things are worth a notice: a group of calls waiting for your yes, and a turn that finished while you were away. Pure functions here; the loop is notices.ts.

/** A session is working when its status says so. @param {any} s */
export const isWorking = (s) => /^(run|work|busy|start|think|stream)/i.test(String(s || ""));

/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

/**
 * Notices for what waits for the person's yes, once each. `seen` is the set of ids already told; it is returned grown.
 * @param {Set<string>} seen @param {any} pending approvals.pending's answer
 * @returns {{ notices: { id: string, title: string, body?: string, route: string }[], seen: Set<string> }}
 */
export function approvalNotices(seen, pending) {
  const next = new Set(seen);
  /** @type {{ id: string, title: string, body?: string, route: string }[]} */ const notices = [];
  const cards = Array.isArray(pending && pending.approvals) ? pending.approvals : [];
  const grouped = new Set();
  for (const g of Array.isArray(pending && pending.groups) ? pending.groups : []) {
    const id = `approval-group:${g.id}:${g.size}`;
    grouped.add(String(g.id));
    if (next.has(id)) continue;
    next.add(id);
    notices.push({ id, title: `${g.size} ${g.size === 1 ? "call waits" : "calls wait"} for your yes`, body: clip(String(g.line || ""), 180), route: "/u/now" });
  }
  for (const c of cards) {
    if (!c || !c.id || (c.group && grouped.has(String(c.group)))) continue;
    const id = `approval:${c.id}`;
    if (next.has(id)) continue;
    next.add(id);
    notices.push({ id, title: "Waiting for your approval", body: clip(String(c.line || c.title || ""), 180), route: "/u/now" });
  }
  return { notices, seen: next };
}

/**
 * "It's done": a session that was working at the last look and is not now. Told once per finish, never for a session the person has open (`openId`).
 * @param {Map<string, string>} was id -> status at the last look @param {any[]} threads threads.list @param {{ openId?: string | null }} [o]
 * @returns {{ notices: { id: string, title: string, body: string, route: string }[], was: Map<string, string> }}
 */
export function doneNotices(was, threads, o = {}) {
  const now = new Map();
  /** @type {{ id: string, title: string, body: string, route: string }[]} */ const notices = [];
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || !t.id) continue;
    const status = String(t.status || "");
    now.set(String(t.id), status);
    if (!isWorking(was.get(String(t.id))) || isWorking(status) || o.openId === t.id) continue;
    const failed = /^(fail|error|stop|cancel)/i.test(status);
    const name = String(t.name || t.title || "Your assistant");
    notices.push({ id: `done:${t.id}:${t.last || t.turns || 0}`, title: failed ? `${clip(name, 40)} stopped` : `${clip(name, 40)} is done`, body: failed ? "It stopped before it finished. Open it to see why." : "Open it to read what it did.", route: `/session/${encodeURIComponent(String(t.id))}` });
  }
  return { notices, was: now };
}


/**
 * One loop for any number of askers: the first ask starts it, the others join it, and it stops when the last asker stops (the screen and the headless task of the Android service both ask for the notice loop;
 * two loops would tell the person everything twice).
 * @template A @param {(arg: A) => () => void} make starts a loop and returns its stop @returns {(arg: A) => () => void}
 */
export function sharedLoop(make) {
  /** @type {{ stop: () => void, refs: number } | null} */ let running = null;
  return arg => {
    if (!running) running = { stop: make(arg), refs: 0 };
    const mine = running; mine.refs++;
    let done = false;
    return () => { if (done) return; done = true; if (--mine.refs <= 0) { mine.stop(); if (running === mine) running = null; } };
  };
}
