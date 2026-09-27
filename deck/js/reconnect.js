// @ts-check
// The Reconnecting pill (docs/adr/0029-resilience.md, R3): what the shell shows while the box does
// not answer, driven by the event stream's state (api.js "deck:stream", follow()'s onState).
//
//   hidden while the stream is open;
//   shown only after the first failed retry (attempt 2), so a blip that heals on the first try
//   shows nothing;
//   "Reconnecting", and 60 s after the box last answered "Reconnecting since 14:32", changed once
//   by one timer started when the pill shows and cleared when it goes (no interval);
//   "This phone is offline." while the device says it has no network.
//
// No DOM here: the shell passes show and hide, so the timing is tested with fake timers.

import { clock } from "./fmt.js";

/** How long the box may be gone before the pill says since when. */
export const SINCE_AFTER = 60_000;

/**
 * @param {{ show: (text: string) => void, hide: () => void, online?: () => boolean, now?: () => number, fmt?: (t: number) => string }} o
 */
export function reconnectPill({ show, hide, online = () => typeof navigator === "undefined" || navigator.onLine !== false, now = Date.now, fmt = clock }) {
  let shown = false;
  let since = /** @type {number|null} */ (null);
  /** @type {any} */ let timer = null;
  const words = () => (!online() ? "This phone is offline."
    : since !== null && now() - since >= SINCE_AFTER ? `Reconnecting since ${fmt(since)}` : "Reconnecting");
  const off = () => {
    since = null;
    if (!shown) return;
    shown = false; clearTimeout(timer); timer = null;
    hide();
  };
  return {
    /** follow()'s state. @param {{ state: string, attempt: number, since: number|null }} s */
    state(s) {
      if (s.state === "open" || s.state === "stopped") return off();
      if (s.state !== "reconnecting" || s.attempt < 2) return;
      since = s.since ?? since ?? now();
      if (!shown) {
        shown = true;
        timer = setTimeout(() => { timer = null; if (shown) show(words()); }, Math.max(0, since + SINCE_AFTER - now()));
      }
      show(words());
    },
    /** The network came or went: the words may change, nothing else. */
    net() { if (shown) show(words()); },
    get shown() { return shown; },
  };
}
