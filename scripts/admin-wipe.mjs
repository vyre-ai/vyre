#!/usr/bin/env node
// scripts/admin-wipe.mjs: what `sudo vyre admin wipe` runs, as root, with the daemon already stopped (launch's wrapper stops it and runs this from a one-off container of the image).
// Reads the home path, takes where the vault's key lives from the home's OWN config (never from an argument), calls wipeHome (lib/vault-wipe.js), prints what it destroyed and what it cannot
// reach, and exits non-zero on any refusal (the code and the plain reason go to stderr). A refusal changes nothing it names: see wipeHome for what is destroyed first.
//   node scripts/admin-wipe.mjs --home <dir> [--seal-dir <dir>] [--backup <path>]...   (or VYRE_HOME for --home)
// Exit codes: 0 wiped, 2 refused (nothing reported as destroyed that was not), 64 bad arguments, 1 anything else.
import path from "node:path";
import { wipeHome, homeKeystore } from "../lib/vault-wipe.js";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ flag) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === flag) { if (i + 1 >= argv.length) usage(`${flag} needs a value`); out.push(argv[++i]); } return out; };
function usage(/** @type {string} */ why) { process.stderr.write(`${why}\nusage: admin-wipe.mjs --home <dir> [--seal-dir <dir>] [--backup <path>]...\n`); process.exit(64); }
for (const a of argv) if (a.startsWith("--") && !["--home", "--seal-dir", "--backup"].includes(a)) usage(`unknown option ${a}`);

const home = take("--home")[0] || process.env.VYRE_HOME;
if (!home || !path.isAbsolute(home)) usage("--home must be an absolute path to the Vyre home");
const sealDir = take("--seal-dir")[0], backups = take("--backup");
if (sealDir && !path.isAbsolute(sealDir)) usage("--seal-dir must be absolute");
for (const b of backups) if (!path.isAbsolute(b)) usage(`--backup must be absolute: ${b}`);

try {
  const keystore = homeKeystore(home);
  /** @type {(() => Promise<void>) | undefined} */ let destroyKeychain;
  if (keystore === "keychain") {
    // A desktop home whose key is in the OS keychain: the keystore's own delete, for the device key and the account Secret Key.
    const { keystore: ks, secretKeyStore } = await import("../core/vault/keys.js");
    const dir = path.join(home, "vault");
    destroyKeychain = async () => { await ks({ dir, kind: "keychain", login: true }).destroy(); await secretKeyStore({ dir, kind: "keychain", login: true }).remove(); };
  }
  const r = await wipeHome({ home, ...(sealDir ? { sealDir } : {}), backups, ...(destroyKeychain ? { destroyKeychain } : {}) });
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  for (const n of r.notices) process.stderr.write(`note: ${n}\n`);
  process.exit(0);
} catch (e) {
  const err = /** @type {any} */ (e);
  process.stderr.write(`refused: ${err.code || "failed"}: ${err.message}\n`);
  process.exit(err.code ? 2 : 1);
}
