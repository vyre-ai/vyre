// @ts-check
// hands (the hands-mac folder): computer use on macOS through the accessibility tree.
//
// The module is named "hands" so its tools can be hands.observe and hands.act; the folder says
// which platform this implementation is for. Starting it costs nothing: the helper is not run,
// and the Accessibility grant is not checked, until a tool is called. A missing build or a
// missing grant is then reported on the call, in words that say what to do, rather than
// failing the module at start, where the person asking would never see why.
//
// Which overlay the hands get follows from which runner they get. A fake runner cannot touch the
// screen, so it gets no overlay unless a test injects one. A real runner always gets the real
// overlay, and there is no setting that swaps it for nothing: config comes from JSON, which
// cannot hold the functions an overlay is made of, so the only way to act without the indicator
// is to not act on the real Mac at all.

import { AsyncLocalStorage } from "node:async_hooks";
import { Hands, KINDS, ACTIONS } from "./hands.js";
import { makeRunner, HandsError } from "./runner.js";
import { makeOverlay, NO_OVERLAY } from "./overlay.js";

const str = { type: "string" };
const where = {
  app: { type: "string", description: "App name or bundle id. Default: the frontmost app." },
  pid: { type: "integer", description: "Process id; wins over app." },
  window: { type: "string", description: "Only windows whose title contains this. Safer than relying on window order in a multi-window app." },
};
const selector = {
  type: "object", required: ["role"],
  description: "Copy it from an element of hands.observe. It is matched against a fresh observation, never used as a location.",
  properties: { role: str, name: str, identifier: str, container: str, path: str },
};
const filter = {
  role: { type: "string", description: "Only controls with this role, e.g. AXTextField or TextField (the AX prefix is optional)." },
  name: { type: "string", description: "Only controls whose label or identifier contains this, ignoring case. Never matched against values." },
  near: { type: "string", description: "Another control's label or selector path: matches come closest to it first." },
  limit: { type: "integer", description: "Most matches to return, 1-500. Default 20." },
};
const actInput = {
  type: "object", required: ["selector", "kind"],
  properties: {
    selector, kind: { type: "string", enum: KINDS },
    action: { type: "string", enum: ACTIONS, description: "For kind action: one of the element's own actions, as hands.observe lists them." },
    value: { type: "string", description: "For set and type." },
    key: { type: "string", description: "For key: return, enter, tab, space, delete, forwarddelete, escape, home, end, pageup, pagedown, left, right, up, down." },
    modifiers: { type: "array", items: { type: "string", enum: ["cmd", "shift", "option", "control"] } },
    ...where,
    settleMs: { type: "integer", description: "How long to keep re-observing for the effect, in ms. Default 1500, at most 5000 (a larger value is clamped); slow apps such as WhatsApp may want 3000-4000." },
    resume: { type: "boolean", description: "Carry on after the person (or hands.stop) stopped Vyre's control. Pass it only after asking the person." },
  },
};

/** An object with the overlay's functions. JSON config can never be one. */
const isOverlay = (/** @type {any} */ o) => o && typeof o === "object" && ["controlling", "ring", "done", "close", "onStop"].every(k => typeof o[k] === "function");

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const opts = (ctx.config && ctx.config.hands) || {};
    // A runner function in config is how tests drive the module without a screen; a bin path
    // points it at another build of the helper.
    const fake = typeof opts.runner === "function";
    const run = fake ? opts.runner : makeRunner({ bin: opts.bin || process.env.VYRE_HANDS_BIN || undefined });
    const overlay = isOverlay(opts.overlay) ? opts.overlay : fake ? NO_OVERLAY : makeOverlay({ bin: process.env.VYRE_OVERLAY_BIN || undefined });
    // The paired box's origin, for the floor: a Deck or Glass tab in a browser is a Vyre surface.
    // No link module means no box, which is the answer, not an error.
    const known = async () => {
      const r = await ctx.call("link.status", {}).catch(() => null);
      const s = r && r.data;
      return { box: s && s.linked && s.box && typeof s.box.address === "string" ? s.box.address : null };
    };
    // Which thread, tool call and agent a tool call came from, for the events it causes: a
    // view ties the step to the chat row that asked for it (ADR 0036). Carried per call, so two
    // calls in flight never trade their labels.
    const via = new AsyncLocalStorage();
    const emit = (/** @type {string} */ type, /** @type {any} */ payload) => {
      const m = /** @type {any} */ (via.getStore()) || {};
      const agent = /^mcp:agent:(.+)$/.exec(String(m.caller || ""));
      const where = { ...(m.thread ? { thread: String(m.thread) } : {}), ...(m.call ? { call: String(m.call) } : {}), ...(agent ? { agent: agent[1] } : {}) };
      return ctx.events.emit(type, { ...payload, ...where }, where.thread ? { thread: where.thread } : {});
    };
    const hands = new Hands({ run, emit, sleep: opts.sleep, overlay, known });

    /** Tool errors keep their code, so a caller can tell "not built" from "not granted" from "floor". */
    const wrap = fn => async (input, meta) => {
      try { return await via.run(meta || {}, () => fn(input)); }
      catch (e) { throw e instanceof HandsError ? Object.assign(new Error(`${e.code}: ${e.message}`), { code: e.code }) : e; }
    };

    ctx.tool("hands.observe", {
      description: "Read the accessibility tree of the frontmost app (or a named app or pid): its window title, a bounded list of controls, each with a selector to hand to hands.act, its value, enabled and focus state, frame and actions, and the text on screen. truncated says the list was capped. In a place Vyre may not look (its own surfaces, sign-in dialogs, password managers, security settings) it returns the app and window only, with blind saying why.",
      input: { type: "object", properties: { ...where, limit: { type: "integer", description: "Most controls to return, 1-500. Default 120." },
        match: { type: "object", properties: filter, description: "Return only the controls that match, read from up to 500 so a match past the default cap is still found." } } },
      run: wrap(input => hands.observe(input)),
    });

    ctx.tool("hands.find", {
      description: "Find controls in an app by role, label and nearness without reading the whole list: the same as hands.observe with match. Returns the app, window, whether it is in front (front), and the matching controls with selectors for hands.act, closest to near first. Works on an app in the background without raising it. The floor applies as in hands.observe.",
      input: { type: "object", properties: { ...where, ...filter } },
      run: wrap(async input => {
        const { app, pid, window, role, name, near, limit } = input;
        const o = await hands.observe({ app, pid, window, match: { role, name, near, limit } });
        const { texts, ...rest } = o;
        return rest;
      }),
    });

    ctx.tool("hands.act", {
      description: "Do one thing to one control, found by selector in a fresh observation: press it, set its value, focus it, perform one of its accessibility actions, type text into it, or send it a key. The app is never raised or activated: press, set, focus and type work on an app in the background, but a key needs the app in front and is refused with code needs_front otherwise (press the control instead). Then observe again and verify the effect. verified is true only when the re-observation shows it. An act that sends something as the person (a Send button, Return in a chat) is held, not done: the answer has held: true, and hands.commit with the same input does it once a person allows it. Refuses with code floor where Vyre may not act, secure on a password field (use vault.fill), stopped after the person stopped Vyre (pass resume: true only after asking them), and no_indicator when the on-screen indicator cannot be shown.",
      input: actInput,
      run: wrap(input => hands.act(input)),
    });

    ctx.tool("hands.commit", {
      description: "Do an act that hands.act held because it sends something as the person, with the same input. Needs a person's proof; they are shown what will be pressed or sent, in which app and window. The floor still applies: it never acts where hands.act may not.",
      input: actInput,
      presence: { summary: input => hands.summary(input) },
      run: wrap(input => hands.act(input, { commit: true })),
    });

    ctx.tool("hands.stop", {
      description: "Stop controlling the Mac now, as Escape does: the act in flight is cut short and later acts are refused until one passes resume: true.",
      input: { type: "object", properties: {} },
      run: wrap(async () => hands.halt("tool")),
    });

    return {
      async stop() {
        // A module that stops mid-session takes the pill down with it; nothing is left on screen
        // claiming control that is no longer there.
        overlay.close();
      },
    };
  },
};
