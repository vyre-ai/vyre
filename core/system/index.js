// @ts-check
// system — the smallest real module. It proves the contract end to end (a manifest, a tool, an
// event) and answers "what is this machine running".

import os from "node:os";
import { build } from "../daemon/build.js";
import { hostedOrigins, save as saveConfig } from "../config/index.js";
import { friendlyDeviceName } from "../../lib/devicename.js";
import { fingerprint8, toBase64url } from "../../lib/identity.js";

// Both fingerprints, or null for either if owner.id is missing or malformed (lib/identity
// itself owns the shape check, so this doesn't keep its own copy of that regex). Any process
// running as this OS user can edit config.json, so owner.id is display identity only, never a
// trust anchor -- a malformed value here is just bad data to shrug off, not something to pass
// through.
function ownerFingerprints(id) {
  try { return { person: toBase64url(fingerprint8(id, "person")), assistant: toBase64url(fingerprint8(id, "assistant")) }; }
  catch { return { person: null, assistant: null }; }
}

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
        const fp = ownerFingerprints(ctx.config.owner && ctx.config.owner.id);
        return { ...build(), role: ctx.config.role, host: os.hostname().split(".")[0], serverName: ctx.config.serverName || null, platform: process.platform, node: process.version,
          owner: { name: (ctx.config.onboard && ctx.config.onboard.person) || null, fingerprint8: fp.person },
          // The name the user gave their assistant in onboarding, else the agent it was created as.
          assistant: { name: (ctx.config.onboard && (ctx.config.onboard.assistant || (ctx.config.onboard.greeted && ctx.config.onboard.greeted.agent))) || null,
            fingerprint8: fp.assistant },
          network: { origins: hostedOrigins(ctx.config.network) } };
      },
    });
    ctx.tool("system.rename", {
      description: "Rename this server: its display name, a label the person chooses (not its vyre.run address). It is shown wherever this machine appears, and a phone sees it when pairing. An empty name goes back to the default.",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async ({ name }) => {
        const label = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
        if (label.length > 64) throw new Error("a name is 1 to 64 printable characters");
        const shown = label ? friendlyDeviceName(label) : null;
        saveConfig({ serverName: shown }, ctx.paths.root, ctx.config);
        ctx.events.emit("device.renamed", { kind: "server", id: "server", name: shown });
        return { id: "server", name: shown };
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
