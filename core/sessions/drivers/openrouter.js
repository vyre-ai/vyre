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

import { hostSafe } from "../endpoint.js";

const BASE = "https://openrouter.ai/api/v1";
const MAX_HISTORY = 60;
const MAX_STREAM = 1_000_000;         // bytes of one answer, then it is cut
const IDLE_MS = 60_000;                // no data for this long ends the turn

/** https, or plain http to this machine only (a test double). @param {string} u */
const okBase = u => { try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname)); } catch { return false; } };

/** @param {{ id?: string, keyEnv?: string, baseUrl?: string, idleMs?: number, model?: string, fetch?: typeof fetch, store?: { get(id: string): any[]|undefined, set(id: string, messages: any[]): void } }} [entry] */
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
  // The model is the one the person chose (a launch's, or the routing entry's, or the one saved with the account): never a default that spends on their behalf.
  const model = String(o.model || (o.env && o.env.VYRE_API_MODEL) || entry.model || "");
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
    let text = "", cost = 0, usage = null, failed = null, cancelled = false;
    try {
      if (!okBase(base)) throw new Error("the OpenRouter address must be https");
      // Resolved again on every turn: a name that now points at a private, tailnet or metadata address gets no key and no prompt.
      if (!(entry.fetch && !entry.lookup) && !(await hostSafe(base, entry.lookup))) throw new Error("that address is not a place a key may be sent");
      if (!key) throw new Error("no OpenRouter key on this account");
      if (!model) throw new Error("choose a model for OpenRouter (in the routing list, or when the session starts)");
      const res = await doFetch(`${base}/chat/completions`, { method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Vyre" },
        body: JSON.stringify({ model, messages, stream: true, usage: { include: true }, provider: { data_collection: "deny" } }) });
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}: ${String(await res.text().catch(() => "")).slice(0, 200)}`);
      const dec = new TextDecoder();
      let buf = "", got = 0;
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
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(String(j.error.message || "the model refused"));
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (typeof d === "string" && d) { text += d; say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: d } } }); }
          if (j.usage) { usage = j.usage; cost = Number(j.usage.cost) || 0; }
        }
      }
    } catch (e) {
      if (asked && ac.signal.aborted) cancelled = true; else failed = /** @type {Error} */ (e);
      // Whatever an error carries, the key is never in it.
      if (failed && key) failed = new Error(String(failed.message).split(key).join("[key]"));
    }
    ac = null;
    if (text) { history.push({ role: "assistant", content: text }); say({ type: "assistant", message: { id: `or-turn-${++turn}`, content: [{ type: "text", text }] } }); }
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
