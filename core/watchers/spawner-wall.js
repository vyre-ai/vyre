// @ts-check
// spawner-wall: the box's wall for watchers. On the box vyred is uid vyre with no capabilities, so
// bubblewrap cannot run; the root spawner (core/spawner) runs each watcher child as a pool uid its
// firewall rejects, and refuses while its own probe of that rule has not passed. This makes it one
// more candidate for lib/sandbox/wall.js, which probes it like the others with the child's own
// attempts. Absent on a machine with no spawner socket or an older spawner.

import { candidates, getWall } from "../../lib/sandbox/index.js";

/** Where a pool uid's private folder lives (the spawner makes it 0700 for that uid): node's permission flag needs a glob. */
export const WORK_GLOB = process.env.VYRE_WATCH_WORK || "/run/vyre-watch/*";

/**
 * The spawner candidate, or null when there is no spawner to ask.
 * @param {{ load?: () => Promise<any> }} [o]
 */
export async function spawnerCandidate({ load = () => import("../spawner/client.js") } = {}) {
  let client;
  try { client = await load(); } catch { return null; }
  if (!client || typeof client.spawnAsWatcher !== "function" || typeof client.available !== "function" || !client.available()) return null;
  return { kind: "spawner", materialize: true, workGlob: WORK_GLOB, launch: (argv, o) => client.spawnAsWatcher(argv, { ro: o && o.ro, cwd: o && o.cwd }) };
}

/** The wall for this machine: the spawner's where there is one, then the others. Probed once. */
export function findWall(opts = {}) {
  return (async () => {
    const sp = await spawnerCandidate(opts);
    return getWall({ candidates: [...(sp ? [sp] : []), ...candidates()], fresh: true });
  })();
}
