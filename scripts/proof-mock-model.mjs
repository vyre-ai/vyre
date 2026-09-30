// @ts-check
// A local stand-in for a model endpoint, for the runner proofs (scripts/provider-*-proof.mjs). It speaks the two wire formats the
// real CLIs use (OpenAI Responses, for Codex; chat completions, for Grok Build) and answers each request from a script:
//   script(request) -> { text } | { tool: { name, args }, then?: string } | { hang: true, text }
// `request` is { api, body, hasToolResult, toolNames, tools }. It logs what it was asked, never anything from headers but whether
// an Authorization header was present.

import http from "node:http";

/** The tool arguments a tool's own schema asks for, for a shell command. @param {any} tool @param {string} cmd */
export function shellArgs(tool, cmd) {
  const props = (tool && (tool.parameters || (tool.function && tool.function.parameters) || tool.input_schema) || {}).properties || {};
  if (props.command && props.command.type === "array") return { command: ["sh", "-c", cmd] };
  if (props.command) return { command: cmd };
  if (props.cmd) return { cmd };
  return { command: cmd };
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
      const tools = (Array.isArray(j.tools) ? j.tools : []).map(t => t);
      const toolNames = tools.map(t => t.name || (t.function && t.function.name) || t.type).filter(Boolean);
      const hasToolResult = api === "responses"
        ? (Array.isArray(j.input) && j.input.some(x => x && /function_call_output|custom_tool_call_output|local_shell_call_output/.test(String(x.type))))
        : (Array.isArray(j.messages) && j.messages.some(m => m && m.role === "tool"));
      seen.push({ method: req.method, url: path, api, model: j.model, stream: j.stream, toolNames: toolNames.slice(0, 12), hasToolResult, auth: Boolean(req.headers.authorization) });
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
