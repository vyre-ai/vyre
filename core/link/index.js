// @ts-check
// link — the Mac and the box as one system (docs/SPEC.md, sections 3 and 9; ADR 0002).
//
// On the box, this module pairs Macs and answers their check-ins. On the Mac, it pairs with the
// box, carries ctx.remote(tool, input) to the box's tools, and proxies the box's event stream at
// /v1/link/events so the Capsule sees box threads as they happen. The box identifies the Mac by
// its WireGuard address (the box's tailnet listener does that); the Mac identifies the box the
// same way, pinned to the node it paired with. No header is trusted in either direction.

import { boxSide } from "./box.js";
import { macSide } from "./mac.js";

/**
 * Test seams, keyed by the VYRE_HOME a vyred runs with. Tests run a Mac and a box in one process
 * and simulate the tailnet with these: { verify(ip), insecure, heartbeat, pollMs, hostname, timeout, now }.
 * Production never sets them.
 * @type {Map<string, any>}
 */
export const seams = new Map();

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const seam = seams.get(ctx.paths.root) || {};
    return ctx.config.role === "box" ? boxSide(ctx, seam) : macSide(ctx, seam);
  },
};
