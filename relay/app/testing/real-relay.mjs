// @ts-check
// The real relay Worker, run locally by wrangler (workerd with its Durable Objects), for tests that must not use a stand-in: start it,
// and register a Wink ticket on it the way a box does (a signed control socket, then {t:"ticket"}). Throwaway runners and CI only.

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { routeId, authMessage } from "../../worker/index.js";
import { ticketSeal, ticketMac, ticketDerive } from "../../../core/relay/wire.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** @param {number} port @returns {Promise<{ url: string, stop: () => Promise<void> }>} */
export async function startRelay(port) {
  const bin = path.join(ROOT, "tools", "wrangler", "node_modules", ".bin", "wrangler");
  // The deployed config, made fit for a local run: the entry that exports only what workerd accepts, no custom domain, no rate-limit bindings.
  const dir = path.join(ROOT, "relay", "worker");
  const dev = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8")
    .replace('main = "index.js"', 'main = "dev-entry.js"')
    .replace(/workers_dev = false\nroutes = \[[^\n]*\]\n/, "")
    .replace(/\[\[ratelimits\]\]\nname = "[A-Z_]+"\nnamespace_id = "\d+"\nsimple = \{[^}]*\}\n/g, "");
  const devFile = path.join(dir, ".wrangler.dev.toml");
  fs.writeFileSync(devFile, dev);
  const child = spawn(bin, ["dev", "--config", ".wrangler.dev.toml", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", path.join(ROOT, ".wrangler-test-state")], { cwd: path.join(ROOT, "relay", "worker"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${url}/health`); if (r.ok) break; } catch {}
    if (child.exitCode !== null) { fs.rmSync(devFile, { force: true }); throw new Error("wrangler dev exited: " + log.slice(-800)); }
    await sleep(500);
    if (i === 119) throw new Error("wrangler dev did not come up: " + log.slice(-800));
  }
  return { url, stop: async () => { child.kill(); fs.rmSync(devFile, { force: true }); fs.rmSync(path.join(ROOT, ".wrangler-test-state"), { recursive: true, force: true }); await new Promise(r => { child.once("exit", r); setTimeout(r, 3000); }); } };
}

/**
 * A box registers a Wink ticket on the relay, as core/relay does. Resolves with the ticket (base64url) once the relay has answered.
 * @param {string} url the relay's http address @param {{ name?: string, handle?: string | null, relay?: string }} [o]
 */
export async function registerTicket(url, o = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const route = await routeId(pub);
  const boxKey = crypto.randomBytes(32);
  const raw = crypto.randomBytes(8);
  const exp = Date.now() + 5 * 60_000;
  const record = ticketSeal(raw, JSON.stringify({ v: 1, name: o.name || "alex", handle: o.handle === undefined ? "alex" : o.handle, relay: o.relay || "wss://relay.vyre.run", route, box: boxKey.toString("base64url"), exp }));
  const mac = ticketMac(raw, record).toString("base64url");
  const loc = ticketDerive("loc", raw).toString("base64url");
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/v1/box?route=${route}`);
  const answered = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the relay did not answer the registration")), 15000);
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.t === "challenge") {
        const sig = crypto.sign(null, Buffer.from(authMessage(route, new Uint8Array(Buffer.from(m.n, "base64url")))), privateKey);
        ws.send(JSON.stringify({ t: "auth", pub: Buffer.from(pub).toString("base64url"), sig: sig.toString("base64url") }));
      } else if (m.t === "ready") ws.send(JSON.stringify({ t: "ticket", loc, record, mac, exp }));
      else if (m.t === "registered") { clearTimeout(t); resolve(m.status); }
    };
    ws.onerror = () => reject(new Error("the box socket failed"));
  });
  const status = await answered;
  if (status !== 200) throw new Error(`the relay answered ${status} to the registration`);
  return { ticket: raw.toString("base64url"), loc, boxKey, ws };
}
