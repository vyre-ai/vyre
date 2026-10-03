// @ts-check
// core/stream's resumable client as a StreamSource (the shape the chat store takes). The client's
// `connect` and the way to open a duplex are passed in, so this file imports nothing and the app
// decides how the box is reached (direct or over the relay). The client already drops repeats and
// resubscribes from its last cursor; the store only folds what it delivers.
//
//   const source = streamSource({ connect, open: ({ from }) => wsDuplex(url + "?from=" + from), send, answer, stop });

/** The client's states in the words the header uses. @param {string} s @returns {"connecting" | "live" | "offline"} */
export function stateOf(s) {
  if (s === "live") return "live";
  if (s === "closed") return "offline";
  return "connecting";
}

/**
 * @param {{ connect: (o: any) => { close(): void }, open: (a: { from: number, attempt: number }) => any,
 *   snapshot?: () => any, send?: (text: string) => void, answer?: (ask: string, decision: "approve" | "deny") => void, stop?: () => void }} o
 */
export function streamSource(o) {
  return {
    /** @param {{ from: number, onFrame: (f: any) => void, onState?: (s: "connecting" | "live" | "offline") => void }} c */
    connect(c) {
      const h = o.connect({ open: o.open, from: c.from, snapshot: o.snapshot, onFrame: c.onFrame, onState: (/** @type {string} */ s) => c.onState?.(stateOf(s)) });
      return { close: () => h.close() };
    },
    /** @param {string} text */
    send(text) { o.send?.(text); },
    /** @param {string} ask @param {"approve" | "deny"} decision */
    answer(ask, decision) { o.answer?.(ask, decision); },
    stop() { o.stop?.(); },
  };
}
