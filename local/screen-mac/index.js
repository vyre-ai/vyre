// @ts-check
// screen (the screen-mac folder): what is on the Mac's screen, for the assistant and sessions.
//
// Starting the module costs nothing: the sight helper is not run, and no grant is checked,
// until screen.context or screen.shot is called. From then on the helper stays alive, idle
// between accessibility notifications, so the next call is answered from a warm cache.
//
// Screen context never leaves this Mac. The tools refuse callers that came over the tailnet,
// the module emits no events (an event would carry screen facts into the store and to every
// subscriber), and nothing it reads is logged.

import { Screen } from "./screen.js";
import { makeHelper, ScreenError } from "./runner.js";

const CALLERS = ["cli", "local", "mcp", "module"];

/** @param {any} meta */
function localOnly(meta) {
  if (meta && meta.peer) throw new ScreenError("local_only", "screen context stays on this Mac and is not available over the tailnet");
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const opts = (ctx.config && ctx.config.screen) || {};
    // A helper object in config is how tests drive the module without a screen; a path points it
    // at another build (or a fake binary).
    const helper = opts.helper && typeof opts.helper === "object" ? opts.helper
      : makeHelper({ bin: (typeof opts.helper === "string" && opts.helper) || process.env.VYRE_SCREEN_BIN || undefined, timeoutMs: opts.timeoutMs });
    const screen = new Screen({ helper, call: (tool, input) => ctx.call(tool, input), maxAgeMs: opts.maxAgeMs, shotDir: opts.shotDir, capture: opts.capture });

    ctx.tool("screen.context", {
      description: "What is on this Mac's screen right now: the front app (name, bundle, pid), its window (title, frame), the focused control (role, name, value, selected text, frame), the page URL in a browser, and the visible text of the window in reading order (capped at textMax characters; truncated says it was cut). Redacted: in a password field or while secure input is on, the focused value and selection are left out and secure is true, and password fields never appear in the text. In a password manager, a system sign-in or permission dialog, a security pane of System Settings, or a Vyre surface, only the app and window title come back, with blind naming why. Local callers only.",
      input: { type: "object", properties: {
        text: { type: "boolean", description: "Include the visible text. Default true; false is faster." },
        textMax: { type: "integer", description: "Most characters of visible text, 0-20000. Default 4000." },
      } },
      callers: CALLERS,
      run: async (input, meta) => { localOnly(meta); return screen.context(input); },
    });

    // A path, not base64. A window on a Retina display is a few megabytes of PNG, and base64 in
    // the tool result would copy every byte into the JSON answer, the session transcript and
    // anything that records tool results. A path in a 0700 folder keeps the pixels in one file on
    // this Mac, which the local caller reads if it wants to see it, and which is gone in a minute.
    ctx.tool("screen.shot", {
      description: "Take a screenshot now, of the front window (default) or the main display (window: false). Returns the path of a PNG in a private folder that is deleted after 60 seconds, plus its width and height; read the file to see it. Needs the Screen Recording grant. Refused, with blind naming why, where screen.context is blind. Local callers only.",
      input: { type: "object", properties: { window: { type: "boolean", description: "Only the front window. Default true." } } },
      callers: CALLERS,
      run: async (input, meta) => { localOnly(meta); return screen.shot(input); },
    });

    return { async stop() { await screen.stop(); } };
  },
};
