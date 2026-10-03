// @ts-check
// records/space-store.js: the record store a Space's kernel uses when the per-Space Twenty is the store (the box's default for business records). The kernel's own SQLite keeps
// grants, tasks, planner rows, Flow runs and the log; Twenty holds the business records (the row split ruling). `spaceStoreFactory` answers `(spaceId, meta) => store` for the
// home's kernel and for every Space it hosts (kernel/home.js `storeFor`, kernel/spaces `storeFor`), provisioning that Space's Twenty on first use (provisionSpace is idempotent).
//
// What provisioning needs on the machine, and who does it:
//   - Docker with compose, and the images twentycrm/twenty, postgres:16, redis:7 (pulled on first use);
//   - the daemon's runner must be able to run `docker` (the daemon's user in the docker group, or the box's docker-api proxy supplied as `runner`);
//   - the two firewall rules per Space (stores/twenty/provision.js firewallRules: agents cannot reach a Space's Twenty, and Twenty cannot reach out) need ROOT. They are written to
//     `<home>/spaces/<name>/twenty/firewall.rules` here, for a root-owned helper to apply, and are not applied by the daemon.
import fs from "node:fs";
import path from "node:path";
import { provisionSpace, spaceDir, firewallRules } from "../stores/twenty/provision.js";
import { createTwentyStore } from "../stores/twenty/store.js";
import { TwentyClient } from "../stores/twenty/client.js";

/** A kernel Space id (`spc_abc...`) as Twenty's per-Space name (lowercase letters, digits and dashes). @param {string} spaceId */
export const twentyName = spaceId => {
  const id = String(spaceId).replace(/^spc_/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = `s-${id}`;
  if (!id || !/^[a-z][a-z0-9-]{0,30}$/.test(n)) throw new Error(`no Twenty name for ${spaceId}`);
  return n;
};

/**
 * @param {{ home: string, log?: (m: string) => void, runner?: any, memory?: "small" | "standard", reach?: "alias" | "ip", gatewayContainer?: string | null,
 *   subnet?: string, provision?: typeof provisionSpace, createStore?: typeof createTwentyStore }} o
 * @returns {(spaceId: string, meta?: any) => Promise<any>}
 */
export function spaceStoreFactory(o) {
  const log = o.log || (() => {});
  const provision = o.provision || provisionSpace;
  const make = o.createStore || createTwentyStore;
  return async spaceId => {
    const name = twentyName(spaceId);
    const p = await provision({ home: o.home, space: name, ...(o.runner ? { runner: o.runner } : {}), reach: o.reach ?? "alias", memory: o.memory ?? "small", gatewayContainer: o.gatewayContainer ?? null, log: m => log(`twenty ${name}: ${m}`) });
    if (o.subnet) {
      const rules = path.join(spaceDir(o.home, name), "firewall.rules");
      try { fs.writeFileSync(rules, firewallRules({ space: name, subnet: o.subnet }), { mode: 0o600 }); } catch { /* the helper reads it when it can */ }
    }
    const read = (/** @type {string} */ f) => fs.readFileSync(f, "utf8").trim();
    return make({ space: spaceId, client: new TwentyClient({ url: p.url, key: () => read(p.keyFile) }), dir: path.join(spaceDir(o.home, name), "state"), webhookSecret: read(p.webhookSecretFile) });
  };
}
