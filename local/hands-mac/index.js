// @ts-check
// hands (the hands-mac folder): computer use on macOS through the accessibility tree.
//
// The module is named "hands" so its tools can be hands.observe and hands.act; the folder says
// which platform this implementation is for. Starting it costs nothing: the helper is not run,
// and the Accessibility grant is not checked, until a tool is called. A missing build or a
// missing grant is then reported on the call, in words that say what to do, rather than
// failing the module at start, where the person asking would never see why.

import { Hands, KINDS } from "./hands.js";
import { makeRunner, HandsError } from "./runner.js";

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

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const opts = (ctx.config && ctx.config.hands) || {};
    // A runner function in config is how tests drive the module without a screen; a bin path
    // points it at another build of the helper.
    const run = typeof opts.runner === "function" ? opts.runner : makeRunner({ bin: opts.bin || process.env.VYRE_HANDS_BIN || undefined });
    const hands = new Hands({ run, emit: (type, payload) => ctx.events.emit(type, payload), sleep: opts.sleep });

    /** Tool errors keep their code in the message, so a caller can tell "not built" from "not granted". */
    const wrap = fn => async input => {
      try { return await fn(input); }
      catch (e) { throw e instanceof HandsError ? new Error(`${e.code}: ${e.message}`) : e; }
    };

    ctx.tool("hands.observe", {
      description: "Read the accessibility tree of the frontmost app (or a named app or pid): its window title, a bounded list of controls, each with a selector to hand to hands.act, its value, enabled and focus state and frame, and the text on screen. truncated says the list was capped.",
      input: { type: "object", properties: { ...where, limit: { type: "integer", description: "Most controls to return, 1-500. Default 120." } } },
      run: wrap(input => hands.observe(input)),
    });

    ctx.tool("hands.act", {
      description: "Do one thing to one control, found by selector in a fresh observation: press it, set its value, focus it, type text into it, or send it a key. Then observe again and verify the effect. verified is true only when the re-observation shows it; the accessibility API accepting the action is not proof. Returns acted, verified, reason, before, after and changes.",
      input: {
        type: "object", required: ["selector", "kind"],
        properties: {
          selector, kind: { type: "string", enum: KINDS },
          value: { type: "string", description: "For set and type." },
          key: { type: "string", description: "For key: return, enter, tab, space, delete, forwarddelete, escape, home, end, pageup, pagedown, left, right, up, down." },
          modifiers: { type: "array", items: { type: "string", enum: ["cmd", "shift", "option", "control"] } },
          ...where,
          settleMs: { type: "integer", description: "How long to keep re-observing for the effect. Default 1500." },
        },
      },
      run: wrap(input => hands.act(input)),
    });

    return { async stop() {} };
  },
};
