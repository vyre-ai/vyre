// @ts-check
// link: the companion core's side on a server (docs: a Windows PC's local core, vouched for by the desktop app device that is its parent; companion.js). Pairing a computer or a phone with a
// server is Wink's (core/wink); a tool on the server from a device is wink.server.call. What is left here is the companion's table and its tools.

import { companionSide } from "./companion.js";
import { boxKey } from "./key.js";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const db = ctx.store.db;
    ctx.store.migrate(MIGRATIONS);
    const now = Date.now;
    let signing = null;
    const key = () => (signing ||= boxKey(ctx.paths.root));
    const companion = companionSide(ctx, { db, now, box: () => ({ pub: key().publicKey, name: ctx.config.name || null }),
      deviceInfo: async id => { const r = /** @type {any} */ (await ctx.call("relay.device.info", { id })); return r && r.data ? r.data : null; } });
    return { async stop() { companion.stop(); } };
  },
};

/** The list is append-only (test/migrations-append-only.test.js): a released step is never edited. The columns a Mac pairing once used stay, unused. */
export const MIGRATIONS = [
  `CREATE TABLE link_peers (id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT, node TEXT, stable_id TEXT,
       key_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER)`,
  `ALTER TABLE link_peers ADD COLUMN kind TEXT NOT NULL DEFAULT 'mac'`,
  `ALTER TABLE link_peers ADD COLUMN parent TEXT`,
  `ALTER TABLE link_peers ADD COLUMN core_pub TEXT`,
];
