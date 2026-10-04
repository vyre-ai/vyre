// A ProxyCommand for ssh (git over ssh, port 22) through the runner's proxy: node proxycmd.js <proxy host:port> <token> <host> <port>.
// It does an HTTP CONNECT with the session token as the proxy password and then pipes stdin and stdout to the tunnel.
import net from "node:net";
const [proxy, token, host, port] = process.argv.slice(2);
const [ph, pp] = proxy.split(":");
const s = net.connect(Number(pp), ph, () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${Buffer.from("vyre:" + token).toString("base64")}\r\n\r\n`));
let head = Buffer.alloc(0), open = false;
s.on("data", d => {
  if (open) return void process.stdout.write(d);
  head = Buffer.concat([head, d]); const i = head.indexOf("\r\n\r\n"); if (i < 0) return;
  if (!/^HTTP\/1\.[01] 200/.test(head.toString("latin1", 0, 20))) { process.stderr.write("proxy refused: " + head.toString().split("\r\n")[0] + "\n"); process.exit(1); }
  open = true; const rest = head.subarray(i + 4); if (rest.length) process.stdout.write(rest); process.stdin.pipe(s);
});
s.on("end", () => process.exit(0)); s.on("error", e => { process.stderr.write(String(e.message) + "\n"); process.exit(1); });
process.stdin.on("end", () => s.end());
