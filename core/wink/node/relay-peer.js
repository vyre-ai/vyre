// @ts-check
// relay-peer: the paired server's side of the relay fallback. It holds one Noise channel to the
// home's route through the relay (core/relay/channel.js deviceSide, the same one every paired device
// uses) and opens a `peer` stream on it for each connection the host wants: {peer: "wink", space}.
// The home's bridge (core/relay/bridge.js) answers 200 and hands the stream to its peer door, as
// the device the channel proved. Only the end-to-end encrypted stream goes through the relay.
// The relay channel code is handed in (`deviceSide` from core/relay/channel.js), so a feature module
// never imports another feature's files (test/boundaries.test.js).

import { streamPipe } from "./peer-wire.js";

const err = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{ deviceSide: (transport: any, o: any) => { receive: (b: Buffer) => void, gone: (r: string) => void, ready: Promise<{ channel: any }> }, url: string, route: string, box: Buffer, keys: { priv: Buffer, pub: Buffer }, hello?: any, WebSocket?: any, connectMs?: number }} o
 *   url: the relay's ws base. route: the home's route id. box: the home's static public key. keys: this device's Noise key.
 * @returns {{ open: (space: string) => Promise<import("./peer-wire.js").Pipe>, close: () => void }}
 */
export function relayPeer(o) {
  const WS = o.WebSocket || globalThis.WebSocket;
  /** @type {Promise<any> | null} */
  let channelP = null;
  /** @type {any} */ let ws = null;
  const reset = () => { channelP = null; ws = null; };

  function channel() {
    if (channelP) return channelP;
    channelP = new Promise((resolve, reject) => {
      const sock = new WS(`${o.url.replace(/\/+$/, "")}/v1/device?route=${o.route}`);
      sock.binaryType = "arraybuffer";
      ws = sock;
      const timer = setTimeout(() => { reject(err("unreachable", "the relay did not answer")); try { sock.close(); } catch { /* gone */ } }, o.connectMs ?? 10_000);
      sock.onerror = () => { clearTimeout(timer); reject(err("unreachable", "the relay is not reachable")); reset(); };
      sock.onopen = () => {
        const side = o.deviceSide({ send: b => sock.send(b), close: (c, r) => sock.close(c, r), get bufferedAmount() { return sock.bufferedAmount; } }, { s: o.keys, box: o.box, route: o.route, hello: o.hello || { v: 1 } });
        sock.onmessage = (/** @type {any} */ e) => side.receive(Buffer.from(e.data));
        sock.onclose = (/** @type {any} */ e) => { side.gone(String(e.reason || "closed")); reset(); };
        side.ready.then(({ channel }) => { clearTimeout(timer); resolve(channel); }, e => { clearTimeout(timer); reject(err("unreachable", e.message)); reset(); });
      };
    });
    channelP.catch(() => {});
    return channelP;
  }

  return {
    /** Open a peer stream to the home for a space; resolves with a pipe once the home has accepted it. @param {string} space */
    async open(space) {
      const ch = await channel();
      const s = ch.open({ peer: "wink", space });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { s.reset("no answer"); reject(err("unreachable", "the home did not accept the peer stream")); }, 10_000);
        s.onhead = h => { clearTimeout(timer); h && h.status === 200 ? resolve(undefined) : reject(err(h?.status === 429 ? "rate_limited" : "denied", `the home refused the peer stream (${h?.status})`)); };
        s.onreset = why => { clearTimeout(timer); reject(err("unreachable", String(why || "reset"))); };
      });
      return streamPipe(s);
    },
    close() { try { ws?.close(1000, "done"); } catch { /* gone */ } reset(); },
  };
}
