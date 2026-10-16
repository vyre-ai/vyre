// @ts-check
// Two small proxies for the first-run proof, both in front of a vyred's unix socket, both keeping a list of the requests that went through (method and path, never a body or a header).
//   tcpFront:  a browser on loopback reaches the daemon (it serves /app/ and /v1/tools) the way the app's own window does, as the named caller.
//   unixFront: the installed Mac app connects to this socket instead of the daemon's; its bytes go through untouched, and the request lines are noted, so the proof can say what its window asked for.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

/** @param {{ socket: string, caller?: string }} o */
export async function tcpFront(o) {
  /** @type {string[]} */ const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${String(req.url).split("?")[0]}`);
    const up = http.request({ socketPath: o.socket, path: req.url, method: req.method, headers: { ...req.headers, host: "localhost", "x-vyre-caller": o.caller || "cli" } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // The page's event stream is a WebSocket: carry the upgrade through to the daemon as it is.
  server.on("upgrade", (req, client, head) => {
    const up = net.connect(o.socket, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries({ ...req.headers, host: "localhost", "x-vyre-caller": o.caller || "cli" }).map(([k, v]) => `${k}: ${v}`), "", ""];
      up.write(lines.join("\r\n"));
      if (head && head.length) up.write(head);
      client.pipe(up); up.pipe(client);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  const port = /** @type {any} */ (server.address()).port;
  return { port, url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r(null))) };
}

/** @param {{ listen: string, upstream: string }} o */
export async function unixFront(o) {
  /** @type {string[]} */ const calls = [];
  try { fs.unlinkSync(o.listen); } catch { /* none yet */ }
  const server = net.createServer((client) => {
    const up = net.connect(o.upstream);
    client.on("data", (d) => {
      for (const m of String(d).matchAll(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) (\/[^\s?]*)[^\s]* HTTP\/1\.[01]\r?$/gm)) calls.push(`${m[1]} ${m[2]}`);
      up.write(d);
    });
    up.on("data", (d) => client.write(d));
    for (const s of [client, up]) { s.on("error", () => { client.destroy(); up.destroy(); }); s.on("close", () => { client.destroy(); up.destroy(); }); }
  });
  await new Promise((r) => server.listen(o.listen, () => r(null)));
  return { calls, close: () => new Promise((r) => { server.close(() => r(null)); try { fs.unlinkSync(o.listen); } catch { /* gone */ } }) };
}
