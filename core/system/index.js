// @ts-check
// system — the smallest real module. It proves the contract end to end (a manifest, a tool, an
// event) and answers "what is this machine running".

import os from "node:os";
import { build } from "../daemon/build.js";
import { hostedOrigins, fingerprint8 } from "../config/index.js";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("system.info", {
      description: "What this machine is running: Vyre version and the commit it was built from, role, host and platform, the owner's name as onboarding saved it and their fingerprint8 (a short, stable, non-secret fingerprint of owner.id, for a surface's avatar), and the assistant's name, which every surface uses to label replies (null: surfaces say \"Vyre\"), and network.origins: the other sites (Vyre's hosted app) that may call this box from the owner's browser ([] when off).",
      input: { type: "object", properties: {} },
      run: async () => ({ ...build(), role: ctx.config.role, host: os.hostname().split(".")[0], platform: process.platform, node: process.version,
        // owner.id itself never leaves this machine -- only its fingerprint, and only core/onboard
        // ever writes owner.id (config.ownerId(), on its own startup); this is read-only.
        owner: { name: (ctx.config.onboard && ctx.config.onboard.person) || null,
          fingerprint8: (ctx.config.owner && ctx.config.owner.id) ? fingerprint8(ctx.config.owner.id) : null },
        // The name the user gave their assistant in onboarding, else the agent it was created as.
        assistant: { name: (ctx.config.onboard && (ctx.config.onboard.assistant || (ctx.config.onboard.greeted && ctx.config.onboard.greeted.agent))) || null },
        network: { origins: hostedOrigins(ctx.config.network) } }),
    });
    ctx.tool("system.echo", {
      description: "Returns what it was given. For checking that tools and the rules path work.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async ({ text }) => ({ text }),
    });
    ctx.events.emit("system.started", { pid: process.pid });
    return { async stop() {} };
  },
};
