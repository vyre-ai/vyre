// @ts-check
// system — the smallest real module. It proves the contract end to end (a manifest, a tool, an
// event) and answers "what is this machine running".

import os from "node:os";
import { build } from "../daemon/build.js";
import { hostedOrigins } from "../config/index.js";
import { fingerprint8, toBase64url } from "../../lib/identity.js";

// owner.id's only valid shape (config.ownerId(): 16 random bytes, hex). Any process running as
// this OS user can edit config.json, so owner.id is display identity only, never a trust anchor
// -- a malformed value here is just bad data to shrug off, not something to pass through.
const OWNER_ID_RE = /^[0-9a-f]{32}$/;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("system.info", {
      description: "What this machine is running: Vyre version and the commit it was built from, role, host and platform, the owner's name as onboarding saved it and their fingerprint8 (a short, stable, non-secret fingerprint of owner.id, base64url, for a surface's avatar), the assistant's name (which every surface uses to label replies; null: surfaces say \"Vyre\") and its own fingerprint8 (same formula, kind \"assistant\", also base64url), and network.origins: the other sites (Vyre's hosted app) that may call this box from the owner's browser ([] when off).",
      input: { type: "object", properties: {} },
      run: async () => {
        // owner.id itself never leaves this machine -- only its fingerprint, and only
        // core/onboard ever writes owner.id (config.ownerId(), on its own startup); this is
        // read-only. Both fingerprints share the one formula and the one encoding (base64url,
        // matching the relay's pairing ticket) from lib/identity.js, so this and tailnet's relay
        // can never drift apart.
        const ownerId = ctx.config.owner && OWNER_ID_RE.test(ctx.config.owner.id) ? ctx.config.owner.id : null;
        return { ...build(), role: ctx.config.role, host: os.hostname().split(".")[0], platform: process.platform, node: process.version,
          owner: { name: (ctx.config.onboard && ctx.config.onboard.person) || null,
            fingerprint8: ownerId ? toBase64url(fingerprint8(ownerId, "person")) : null },
          // The name the user gave their assistant in onboarding, else the agent it was created as.
          assistant: { name: (ctx.config.onboard && (ctx.config.onboard.assistant || (ctx.config.onboard.greeted && ctx.config.onboard.greeted.agent))) || null,
            fingerprint8: ownerId ? toBase64url(fingerprint8(ownerId, "assistant")) : null },
          network: { origins: hostedOrigins(ctx.config.network) } };
      },
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
