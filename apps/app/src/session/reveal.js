// @ts-check
// Every streaming reply on one session screen, revealed at the display's pace by chat's pacer
// (deck/chat/core/pace.js, passed in so this file imports nothing): arrivals move a reply's
// target, the one frame clock moves what shows. The store runs frame(t) once per frame for all
// of them, so a frame is one commit however many rows stream.
//
// - seed(key, length): text already on screen (read on open, or from the cache) shows as it is;
//   only what arrives after it is paced.
// - push(key, length, t): the reply is this long, as of `t` (when its event arrived). The first
//   push of a reply that had nothing on screen is its first token: frame() says so (`first`,
//   with `arrived`) on the frame its first characters show.
// - finish(key): nothing more is coming. The backlog still drains at the pace (a done that lands
//   with a lump does not jump), then the reply leaves the pacer (`done`).
// - frame(t): each reply's characters to show now. `changed` names the replies that moved (their
//   rows repaint), `samples` the characters each moved this frame (the meter's chars per frame,
//   taken only on frames a reply had a backlog), `active` whether another frame is needed.
// Pure and DOM-free; Node tests drive it with plain numbers.

/**
 * @typedef {{ push(targetLength: number, now: number): void, done(): void, visible(now: number): number, settled(now: number): boolean }} Pacer
 * @typedef {{ key: string, shown: number, first: boolean, arrived: number|null, done: boolean }} Change
 */

/** @param {{ createPacer: () => Pacer }} deps */
export function createReveal({ createPacer }) {
  /** @type {Map<string, { pacer: Pacer, shown: number, target: number, finished: boolean, first: boolean, arrived: number|null }>} */
  const live = new Map();
  /** Lengths on screen that are not paced (read, not streamed here). @type {Map<string, number>} */
  const seeded = new Map();

  return {
    /** @param {string} key @param {number} length */
    seed(key, length) {
      if (!live.has(key)) seeded.set(key, length);
    },
    /** @param {string} key @param {number} length @param {number} t */
    push(key, length, t) {
      let r = live.get(key);
      if (!r) {
        const from = Math.min(seeded.get(key) ?? 0, length);
        seeded.delete(key);
        const pacer = createPacer();
        if (from > 0) {
          // What already shows is not revealed again: the pacer starts caught up to it.
          pacer.push(from, t - 1000);
          pacer.visible(t);
        }
        r = { pacer, shown: from, target: from, finished: false, first: from === 0, arrived: from === 0 ? t : null };
        live.set(key, r);
      }
      r.target = length;
      r.pacer.push(length, t);
    },
    /** @param {string} key */
    finish(key) {
      const r = live.get(key);
      if (r) r.finished = true;
    },
    /** How much of the reply shows; undefined when it is not paced (show all of it). @param {string} key */
    shown(key) {
      return live.get(key)?.shown;
    },
    /** @param {string} key */
    has(key) {
      return live.has(key);
    },
    /** A reply that left the view (a rewind, a reread). @param {string} key */
    drop(key) {
      live.delete(key);
      seeded.delete(key);
    },
    /** @param {number} t @returns {{ changed: Change[], samples: number[], active: boolean }} */
    frame(t) {
      /** @type {Change[]} */
      const changed = [];
      /** @type {number[]} */
      const samples = [];
      let active = false;
      for (const [key, r] of live) {
        const backlog = r.shown < r.target;
        const v = r.pacer.visible(t);
        const settled = v >= r.target;
        const moved = v !== r.shown;
        if (backlog) samples.push(Math.max(0, v - r.shown));
        const first = moved && r.first && r.shown === 0 && v > 0;
        r.shown = v;
        if (first) r.first = false;
        const done = r.finished && settled;
        if (done) live.delete(key);
        else if (!settled) active = true;
        if (moved || done) changed.push({ key, shown: v, first, arrived: first ? r.arrived : null, done });
      }
      return { changed, samples, active };
    },
  };
}
