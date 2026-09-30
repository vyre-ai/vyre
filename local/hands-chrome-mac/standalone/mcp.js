// @ts-check
// mcp: a small stdio MCP server (newline-delimited JSON-RPC 2.0), no dependencies. It serves the
// runtime's tools to Claude Code. stdout carries the protocol and nothing else; logs go to stderr.

const PROTOCOL = "2025-06-18";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
/** MCP tool names allow no dots. @param {string} n */
export const wireName = n => n.replace(/\./g, "_");

/**
 * @param {{ runtime: any, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, name?: string, version?: string, log?: (m: string) => void }} o
 * @returns {Promise<void>} resolves when stdin ends
 */
export function serve({ runtime, stdin, stdout, name = "vyre-chrome", version = "0.0.0", log = () => {} }) {
  let clientElicits = false;
  let nextServerId = 1;
  /** @type {Map<number, (m: any) => void>} */ const asking = new Map();
  /** Ask the person through the client (MCP elicitation), or null when the client cannot. @param {string} message */
  const ask = (/** @type {string} */ message) => !clientElicits ? null : new Promise(resolve => {
    const id = `s${nextServerId++}`;
    const t = setTimeout(() => { asking.delete(/** @type {any} */ (id)); resolve({ action: "cancel" }); }, 5 * 60_000);
    asking.set(/** @type {any} */ (id), (/** @type {any} */ m) => { clearTimeout(t); resolve(m && m.result ? m.result : { action: "cancel" }); });
    send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message, requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Send it" } }, required: ["approve"] } } });
  });
  const byWire = () => new Map(runtime.list().map((/** @type {any} */ t) => [wireName(t.name), t.name]));
  const send = (/** @type {any} */ m) => { try { stdout.write(JSON.stringify(m) + "\n"); } catch (e) { log(`write failed: ${/** @type {Error} */ (e).message}`); } };
  const reply = (/** @type {any} */ id, /** @type {any} */ result) => send({ jsonrpc: "2.0", id, result });
  const fail = (/** @type {any} */ id, /** @type {number} */ code, /** @type {string} */ message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  /** A tool result as MCP content: a screenshot becomes an image block, the rest is text. @param {any} r */
  function content(r) {
    const img = r && typeof r === "object" && r.image && typeof r.image.data === "string" ? r.image : null;
    if (!img) return [{ type: "text", text: JSON.stringify(r ?? null) }];
    const { image, ...rest } = r;
    return [{ type: "image", data: img.data, mimeType: img.mime || "image/jpeg" }, { type: "text", text: JSON.stringify({ ...rest, image: { mime: img.mime, bytes: img.bytes } }) }];
  }

  async function onCall(/** @type {any} */ id, /** @type {any} */ p) {
    const receivedAt = Date.now();
    const real = byWire().get(String(p && p.name));
    if (!real) return fail(id, -32602, `unknown tool ${p && p.name}`);
    let out;
    try { out = await runtime.invoke(real, p.arguments || {}, { receivedAt, ask: clientElicits ? ask : null }); }
    catch (e) { out = { ok: false, error: e }; }
    if (out.ok) return reply(id, { content: content(out.result) });
    const e = out.error || {};
    const msg = String(e.message || e);
    reply(id, { isError: true, content: [{ type: "text", text: /^[a-z_]+: /.test(msg) || !e.code ? msg : `${e.code}: ${msg}` }] });
  }

  function onMessage(/** @type {any} */ m) {
    if (!m || typeof m !== "object") return;
    if (typeof m.method !== "string" && !(m.id !== undefined && asking.has(m.id))) return;
    // A reply to something we asked the client (an approval).
    if (m.method === undefined && m.id !== undefined && asking.has(m.id)) { const f = /** @type {any} */ (asking.get(m.id)); asking.delete(m.id); return f(m); }
    const { id, method, params } = m;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case "initialize": {
        const asked = params && params.protocolVersion;
        clientElicits = Boolean(params && params.capabilities && params.capabilities.elicitation);
        return reply(id, { protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name, version },
          instructions: "Vyre for Chrome. Control the person's own Chrome. Read with chrome_snapshot, act with chrome_act and chrome_fill. Reuse the open tab (chrome_tabs use); never open a tab per step. A send, post or payment is held and returns an id: call chrome_send with it, which the person approves. If the person presses Esc everything stops until they answer and you call chrome_resume." });
      }
      case "ping": return isRequest ? reply(id, {}) : undefined;
      case "tools/list": return reply(id, { tools: runtime.list().map((/** @type {any} */ t) => ({ name: wireName(t.name), description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": return void onCall(id, params).catch(e => fail(id, -32603, String(e && e.message || e)));
      default:
        if (method.startsWith("notifications/")) return;
        if (isRequest) fail(id, -32601, `method not found: ${method}`);
    }
  }

  return new Promise(resolve => {
    let buf = "";
    stdin.setEncoding && stdin.setEncoding("utf8");
    stdin.on("data", (/** @type {string} */ d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
        try { onMessage(m); } catch (e) { log(`handler error: ${/** @type {Error} */ (e).message}`); if (m && m.id != null) fail(m.id, -32603, "internal error"); }
      }
      if (buf.length > 8 * 1024 * 1024) buf = "";
    });
    stdin.on("end", () => resolve());
    stdin.on("close", () => resolve());
  });
}
