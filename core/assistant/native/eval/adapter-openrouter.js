// @ts-check
// The OpenRouter adapter for the fit eval: chat completions with function calling, so a Claude, GPT or Gemini model is scored through one door with one key.
// Used by run.js only, never by a test. Tool names go out with `__` for `.` as in the Claude adapter; how a tool result is returned is this file's own.

const URL = "https://openrouter.ai/api/v1/chat/completions";
const out = (/** @type {string} */ n) => n.replace(/\./g, "__");
const back = (/** @type {string} */ n) => n.replace(/__/g, ".");

/** @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} o @returns {import("./fit.js").Adapter} */
export function openrouterAdapter({ apiKey, model, fetchImpl = fetch }) {
  return {
    name: model,
    async run(messages, tools, opts) {
      const wire = messages.map(m => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) return { role: "assistant", content: m.content || null, tool_calls: m.tool_calls.map(c => ({ id: c.id, type: "function", function: { name: out(c.name), arguments: JSON.stringify(c.input ?? {}) } })) };
        return { role: m.role, content: m.content };
      });
      const res = await fetchImpl(URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: opts.max_tokens, messages: wire, tools: tools.map(t => ({ type: "function", function: { name: out(t.name), description: t.description, parameters: t.schema } })) }) });
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
      const j = /** @type {any} */ (await res.json());
      const msg = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message : {};
      /** @param {any} s */ const parse = s => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
      return { content: String(msg.content || ""),
        tool_calls: (msg.tool_calls || []).map((/** @type {any} */ c) => ({ id: c.id, name: back(c.function.name), input: parse(c.function.arguments) })),
        usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 } };
    },
  };
}
