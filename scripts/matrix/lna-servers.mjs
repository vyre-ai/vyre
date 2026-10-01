// lna-servers.mjs: the local server (loopback, answers /ping and /page with CORS) and the public page's
// server (/lna.html), for lna.mjs. CI runners only. Prints {"local":port,"public":port}.
import http from "node:http";
if (!process.env.CI) { console.error("lna-servers: runs on a CI runner only"); process.exit(2); }
const local = http.createServer((req, res) => {
  const h = { "access-control-allow-origin": "*", "access-control-allow-private-network": "true", "access-control-allow-headers": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, h).end(); return; }
  if (req.url.startsWith("/page")) { res.writeHead(200, { ...h, "content-type": "text/html" }).end("<title>local page</title><p>local page</p>"); return; }
  res.writeHead(200, { ...h, "content-type": "text/plain" }).end("pong");
});
await new Promise(r => local.listen(0, "127.0.0.1", r));
const pub = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }).end("<title>public page</title><p>public page</p>"); });
await new Promise(r => pub.listen(0, "127.0.0.1", r));
console.log(JSON.stringify({ local: local.address().port, public: pub.address().port }));
setInterval(() => {}, 1 << 30);
