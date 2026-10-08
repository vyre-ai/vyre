// @ts-check
// The stand-ins every walk uses, and nothing else outside the server itself: the names directory (scripts/standin-directory.mjs, the Worker's real code on the fake runtime) and the relay
// (relay/node/server.js, the real relay). Both listen on loopback, or on all interfaces when a server in a container has to reach them. Nothing here ever touches vyre.run.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "../../../relay/node/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

/** @returns {Promise<number>} */
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); s.on("error", rej); });

/** @param {number} port @param {string} host @param {number} [ms] */
async function waitPort(port, host, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise(r => { const c = net.connect(port, host, () => { c.destroy(); r(true); }); c.on("error", () => r(false)); });
    if (ok) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`nothing listened on ${host}:${port}`);
}

/**
 * @param {{ out: string, host?: string, publicHost?: string, liveRelay?: string }} o `host` is where they listen (127.0.0.1, or 0.0.0.0 for a container); `publicHost` is the address a server in a container uses for them.
 */
export async function startStandins(o) {
  const host = o.host || "127.0.0.1", pub = o.publicHost || "127.0.0.1";
  fs.mkdirSync(o.out, { recursive: true });
  // --live-relay: the real relay is the transport only (pairing tickets and channels are its normal use); the names directory stays the stand-in, so no name is ever written for real.
  const relay = o.liveRelay ? null : createRelay({});
  const relayUrl = relay ? await relay.listen(0, host) : "";
  const relayPort = relay ? Number(new URL(relayUrl.replace(/^ws/, "http")).port) : 0;
  const port = await freePort();
  const logFd = fs.openSync(path.join(o.out, "standin-directory.log"), "a");
  const dir = spawn(process.execPath, [path.join(repo, "scripts/standin-directory.mjs"), "--port", String(port), "--host", host, "--zone", "vyre.test", "--claims-per-ip", "1000"], { stdio: ["ignore", logFd, logFd] });
  await waitPort(port, host === "0.0.0.0" ? "127.0.0.1" : host);
  return {
    relay: o.liveRelay || `ws://127.0.0.1:${relayPort}`, names: `http://127.0.0.1:${port}`,
    // a server in a container takes only a loopback ws relay, so it is given the same ws://127.0.0.1 address and the installer walk forwards it (server-installer.mjs)
    relayForServer: o.liveRelay || `ws://127.0.0.1:${relayPort}`, relayPort, hostIp: pub, namesForServer: `http://${pub}:${port}`,
    async stop() { try { dir.kill("SIGTERM"); } catch { /* gone */ } try { if (relay) await relay.close(); } catch { /* closed */ } },
  };
}
