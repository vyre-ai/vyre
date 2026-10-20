// @ts-check
// The last rung of a fallback list: a plain API-key driver for OpenRouter (or any OpenAI-compatible
// chat endpoint). No process, no login, no tools: it speaks the chat completions stream over HTTP
// from inside vyred and the same session wire every provider speaks (core/sessions/conformance.js).
// Because it has no tools it never asks a permission question and can touch nothing on the machine;
// it is for answering, which is what a thread that has run out of every other provider needs.
//
//   capabilities.process false  no pid or group to report or kill; stop() aborts the request
//   capabilities.tools false    no permission questions exist to route (conform skips those, not the rest)
//
// The conversation is kept by the caller's store ({get, set}, sessions_openrouter in the sessions
// module) so a resume after a restart carries on where it was; without one it lives in memory.
// The key comes from o.env.OPENROUTER_API_KEY (an account of kind api-key), read here and nowhere else.

import { resolveSafe, pinnedFetch } from "../../../lib/api-endpoint.js";
import { route, doorMessage, isRefusal } from "../../../lib/door-bridge.js";
import { scrub as scrubText } from "../../../lib/scrub.js";
import { redact as redactCredentials } from "../../../lib/sanitize.js";
import { OPENROUTER_DEFAULT_MODEL } from "../account-model.js";
import { aiError, classifyAiError } from "../../../lib/ai-errors.js";

const BASE = "https://openrouter.ai/api/v1";
const MAX_HISTORY = 60;
const MAX_STREAM = 1_000_000;         // bytes of one answer, then it is cut
const DONE = Symbol("done");
const IDLE_MS = 60_000;                // no data for this long ends the turn

/** https, or plain http to this machine only (a test double). @param {string} u */
const okBase = u => { try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname)); } catch { return false; } };

/**
 * The provider side of the inference door for this driver: register it as `drivers[id]` in the door. The door has already scanned the
 * messages; this only makes the HTTP call (not streamed: the door answers whole, see team/archive/work-journals/door-retrofit.md) with the key the caller
 * passes in `credential`, which the door never logs. The key is never in an error it raises.
 * @param {{ baseUrl?: string, fetch?: typeof fetch, lookup?: any, idleMs?: number }} [entry]
 */
export function openrouterDoorDriver(entry = {}) {
  return {
    /** @param {{ model: string, messages: any[], max_output_tokens?: number, credential?: { key?: string, base?: string } }} input */
    async call(input) {
      const key = String((input.credential && input.credential.key) || "");
      const base = String((input.credential && input.credential.base) || entry.baseUrl || BASE).replace(/\/+$/, "");
      // every failure carries its class (lib/ai-errors.js), so a caller with a fallback account knows whether another account could answer; the words are as before, the key never in them
      const fail = (/** @type {string} */ m, /** @type {import("../../../lib/ai-errors.js").AiErrorClass} */ cls = "bad_request") => aiError(cls, scrubText(m, [key], { marker: "[key]", min: 1 }));
      if (!okBase(base)) throw fail("the OpenRouter address must be https");
      const pin = entry.fetch && !entry.lookup ? null : await resolveSafe(base, entry.lookup);
      if (!(entry.fetch && !entry.lookup) && !pin) throw fail("that address is not a place a key may be sent");
      if (!key) throw fail("no OpenRouter key on this account", "auth");
      if (!input.model) throw fail("choose a model for OpenRouter (in the routing list, or when the session starts)");
      const doFetch = entry.fetch || globalThis.fetch;
      let res;
      try {
        res = await (pin && !entry.fetch ? (/** @type {any} */ u, /** @type {any} */ i) => pinnedFetch(u, i, pin) : doFetch)(`${base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout((Number(entry.idleMs) || IDLE_MS) * 4),
          headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Vyre" },
          body: JSON.stringify({ model: input.model, messages: input.messages, stream: false, usage: { include: true }, provider: { data_collection: "deny" }, ...(input.max_output_tokens ? { max_tokens: input.max_output_tokens } : {}) }) });
      } catch (e) { throw fail(`OpenRouter could not be reached: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), "unavailable"); }
      if (!res.ok) { const body = String(await res.text().catch(() => "")).slice(0, 200); throw fail(`OpenRouter answered ${res.status}: ${body}`, classifyAiError({ status: res.status, text: body })); }
      const j = /** @type {any} */ (await res.json());
      if (j.error) throw fail(String(j.error.message || "the model refused"), classifyAiError({ status: j.error.code, text: String(j.error.message || "") }));
      const content = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "");
      const u = j.usage;
      return { content, ...(u ? { usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, cost_usd: Number(u.cost) || 0 } } : {}) };
    },
  };
}

/** The model an OpenRouter turn asks for. @param {any} o @param {any} entry @returns {string} */
export function modelFor(o, entry) {
  const asked = String(o.model || "");
  return asked.includes("/") ? asked : String((o.env && o.env.VYRE_API_MODEL) || entry.model || OPENROUTER_DEFAULT_MODEL);
}

/** @param {{ id?: string, keyEnv?: string, baseUrl?: string, idleMs?: number, model?: string, fetch?: typeof fetch, door?: any, legacyDirect?: boolean, chainFor?: (o: any) => any, warn?: (m: string) => void, store?: { get(id: string): any[]|undefined, set(id: string, messages: any[]): void } }} [entry] */
export function openrouterProvider(entry = {}) {
  const memory = new Map();
  const store = entry.store || { get: id => memory.get(id), set: (id, m) => { memory.set(id, m); } };
  return {
    id: entry.id || "openrouter",
    driver: "http",
    capabilities: { streaming: true, resume: true, interrupt: true, modes: false, steering: false, usage: "detailed", rewind: false, process: false, tools: false },
    /** @param {any} o */
    run(o) { return runChat(entry, store, o); },
  };
}

/** @param {any} entry @param {any} store @param {any} o */
function runChat(entry, store, o) {
  const doFetch = entry.fetch || globalThis.fetch;
  const key = String((o.env && o.env[entry.keyEnv || "OPENROUTER_API_KEY"]) || "");
  // An account may name its own endpoint and model (the setup screen's "OpenAI-compatible": a key plus a base URL): https, or this machine only; anything else
  // is ignored here, so a bad value can never send the key somewhere else.
  const acctBase = o.env && o.env.VYRE_API_BASE_URL && okBase(String(o.env.VYRE_API_BASE_URL)) ? String(o.env.VYRE_API_BASE_URL) : "";
  const base = String(acctBase || entry.baseUrl || BASE).replace(/\/+$/, "");
  // The model is the one the person chose: the account's saved one, else the routing entry's, else the default first run saves. A launch's own model counts only when it is an OpenRouter id ("vendor/model"): a Claude
  // alias such as "opus", which a chat's default carries, is not a model OpenRouter knows and is never sent to it.
  const model = modelFor(o, entry);
  /** @type {{ role: string, content: string }[]} */
  const history = o.resume ? [...(store.get(o.id) || [])] : [];
  const queue = /** @type {string[]} */ ([]);
  let busy = false, alive = true, ac = /** @type {AbortController|null} */ (null), total = 0, turn = 0, asked = false;   // asked: the person interrupted or stopped it
  const say = m => { try { o.onMessage(m); } catch {} };
  const exit = () => { if (!alive) return; alive = false; try { o.onExit(0, null, ""); } catch {} };
  const textOf = c => (typeof c === "string" ? c : Array.isArray(c) ? c.map(b => (b && b.type === "text" ? String(b.text) : "")).join("") : "");

  say({ type: "system", subtype: "init", session_id: o.id, model, resumed: Boolean(o.resume) });

  async function pump() {
    if (busy || !alive || !queue.length) return;
    busy = true;
    const prompt = /** @type {string} */ (queue.shift());
    history.push({ role: "user", content: prompt });
    const messages = [...(o.system && o.system.text ? [{ role: "system", content: String(o.system.text) }] : []), ...history.slice(-MAX_HISTORY)];
    ac = new AbortController();
    asked = false;
    // One reply is one message: the stream names it (message_start) before its first text, and the finished message carries the same id and block, so a surface draws one bubble and not two. (Claude Code does the same.)
    const mid = `or-turn-${turn + 1}`; let opened = false;
    const delta = (/** @type {string} */ t) => { if (!opened) { opened = true; say({ type: "stream_event", event: { type: "message_start", message: { id: mid } } }); } say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } }); };
    let text = "", cost = 0, usage = null, failed = null, cancelled = false;
    try {
      if (!okBase(base)) throw new Error("the OpenRouter address must be https");
      // Resolved again on every turn: a name that now points at a private, tailnet or metadata address gets no key and no prompt.
      // A test double (entry.fetch) is called as is; otherwise the request goes to the address just resolved, so nothing can change under it.
      const pin = entry.fetch && !entry.lookup ? null : await resolveSafe(base, entry.lookup);
      if (!(entry.fetch && !entry.lookup) && !pin) throw new Error("that address is not a place a key may be sent");
      if (!key) throw new Error("no OpenRouter key on this account");
      if (!model) throw new Error("choose a model for OpenRouter (in the routing list, or when the session starts)");
      // The owner's own API-key account (VYRE_OWNER_ACCOUNT, set from the account row by the Switchboard, never from a request) may go direct when no door is connected; its prompt is scrubbed of credentials first. Any other run needs the door.
      const door = typeof entry.door === "function" ? entry.door() : entry.door;   // a getter: the door is there only on a home with a sealing process
      const via = route({ door, legacyDirect: entry.legacyDirect, directOk: Boolean(o.env && o.env.VYRE_OWNER_ACCOUNT === "1"), warn: entry.warn }, entry.id || "openrouter");
      if ("refused" in via) throw new Error(via.refused);
      if ("door" in via) {
        // Through the door: scanned, ledgered, residency and budget checked. The door answers whole, so the text arrives as one chunk (a known gap).
        let out;
        try { out = await via.door.call({ chain: await (entry.chainFor ? entry.chainFor(o) : o.chain), purpose: "session", provider: entry.id || "openrouter", model, session: String(o.id), messages, credential: { key, base } }); }
        catch (e) { if (isRefusal(e)) throw new Error(doorMessage(e) || "the inference door refused this"); throw e; }
        text = String(out.content || "");
        if (!text) throw new Error("the model returned no answer");
        delta(text);
        if (out.usage) { usage = { prompt_tokens: out.usage.input_tokens, completion_tokens: out.usage.output_tokens }; cost = Number(out.usage.cost_usd) || 0; }
        throw DONE;
      }
      const sent = "direct" in via && !entry.legacyDirect ? messages.map(m => ({ ...m, content: typeof m.content === "string" ? redactCredentials(m.content).text : m.content })) : messages;
      const res = await (pin && !entry.fetch ? (u, i) => pinnedFetch(u, i, pin) : doFetch)(`${base}/chat/completions`, { method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Vyre" },
        body: JSON.stringify({ model, messages: sent, stream: true, usage: { include: true }, provider: { data_collection: "deny" } }) });
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}: ${String(await res.text().catch(() => "")).slice(0, 200)}`);
      const dec = new TextDecoder();
      let buf = "", got = 0, other = "";   // other: what is not a server-sent event line (a plain JSON answer, or an error body), kept to be read when the stream ends
      const it = /** @type {any} */ (res.body)[Symbol.asyncIterator]();
      for (;;) {
        // No data for a minute ends the turn; so does an answer past the cap.
        let timer;
        const step = await Promise.race([it.next(), new Promise(r => { timer = setTimeout(() => r({ idle: true }), Number(entry.idleMs) || IDLE_MS); })]).finally(() => clearTimeout(timer));
        if (/** @type {any} */ (step).idle) { ac.abort(); throw new Error("OpenRouter stopped answering"); }
        if (/** @type {any} */ (step).done) break;
        const chunk = /** @type {any} */ (step).value;
        got += chunk.length;
        if (got > MAX_STREAM) { ac.abort(); throw new Error("the answer ran past the size Vyre keeps (1 MB) and was cut"); }
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) { if (line && !line.startsWith(":") && other.length < 65_536) other += line + "\n"; continue; }
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(String(j.error.message || "the model refused"));
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (typeof d === "string" && d) { text += d; delta(d); }
          if (j.usage) { usage = j.usage; cost = Number(j.usage.cost) || 0; }
        }
      }
      if (buf.trim() && !buf.trim().startsWith("data:") && other.length < 65_536) other += buf;
      // An answer that is not a stream (a plain JSON body, or an error sent with a 200) is read whole; a turn with no text at all is a failure said in words, never an empty "success".
      if (!text && other.trim()) {
        let j = null; try { j = JSON.parse(other); } catch { /* not JSON */ }
        if (j && j.error) throw new Error(String(j.error.message || "the model refused"));
        const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (typeof c === "string" && c) { text = c; delta(c); if (j.usage) { usage = j.usage; cost = Number(j.usage.cost) || 0; } }
        else if (!j) throw new Error(`OpenRouter sent something Vyre could not read: ${other.replace(/\s+/g, " ").slice(0, 120)}`);
      }
      if (!text) throw new Error("the model returned no answer");
    } catch (e) {
      if (e === DONE) { /* answered through the door */ }
      else if (asked && ac.signal.aborted) cancelled = true; else failed = /** @type {Error} */ (e);
      // Whatever an error carries, the key is never in it.
      if (failed && key) failed = new Error(scrubText(String(failed.message), [key], { marker: "[key]", min: 1 }));
    }
    ac = null;
    if (text) { history.push({ role: "assistant", content: text }); turn++; say({ type: "assistant", message: { id: mid, content: [{ type: "text", text }] } }); }
    else if (history.length && history[history.length - 1].role === "user") history.pop();   // an unanswered turn is not kept
    store.set(o.id, history.slice(-MAX_HISTORY));
    total += cost;
    const limited = failed && /\b(429|402)\b|rate.?limit|insufficient|credit/i.test(failed.message);
    say({ type: "result", subtype: failed ? "error" : "success", is_error: Boolean(failed), result: failed ? (limited ? `usage limit reached: ${failed.message}` : failed.message) : cancelled ? "interrupted" : text,
      total_cost_usd: total, usage: usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } : {} });
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
