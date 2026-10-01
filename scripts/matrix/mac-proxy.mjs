// mac-proxy.mjs <https-tunnel-url>: 127.0.0.1:7300 on this Mac runner, forwarded to the box on a
// Linux runner through a throwaway tunnel. The page and the iOS simulator see the box as
// 127.0.0.1:7300, the only Host its onboarding takes; the tunnel's far end sets that Host for the
// box (cloudflared --http-host-header). Plain requests and WebSocket upgrades. CI runners only.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const target = new URL(process.argv[2]);
if (!process.env.CI) { console.error("mac-proxy: runs on a CI runner only"); process.exit(2); }
const headersFor = h => ({ ...h, host: target.host });

const server = http.createServer((req, res) => {
  const up = https.request({ host: target.hostname, port: 443, method: req.method, path: req.url, headers: headersFor(req.headers) }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", e => { res.writeHead(502); res.end("mac-proxy: " + e.message); });
  req.pipe(up);
});
server.on("upgrade", (req, socket, head) => {
  const up = tls.connect({ host: target.hostname, port: 443, servername: target.hostname }, () => {
    const h = headersFor(req.headers);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(7300, "127.0.0.1", () => console.log(`mac-proxy: 127.0.0.1:7300 -> ${target.host}`));
