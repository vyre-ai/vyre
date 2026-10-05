// @ts-check
// stores/twenty/mac: what createStoreFor (space-store.js) needs on a Mac server, where the Space's Twenty runs in Colima's own Docker (the 0.2 decision: Colima only). The same pinned
// images and compose as a server (provision.js, unchanged); what differs is where docker is and how much room there is:
//   - docker runs against Colima's socket (DOCKER_HOST from ~/.vyre/vyre.env, never `docker context use`, so any other Docker on the Mac is left alone);
//   - the preflight asks `vyre-runtime room N` (lib/mac-runtime.js) whether the VM can hold N spaces, and says its plain message (and offers the person's server) when it cannot;
//   - a new Space's provision first calls makeRoom(N), which resizes the VM with a short restart and logs "Making room for a new space", then provisions as on a server.
// Use: createStoreFor({ home, ...macStoreOptions({ home, log }) }).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roomFor, makeRoom } from "../../lib/mac-runtime.js";
import { provisionSpace, spaceDir, realRunner } from "./provision.js";
import { REQUIRE } from "./space-store.js";

/** Colima's own socket for this account. @param {Record<string, string | undefined>} env */
const colimaSocket = env => `unix://${path.join(env.HOME || os.homedir(), ".colima", "default", "docker.sock")}`;

/**
 * The Docker host this Mac's Spaces use: DOCKER_HOST in the environment, else the line in vyre.env (what install-mac-server.sh writes), else Colima's own socket.
 * @param {{ env?: Record<string, string | undefined>, vyreHome?: string }} [o]
 */
export function dockerHostOf({ env = process.env, vyreHome } = {}) {
  if (env.DOCKER_HOST) return env.DOCKER_HOST;
  try {
    const f = path.join(vyreHome || env.VYRE_HOME || path.join(env.HOME || os.homedir(), ".vyre"), "vyre.env");
    const m = /^DOCKER_HOST=(.+)$/m.exec(fs.readFileSync(f, "utf8"));
    if (m) return m[1].trim();
  } catch { /* none */ }
  return colimaSocket(env);
}

/** How many Spaces of this home already run on Twenty (the personal Space counts when it does). @param {string} home */
export function countTwentySpaces(home) {
  let n = 0;
  const kind = (/** @type {string} */ dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8")).kind; } catch { return null; } };
  if (kind(path.join(home, "kernel")) === "twenty") n++;
  let names = [];
  try { names = fs.readdirSync(path.join(home, "kernel", "spaces")); } catch { /* none */ }
  for (const s of names) if (kind(path.join(home, "kernel", "spaces", s)) === "twenty") n++;
  return n;
}

/**
 * The options to spread into createStoreFor on a Mac.
 * @param {{ home: string, env?: Record<string, string | undefined>, log?: (line: string) => void,
 *   room?: typeof roomFor, makeRoom?: typeof makeRoom, statfs?: (p: string) => { bavail: number, bsize: number }, provision?: typeof provisionSpace }} o
 */
export function macStoreOptions(o) {
  const env = { ...(o.env ?? process.env) };
  env.DOCKER_HOST = dockerHostOf({ env, ...(env.VYRE_HOME ? { vyreHome: env.VYRE_HOME } : {}) });
  const log = o.log ?? (() => {});
  const room = o.room ?? roomFor, make = o.makeRoom ?? makeRoom;
  const total = (/** @type {string} */ dir) => countTwentySpaces(o.home) + (fs.existsSync(path.join(dir, "store.json")) ? 0 : 1);

  return {
    runner: realRunner({ env }),
    /** Twenty is reached on 127.0.0.1 at the port recorded in the Space's reach.json (provision.js, `publish: "loopback"`). */
    reach: /** @type {"loopback"} */ ("loopback"),
    /** The Mac's preflight: Colima's socket is there, there is disk, and the VM can be given room for this Space. Never throws. @param {{ dir: string }} p */
    async preflight(p) {
      /** @type {string[]} */ const reasons = [];
      const host = env.DOCKER_HOST ?? "";
      const sock = host.startsWith("unix://") ? host.slice(7) : "";
      const docker = Boolean(sock) && fs.existsSync(sock);
      if (!docker) reasons.push("Colima is not running on this Mac, so Docker is not there yet (it starts when the Mac does)");
      let disk = null;
      try { const s = (o.statfs ?? ((/** @type {string} */ q) => fs.statfsSync(q)))(fs.existsSync(p.dir) ? p.dir : path.dirname(p.dir)); disk = Math.floor((s.bavail * s.bsize) / 1048576); } catch { /* unknown */ }
      if (disk !== null && disk < REQUIRE.diskMb) reasons.push(`not enough disk: ${disk} MB free, a Space's Twenty needs about ${REQUIRE.diskMb} MB`);
      const r = await room(total(p.dir), { env });
      if (!r.ok) reasons.push(r.message);
      return { ok: reasons.length === 0, reasons, facts: { memoryAvailableMb: r.memory_gib ? r.memory_gib * 1024 : null, diskFreeMb: disk, docker, root: false, platform: process.platform } };
    },
    /** A new Space makes room first; one that is already provisioned just comes back up. @param {Parameters<typeof provisionSpace>[0]} p */
    async provision(p) {
      const provisioned = fs.existsSync(path.join(spaceDir(p.home, p.space), "service.key"));
      if (!provisioned) {
        const made = await make(countTwentySpaces(o.home) + 1, { env, onProgress: line => (p.log ?? log)(line) });
        if (!made.ok) throw Object.assign(new Error(made.message), { code: "unavailable", reasons: [made.message] });
      }
      return (o.provision ?? provisionSpace)({ ...p, publish: "loopback", reach: "loopback" });
    },
  };
}

