// @ts-check
// The Claude adapter for the fit eval: the Anthropic Messages API, nothing else. Used by run.js only, never by a test. Everything that differs
// between providers (tool name rules, how a tool result is sent back) lives in an adapter like this one; the eval never sees it.

const URL = "https://api.anthropic.com/v1/messages";
/** The API allows letters, digits, underscore and hyphen in a tool name: Vyre's `matters.find` goes out as `matters__find`. */
const out = (/** @type {string} */ n) => n.replace(/\./g, "__");
const back = (/** @type {string} */ n) => n.replace(/__/g, ".");

/** @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} o @returns {import("./fit.js").Adapter} */
export function claudeAdapter({ apiKey, model, fetchImpl = fetch }) {
  return {
    name: model,
    async run(messages, tools, opts) {
      const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
      /** @type {any[]} */ const wire = [];
      for (const m of messages) {
        if (m.role === "user") wire.push({ role: "user", content: m.content });
        else if (m.role === "assistant") wire.push({ role: "assistant", content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...(m.tool_calls || []).map(c => ({ type: "tool_use", id: c.id, name: out(c.name), input: c.input || {} }))] });
        else if (m.role === "tool") {
          const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
          const prev = wire[wire.length - 1];
          if (prev && prev.role === "user" && Array.isArray(prev.content)) prev.content.push(block); else wire.push({ role: "user", content: [block] });
        }
      }
      const res = await fetchImpl(URL, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: opts.max_tokens, system, messages: wire, tools: tools.map(t => ({ name: out(t.name), description: t.description, input_schema: t.schema })) }) });
      if (!res.ok) throw new Error(`the Anthropic API answered ${res.status}`);
      const j = /** @type {any} */ (await res.json());
      const blocks = Array.isArray(j.content) ? j.content : [];
      return { content: blocks.filter((/** @type {any} */ b) => b.type === "text").map((/** @type {any} */ b) => b.text).join("\n"),
        tool_calls: blocks.filter((/** @type {any} */ b) => b.type === "tool_use").map((/** @type {any} */ b) => ({ id: b.id, name: back(b.name), input: b.input })),
        usage: { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: j.usage?.output_tokens ?? 0 } };
    },
  };
}
