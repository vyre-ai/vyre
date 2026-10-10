// @ts-check
import { redact } from "./secret-shapes.js";
// door-bridge: how a session provider reaches a model through the inference door (contract 8.4; invariants 5 and 6).
//
// A provider that speaks to a model over HTTP (the API-key chat driver) calls door.call. A provider that runs its own model process
// (Claude Code, Codex, Grok) cannot: the process talks to its provider itself. For those we route what we can: the prompt on its way
// in, and every message on its way out to the transcript, through door.sanitize and door.result; the egress firewall covers the rest
// (team/archive/work-journals/door-retrofit.md says exactly what).
//
// A subscription login (Codex, Grok: the vendor's own CLI with the person's own sign-in, which talks to its own vendor) is not an API-key call, so it needs no door to run:
// loginDirect runs it direct and still scrubs what goes in (the same credential table every redactor reads). With a door connected it goes through the door as above.
//
// The door is injected (`door`, ModelApi plus sanitize and result when it has them). With none, a provider refuses to run unless
// `legacyDirect` is on, which logs one warning per provider and keeps today's direct behaviour. Nothing ships silently unrouted.

/** The words a person sees for each refusal. Never a value, never a class's content. @param {any} e */
export function doorMessage(e) {
  const r = e && (e.refusal || e);
  switch (r && r.code) {
    case "ledger_hit": return "Vyre stopped this: the text contains something sealed that this session already used.";
    case "residency": return "This Space's policy does not allow that model provider.";
    case "not_a_sink": return "This part of Vyre is not allowed to send text to a model.";
    case "budget": return "This went past a limit Vyre keeps on model calls" + (r.meter ? ` (${String(r.meter).replace(/[^\w ]/g, "")})` : "") + ".";
    default: return null;
  }
}

/** Is this error one the door raised? @param {any} e */
export const isRefusal = e => Boolean(e && (e.refusal || ["ledger_hit", "residency", "not_a_sink", "budget"].includes(e.code)));

const warned = new Set();
/** The routing decision for one provider: the door to use, or direct on purpose, or neither (refuse).
 * @param {{ door?: any, legacyDirect?: boolean, warn?: (m: string) => void }} cfg @param {string} who
 * @returns {{ door: any } | { direct: true } | { refused: string }} */
export function route(cfg, who) {
  if (cfg.door) return { door: cfg.door };
  if (cfg.legacyDirect) {
    if (!warned.has(who)) { warned.add(who); (cfg.warn || (m => process.stderr.write(m + "\n")))(`vyre: ${who} is calling its model provider directly (legacyDirect is on); it is not behind the inference door`); }
    return { direct: true };
  }
  return { refused: "Model calls must go through Vyre's inference door and none is connected, so this was not sent." };
}
/** For tests: forget which providers already warned. */
export const _resetWarned = () => warned.clear();

/**
 * Wrap a provider that runs its own model process: the prompt is sanitised before it is written, and every message it reports is
 * sanitised before anything persists or shows it (D-2). Order is kept: messages are processed one at a time.
 * @param {{ id?: string, run: (o: any) => any, capabilities?: any }} provider
 * @param {{ door?: any, legacyDirect?: boolean, chainFor?: (o: any) => any, warn?: (m: string) => void }} cfg
 */
export function throughDoor(provider, cfg) {
  const who = provider.id || "provider";
  return {
    ...provider,
    run(/** @type {any} */ o) {
      const r = route(cfg, who);
      if ("direct" in r) return provider.run(o);
      if ("refused" in r) {
        // Report it the way a failed turn is reported, and start nothing.
        queueMicrotask(() => { try { o.onMessage({ type: "result", subtype: "error", is_error: true, result: r.refused, total_cost_usd: 0, usage: {} }); } catch {} });
        return { pid: undefined, alive: true, write() {}, interrupt: () => Promise.resolve(), stop: async () => { try { o.onExit(0, null, ""); } catch {} } };
      }
      const door = r.door;
      const chain = () => (cfg.chainFor ? cfg.chainFor(o) : o.chain);
      const session = String(o.id);
      let tail = Promise.resolve();
      const later = (/** @type {() => Promise<any>} */ f) => { tail = tail.then(f, f); return tail; };
      const fail = (/** @type {any} */ e) => { try { o.onMessage({ type: "result", subtype: "error", is_error: true, result: doorMessage(e) || "Vyre could not check this text before it moved on.", total_cost_usd: 0, usage: {} }); } catch {} };
      /** Sanitise every text a message carries. @param {any} m */
      const cleanOut = async m => {
        const text = async (/** @type {string} */ s) => (typeof door.result === "function" ? door.result({ chain: chain(), session, text: s, purpose: "session" }) : s);
        if (m && m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
          const content = [];
          for (const b of m.message.content) content.push(b && b.type === "text" ? { ...b, text: await text(String(b.text)) } : b && b.type === "tool_use" ? { ...b, input: JSON.parse(await text(JSON.stringify(b.input ?? null))) } : b);
          return { ...m, message: { ...m.message, content } };
        }
        if (m && m.type === "stream_event" && m.event && m.event.delta && typeof m.event.delta.text === "string") return { ...m, event: { ...m.event, delta: { ...m.event.delta, text: await text(m.event.delta.text) } } };
        if (m && m.type === "result" && typeof m.result === "string") return { ...m, result: await text(m.result) };
        return m;
      };
      const h = provider.run({ ...o, onMessage: (/** @type {any} */ m) => { later(async () => { try { o.onMessage(await cleanOut(m)); } catch (e) { fail(e); } }); } });
      return {
        ...h,
        get alive() { return h.alive; },
        write(/** @type {any} */ m) {
          if (!m || m.type !== "user" || typeof door.sanitize !== "function") return h.write(m);
          const c = m.message && m.message.content;
          later(async () => {
            try {
              const clean = typeof c === "string" ? await door.sanitize({ chain: chain(), session, text: c, purpose: "session" })
                : Array.isArray(c) ? await Promise.all(c.map(async (/** @type {any} */ b) => (b && b.type === "text" ? { ...b, text: await door.sanitize({ chain: chain(), session, text: String(b.text), purpose: "session" }) } : b))) : c;
              h.write({ ...m, message: { ...m.message, content: clean } });
            } catch (e) { fail(e); }
          });
        },
      };
    },
  };
}

/** A user message with every text in it scrubbed of credentials. @param {any} m */
function scrubbed(m) {
  if (!m || m.type !== "user" || !m.message) return m;
  const c = m.message.content;
  const content = typeof c === "string" ? redact(c) : Array.isArray(c) ? c.map((/** @type {any} */ b) => (b && b.type === "text" && typeof b.text === "string" ? { ...b, text: redact(b.text) } : b)) : c;
  return { ...m, message: { ...m.message, content } };
}

/**
 * A provider that runs the vendor's own CLI on the person's own subscription login. With a door connected it goes through it (throughDoor); with none it runs direct, the prompt scrubbed of
 * credentials on its way in. It is still Vyre's session: the Switchboard keeps the transcript, memory, tools and the Gate; "direct" only means the CLI reaches its own model with its own sign-in.
 * @param {{ id?: string, run: (o: any) => any, capabilities?: any }} provider
 * @param {{ door?: any, legacyDirect?: boolean, chainFor?: (o: any) => any, warn?: (m: string) => void }} cfg
 */
export function loginDirect(provider, cfg) {
  const doored = throughDoor(provider, cfg);
  return {
    ...doored,
    run(/** @type {any} */ o) {
      if (cfg.door) return doored.run(o);
      const h = provider.run(o);
      return new Proxy(h, { get: (t, k) => (k === "write" ? (/** @type {any} */ m) => t.write(scrubbed(m)) : Reflect.get(t, k, t)) });
    },
  };
}
