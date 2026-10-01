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
import { callerKind, agentClaim } from "../../core/modules/index.js";

const CALLERS = ["cli", "local", "mcp", "module"];

const PEOPLE = ["cli", "local", "deck", "capsule"];
/**
 * The agent behind a call, or null when it is the person's own surface, a plain model session of theirs (mcp) or a module. Same rule as Chrome control: an agent claim in any spelling, or a caller
 * kind that is none of those, is an agent.
 * @param {any} meta
 */
function agentOf(meta) {
  const claim = agentClaim(meta && meta.caller) || (meta && meta.agent ? String(meta.agent) : null);
  if (claim) return claim;
  const kind = callerKind(meta && meta.caller);
  return [...PEOPLE, "mcp", "module"].includes(kind) ? null : `caller:${kind}`;
}

/**
 * The screen can hold mail, bank pages and passwords, so an agent sees it only the way it drives Chrome: with the person's computer-use grant (hands.grant.add, theirs to give) AND inside a
 * posted plan (chrome.plan, checked through chrome.plan.check). The person's own surfaces ("ask about my screen") and their own model session are not agents and are not asked.
 * @param {any} ctx @param {any} meta
 */
async function agentGate(ctx, meta) {
  const agent = agentOf(meta);
  if (!agent) return;
  const g = /** @type {any} */ (await ctx.call("hands.grant.list", {}).catch(() => null));
  const granted = g && !g.error && Array.isArray(g.data) && g.data.some((/** @type {any} */ x) => x.agent === agent);
  if (!granted) throw new ScreenError("denied", `${agent} is not granted to use this Mac, so it cannot see the screen. Grant it once with hands.grant.add or ask the person to.`);
  const p = /** @type {any} */ (await ctx.call("chrome.plan.check", { agent }).catch(() => null));
  if (!(p && !p.error && p.data && p.data.planned === true)) throw new ScreenError("plan_first", "post your plan first with chrome.plan (a short list of steps), then look at the screen.");
}

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
      run: async (input, meta) => { localOnly(meta); await agentGate(ctx, meta); return screen.context(input); },
    });

    // A path, not base64. A window on a Retina display is a few megabytes of PNG, and base64 in
    // the tool result would copy every byte into the JSON answer, the session transcript and
    // anything that records tool results. A path in a 0700 folder keeps the pixels in one file on
    // this Mac, which the local caller reads if it wants to see it, and which is gone in a minute.
    ctx.tool("screen.shot", {
      description: "Take a screenshot now, of the front window (default) or the main display (window: false). Returns the path of a PNG in a private folder that is deleted after 60 seconds, plus its width and height; read the file to see it. Needs the Screen Recording grant. Refused, with blind naming why, where screen.context is blind. Local callers only.",
      input: { type: "object", properties: { window: { type: "boolean", description: "Only the front window. Default true." } } },
      callers: CALLERS,
      run: async (input, meta) => { localOnly(meta); await agentGate(ctx, meta); return screen.shot(input); },
    });

    return { async stop() { await screen.stop(); } };
  },
};
