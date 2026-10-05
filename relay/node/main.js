// @ts-check
// The self-hosted relay and name directory as one container's entry (relay/Dockerfile). Plain HTTP and WebSocket: put TLS in front (relay/README.md).
//
//   VYRE_RELAY_PORT       relay port (default 8080; 0 turns the relay off)
//   VYRE_DIRECTORY_PORT   name directory port (default 8081; 0 turns the directory off)
//   VYRE_RELAY_HOST       bind address (default 0.0.0.0 inside the container; publish the port on 127.0.0.1 or behind your proxy)
//   VYRE_STATE_DIR        where the directory keeps its one state file (default /data)
//   VYRE_DIRECTORY_ORIGIN the directory's public https origin, when it has one
//   VYRE_DIRECTORY_ZONE   the zone its names live in (default vyre.local; nothing is published to DNS)
//   VYRE_TRUST_PROXY=1    take the client address from the proxy's x-forwarded-for
// The relay holds no state on disk: routes live in memory and a restart makes every box reconnect, which they do by themselves.
import path from "node:path";
import { createRelay } from "./server.js";
import { createDirectoryServer } from "./directory.js";

const env = process.env;
const host = env.VYRE_RELAY_HOST || "0.0.0.0";
const num = (/** @type {string | undefined} */ v, /** @type {number} */ d) => (v === undefined || v === "" ? d : Number(v));
const log = (/** @type {string} */ m) => console.log(`${new Date().toISOString()} ${m}`);
const stops = [];
const relayPort = num(env.VYRE_RELAY_PORT, 8080), dirPort = num(env.VYRE_DIRECTORY_PORT, 8081);
if (relayPort > 0) {
  const relay = createRelay({ log });
  log(`relay on ${await relay.listen(relayPort, host)}`);
  stops.push(() => relay.close());
}
if (dirPort > 0) {
  const d = await createDirectoryServer({ port: dirPort, host, zone: env.VYRE_DIRECTORY_ZONE, publicOrigin: env.VYRE_DIRECTORY_ORIGIN, stateFile: path.join(env.VYRE_STATE_DIR || "/data", "directory.state"), log });
  log(`name directory on ${d.url}`);
  stops.push(() => d.close());
}
if (!stops.length) { log("nothing to run: both ports are 0"); process.exit(1); }
const stop = async () => { for (const f of stops) { try { await f(); } catch { /* going down */ } } process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
