#!/usr/bin/env node
// scripts/dev-enrol-software-key.mjs: DEVELOPMENT-KIND TREES ONLY. Gives an owner a SOFTWARE presence key (method "software", lead ruling 4) in a home's sealing process, so an automated walk of a dev-kind install can give presence for the
// acts that need it (invite a person, a sealed record field, a held send, a rollback) without a phone. It refuses on a release-kind tree (the sealing process would refuse the key anyway), refuses while the daemon is running (the sealing
// process owns its folder: stop the daemon first, `vyre down` or `docker compose stop vyre`), and keeps the private key in <home>/dev-owner-key.json (0600). The daemon must then be started with VYRE_SEAL_DEV=1 and VYRE_SEAL_SOFTWARE=1
// so its own sealing process accepts the key (kernel/home.js passes it under the same dev switch).
//   node scripts/dev-enrol-software-key.mjs --home <abs dir> [--seal-dir <abs>]
// It prints one line of JSON { person, key_id, signer, key_file } and how to sign: scripts/dev-sign-proof.mjs. Run it as the daemon's own user (the owner's uid is part of the owner's chain).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startSealer } from "../kernel/seal/client.js";
import { devSwitch } from "../kernel/seal/appattest.js";
import { createChainBuilder } from "../kernel/core/chain.js";
import { createKernelSeal } from "../kernel/core/seal.js";

const argv = process.argv.slice(2), take = (/** @type {string} */ f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
const die = (/** @type {number} */ code, /** @type {string} */ m) => { process.stderr.write(`dev-enrol-software-key: ${m}\n`); process.exit(code); };
const home = take("--home") || process.env.VYRE_HOME;
if (!home || !path.isAbsolute(home)) die(64, "--home must be an absolute path to the Vyre home\nusage: dev-enrol-software-key.mjs --home <dir> [--seal-dir <dir>]");
if (!devSwitch("1")) die(2, "this is a release-kind build: a software presence key is refused here, so none is made");
let id; try { id = JSON.parse(fs.readFileSync(path.join(home, "kernel", "space.json"), "utf8")); } catch { id = null; }
if (!id || !/^spc_[a-z2-7]{12}$/.test(id.space) || !/^per_[a-z2-7]{26}$/.test(id.owner)) die(2, "this folder holds no Vyre home (no kernel/space.json): start the daemon once, then stop it");
const keyFile = path.join(home, "dev-owner-key.json");
if (fs.existsSync(keyFile)) die(2, `${keyFile} exists: a software key is already enrolled for this home (delete it and the home's seal folder only on a throwaway install)`);
const sealDir = take("--seal-dir") || path.join(home, "kernel", "seal");
if (fs.existsSync(path.join(home, "vyred.pid"))) { try { process.kill(Number(fs.readFileSync(path.join(home, "vyred.pid"), "utf8")), 0); die(2, "the daemon is running: stop it first (vyre down), the sealing process owns its folder"); } catch (e) { if (/** @type {any} */ (e).code !== "ESRCH" && /** @type {any} */ (e).code !== "ENOENT" && !/NaN/.test(String(e))) throw e; } }

const sealer = startSealer({ dir: sealDir, dev: true, software: true, timeoutMs: 15_000 });
try {
  await sealer.health();
  const chains = createChainBuilder({ space: id.space, owner: id.owner, owner_uid: process.getuid ? process.getuid() : 0, seal: createKernelSeal({ sealer }), clock: Date.now, is_person: () => true });
  const atDeck = chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid ? process.getuid() : 0 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64"), key_id = `dk_${crypto.randomBytes(4).toString("hex")}`;
  const begun = await sealer.begin({ chain: atDeck, person: id.owner, key_id, spki });
  await sealer.enrol({ chain: atDeck, person: id.owner, key_id, spki, signer: "software", token: begun.token });
  fs.writeFileSync(keyFile, JSON.stringify({ person: id.owner, space: id.space, key_id, signer: "software", spki, private_pkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ person: id.owner, key_id, signer: "software", key_file: keyFile }) + "\n");
  process.stderr.write(`enrolled. Start the daemon with VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1. To sign a proof for an act the daemon asks for:\n  node scripts/dev-sign-proof.mjs --home ${home} --op <act, e.g. grant.role> --fields '<the fields the act shows>'\nor, for an act whose request line already carries payload_hash and chain_hash (admin anchor-reset): --request '<that JSON>'.\n`);
} catch (e) { die(1, `${/** @type {any} */ (e).code || "failed"}: ${/** @type {Error} */ (e).message}`); }
finally { await sealer.close().catch(() => {}); }
