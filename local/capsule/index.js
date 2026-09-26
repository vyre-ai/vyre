// @ts-check
// capsule — the Capsule as a module of vyred on the Mac (docs/SPEC.md, section 9).
//
// The app itself is an Electron process of its own: a window cannot live inside a daemon. This
// module is how the rest of Vyre reaches it. capsule.show puts a capsule.requested event on the
// stream, which the app follows, so the assistant, the CLI or a phone can open the Capsule on
// this Mac. capsule.status says what is installed and built. With `capsule.autostart: true` in
// config.json, vyred starts the app hidden in the menu bar when it starts; it is off by default
// so that vyred started for a test, or over SSH, never opens a window on someone's screen.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dialogsAllowed } from "../../core/config/dialogs.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function electron() {
  try { return String(createRequire(path.join(HERE, "package.json"))("electron")); } catch { return null; }
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const built = name => fs.existsSync(path.join(HERE, "bin", name));
    ctx.tool("capsule.status", {
      description: "Whether the Capsule can run on this machine: macOS, Electron installed, the double-Control helper built.",
      input: { type: "object", properties: {} },
      run: async () => ({ mac: process.platform === "darwin", electron: Boolean(electron()), hotkey: built("hotkey"), launcher: built("vyre-launcher"),
        autostart: Boolean(ctx.config.capsule && ctx.config.capsule.autostart) }),
    });
    ctx.tool("capsule.show", {
      description: "Open the Capsule on this Mac (or hide or toggle it). It opens ready to type; it does not answer anything by itself.",
      input: { type: "object", properties: { action: { type: "string", enum: ["show", "hide", "toggle"] } } },
      run: async ({ action = "show" }) => {
        const e = ctx.events.emit("capsule.requested", { action });
        return { requested: action, event: e.id };
      },
    });
    // Never under tests: a vyred a test starts must not put the Capsule on the screen.
    const auto = ctx.config.capsule && ctx.config.capsule.autostart && process.platform === "darwin" && dialogsAllowed();
    const bin = auto ? electron() : null;
    if (auto && !bin) ctx.log("capsule.autostart is on, but Electron is not installed in local/capsule (vyre capsule build)");
    if (bin) {
      const child = spawn(bin, [HERE, "--hidden"], { detached: true, stdio: "ignore",
        env: { ...process.env, VYRE_SOCKET: ctx.paths.socket, VYRE_CAPSULE_BIN: path.join(HERE, "bin") } });
      child.unref();
      ctx.log(`started the Capsule (pid ${child.pid})`);
    }
    return { async stop() {} };
  },
};
