// @ts-check
// peers — the seams the move engine (ADR 0042, federation's core/move/index.js) needs to name
// and reach one of the owner's own OTHER nodes, source-initiated, not the Mac-to-box shape
// core/link/mac.js and core/link/box.js already cover. Built to federation's own contract
// (core/move/index.js's header comment, sent to tailnet directly), narrowed 28 Sep after the
// reviewer's finding on move.receive.ask (a self-asserted identity is never trusted; the
// destination verifies the source itself via its own ownedNode(meta.peer.stableId), so
// selfIdentity dropped everything but an optional cosmetic nickname):
//
// Curried factories: call `ownedNode(ctx)` / `openPeer(ctx)` / `selfIdentity(ctx)` ONCE, at
// core/move's own module start, and store what each returns in `seams.set(ctx.paths.root, {...})`
// — the returned functions themselves are what federation's own contract signatures
// (`ownedNode(id)`, `openPeer(node)`, `selfIdentity()`) describe, taking no `ctx` of their own.
//
//   ownedNode(ctx) -> (id) -> { stableId, staticKey, name } | null
//     Is `id` one of the owner's own paired nodes? Answered from `relay_devices` (relay.devices.
//     node, module-only), ADR 0026's own Noise identity for a paired device — never re-derived
//     from a live network lookup, and never `link_peers` (a different, older Mac<->box pairing
//     mechanism with its own key exchange, not this one). This is the authoritative table
//     federation asked for. `name` is the device's own paired name (already sanitised at pairing
//     time, core/relay/index.js's `admit()`), for a "Receive a move from <name>" line.
//   openPeer(ctx) -> (node) -> { call(tool, input) }
//     A live, source-initiated connection to `node` (the shape ownedNode returned), carried over
//     the owner's own tailnet — never the relay's bridge (ADR 0046, "the relay introduces,
//     Tailscale carries"). Needs the target device to have ALSO reported its tailnet node
//     (relay.devices.path's node_id/node_name, already built, no dependency on ADR 0046 landing);
//     refuses with `not_reachable` when it has not, same as federation's own default seam.
//   selfIdentity(ctx) -> () -> { nickname?: string }
//     Cosmetic only, narrowed to match federation's own current call site (df782ec0): the
//     destination now identifies the source itself via ownedNode, never from anything the source
//     claims about itself. `nickname` is this box's own configured name, when it has one.
//
// core/link/transport.js needed no change for this: `connector({ address, verify, pinned })` was
// already symmetric (nothing in it assumes "the Mac" or "the box"); the Mac-to-box shape lived
// only in how core/link/mac.js always called it, never in the function itself.

import { connector, identifyBox } from "./transport.js";

/**
 * @param {any} ctx
 * @returns {(id: string) => Promise<{ stableId: string, staticKey: string, name: string } | null>}
 */
export function ownedNode(ctx) {
  return async id => {
    const r = await ctx.call("relay.devices.node", { id: String(id) }, "module:link");
    const d = r && r.data;
    if (!d || !d.stableId || !d.staticKey) return null;
    return { stableId: d.stableId, staticKey: d.staticKey, name: d.name || "a device" };
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
 * @param {any} ctx
 * @returns {() => Promise<{ nickname?: string }>}
 */
export function selfIdentity(ctx) {
  return async () => {
    const name = (ctx.config && ctx.config.name) || (ctx.config && ctx.config.network && ctx.config.network.name);
    return typeof name === "string" && name ? { nickname: name } : {};
  };
}
