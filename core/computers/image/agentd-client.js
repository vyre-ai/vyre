// @ts-check
// agentd-client: `docker exec -i <computer> node /opt/agentd/agentd-client.js <action>` with the JSON body on standard input. It reads the token from the root-only file, calls agentd over its unix
// socket and prints agentd's JSON answer; exit status 0 for 2xx, 1 otherwise. This is vyred's only way into agentd.

import http from "node:http";
import fs from "node:fs";

const ACTION = /^(create|start|stop|wipe|remove)$/;

/** @param {{ socket: string, token: string, action: string, body: string }} o @returns {Promise<{ status: number, text: string }>} */
export function callAgentd(o) {
  return new Promise((resolve, reject) => {
    if (!ACTION.test(o.action)) return reject(new Error(`"${o.action}" is not an agentd action`));
    const req = http.request({ socketPath: o.socket, path: `/agents/${o.action}`, method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(o.body) } }, res => {
      let text = ""; res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode || 0, text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

async function main() {
  const body = await new Promise(r => { let b = ""; process.stdin.on("data", c => { b += c; }); process.stdin.on("end", () => r(b)); });
  const res = await callAgentd({ socket: process.env.AGENTD_SOCKET || "/run/agentd.sock", token: fs.readFileSync(process.env.AGENTD_TOKEN_FILE || "/var/lib/vyre/.agentd-token", "utf8").trim(), action: String(process.argv[2] || ""), body: String(body) });
  process.stdout.write(res.text);
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}
if (process.argv[1] && process.argv[1].endsWith("agentd-client.js")) main().catch(e => { process.stderr.write(String(e.message) + "\n"); process.exit(1); });
