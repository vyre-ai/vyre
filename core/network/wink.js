// @ts-check
// network.wink.*: the names the surfaces call for the person's network (spec 4.7). The work is the Wink module's (wink.network.*, internal, core/wink/network.js);
// this module owns the `network.` prefix, so it holds the public names and does what a public name needs: who may ask, and for a change the owner and their presence.
//
//   network.wink.status  read, for the owner's surfaces, modules, devices and the assistant; never a guest.
//   network.wink.whois   read, same callers.
//   network.wink.join    change, the owner's, with presence.
//   network.wink.leave   change, the owner's, with presence.
//
// Nothing here reads a tag, a host name or another product's status. A box without the Wink module answers "unavailable" and says so.

import { agentClaim } from "../modules/index.js";

const str = { type: "string" };
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Register the four public tools. @param {any} ctx */
export function registerWinkNetwork(ctx) {
  /** A read: anyone but a guest or an anonymous caller. */
  const readers = (caller, what) => {
    const c = String(caller || "");
    if (!c || c === "anonymous" || c.startsWith("tailnet-guest:")) throw fail("denied", `${what} is for the owner's own devices and modules`);
  };
  /** A change: the owner's, never an agent's or a guest's. */
  const owner = (caller, meta, what) => {
    readers(caller, what);
    const c = String(caller);
    if ((meta && meta.agent) || agentClaim(c) || ["hook", "onboard"].includes(c)) throw fail("denied", `${what} is the owner's, from the Capsule, the Deck or this computer's terminal`);
  };
  /** The Wink module's answer, its error thrown as the error it is. @param {Promise<any>} call */
  const via = async call => {
    const r = await call;
    if (r && typeof r === "object" && "error" in r && r.error) throw Object.assign(new Error(r.error.message || String(r.error)), { code: r.error.code || "unavailable" });
    return r && typeof r === "object" && "data" in r ? r.data : r;
  };

  ctx.tool("network.wink.status", {
    description: "How the network looks from this machine: whether you are signed in, per space whether the link is up and whether it goes direct or through the relay, the relay, the server's door, your storage devices and the clock. Read only. Answers { identity, spaces, relay, storage, clock, otherVpn }.",
    input: obj({ ping: { type: "boolean" } }),
    run: (input, meta = {}) => { readers(meta.caller, "the network status"); return via(ctx.call("wink.network.status", { ping: input && input.ping })); },
  });
  ctx.tool("network.wink.whois", {
    description: "Who is the connected device at an address, or with a device id: its device id, identity, kind and space, from the identity list and the connections this machine admitted. Answers { eid, identity, kind, space, online, via }.",
    input: obj({ addr: str, eid: str }),
    run: (input, meta = {}) => { readers(meta.caller, "who is"); return via(ctx.call("wink.network.whois", input || {})); },
  });
  ctx.tool("network.wink.join", {
    description: "Bring up this machine's link to a space it has been given a way into. With another VPN running here the link goes through the relay only. Answers { joined, space }.",
    input: obj({ space: str }, ["space"]),
    presence: { summary: async input => `Link this computer to ${(input && input.space) || "a space"}` },
    run: (input, meta = {}) => { owner(meta.caller, meta, "joining a space's network"); return via(ctx.call("wink.network.join", { space: input.space })); },
  });
  ctx.tool("network.wink.leave", {
    description: "Take this machine's link to a space down. A server that hosts the space does not leave it. Answers { left, space }.",
    input: obj({ space: str }, ["space"]),
    presence: { summary: async input => `Unlink this computer from ${(input && input.space) || "a space"}` },
    run: (input, meta = {}) => { owner(meta.caller, meta, "leaving a space's network"); return via(ctx.call("wink.network.leave", { space: input.space })); },
  });
}
