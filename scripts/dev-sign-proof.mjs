#!/usr/bin/env node
// scripts/dev-sign-proof.mjs: DEVELOPMENT-KIND TREES ONLY. Signs one presence proof with the software key scripts/dev-enrol-software-key.mjs made, for the act the daemon (or an admin script) asked for. Prints the proof as one line
// of JSON (or, with --header, the base64url value for the x-vyre-kernel-proof request header), ready to put in the call (x-vyre-presence / the proof field) or on the stdin of `vyre admin anchor-reset`. A proof is single use, lives under a minute, and is refused if made before the sealing process started.
//   node scripts/dev-sign-proof.mjs --home <dir> --op <act> [--fields '<json>']        the proof for this act with these fields (the hash is computed as the sealing process does)
//   node scripts/dev-sign-proof.mjs --home <dir> --request '<json from the request line>'   uses its op, payload_hash and chain_hash as given
//   node scripts/dev-sign-proof.mjs --home <dir> [--space <spc_...>] --gate <kernel action, e.g. grants.invite> [--resource <urn>] [--input '<json>']
//        a KERNEL GATED ACT (a grant, an invite, a role): the proof the kernel's gate asks for. The op is "grant.<verb>", the fields are { resource, input_hash } where input_hash is the hash of { action, input } exactly as
//        the kernel builds it, so --input must be the very object the kernel is given (for spaces.invites.create { space, role: "member" } that is {"role":"member"}: no space key). --space is the Space the act is in (a
//        created Space's own id, not the home's): it is part of the payload hash and of the chain the proof is bound to. --resource defaults to vyre://<space>/invite/new for grants.invite.
//   node scripts/dev-sign-proof.mjs --home <dir> [--space <spc_...>] --call <name> --args '<json array>'
//        the same act by the kernel's own request builder (kernel/remote/proof.js proofRequest: create, revoke, narrow, setRole, ruleSet, ruleRemove, inviteCreate, ...), e.g. --call ruleSet --args '[{...the rule}]'. Prefer this
//        for any grants or rules act: the op, resource and input hash come from the kernel's own table, not a second list.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chainCtx, payloadHash, proofBytes } from "../kernel/seal/wire.js";
import { devSwitch } from "../kernel/seal/appattest.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";
import { opOf, proofRequest, PROOF_CALLS } from "../kernel/remote/proof.js";

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
  const space = take("--space") || k.space;
  let fields;
  if (take("--call")) {
    const call = /** @type {string} */ (take("--call")), args = take("--args") ? JSON.parse(/** @type {string} */ (take("--args"))) : [];
    if (!PROOF_CALLS.includes(call)) die(64, `--call is one of: ${PROOF_CALLS.join(", ")}`);
    const rq = proofRequest(space, call, ...args); op = rq.op; fields = rq.fields;
  } else if (take("--gate")) {
    const action = /** @type {string} */ (take("--gate")), input = take("--input") ? JSON.parse(/** @type {string} */ (take("--input"))) : {};
    const resource = take("--resource") || (action === "grants.invite" ? `vyre://${space}/invite/new` : null);
    if (!resource) die(64, "--resource is required for this act (the urn the kernel gates, vyre://<space>/...)");
    op = opOf(action);
    fields = { resource, input_hash: sha256(canonical({ action, input })) };
  } else {
    op = take("--op"); if (!op) die(64, "--op, --gate or --request is required");
    fields = take("--fields") ? JSON.parse(/** @type {string} */ (take("--fields"))) : {};
  }
  payload_hash = payloadHash(op, space, fields);
  chain_hash = chainCtx({ space, hops: [{ actor: { kind: "person", id: k.person, space } }] }).chain_hash;
}
const now = Date.now(), proof = { signer: "software", key_id: k.key_id, payload_hash, decision: op, chain_hash, issued_at: now, expires_at: now + 50_000, nonce: crypto.randomBytes(8).toString("base64url") };
const key = crypto.createPrivateKey({ key: Buffer.from(k.private_pkcs8, "base64"), format: "der", type: "pkcs8" });
const out = { ...proof, signature: crypto.sign("sha256", proofBytes(proof), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") };
// --header: the value for the daemon's `x-vyre-kernel-proof` request header (base64url of the proof JSON), instead of the JSON itself.
process.stdout.write((argv.includes("--header") ? Buffer.from(JSON.stringify(out)).toString("base64url") : JSON.stringify(out)) + "\n");
