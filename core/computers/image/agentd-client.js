// @ts-check
// agentd-client: `/opt/agentd/client` run by `docker exec -i` as the dedicated agentctl user, with the request on standard input. It reads the token from the root-only file, calls agentd over its unix
// socket and prints agentd's JSON answer; exit status 0 for 2xx, 1 otherwise. This is vyred's only way into agentd.

import http from "node:http";
import fs from "node:fs";
import { SOCKET, TOKEN_FILE } from "./agentd-main.js";

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

/** The client vyred runs with `docker exec -i` as agentctl: the request is {"action", "body"} on standard input, the answer is {"status", "body"} on standard output (the exec has no exit code to read through the proxy). */
export async function main() {
  const raw = await new Promise(r => { let b = ""; process.stdin.on("data", c => { b += c; if (b.length > 16 * 1024) process.exit(2); }); process.stdin.on("end", () => r(b)); });
  /** @type {any} */ let req;
  try { req = JSON.parse(String(raw)); } catch { process.stderr.write("the request is not JSON\n"); process.exit(2); }
  const res = await callAgentd({ socket: SOCKET, token: fs.readFileSync(TOKEN_FILE, "utf8").trim(),
    action: String(req && req.action || ""), body: JSON.stringify(req && req.body || {}) });
  let body = null; try { body = JSON.parse(res.text); } catch { /* not json */ }
  process.stdout.write(JSON.stringify({ status: res.status, body }));
  process.exit(0);
}
