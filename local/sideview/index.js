// @ts-check
// sideview: a session on the left, Chrome or Glass filling the rest (docs/adr/0015).
//
// Starting the module costs nothing: vyre-tile runs once per call and exits, so an idle side
// view has no process, timer or observer. Window titles come back to the caller and are never
// logged or emitted; the tools refuse tailnet callers, like screen context.

import { Sideview } from "./sideview.js";
import { makeTile, SideviewError } from "./runner.js";

const CALLERS = ["cli", "local", "mcp", "module"];

/** @param {any} meta */
function localOnly(meta) {
  if (meta && meta.peer) throw new SideviewError("local_only", "the side view arranges this Mac's windows and is not available over the tailnet");
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const opts = (ctx.config && ctx.config.sideview) || {};
    // A tile object in config is how tests drive the module without windows; a path points it at
    // another build (or a fake binary). launch and activate are for tests too.
    const tile = opts.tile && typeof opts.tile === "object" ? opts.tile
      : makeTile({ bin: (typeof opts.tile === "string" && opts.tile) || process.env.VYRE_TILE_BIN || undefined });
    const view = new Sideview({
      tile, call: (tool, input) => ctx.call(tool, input),
      ...(opts.launch ? { launch: opts.launch } : {}), ...(opts.activate ? { activate: opts.activate } : {}),
      region: opts.region || null, waitMs: opts.waitMs, stepMs: opts.stepMs,
    });

    ctx.tool("sideview.open", {
      description: "Tile this Mac for working beside a session: the session's window on the left (ratio of the display's width, 0.29 by default, full height between the menu bar and the Dock) and Chrome's front window filling the rest, edge to edge. session: \"front\" (the front terminal, the default), \"terminal\" (the top terminal window), {bundle} or {pid}. browser: \"chrome\" (default) or \"glass\" (the paired box's Glass page for `glass`, an agent's name or box). url opens in a new Chrome tab. Chrome is opened if it has no window. The frames the windows had are remembered for sideview.close. Needs the Accessibility grant. Local callers only.",
      input: { type: "object", properties: {
        session: { description: "\"front\", \"terminal\", {\"bundle\": \"com.apple.Terminal\"} or {\"pid\": 123}." },
        panel: { type: "object", description: "Instead of session: the left frame {x, y, w, h} (accessibility points) that the Capsule's own session panel already holds. Only Chrome is moved, fitted from its right edge." },
        browser: { type: "string", enum: ["chrome", "glass"] },
        glass: { type: "string", description: "With browser glass: an agent's name, or box (the default)." },
        url: { type: "string", description: "An http(s) page to open in the right window." },
        ratio: { type: "number", description: "The left window's share of the width, 0.2-0.5. Default 0.29." },
      } },
      callers: CALLERS,
      run: async (input, meta) => { localOnly(meta); return view.open(input); },
    });

    ctx.tool("sideview.close", {
      description: "Put back the windows the side view moved, where they were before sideview.open. Local callers only.",
      input: { type: "object", properties: {} },
      callers: CALLERS,
      run: async (_input, meta) => { localOnly(meta); return view.close(); },
    });

    ctx.tool("sideview.status", {
      description: "Whether the side view is open, with its ratio and the two windows (app, title, frame). Local callers only.",
      input: { type: "object", properties: {} },
      callers: CALLERS,
      run: async (_input, meta) => { localOnly(meta); return view.status(); },
    });

    return { async stop() {} };
  },
};
