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

const BASE = "https://openrouter.ai/api/v1";
const MAX_HISTORY = 60;

/** @param {{ baseUrl?: string, model?: string, fetch?: typeof fetch, store?: { get(id: string): any[]|undefined, set(id: string, messages: any[]): void } }} [entry] */
export function openrouterProvider(entry = {}) {
  const memory = new Map();
  const store = entry.store || { get: id => memory.get(id), set: (id, m) => { memory.set(id, m); } };
  return {
    id: "openrouter",
    driver: "http",
    capabilities: { streaming: true, resume: true, interrupt: true, modes: false, steering: false, usage: "detailed", rewind: false, process: false, tools: false },
    /** @param {any} o */
    run(o) { return runChat(entry, store, o); },
  };
}

/** @param {any} entry @param {any} store @param {any} o */
function runChat(entry, store, o) {
  const doFetch = entry.fetch || globalThis.fetch;
  const key = String((o.env && o.env.OPENROUTER_API_KEY) || "");
  const base = String(entry.baseUrl || BASE).replace(/\/+$/, "");
  const model = String(o.model || entry.model || "openrouter/auto");
  /** @type {{ role: string, content: string }[]} */
  const history = o.resume ? [...(store.get(o.id) || [])] : [];
  const queue = /** @type {string[]} */ ([]);
  let busy = false, alive = true, ac = /** @type {AbortController|null} */ (null), total = 0, turn = 0;
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
    let text = "", cost = 0, usage = null, failed = null, cancelled = false;
    try {
      if (!key) throw new Error("no OpenRouter key on this account");
      const res = await doFetch(`${base}/chat/completions`, { method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Vyre" },
        body: JSON.stringify({ model, messages, stream: true, usage: { include: true } }) });
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}: ${String(await res.text().catch(() => "")).slice(0, 200)}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of /** @type {any} */ (res.body)) {
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
      if (ac.signal.aborted) cancelled = true; else failed = /** @type {Error} */ (e);
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
    interrupt() { if (ac) ac.abort(); return Promise.resolve(); },
    async stop() { if (ac) ac.abort(); exit(); },
  };
}
