// @ts-check
// A local stand-in for a model endpoint, for the runner proofs (scripts/provider-*-proof.mjs). It speaks the two wire formats the
// real CLIs use (OpenAI Responses, for Codex; chat completions, for Grok Build) and answers each request from a script:
//   script(request) -> { text } | { tool: { name, args }, then?: string } | { custom: { name, input } } | { hang: true, text }
// `request` is { api, body, hasToolResult, toolNames, tools } (tools: top-level and additional_tools, namespaces flattened).
//   step.custom = { name, input } answers with a custom (freeform) tool call, as Codex's `exec` is. It logs what it was asked, never anything from headers but whether
// an Authorization header was present.

import http from "node:http";

/** The tool arguments a tool's own schema asks for, for a shell command. @param {any} tool @param {string} cmd */
export function shellArgs(tool, cmd) {
  const schema = (tool && (tool.parameters || (tool.function && tool.function.parameters) || tool.input_schema) || {});
  const props = schema.properties || {};
  /** @type {Record<string, any>} */ let args;
  if (props.command && props.command.type === "array") args = { command: ["sh", "-c", cmd] };
  else if (props.command) args = { command: cmd };
  else if (props.cmd) args = { cmd };
  else args = { command: cmd };
  // Every other field the tool's own schema requires, filled with the plainest value of its type (Grok's run_terminal_command wants a
  // `description`, and a call that fails to parse never reaches the permission question).
  for (const k of Array.isArray(schema.required) ? schema.required : []) {
    if (k in args) continue;
    const ty = props[k] && props[k].type;
    args[k] = ty === "boolean" ? false : ty === "number" || ty === "integer" ? 0 : ty === "array" ? [] : ty === "object" ? {} : "proof";
  }
  return args;
}

/** @param {(req: any) => any} script */
export function mockModel(script) {
  /** @type {any[]} */ const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      /** @type {any} */ let j = {}; try { j = JSON.parse(body); } catch {}
      const path = String(req.url).split("?")[0];
      const api = /\/responses$/.test(path) ? "responses" : /\/chat\/completions$/.test(path) ? "chat" : null;
      // Codex 0.159 with its newer models declares no top-level `tools`: they ride in an `additional_tools` input item, grouped in
      // namespaces, and the nested ones (the shell as tools.exec_command, an MCP server's as tools.mcp__<server>__<tool>) are only
      // reachable from inside the one `exec` custom tool's JavaScript. So the declared tools are every top-level one and every
      // additional_tools one, namespaces flattened.
      const flat = ts => (Array.isArray(ts) ? ts : []).flatMap(t => (t && t.type === "namespace" ? flat(t.tools) : [t]));
      const extra = (Array.isArray(j.input) ? j.input : []).filter(x => x && x.type === "additional_tools").flatMap(x => flat(x.tools));
      const tools = [...flat(j.tools), ...extra].filter(Boolean);
      const toolNames = tools.map(t => t.name || (t.function && t.function.name) || t.type).filter(Boolean);
      // A tool result counts only when it follows the person's latest message: the history of an earlier turn holds results of its own,
      // and treating those as this turn's would answer a new prompt with the old script's text.
      const lastUser = a => { for (let i = a.length - 1; i >= 0; i--) { const x = a[i]; if (x && ((x.type === "message" && x.role === "user") || x.role === "user")) return i; } return -1; };
      const hasToolResult = api === "responses"
        ? (Array.isArray(j.input) && j.input.slice(lastUser(j.input) + 1).some(x => x && /function_call_output|custom_tool_call_output|local_shell_call_output/.test(String(x.type))))
        : (Array.isArray(j.messages) && j.messages.slice(lastUser(j.messages) + 1).some(m => m && m.role === "tool"));
      seen.push({ method: req.method, url: path, api, model: j.model, stream: j.stream, keys: Object.keys(j).slice(0, 14), toolNames: toolNames.slice(0, 14), toolTypes: [...new Set(tools.map(t => t.type))], toolChoice: j.tool_choice, hasToolResult, auth: Boolean(req.headers.authorization) });
      if (req.method !== "POST" || !api) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `mock: no ${req.method} ${req.url}` } })); return; }
      const step = script({ api, body: j, hasToolResult, toolNames, tools }) || { text: "OK" };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const done = () => res.end();
      if (api === "responses") responses(res, j, step, done); else chat(res, j, step, done);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: /** @type {any} */ (server.address()).port, seen, close: () => server.close() })));
}

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function responses(res, j, step, done) {
  const model = j.model || "mock";
  res.write(ev("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", model, output: [] } }));
  if (step.custom) {
    // A custom (freeform) tool call, as Codex's `exec` is: the input is source text, not JSON.
    const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_c1", name: step.custom.name, input: step.custom.input, status: "completed" };
    res.write(ev("response.output_item.added", { output_index: 0, item: { ...item, input: "", status: "in_progress" } }));
    res.write(ev("response.custom_tool_call_input.delta", { item_id: "ctc_1", output_index: 0, delta: step.custom.input }));
    res.write(ev("response.custom_tool_call_input.done", { item_id: "ctc_1", output_index: 0, input: step.custom.input }));
    res.write(ev("response.output_item.done", { output_index: 0, item }));
    res.write(ev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", model, output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }));
    return done();
  }
  if (step.tool) {
    const args = JSON.stringify(step.tool.args);
    const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: step.tool.name, arguments: args, status: "completed" };
    res.write(ev("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }));
    res.write(ev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: args }));
    res.write(ev("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: args }));
    res.write(ev("response.output_item.done", { output_index: 0, item }));
    res.write(ev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", model, output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }));
    return done();
  }
  const msg = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] };
  res.write(ev("response.output_item.added", { output_index: 0, item: { ...msg, status: "in_progress", content: [] } }));
  res.write(ev("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
  const finish = () => {
    res.write(ev("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: step.text }));
    res.write(ev("response.output_item.done", { output_index: 0, item: msg }));
    res.write(ev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", model, output: [msg], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }));
    done();
  };
  if (step.hang) {
    // A slow answer: a word, then nothing for a long while (so a turn can be interrupted), then the rest.
    res.write(ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "working " }));
    const t = setTimeout(() => { res.write(ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: step.text })); finish(); }, 60_000);
    res.on("close", () => clearTimeout(t));
    return;
  }
  res.write(ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: step.text }));
  finish();
}

function chat(res, j, step, done) {
  const model = j.model || "mock";
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`;
  if (step.tool) {
    res.write(chunk({ role: "assistant", content: null }));
    res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }));
    res.write(chunk({}, "tool_calls"));
    res.write(usage); res.write("data: [DONE]\n\n");
    return done();
  }
  res.write(chunk({ role: "assistant", content: "" }));
  if (step.hang) {
    res.write(chunk({ content: "working " }));
    const t = setTimeout(() => { res.write(chunk({ content: step.text })); res.write(chunk({}, "stop")); res.write(usage); res.write("data: [DONE]\n\n"); done(); }, 60_000);
    res.on("close", () => clearTimeout(t));
    return;
  }
  res.write(chunk({ content: step.text }));
  res.write(chunk({}, "stop"));
  res.write(usage); res.write("data: [DONE]\n\n");
  done();
}
