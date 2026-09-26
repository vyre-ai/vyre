// @ts-check
// listener — the three routes Mattermost calls back on: button presses, dialog submissions and
// the /vyre slash command. Nothing else is served.
//
// It binds where config says (on the box, the address the Mattermost container reaches vyred
// on) and holds no logic: every check (the hook secret, the owner, the slash token) is the
// bridge's, where it is tested. Bodies are capped, since anything on that network can post here.

import http from "node:http";

const MAX = 256 * 1024;

/**
 * @param {{ host?: string, port?: number, handlers: { action: (b: any) => Promise<any>, dialog: (b: any) => Promise<any>, slash: (f: Record<string, string>) => Promise<any> },
 *   log?: (m: string) => void }} o
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function listen({ host = "127.0.0.1", port = 0, handlers, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url || "/", "http://chat").pathname;
      const route = { "/chat/action": "action", "/chat/dialog": "dialog", "/chat/slash": "slash" }[path];
      if (req.method !== "POST" || !route) return reply(404, { error: "not found" });
      const raw = await read(req);
      if (raw === null) return reply(413, { error: "too large" });
      let body;
      if (route === "slash") body = Object.fromEntries(new URLSearchParams(raw));
      else { try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "not JSON" }); } }
      const out = await handlers[route](body);
      reply(out && out.status ? out.status : 200, out ? out.body : {});
    } catch (e) {
      log(`chat listener: ${/** @type {Error} */ (e).message}`);
      if (!res.headersSent) reply(500, { error: "failed" });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(undefined)); });
  const a = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`,
    close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }),
  };
}

/** @param {http.IncomingMessage} req @returns {Promise<string|null>} */
async function read(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}
