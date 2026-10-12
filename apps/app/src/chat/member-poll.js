// @ts-check
// A team member's chat, read over the member door (chat.read): the same duplex core/stream's resumable client opens a socket for, made of calls. ONE session is held for the open chat (the caller opens it and closes it
// with the chat); it asks for the frames after its cursor every POLL_MS while the screen is visible, hands each to the client once, in order, and says "heartbeat" when the log has nothing new so the client's idle timer
// stays quiet. A full page is followed at once (history from the start comes in 200-frame pages). Answers arrive in POLL_MS steps, a whole message or its text so far: nothing here pushes. No frame is invented: what
// comes back is what the door drew for her (her join floor, the kernel's say per frame).
import { heartbeatFrame, resetFrame } from "../../../../core/stream/protocol.js";

export const POLL_MS = 3500;
export const PAGE = 200;
const FAIL_LIMIT = 3;

/**
 * @param {{ call: (name: string, args: any[]) => Promise<any>, chat: string, from: number, visible?: () => boolean, sleep?: (ms: number) => Promise<void>, pollMs?: number, onEnd?: () => void }} o
 * `call` is the held session's call ("chat.read", [{ chat, from, limit }]); `chat` is the chat id.
 * @returns {Promise<{ send(m: unknown): void, onMessage(cb: (m: any) => void): void, onClose(cb: () => void): void, close(): void, info: { viewer?: string, head?: number, floor?: number } }>}
 */
export async function pollDuplex(o) {
  const sleep = o.sleep || ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const visible = o.visible || (() => true);
  const pollMs = o.pollMs ?? POLL_MS;
  /** @type {Array<(m: any) => void>} */ const msg = [];
  /** @type {Array<() => void>} */ const shut = [];
  let closed = false, cursor = Math.max(0, o.from | 0);
  const end = () => { if (closed) return; closed = true; for (const cb of shut) { try { cb(); } catch { /* a listener */ } } try { o.onEnd?.(); } catch { /* closing */ } };
  const first = await o.call("chat.read", [{ chat: o.chat, from: cursor, limit: 0 }]);
  const info = { viewer: typeof first.viewer === "string" ? first.viewer : undefined, head: typeof first.head === "number" ? first.head : undefined, floor: typeof first.floor === "number" ? first.floor : undefined };
  const deliver = (/** @type {any} */ f) => { for (const cb of msg) { try { cb(f); } catch { /* a listener */ } } };
  let started = false;
  const run = () => { if (started || closed) return; started = true; void (async () => {
    let failed = 0;
    while (!closed) {
      if (!visible()) { await sleep(pollMs); continue; }
      let r;
      try { r = await o.call("chat.read", [{ chat: o.chat, from: cursor, limit: PAGE }]); failed = 0; } catch { if (++failed >= FAIL_LIMIT) { end(); return; } await sleep(pollMs * 2); continue; }
      if (closed) return;
      if (r && r.reset) { deliver(resetFrame(o.chat, r.reset, r.head)); end(); return; }
      const frames = Array.isArray(r && r.frames) ? r.frames : [];
      for (const f of frames) deliver(f);
      if (typeof r.next === "number" && r.next > cursor) cursor = r.next;
      if (frames.length >= PAGE) continue;                       // a full page: more is waiting
      deliver(heartbeatFrame(o.chat, cursor));                   // caught up: keep the client's idle timer quiet
      await sleep(pollMs);
    }
  })(); };
  // the client subscribes (send) once its listeners are in place: polling starts then, so no frame is delivered to nobody
  return { send() { run(); }, onMessage: (cb) => { msg.push(cb); }, onClose: (cb) => { shut.push(cb); if (closed) cb(); }, close: end, info };
}
