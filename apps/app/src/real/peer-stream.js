// @ts-check
// The duplex core/stream/client.js opens for a chat followed over the peer wire.
//
// The peer client replays frames that arrived in the same chunk as the open call's answer before
// openStream returns, and the stream client registers onMessage only after open() resolves. A
// duplex that delivers those frames into an empty listener list loses them. The client's cursor
// then stays behind, the next frame looks like a gap, and the reconnect loses its catch-up the
// same way. An open chat never shows the reply. Hold every frame until onMessage is registered,
// then hand the held ones over in order. info (head, viewer, floor) is filled before this
// resolves: the chat reads head as soon as open() returns, to tell a replay from a live frame.

/**
 * @param {(tool: string, input: any, handlers: { onframe: (data: any) => void, onend: (why: string) => void }) => Promise<{ result?: any, close?: () => void }>} openStream
 * @param {{ chat: string, from: number }} input
 */
export async function peerStreamDuplex(openStream, input) {
  /** @type {any[]} */
  const pending = [];
  /** @type {Array<(m: any) => void>} */
  const msg = [];
  /** @type {Array<() => void>} */
  const shut = [];
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const cb of shut) cb();
  };
  const s = await openStream("stream.open-peer", input, {
    onframe: (data) => {
      if (!msg.length) { pending.push(data); return; }
      for (const cb of msg) cb(data);
    },
    onend: end,
  });
  const r = (s && s.result) || {};
  return {
    send() {},
    onMessage: (/** @type {(m: any) => void} */ cb) => {
      msg.push(cb);
      const batch = pending.splice(0);
      for (const data of batch) cb(data);
    },
    // A stream that already ended must not drop the duplex before the same turn registers
    // onMessage: the held frames flush first, then the close runs.
    onClose: (/** @type {() => void} */ cb) => {
      shut.push(cb);
      if (ended) queueMicrotask(cb);
    },
    close: () => { try { s && s.close && s.close(); } catch { /* closed */ } end(); },
    info: { viewer: r.viewer, head: r.head, floor: r.floor },
  };
}
