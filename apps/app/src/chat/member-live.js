// @ts-check
// A team member's live chat read over the member door (`chat.open` on the wire): the same duplex core/stream's resumable client opens, with frames pushed over the held member session (no 3.5 s poll).

/**
 * @param {{ openChat: (chat: string, from: number, h: { onframe(data: any, seq: number): void, onend?(why: string): void }) => Promise<{ close(): void, result?: any }>, chat: string, from: number, onEnd?: () => void }} o
 */
export async function liveDuplex(o) {
  /** @type {Array<(m: any) => void>} */ const msg = [];
  /** @type {Array<() => void>} */ const shut = [];
  let closed = false;
  let stream = /** @type {{ close(): void, result?: any } | null} */ (null);
  let started = false;
  /** @type {{ viewer?: string, head?: number, floor?: number }} */ const info = {};
  const end = () => {
    if (closed) return;
    closed = true;
    try { stream && stream.close(); } catch { /* closing */ }
    for (const cb of shut) { try { cb(); } catch { /* a listener */ } }
    try { o.onEnd?.(); } catch { /* closing */ }
  };
  const run = () => {
    if (started || closed) return;
    started = true;
    void o.openChat(o.chat, o.from, {
      onframe: (data) => { for (const cb of msg) { try { cb(data); } catch { /* a listener */ } } },
      onend: () => end(),
    }).then((s) => {
      stream = s;
      const r = s.result && typeof s.result === "object" ? s.result : {};
      if (typeof r.viewer === "string") info.viewer = r.viewer;
      if (typeof r.head === "number") info.head = r.head;
      if (typeof r.floor === "number") info.floor = r.floor;
    }).catch(() => end());
  };
  return {
    send() { run(); },
    onMessage: (/** @type {(frame: any) => void} */ cb) => { msg.push(cb); },
    onClose: (/** @type {() => void} */ cb) => { shut.push(cb); if (closed) cb(); },
    close: end,
    info,
  };
}
