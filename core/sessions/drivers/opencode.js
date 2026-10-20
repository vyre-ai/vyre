// @ts-check
// The session side of OpenCode (Go and the inference API). The HTTP call, the paths and the headers live in lib/opencode.js.
// This speaks the same session wire as the other API-key drivers (one reply, one bubble). It has no tools and no process.
// The key is o.env[keyEnv] (OPENCODE_API_KEY). Go is o.env.VYRE_OPENCODE_GO === "1", and only then is the thread id sent as x-opencode-session. A base URL on the account is not read: OpenCode has one address.

import { route, doorMessage, isRefusal } from "../../../lib/door-bridge.js";
import { scrub as scrubText } from "../../../lib/scrub.js";
import { redact as redactCredentials } from "../../../lib/sanitize.js";
import { opencodeCall } from "../../../lib/opencode.js";

const MAX_HISTORY = 60;

/** @param {unknown} c */
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && b.type === "text" ? String(b.text || "") : "")).join("") : "");

/** @param {{ id?: string, keyEnv?: string, fetch?: (url: string, init: any) => Promise<any>, door?: any, legacyDirect?: boolean, chainFor?: (o: any) => any, warn?: (m: string) => void, store?: { get(id: string): any[] | undefined, set(id: string, messages: any[]): void } }} [entry] */
export function opencodeProvider(entry = {}) {
  const memory = new Map();
  const store = entry.store || { get: (id) => memory.get(id), set: (id, m) => { memory.set(id, m); } };
  const id = entry.id || "opencode";
  return {
    id,
    driver: "http",
    capabilities: { streaming: true, resume: true, interrupt: true, modes: false, steering: false, usage: "detailed", rewind: false, process: false, tools: false },
    /** @param {any} o */
    run(o) { return runChat(entry, store, id, o); },
  };
}

/** @param {any} entry @param {any} store @param {string} id @param {any} o */
function runChat(entry, store, id, o) {
  const key = String((o.env && o.env[entry.keyEnv || "OPENCODE_API_KEY"]) || "");
  const go = Boolean(o.env && o.env.VYRE_OPENCODE_GO === "1");
  const model = String(o.model || (o.env && o.env.VYRE_API_MODEL) || "");
  /** @type {{ role: string, content: string }[]} */
  const history = o.resume ? [...(store.get(o.id) || [])] : [];
  const queue = /** @type {string[]} */ ([]);
  let busy = false, alive = true, ac = /** @type {AbortController | null} */ (null), asked = false;
  const say = (/** @type {any} */ m) => { try { o.onMessage(m); } catch { /* a surface that threw does not kill the turn */ } };
  const exit = () => { if (!alive) return; alive = false; try { o.onExit(0, null, ""); } catch { /* same */ } };
  say({ type: "system", subtype: "init", session_id: o.id, model, resumed: Boolean(o.resume) });

  async function pump() {
    if (busy || !alive || !queue.length) return;
    busy = true;
    const prompt = /** @type {string} */ (queue.shift());
    history.push({ role: "user", content: prompt });
    const messages = [...(o.system && o.system.text ? [{ role: "system", content: String(o.system.text) }] : []), ...history.slice(-MAX_HISTORY)];
    ac = new AbortController();
    asked = false;
    const mid = `oc-turn-${history.filter((m) => m.role === "user").length}`;
    let opened = false;
    const delta = (/** @type {string} */ t) => {
      if (!opened) { opened = true; say({ type: "stream_event", event: { type: "message_start", message: { id: mid } } }); }
      say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } });
    };
    let text = "", usage = /** @type {any} */ (null), failed = /** @type {Error | null} */ (null), cancelled = false;
    try {
      if (!model) throw new Error("Choose a model for this OpenCode account.");
      const door = typeof entry.door === "function" ? entry.door() : entry.door;
      const via = route({ door, legacyDirect: entry.legacyDirect, directOk: Boolean(o.env && o.env.VYRE_OWNER_ACCOUNT === "1"), warn: entry.warn }, id);
      if ("refused" in via) throw new Error(via.refused);
      const flat = messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : textOf(m.content) }));
      if ("door" in via) {
        let out;
        try {
          out = await via.door.call({
            chain: await (entry.chainFor ? entry.chainFor(o) : o.chain), purpose: "session", provider: id, model,
            ...(go ? { go: true, session: String(o.id) } : {}), messages: flat, credential: { key },
          });
        } catch (e) { if (isRefusal(e)) throw new Error(doorMessage(e) || "the inference door refused this"); throw e; }
        text = String(out.content || "");
        if (!text) throw new Error(go ? "OpenCode Go did not answer. Try again in a moment." : "OpenCode did not answer. Try again in a moment.");
        delta(text);
        if (out.usage) usage = out.usage;
      } else {
        const sent = !entry.legacyDirect ? flat.map((m) => ({ ...m, content: redactCredentials(m.content).text })) : flat;
        const out = await opencodeCall({ go, key, model, messages: sent, ...(go ? { session: String(o.id) } : {}), fetch: entry.fetch, signal: ac.signal });
        text = out.content;
        usage = out.usage || null;
        delta(text);
      }
    } catch (e) {
      if (asked && ac && ac.signal.aborted) cancelled = true;
      else failed = e instanceof Error ? e : new Error(String(e));
      if (failed && key) failed = new Error(scrubText(String(failed.message), [key], { marker: "[key]", min: 1 }));
    }
    ac = null;
    if (text) { history.push({ role: "assistant", content: text }); say({ type: "assistant", message: { id: mid, content: [{ type: "text", text }] } }); }
    else if (history.length && history[history.length - 1].role === "user") history.pop();
    store.set(o.id, history.slice(-MAX_HISTORY));
    say({
      type: "result", subtype: failed ? "error" : "success", is_error: Boolean(failed),
      result: failed ? failed.message : cancelled ? "interrupted" : text,
      total_cost_usd: 0, usage: usage ? { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 } : {},
    });
    busy = false;
    pump();
  }

  return {
    pid: undefined,
    get alive() { return alive; },
    /** @param {any} m */
    write(m) {
      if (!alive || !m || m.type !== "user") return;
      queue.push(textOf(m.message && m.message.content));
      pump();
    },
    interrupt() { asked = true; if (ac) ac.abort(); return Promise.resolve(); },
    async stop() { asked = true; if (ac) ac.abort(); exit(); },
  };
}
