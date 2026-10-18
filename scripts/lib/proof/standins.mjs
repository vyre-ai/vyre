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

/**
 * @param {{ out: string, host?: string, publicHost?: string, liveRelay?: string, ports?: { relay?: number, names?: number }, appOrigins?: string }} o `host` is where they listen (127.0.0.1, or 0.0.0.0 for a container); `publicHost` is the address a server in a container uses for them.
 */
export async function startStandins(o) {
  const host = o.host || "127.0.0.1", pub = o.publicHost || "127.0.0.1";
  fs.mkdirSync(o.out, { recursive: true });
  // --live-relay: the real relay is the transport only (pairing tickets and channels are its normal use); the names directory stays the stand-in, so no name is ever written for real.
  const relay = o.liveRelay ? null : createRelay({});
  const relayUrl = relay ? await relay.listen(o.ports?.relay || 0, host) : "";
  const relayPort = relay ? Number(new URL(relayUrl.replace(/^ws/, "http")).port) : 0;
  // The port is picked free and released before the directory binds it, so a test running beside this one can take it in between: the directory then dies on EADDRINUSE while something else answers on the port. Each try
  // therefore starts the directory, waits for the PROCESS to be listening and to answer a real request, and takes a new port when it exits first (a named port is tried once).
  const logFd = fs.openSync(path.join(o.out, "standin-directory.log"), "a");
  /** @type {import("node:child_process").ChildProcess} */ let dir = /** @type {any} */ (null);
  let port = 0;
  for (let attempt = 1; ; attempt++) {
    port = o.ports?.names || await freePort();
    dir = spawn(process.execPath, [path.join(repo, "scripts/standin-directory.mjs"), "--port", String(port), "--host", host, "--zone", "vyre.test", "--claims-per-ip", "1000", ...(o.appOrigins ? ["--app-origins", o.appOrigins] : [])], { stdio: ["ignore", logFd, logFd] });
    const child = dir;
    let exited = false;
    child.once("exit", () => { exited = true; });
    try {
      const end = Date.now() + 15_000;
      for (;;) {
        if (exited) throw new Error(`the names directory exited before it answered on ${port}`);
        const up = await fetch(`http://127.0.0.1:${port}/v1/ids/resolve?name=standin-ready`, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false);
        // an answer from something else on a taken port can come before our own process has failed to bind: it must still be alive, and answer again, a moment later
        if (up && !exited) { await new Promise(r => setTimeout(r, 500)); if (exited) throw new Error(`the names directory exited before it answered on ${port}`); if (await fetch(`http://127.0.0.1:${port}/v1/ids/resolve?name=standin-ready`, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false)) break; }
        if (Date.now() > end) throw new Error(`nothing answered on 127.0.0.1:${port}`);
        await new Promise(r => setTimeout(r, 100));
      }
      break;
    } catch (e) {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      if (o.ports?.names || attempt >= 5) throw e;
    }
  }
  return {
    relay: o.liveRelay || (o.publicHost ? `ws://${pub}:${relayPort}` : `ws://127.0.0.1:${relayPort}`), names: `http://127.0.0.1:${port}`,
    // the app and a server in a container name the relay by the same address (the setup offer pins the relay it was made for), the runner's own
    relayForServer: o.liveRelay || (o.publicHost ? `ws://${pub}:${relayPort}` : `ws://127.0.0.1:${relayPort}`), relayPort, hostIp: pub, namesForServer: `http://${pub}:${port}`,
    async stop() { try { dir.kill("SIGTERM"); } catch { /* gone */ } try { if (relay) await relay.close(); } catch { /* closed */ } },
  };
}
