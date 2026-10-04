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

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Hands, KINDS, ACTIONS } from "./hands.js";
import { makeRunner, HandsError } from "./runner.js";
import { makeOverlay, NO_OVERLAY } from "./overlay.js";
import { MIGRATIONS, grants } from "./grant.js";
import { callerKind, agentClaim } from "../../core/modules/index.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
/**
 * Who must hold the grant. Null is the person: their own surfaces, or their own MCP session
 * (vyred vouches an unnamed mcp caller is not an agent). Anything else, named or not, is an agent
 * or a stranger and needs a grant: a named claim from any route (mcp:agent:, harness:agent:,
 * cli:agent:, ...) by that name, and every other caller (a tailnet guest, a module, a hook) by a
 * key no one can be granted under, so it is refused. Fail closed (reviewer-2 H1).
 */
/** Modules that ship with Vyre and act for the person (the apps adapters press Send through hands.commit; sight reads). A module someone adds is not on it. */
const FIRST_PARTY = /^module:(apps|sight|gate|chrome)$/;
const grantKey = (caller, meta) => {
  const claim = agentClaim(caller);
  if (claim) return claim;
  // The name alone is not enough: a module someone adds under a free name (apps, chrome) must not
  // pass. The loader sets firstParty only for modules the repo ships (reviewer-2).
  if (FIRST_PARTY.test(String(caller)) && meta && meta.firstParty === true) return null;
  return [...PEOPLE, "mcp"].includes(callerKind(caller)) ? null : `caller:${callerKind(caller)}`;
};
/** The person's own direct turn, which is what asks for an outward act (asking is approving). */
const asked = caller => PEOPLE.includes(callerKind(caller)) && !agentClaim(caller);

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
    ctx.store.migrate(MIGRATIONS);
    const g = grants(ctx.store.db);
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
      const agent = agentClaim(m.caller);
      // `run` is the thread the panel's pills use, else the agent: every hands event carries it, like the chrome ones.
      const where = { ...(m.thread ? { thread: String(m.thread) } : {}), ...(m.call ? { call: String(m.call) } : {}), ...(agent ? { agent } : {}) };
      const run = m.thread ? String(m.thread) : agent || "";
      return ctx.events.emit(type, { ...payload, ...where, ...(run ? { run } : {}) }, where.thread ? { thread: where.thread } : {});
    };
    // The Gate is how an unasked outward act reaches a person (PLAN.md C4): hands offers one
    // sender, hands:mac, and holds through it exactly like google or any other module does.
    // A call that comes before the Gate module has started (or fails for any reason) falls back
    // to the old direct hands.commit path rather than silently acting; see hands.act's `use`.
    // What was held stays HERE, keyed by the Gate's id. The Gate card carries only what the person
    // reads; the act to replay and its screen hash never leave hands, so an agent that files its
    // own gate.request cannot make release run anything (reviewer-2 H2).
    /** @type {Map<string, { input: any, hash: string, key: string|null }>} */
    const heldActs = new Map();
    const hold = async ({ content, thread }) => {
      // The real destination, as the Gate matches it: the app and the window (a conversation, a document), which is as close to
      // "who or what does this go to" as a screen gives. It has a ":" so it can be named exactly; a plain word never matches.
      // Screen content is not trusted text: control and bidi marks become spaces so a hostile title cannot spoof what an approval card shows.
      const plain = (/** @type {unknown} */ t) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, " ").replace(/\s+/g, " ").trim();
      const to = `${plain(content && content.app) || "the Mac"}: ${plain(content && content.window) || "window"}`.slice(0, 200);
      const { input, hash, ...shown } = content || {};
      const meta = /** @type {any} */ (via.getStore() || {});
      const caller = meta.caller;
      // The Gate releases at once what the person's own words or a standing permission covered, and
      // calls hands.release before gate.request returns an id: file the record under a random ref
      // first (it rides on the card, never where an agent reads) and let release find it by either.
      const ref = crypto.randomBytes(9).toString("hex");
      heldActs.set(ref, { input, hash, key: grantKey(caller, meta) });
      const r = await ctx.call("gate.request", { kind: "act", via: "hands:mac", to, content: { ...shown, ref }, ...(thread ? { thread } : {}) });
      const data = r && !r.error && r.data ? r.data : null;
      heldActs.delete(ref);
      if (data && data.state === "sent") return { sent: true, id: data.id, result: data.result };
      if (data && data.id) {
        heldActs.set(String(data.id), { input, hash, key: grantKey(caller, meta) });
        while (heldActs.size > 200) heldActs.delete(/** @type {string} */ (heldActs.keys().next().value));
      }
      return data;
    };
    const hands = new Hands({ run, emit, sleep: opts.sleep, overlay, known, hold });
    const offer = async () => {
      const r = await ctx.call("gate.offer", { name: "hands:mac", tool: "hands.release", kinds: ["act"], recipients: "to",
        content: { app: "string", window: "string?", control: "string (what will be pressed, typed or sent)", value: "string? (clipped)" } });
      if (r.error) ctx.log(`could not offer the hands:mac sender: ${r.error.message}`);
    };
    await offer();

    /** Tool errors keep their code, so a caller can tell "not built" from "not granted" from "floor". */
    const wrap = fn => async (input, meta) => {
      try { return await via.run(meta || {}, () => fn(input, meta || {})); }
      catch (e) { throw e instanceof HandsError ? Object.assign(new Error(`${e.code}: ${e.message}`), { code: e.code }) : e; }
    };

    /**
     * The one grant (reviewer-2 H2): a named agent (box-side, the assistant, or an ACP provider,
     * every one reaches vyred as mcp:agent:<name>) may drive this Mac only once a person has
     * granted it here. The person's own direct session (no agent name) is not gated: that is the
     * person driving their own Mac, which was never what the grant is for.
     */
    const gated = fn => wrap((input, meta) => {
      const agent = grantKey(meta.caller, meta);
      if (agent && !g.has(agent)) {
        throw Object.assign(new Error(`${agent} is not granted to drive this Mac. Grant it once with hands.grant.add (needs the person), or ask them to.`), { code: "denied" });
      }
      return fn(input, meta);
    });

    /**
     * A runaway guard, invisible until it matters: a granted agent that has done stepCap acts (default 300) without a word from the
     * person is asked to check in. Any call from the person, an idle half hour, a stop, or `resume: true` after asking them starts
     * the count again. Hands-free otherwise: the person is never asked ahead of time.
     */
    const stepCap = Number.isInteger(opts.stepCap) && opts.stepCap > 0 ? opts.stepCap : 300;
    const IDLE_MS = 30 * 60_000;
    /** @type {Map<string, { n: number, at: number }>} */
    const runs = new Map();
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const counted = fn => (input, meta) => {
      const agent = grantKey(meta.caller, meta);
      if (agent) {
        let r = runs.get(agent);
        if (!r || now() - r.at > IDLE_MS || (input && input.resume === true)) { r = { n: 0, at: now() }; runs.set(agent, r); }
        if (r.n >= stepCap) throw Object.assign(new Error(`${r.n} acts in a row with no word from the person. Ask them to check on this, then pass resume: true.`), { code: "step_cap" });
        r.n++; r.at = now();
      }
      return fn(input, meta);
    };

    ctx.tool("hands.observe", {
      callers: [...PEOPLE, "module", "mcp", "harness"], // an agent drives its own grant; the body checks it
      description: "Read the accessibility tree of the frontmost app (or a named app or pid): its window title, a bounded list of controls, each with a selector to hand to hands.act, its value, enabled and focus state, frame and actions, and the text on screen. truncated says the list was capped. In a place Vyre may not look (its own surfaces, sign-in dialogs, password managers, security settings) it returns the app and window only, with blind saying why.",
      input: { type: "object", properties: { ...where, limit: { type: "integer", description: "Most controls to return, 1-500. Default 120." },
        match: { type: "object", properties: filter, description: "Return only the controls that match, read from up to 500 so a match past the default cap is still found." } } },
      run: gated(input => hands.observe(input)),
    });

    ctx.tool("hands.find", {
      callers: [...PEOPLE, "module", "mcp", "harness"], // an agent drives its own grant; the body checks it
      description: "Find controls in an app by role, label and nearness without reading the whole list: the same as hands.observe with match. Returns the app, window, whether it is in front (front), and the matching controls with selectors for hands.act, closest to near first. Works on an app in the background without raising it. The floor applies as in hands.observe.",
      input: { type: "object", properties: { ...where, ...filter } },
      run: gated(async input => {
        const { app, pid, window, role, name, near, limit } = input;
        const o = await hands.observe({ app, pid, window, match: { role, name, near, limit } });
        const { texts, ...rest } = o;
        return rest;
      }),
    });

    ctx.tool("hands.act", {
      callers: [...PEOPLE, "module", "mcp", "harness"], // an agent drives its own grant; the body checks it
      description: "Do one thing to one control, found by selector in a fresh observation: press it, set its value, focus it, perform one of its accessibility actions, type text into it, or send it a key. The app is never raised or activated: press, set, focus and type work on an app in the background, but a key needs the app in front and is refused with code needs_front otherwise (press the control instead). Then observe again and verify the effect. verified is true only when the re-observation shows it. An act that sends something as the person (a Send button, Return in a chat) is held, not done: the answer has held: true and an id, and the person approves it at the Gate (gate.approve) like any other send; hands.commit with the same input is the older direct path, kept for a caller that wants to drive it itself. Refuses with code floor where Vyre may not act, secure on a password field (use vault.fill), stopped after the person stopped Vyre (pass resume: true only after asking them), and no_indicator when the on-screen indicator cannot be shown.",
      input: actInput,
      run: gated(counted((input, meta) => hands.act(input, { thread: meta.thread, commit: asked(meta.caller) }))),
    });

    ctx.tool("hands.commit", {
      callers: [...PEOPLE, "module", "mcp", "harness"], // an agent drives its own grant; the body checks it
      description: "Do an act that hands.act held because it sends something as the person, with the same input. Needs a person's proof; they are shown what will be pressed or sent, in which app and window. The floor still applies: it never acts where hands.act may not. Prefer letting the person approve the held item at the Gate (gate.held / gate.approve) instead: this tool exists for a caller that wants to drive the approval itself.",
      input: actInput,
      presence: { summary: input => hands.summary(input) },
      run: gated(input => hands.act(input, { commit: true })),
    });

    ctx.tool("hands.release", {
      internal: true,
      description: "The Gate's own call once a person approved a held act: re-checks the screen has not moved since it was held, then does exactly what was held. Never called directly.",
      input: { type: "object", properties: { id: str, to: { type: "array", items: str }, content: { type: "object" } }, required: ["id", "content"] },
      run: wrap((input, meta) => {
        if (meta.caller !== "module:gate") throw Object.assign(new Error("only the Gate releases a held act"), { code: "denied" });
        const ref = input.content && typeof input.content.ref === "string" ? input.content.ref : "";
        const rkey = heldActs.has(String(input.id)) ? String(input.id) : ref;
        const rec = heldActs.get(rkey);
        if (!rec || !rec.hash || !rec.input) throw Object.assign(new Error("that held act is not one hands made, or it was already released"), { code: "denied" });
        heldActs.delete(rkey);
        // The agent that caused the hold must still be granted when the person approves it.
        if (rec.key && !g.has(rec.key)) throw Object.assign(new Error(`${rec.key} is no longer granted to drive this Mac. Nothing was done.`), { code: "denied" });
        return hands.release({ input: rec.input, hash: rec.hash });
      }),
    });

    ctx.tool("hands.stop", {
      callers: [...PEOPLE, "module", "mcp", "harness"], // an agent drives its own grant; the body checks it
      description: "Stop controlling the Mac now, as Escape does: the act in flight is cut short and later acts are refused until one passes resume: true.",
      input: { type: "object", properties: {} },
      run: gated(async () => { runs.clear(); return hands.halt("tool"); }),
    });

    // The panel's controls, the person's own (never a model): pause holds like Esc, resume lets the run carry on.
    ctx.tool("hands.pause", {
      description: "Pause Vyre's control of the Mac now, as the person from the panel. It holds like Escape until the person resumes.",
      input: { type: "object", properties: { run: str } },
      callers: PEOPLE,
      run: wrap(async (_input, _meta) => { runs.clear(); const r = await hands.halt("tool"); emit("hands.paused", {}); return { ok: true, paused: true, ...(r && typeof r === "object" ? {} : {}) }; }),
    });
    ctx.tool("hands.resume", {
      description: "Let Vyre carry on controlling the Mac after a stop or a pause, as the person from the panel.",
      input: { type: "object", properties: { run: str } },
      callers: PEOPLE,
      run: wrap(async () => { runs.clear(); return hands.resumeByPerson(); }),
    });

    ctx.tool("hands.indicator", {
      description: "Show the on-screen pill that says Vyre is controlling an app, and arm the Escape key to stop it. The chrome module calls this before every act it makes in the person's Chrome, so the person can see and stop it exactly as they can stop the hands. Refuses with no_indicator where the pill cannot be shown.",
      input: { type: "object", properties: { app: str } },
      callers: [...PEOPLE, "module"],
      run: wrap(async input => { await overlay.controlling(String((input && input.app) || "Chrome"), null); return { ok: true }; }),
    });

    ctx.tool("hands.grant.list", {
      description: "Every agent granted to drive this Mac's computer use, and when.",
      input: { type: "object", properties: {} },
      callers: [...PEOPLE, "module"],
      run: wrap(async () => g.list()),
    });

    ctx.tool("hands.grant.add", {
      description: "Grant an agent (by name, from agents.list) to drive this Mac hands-free from then on: hands.observe/find/act/commit and screen.context reach it with no further prompt. The person's own tap or own words (\"let my agents control my Mac\") is the approval, so this takes no Touch ID; an agent cannot grant itself because only the person's own surfaces may call it. One time, revocable with hands.grant.remove.",
      input: { type: "object", properties: { agent: str }, required: ["agent"] },
      callers: PEOPLE,
      run: wrap((input, meta) => g.add(String(input.agent), meta.caller || null, Date.now())),
    });

    ctx.tool("hands.grant.remove", {
      description: "Revoke an agent's grant to drive this Mac. Takes effect at once; needs no proof, since taking access away is never what the no-nag rule protects against.",
      input: { type: "object", properties: { agent: str }, required: ["agent"] },
      callers: PEOPLE,
      run: wrap(input => g.remove(String(input.agent))),
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
