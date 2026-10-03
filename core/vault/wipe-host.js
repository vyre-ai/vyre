// @ts-check
// core/vault/wipe-host.js: what `sudo vyre admin wipe` runs, with the daemon STOPPED (the CLI wrapper confirms with the person and stops it). Keys first, then folders: the vault's device key
// and Secret Key, then every vault row and file; then the sealing master and its folder. Returns what was destroyed, counts only. Not a tool and not reachable from the daemon.
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { wipeSealDir } from "../../kernel/seal/wipe.js";

/**
 * @param {{ db: string, vaultDir: string, sealDir: string, config?: any, log?: (m: string) => void }} o
 *   db: the home's vyre.db; vaultDir: ctx.paths.vault; sealDir: `<home>/seal`; config: the home's config (its `vault.keystore` says where the device key lives).
 */
export async function wipeHome({ db, vaultDir, sealDir, config = {}, log = () => {} }) {
  const conn = open(db);
  try {
    migrate(conn, "vault", MIGRATIONS);
    const vault = await new Vault({ db: conn, dir: vaultDir, config, emit: () => {}, log }).wipe();
    const seal = wipeSealDir(sealDir);
    return { vault: { keys_destroyed: true, tables_emptied: vault.tables, files_removed: vault.files }, seal };
  } finally { conn.close(); }
}
