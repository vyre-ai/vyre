// @ts-check
import http from "node:http";

/**
 * A fake Anthropic Messages API for driving a real Claude Code binary with no credentials:
 * point ANTHROPIC_BASE_URL at `url` and set ANTHROPIC_API_KEY to anything. The main loop's
 * request with n tool results in it gets steps[n](n) (the last step repeats): a block
 * { type: "tool_use", id, name, input } or { type: "text", text }. Side requests (titles, quota
 * checks: anything isMain says no to) get "ok". Streaming and plain JSON both work. `log` holds
 * every request { path, body }. Close with server.close().
 * @param {Array<(n: number) => any>} steps
 * @param {{ isMain?: (body: any) => boolean }} [o] default: the request offers tools
 * @returns {Promise<{ server: import("node:http").Server, log: Array<{ path: string|undefined, body: any }>, url: string }>}
 */
export function fakeApi(steps, { isMain = b => Array.isArray(b.tools) && b.tools.length > 0 } = {}) {
  /** @type {Array<{ path: string|undefined, body: any }>} */
  const log = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const b = body ? JSON.parse(body) : {};
      log.push({ path: req.url, body: b });
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(req.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      const main = isMain(b);
      const results = main ? b.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === "tool_result").length : -1;
      const block = main ? steps[Math.min(results, steps.length - 1)](results) : { type: "text", text: "ok" };
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const msg = { id: `msg_${log.length}`, type: "message", role: "assistant", model: b.model, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!b.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ...msg, content: [block], stop_reason: stop }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null } });
      if (block.type === "tool_use") {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, log, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` })));
}
