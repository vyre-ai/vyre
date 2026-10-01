// @ts-check
// gate: which addresses may connect to this computer's ports (7000 and the screen's 5900).
//
// Every computer shares one Docker network, and agent code is model-controlled, so another computer must not be able to
// dial this one. Once vyred has shown the computer's own token (the owner's, or an identified CDP client's), its address is
// pinned: from then on a connection from any other address, loopback aside (this computer's own processes), is closed before
// a byte is read. Any later valid token re-pins, so a vyred that comes back at a new address is let in once it can show the
// token; a wrong token never pins. Before the first valid token anything may connect, and anything that does can only be
// told 401: the pool pins right after a computer starts (GET /ping). This is the first of two walls; the token and the VNC
// password stay. It trusts the source address, which holds because the computer runs with no NET_RAW, no NET_ADMIN and no
// way to gain a capability (cap_drop ALL, no-new-privileges: driver/policy.js, and the J7 matrix steps 7.4 and 7.5).

/** @param {unknown} a */
export const plainAddr = a => String(a || "").replace(/^::ffff:/, "");
/** @param {unknown} a */
export const isLoopback = a => plainAddr(a) === "127.0.0.1" || plainAddr(a) === "::1";

export function createGate() {
  /** @type {string|null} */
  let pinned = null;
  return {
    /** May this address connect? @param {string|undefined} addr */
    allowed(addr) { return isLoopback(addr) || pinned === null || plainAddr(addr) === pinned; },
    /** vyred showed the token from this address. @param {string|undefined} addr */
    pin(addr) { if (!isLoopback(addr)) pinned = plainAddr(addr); },
    get pinned() { return pinned; },
  };
}
