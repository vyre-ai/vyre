// @ts-check
// network: the person's built-in network, in Wink's words (spec 4.7). The work is the Wink module's (core/wink/network.js); this module owns the
// `network.` prefix and holds the four public names (network.wink.status, .whois, .join, .leave: core/network/wink.js).
//
// Nothing here starts, installs or asks for another product's VPN. Guests from other networks are not network members any more: a guest is the
// space role "temp" (DESIGN-wink 1). Public share links and webhooks come in through the Wink public gate (core/wink/control/gate.js).

import { registerWinkNetwork } from "./wink.js";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    registerWinkNetwork(ctx);
    return { async stop() {} };
  },
};
