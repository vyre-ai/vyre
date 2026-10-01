// @ts-check
// gate: which addresses may reach this computer, on its two ports (7000 and the screen's 5900).
//
// Every computer shares one Docker network, and agent code is model-controlled, so another computer must not be able to
// use this one. Two walls, and this is the first: an address gate. The second is what was always there: computerd's own
// 256-bit token for 7000, and the VNC password for the screen.
//
//   The screen (5900) has no token to check, so its gate is strict: only vyred's pinned address, or loopback (this
//   computer's own processes), is let in. Before there is a pin, nobody else is.
//   computerd (7000) lets any address connect but serves an address that is not pinned nothing at all: the connection is
//   closed with no answer. The one exception is a valid token (the owner's or an identified CDP client's): it proves
//   the caller is vyred, so it serves the request and pins that address. That is how a vyred that comes back at a new
//   address is recognised, with no restart. A wrong token never pins, and an address that keeps failing is closed on
//   at the connection (rate limit, below).
//
// What this rests on, stated so a change that breaks it is noticed:
//   - no computer has NET_RAW or NET_ADMIN, and none can gain a capability (cap_drop ALL, no-new-privileges: driver/policy.js,
//     FORBIDDEN_CAPS), so no process in a computer can forge a source address or poison the bridge;
//   - nothing in a computer forwards remote traffic to loopback (tailscale in userspace mode, `tailscale serve`, socat, a local
//     proxy to 7000 or 5900 would make a remote peer look local, and loopback is let in). None runs: the image has no
//     tailscaled, and image/loopback.test.js and the J7 matrix step 7.5c check it.

/** @param {unknown} a */
export const plainAddr = a => String(a || "").replace(/^::ffff:/, "");
/** @param {unknown} a */
export const isLoopback = a => plainAddr(a) === "127.0.0.1" || plainAddr(a) === "::1";

const WINDOW_MS = 60_000, MAX_FAILS = 20;

/** @param {{ now?: () => number }} [o] */
export function createGate({ now = Date.now } = {}) {
  /** @type {string|null} */
  let pinned = null;
  /** @type {Map<string, number[]>} */
  const fails = new Map();
  return {
    /** The screen's gate: vyred's pinned address or this computer's own processes. @param {string|undefined} addr */
    allowedScreen(addr) { return isLoopback(addr) || (pinned !== null && plainAddr(addr) === pinned); },
    /** Is this a peer computerd answers without a token? (loopback, and the pinned address) @param {string|undefined} addr */
    known(addr) { return isLoopback(addr) || (pinned !== null && plainAddr(addr) === pinned); },
    /** vyred showed a valid token from this address: it is the one. @param {string|undefined} addr */
    pin(addr) { if (!isLoopback(addr)) pinned = plainAddr(addr); },
    /** A request from an address that is not known and showed no valid token. @param {string|undefined} addr */
    failed(addr) {
      const k = plainAddr(addr), t = now();
      const l = (fails.get(k) || []).filter(x => t - x < WINDOW_MS);
      l.push(t); fails.set(k, l);
    },
    /** Has this address failed so often that it is closed on at the connection? @param {string|undefined} addr */
    blocked(addr) {
      const k = plainAddr(addr);
      if (this.known(addr)) return false;
      const t = now();
      return (fails.get(k) || []).filter(x => t - x < WINDOW_MS).length >= MAX_FAILS;
    },
    get pinned() { return pinned; },
  };
}
