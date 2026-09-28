// @ts-check
// peers — the three seams the move engine (ADR 0042, federation's core/move/index.js) needs to
// name and reach one of the owner's own OTHER nodes, source-initiated, not the Mac-to-box shape
// core/link/mac.js and core/link/box.js already cover. Built to federation's own contract
// (core/move/index.js's header comment, sent to tailnet directly):
//
//   ownedNode(id) -> { stableId, staticKey } | null
//     Is `id` one of the owner's own paired nodes? Answered from `relay_devices` (relay.devices.
//     node, module-only), ADR 0026's own Noise identity for a paired device — never re-derived
//     from a live network lookup, and never `link_peers` (a different, older Mac<->box pairing
//     mechanism with its own key exchange, not this one). This is the authoritative table
//     federation asked for.
//   openPeer(node) -> { call(tool, input) }
//     A live, source-initiated connection to `node` (the shape ownedNode returned), carried over
//     the owner's own tailnet — never the relay's bridge (ADR 0046, "the relay introduces,
//     Tailscale carries"). Needs the target device to have ALSO reported its tailnet node
//     (relay.devices.path's node_id/node_name, already built, no dependency on ADR 0046 landing);
//     refuses with `not_reachable` when it has not, same as federation's own default seam.
//   selfIdentity() -> { stableId, name, fingerprint }
//     This device's own relay identity, read back from relay.status/relay.devices.node for
//     whichever device row is this process's own — used only to name the source on a consent ask
//     a person answers, not security-critical on its own (openPeer's own pinning is what proves
//     anything).
//
// core/link/transport.js needed no change for this: `connector({ address, verify, pinned })` was
// already symmetric (nothing in it assumes "the Mac" or "the box"); the Mac-to-box shape lived
// only in how core/link/mac.js always called it, never in the function itself.

import { connector, identifyBox } from "./transport.js";

/**
 * @param {any} ctx
 * @returns {(id: string) => Promise<{ stableId: string, staticKey: string } | null>}
 */
export function ownedNode(ctx) {
  return async id => {
    const r = await ctx.call("relay.devices.node", { id: String(id) }, "module:link");
    const d = r && r.data;
    if (!d || !d.stableId || !d.staticKey) return null;
    return { stableId: d.stableId, staticKey: d.staticKey };
  };
}

/**
 * @param {any} ctx
 * @returns {(node: { stableId: string, staticKey: string }) => Promise<{ call(tool: string, input: any): Promise<any> }>}
 */
export function openPeer(ctx) {
  return async node => {
    const r = await ctx.call("relay.devices.node", { id: node && node.stableId }, "module:link");
    const tn = r && r.data && r.data.node;
    if (!tn || !tn.name) throw Object.assign(new Error("that device has not reported a tailnet node yet"), { code: "not_reachable" });
    const conn = connector({ address: `https://${tn.name}`, verify: ip => identifyBox(ip), pinned: () => tn.stableId });
    return {
      async call(tool, input) {
        const { body } = await conn.json("POST", `/v1/tools/${encodeURIComponent(tool)}`, input, { timeout: 10_000 });
        return body;
      },
    };
  };
}

/**
 * Names this device on a move's consent ask; not security-critical on its own, so a missing
 * fingerprint (no relay module, or the relay has never connected) degrades to an empty string
 * rather than failing the whole call — openPeer's own pinning is what actually proves anything.
 * @param {any} ctx
 * @returns {() => Promise<{ stableId: string, name: string, fingerprint: string }>}
 */
export function selfIdentity(ctx) {
  return async () => {
    const status = await ctx.call("relay.status", {}, "module:link");
    const name = String((ctx.config && ctx.config.name) || (ctx.config && ctx.config.network && ctx.config.network.name) || "this device");
    const route = status && status.data && status.data.route;
    return { stableId: String(route || ""), name, fingerprint: "" };
  };
}
