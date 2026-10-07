#!/usr/bin/env node
// scripts/appattest-check.mjs: the real-device check for the App Attest verifier (kernel/seal/appattest.js). Give it the two blobs the app produced and it prints which checks pass, one line each, so the walk record shows
// which of the three UNVERIFIED details held on real Apple bytes. Nothing is sent anywhere. Offline, against the pinned Apple root only (VYRE_SEAL_APPATTEST_DEV and test roots do not apply here).
//   node scripts/appattest-check.mjs --attestation <file base64> --key-id <base64> --token <enrol token> --spki <Secure Enclave SPKI base64> --app-id TEAMID.bundle.id [--develop]
//   or, from the blob a phone puts in its pairing entry as `attest` (apps/app/modules/vyre-signer entryAttestation):
//   node scripts/appattest-check.mjs --attest <file with the base64url blob> --entry-pub <the entry's Ed25519 key, base64url> --enclave <the entry's enclave point, base64url> --app-id TEAMID.bundle.id [--develop] [--write-fixture <file>]
//        [--assertion <file base64> --proof-bytes <file with the exact proof bytes> --last-counter N --app-key-spki <base64 of the attested App Attest key, printed by the first part>]
import crypto from "node:crypto";
import fs from "node:fs";
import { APPLE_ROOT_PEM, cbor, nonceOf, enrolClientData } from "../kernel/seal/appattest.js";

const a = process.argv.slice(2);
const given = {};
const arg = n => { if (n in given) return given[n]; const i = a.indexOf(`--${n}`); return i < 0 ? undefined : a[i + 1]; };
const sha = b => crypto.createHash("sha256").update(b).digest();
const line = (name, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const attempt = (name, fn) => { try { const r = fn(); line(name, r !== false, typeof r === "string" ? r : ""); return r !== false; } catch (e) { line(name, false, e.message); return false; } };

// The pairing entry's blob: base64url of { format: "apple-appattest", keyId, attestation }. The App Attest key vouches for SHA256("vyre-enrol\nentry:" + entry key + "\n" + the chip key's SPKI base64).
if (arg("attest")) {
  const spkiHead = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  try {
    const blob = JSON.parse(Buffer.from(fs.readFileSync(arg("attest"), "utf8").trim(), "base64url").toString("utf8"));
    if (blob.format !== "apple-appattest") throw new Error(`format ${blob.format} is not checked here`);
    const b = fromB64url => Buffer.from(fromB64url, "base64url");
    given.attestation = "/dev/null";
    given["key-id"] = b(blob.keyId).toString("base64");
    given.token = "entry:" + (arg("entry-pub") || "");
    given.spki = Buffer.concat([spkiHead, b(arg("enclave") || "")]).toString("base64");
    given._raw = b(blob.attestation);
    console.log(`blob      format ${blob.format}, key id ${blob.keyId}`);
  } catch (e) { line("the attest blob reads", false, e.message); process.exit(1); }
}
if ((arg("attestation") || given._raw)) {
  const raw = given._raw ?? Buffer.from(fs.readFileSync(arg("attestation"), "utf8").trim(), "base64"), keyId = Buffer.from(arg("key-id") || "", "base64"), appId = arg("app-id") || "";
  let top, authData, leaf, inter, spki;
  attempt("cbor: strict subset, fmt apple-appattest", () => { top = cbor(raw); return top.get("fmt") === "apple-appattest"; });
  attempt("authData and two certificates present", () => { authData = top.get("authData"); const x = top.get("attStmt").get("x5c"); [leaf, inter] = x.map(d => new crypto.X509Certificate(d)); return x.length === 2 && Buffer.isBuffer(authData); });
  const root = new crypto.X509Certificate(APPLE_ROOT_PEM), now = new Date();
  attempt("intermediate is issued by the pinned Apple root", () => inter.checkIssued(root) && inter.verify(root.publicKey));
  attempt("leaf is issued by the intermediate", () => leaf.checkIssued(inter) && leaf.verify(inter.publicKey), `leaf valid ${leaf?.validFrom} to ${leaf?.validTo}`);
  attempt("certificate dates cover now", () => [leaf, inter].every(c => now >= new Date(c.validFrom) && now <= new Date(c.validTo)));
  attempt("(c) nonce extension 1.2.840.113635.100.8.2 found and well formed", () => nonceOf(Buffer.from(leaf.raw)).length === 32);
  attempt("nonce equals SHA256(authData || clientDataHash)", () => nonceOf(Buffer.from(leaf.raw)).equals(sha(Buffer.concat([authData, enrolClientData(arg("token") || "", arg("spki") || "")]))));
  attempt("key id equals SHA256(leaf public key point)", () => { spki = leaf.publicKey.export({ type: "spki", format: "der" }); return sha(spki.subarray(-65)).equals(keyId); });
  attempt("rpIdHash equals SHA256(app id)", () => authData.subarray(0, 32).equals(sha(appId)), appId);
  attempt("counter is 0", () => authData.readUInt32BE(33) === 0);
  attempt("(b) aaguid", () => { const g = authData.subarray(37, 53).toString("latin1").replace(/\0+$/, ""); return g === "appattest" || (a.includes("--develop") && g === "appattestdevelop") ? g : false; }, `aaguid ${JSON.stringify(authData?.subarray(37, 53).toString("latin1"))}`);
  attempt("credential id equals key id", () => authData.subarray(55, 55 + authData.readUInt16BE(53)).equals(keyId));
  if (arg("write-fixture") && spki) {
    // sanitised: the attestation object, the key id, the token and the chip SPKI are public values; nothing secret is in them
    fs.writeFileSync(arg("write-fixture"), JSON.stringify({ attestation: raw.toString("base64"), keyId: keyId.toString("base64"), token: arg("token"), spki: arg("spki"), appId, now: Date.now(), develop: a.includes("--develop") }, null, 2) + "\n");
    console.log(`fixture   written to ${arg("write-fixture")}`);
  }
  if (spki) console.log(`app-key-spki ${Buffer.from(spki).toString("base64")}`);
}
if (arg("assertion")) {
  const top = cbor(Buffer.from(fs.readFileSync(arg("assertion"), "utf8").trim(), "base64")), proofBytes = fs.readFileSync(arg("proof-bytes")), spki = Buffer.from(arg("app-key-spki") || "", "base64");
  const sig = top.get("signature"), ad = top.get("authenticatorData"), cdh = sha(proofBytes), nonce = sha(Buffer.concat([ad, cdh]));
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  attempt("assertion counter above the last", () => ad.readUInt32BE(33) > Number(arg("last-counter") || 0), `counter ${ad.readUInt32BE(33)}`);
  attempt("(a) signature verifies over sha256(authData || clientDataHash) as the signed data", () => crypto.verify("sha256", nonce, key, sig));
  attempt("(a, alternative) signature verifies over authData || clientDataHash directly", () => crypto.verify("sha256", Buffer.concat([ad, cdh]), key, sig));
}
