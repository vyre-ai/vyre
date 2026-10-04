#!/usr/bin/env node
// scripts/dev-sign-proof.mjs: DEVELOPMENT-KIND TREES ONLY. Signs one presence proof with the software key scripts/dev-enrol-software-key.mjs made, for the act the daemon (or an admin script) asked for. Prints the proof as one line
// of JSON, ready to put in the call (x-vyre-presence / the proof field) or on the stdin of `vyre admin anchor-reset`. A proof is single use, lives under a minute, and is refused if made before the sealing process started.
//   node scripts/dev-sign-proof.mjs --home <dir> --op <act> [--fields '<json>']        the proof for this act with these fields (the hash is computed as the sealing process does)
//   node scripts/dev-sign-proof.mjs --home <dir> --request '<json from the request line>'   uses its op, payload_hash and chain_hash as given
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chainCtx, payloadHash, proofBytes } from "../kernel/seal/wire.js";
import { devSwitch } from "../kernel/seal/appattest.js";

const argv = process.argv.slice(2), take = (/** @type {string} */ f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
const die = (/** @type {number} */ c, /** @type {string} */ m) => { process.stderr.write(`dev-sign-proof: ${m}\n`); process.exit(c); };
if (!devSwitch("1")) die(2, "this is a release-kind build: software proofs are refused here");
const home = take("--home") || process.env.VYRE_HOME;
if (!home || !path.isAbsolute(home)) die(64, "--home must be an absolute path");
let k; try { k = JSON.parse(fs.readFileSync(path.join(home, "dev-owner-key.json"), "utf8")); } catch { die(2, "no dev-owner-key.json in this home: run scripts/dev-enrol-software-key.mjs first"); }
let op, payload_hash, chain_hash;
if (take("--request")) {
  const r = JSON.parse(/** @type {string} */ (take("--request")));
  const q = r.request || r; op = q.op; payload_hash = q.payload_hash; chain_hash = q.chain_hash;
  if (!op || !payload_hash || !chain_hash) die(64, "the request needs op, payload_hash and chain_hash");
} else {
  op = take("--op"); if (!op) die(64, "--op or --request is required");
  const fields = take("--fields") ? JSON.parse(/** @type {string} */ (take("--fields"))) : {};
  payload_hash = payloadHash(op, k.space, fields);
  chain_hash = chainCtx({ space: k.space, hops: [{ actor: { kind: "person", id: k.person, space: k.space } }] }).chain_hash;
}
const now = Date.now(), proof = { signer: "software", key_id: k.key_id, payload_hash, decision: op, chain_hash, issued_at: now, expires_at: now + 50_000, nonce: crypto.randomBytes(8).toString("base64url") };
const key = crypto.createPrivateKey({ key: Buffer.from(k.private_pkcs8, "base64"), format: "der", type: "pkcs8" });
process.stdout.write(JSON.stringify({ ...proof, signature: crypto.sign("sha256", proofBytes(proof), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") }) + "\n");
