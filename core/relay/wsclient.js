// @ts-check
// wsclient: the client half of RFC 6455 that the bridge needs to stand in for a device's WebSocket (ADR 0026, section 4). vyred's stream router speaks the server half; here frames going in are masked
// and frames coming out are not. Fragmented messages are reassembled, so each whole message becomes one data frame in the channel. The framing itself is lib/ws.js; this file is the bridge's shape of it
// ({ op, payload }) and its size limit.

import { encodeFrame, FrameParser } from "../../lib/ws.js";

export const OP = Object.freeze({ text: 1, binary: 2, close: 8, ping: 9, pong: 10 });
/** A message bigger than the relay's frame limit could not cross the channel whole. */
export const MAX_MESSAGE = (1 << 20) - 64;

/** One masked client frame, fin=1. @param {Buffer} payload @param {number} opcode */
export const clientFrame = (payload, opcode) => encodeFrame(payload, opcode, true);

/** Cuts a server's byte stream into whole messages and control frames. Throws on a protocol error. */
export class ServerFrames {
  constructor() { this.parser = new FrameParser({ masked: false, max: MAX_MESSAGE }); }

  /** @param {Buffer} chunk @returns {Array<{ op: number, payload: Buffer }>} */
  push(chunk) {
    let events;
    try { events = this.parser.push(chunk); }
    catch (e) { throw /over the|message of over/.test(String(/** @type {Error} */ (e).message)) ? new Error("message too big for the relay") : e; }
    return /** @type {any[]} */ (events).map(e => e.control ? { op: OP[/** @type {"close"|"ping"|"pong"} */ (e.control)], payload: e.payload } : { op: e.opcode, payload: e.message });
  }
}
