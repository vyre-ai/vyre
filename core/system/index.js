// @ts-check
// system — the smallest real module. It proves the contract end to end (a manifest, a tool, an
// event) and answers "what is this machine running".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileVault } from "../../lib/online.js";
import { build } from "../daemon/build.js";
import { hostedOrigins, save as saveConfig } from "../config/index.js";
import { friendlyDeviceName, cleanLabel } from "../../lib/devicename.js";
import { fingerprint8, toBase64url } from "../../lib/identity.js";
import { PKG_ROOT } from "../../kernel/devbuild.js";

// Both fingerprints, or null for either if owner.id is missing or malformed (lib/identity
// itself owns the shape check, so this doesn't keep its own copy of that regex). Any process
// running as this OS user can edit config.json, so owner.id is display identity only, never a
// trust anchor -- a malformed value here is just bad data to shrug off, not something to pass
// through.
function ownerFingerprints(id) {
  try { return { person: toBase64url(fingerprint8(id, "person")), assistant: toBase64url(fingerprint8(id, "assistant")) }; }
  catch { return { person: null, assistant: null }; }
}

/**
 * FileVault on a Mac ("on", "off", "unknown"); null anywhere else. A Mac with FileVault on waits at the login window after an unplanned restart and runs nothing, so the app warns on a server card (always-online).
 * `fdesetup status` needs no privilege; the answer is kept for a minute.
 */
let vaultAt = 0, vaultNow = /** @type {"on" | "off" | "unknown" | null} */ (null);
function vault() {
  if (process.platform !== "darwin") return null;
  if (Date.now() - vaultAt > 60_000) { vaultNow = fileVault((cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] })); vaultAt = Date.now(); }
  return vaultNow;
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("system.info", {
      effect: "read",
      description: "What this machine is running: Vyre version and commit, role, host, platform, owner and assistant names with avatar fingerprint8, and network.origins.",
      input: { type: "object", properties: {} },
      run: async () => {
        // owner.id itself never leaves this machine -- only its fingerprint, and only
        // core/onboard ever writes owner.id (config.ownerId(), on its own startup); this is
        // read-only. Both fingerprints share the one formula and the one encoding (base64url,
        // matching the relay's pairing ticket) from lib/identity.js, so this and tailnet's relay
        // can never drift apart.
        const fp = ownerFingerprints(ctx.config.owner && ctx.config.owner.id);
        return { ...build(), role: ctx.config.role, host: os.hostname().split(".")[0], memoryMb: Math.round(os.totalmem() / 1048576), serverName: ctx.config.serverName || null, platform: process.platform, filevault: vault(), node: process.version,
          owner: { name: (ctx.config.onboard && ctx.config.onboard.person) || null, fingerprint8: fp.person },
          // The name the user gave their assistant in onboarding, else the agent it was created as.
          assistant: { name: (ctx.config.onboard && (ctx.config.onboard.assistant || (ctx.config.onboard.greeted && ctx.config.onboard.greeted.agent))) || null,
            fingerprint8: fp.assistant },
          network: { origins: hostedOrigins(ctx.config.network) } };
      },
    });
    ctx.tool("system.modules", {
      effect: "read",
      description: "The modules on this machine and the slots each shows in the app: { modules: [{ name, version, state, now: [tool, ...] }] }. A module's Now card is a tool named in shows.deck as now:<tool>; the app calls it and draws what it answers.",
      input: { type: "object", properties: {} },
      run: async () => ({ modules: ctx.modules.status().map((/** @type {any} */ m) => ({ name: m.name, version: m.version, state: m.state,
        now: (m.shows && Array.isArray(m.shows.deck) ? m.shows.deck : []).filter((/** @type {any} */ s) => typeof s === "string" && s.startsWith("now:")).map((/** @type {string} */ s) => s.slice(4)) })) }),
    });
    ctx.tool("system.build", {
      description: "The release's signed record of the web app this daemon serves at /app/: appbuild.json (the sha256 of every file of the build), the signed SHA256SUMS that lists it, and SHA256SUMS.sig. A client (the Mac window) verifies the signature with the release key and the list's own hash, then checks every file it is served. A development build has none.",
      input: { type: "object", properties: {} },
      run: async () => {
        /** @param {string} f */
        const read = f => { const p = path.join(PKG_ROOT, f); const st = fs.lstatSync(p); if (!st.isFile() || st.size > 8_000_000) throw new Error("not a plain file"); return fs.readFileSync(p, "utf8"); };
        try { return { appbuild: read("appbuild.json"), sums: read("SHA256SUMS"), sig: read("SHA256SUMS.sig").trim() }; }
        catch { throw Object.assign(new Error("this build carries no signed record of the app (a development build); install a released build to get one"), { code: "no_build" }); }
      },
    });
    ctx.tool("system.rename", {
      effect: "write",
      description: "Rename this server: its display name, a label the person chooses (not its vyre.run address). It is shown wherever this machine appears, and a phone sees it when pairing. An empty name goes back to the default.",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async ({ name }) => {
        const label = cleanLabel(name);
        if (label.length > 64) throw new Error("a name is 1 to 64 printable characters");
        const shown = label ? friendlyDeviceName(label) : null;
        saveConfig({ serverName: shown }, ctx.paths.root, ctx.config);
        ctx.events.emit("device.renamed", { kind: "server", id: "server", name: shown });
        return { id: "server", name: shown };
      },
    });

    ctx.tool("system.echo", {
      effect: "read",
      description: "Returns what it was given. For checking that tools and the rules path work.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async ({ text }) => ({ text }),
    });
    ctx.events.emit("system.started", { pid: process.pid });
    return { async stop() {} };
  },
};
