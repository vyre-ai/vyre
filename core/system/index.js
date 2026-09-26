// @ts-check
// system — the smallest real module. It proves the contract end to end (a manifest, a tool, an
// event) and answers "what is this machine running".

import os from "node:os";
import fs from "node:fs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("system.info", {
      description: "What this machine is running: Vyre version, role, host and platform, and the owner's name as onboarding saved it (for a surface's avatar).",
      input: { type: "object", properties: {} },
      run: async () => ({ version: VERSION, role: ctx.config.role, host: os.hostname().split(".")[0], platform: process.platform, node: process.version,
        owner: { name: (ctx.config.onboard && ctx.config.onboard.person) || null } }),
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
