// @ts-check
// kernel/seal/appattest.js: the Apple App Attest verifier of the sealing process (node: built-ins only, like the rest of kernel/seal). The app keeps its presence key in the Secure Enclave and, at enrol,
// has an App Attest key vouch for it: clientDataHash = SHA256("vyre-enrol\n" + token + "\n" + the Secure Enclave key's SPKI as base64 text). Every check here is OFFLINE against the pinned Apple root; the
// attStmt receipt is stored by the caller and never acted on (it is for Apple's fraud-metric servers). The leaf certificate is checked at enrol only (it lives for days); continued integrity is B2's job,
// the per-proof assertion. Three details are UNVERIFIED against real Apple bytes until the real-device check passes (scripts/appattest-check.mjs): (a) the exact message an assertion signature covers (we
// verify the documented nonce, SHA256(authData || clientDataHash), as the signed data), (b) the aaguid bytes per environment, (c) the nonce extension's encoding in a real leaf. Release acceptance is therefore
// closed by APPATTEST_VERIFIED until a real attestation and assertion fixture passes (AA-3).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Release builds accept `apple-appattest` only when this is true; it is flipped in the commit that adds a sanitized real attestation and assertion as a fixture with a test that verifies it (AA-3). */
export const APPATTEST_VERIFIED = false;
/** The application ids that may enrol: TEAMID.bundle.id, pinned in code (AA-1), never read from the home's config. Empty until native-core gives the real one; a dev-kind process may add some through its switch. */
export const APP_IDS = Object.freeze(/** @type {string[]} */ ([]));
/** Apple's App Attestation Root CA (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem, valid to 2045); pinned by value and by this SHA-256 of its DER (a test asserts it). */
export const APPLE_ROOT_SHA256 = "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932";
export const APPLE_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;
const AAGUID_PROD = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]), AAGUID_DEV = Buffer.from("appattestdevelop");
const NONCE_OID = "1.2.840.113635.100.8.2";
const sha256 = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest();

/** The bytes the app hashes into the attestation: binds the one-use enrol token and the Secure Enclave key. @param {string} token @param {string} spkiB64 */
export const enrolClientData = (token, spkiB64) => sha256(`vyre-enrol\n${token}\n${spkiB64}`);

class Refuse extends Error {}
const no = (/** @type {string} */ why) => { throw new Refuse(why); };

/** A strict CBOR subset: definite lengths, no tags, no floats, depth at most 4, no duplicate keys, canonical integers. Every length is checked against what is left before it is used. @param {Buffer} buf */
export function cbor(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > 16384) no("too_big");
  let at = 0;
  const need = (/** @type {number} */ n) => { if (!(n >= 0) || at + n > buf.length) no("short"); };
  const head = () => {
    need(1); const b = buf[at++], major = b >> 5, info = b & 31;
    if (info < 24) return { major, n: info };
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : no("bad_head");
    need(size); let n = 0n; for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(buf[at++]);
    if (n < (info === 24 ? 24n : info === 25 ? 256n : info === 26 ? 65536n : 4294967296n)) no("not_canonical");
    if (n > 0xffffffffn) no("huge");
    return { major, n: Number(n) };
  };
  const item = (/** @type {number} */ depth) => {
    if (depth > 4) no("deep");
    const { major, n } = head();
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) { need(n); const s = buf.subarray(at, at + n); at += n; return major === 2 ? Buffer.from(s) : s.toString("utf8"); }
    if (major === 4) { if (n > 16) no("big_array"); const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
    if (major === 5) { if (n > 16) no("big_map"); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(depth + 1); if (typeof k !== "string" && typeof k !== "number") no("bad_key"); if (m.has(k)) no("dup_key"); m.set(k, item(depth + 1)); } return m; }
    return no("unsupported");
  };
  const v = item(0);
  if (at !== buf.length) no("trailing");
  return v;
}

/** Walk one DER element at `at`: { tag, start, end } with every length checked. */
function der(/** @type {Buffer} */ b, /** @type {number} */ at) {
  if (at + 2 > b.length) no("der_short");
  const tag = b[at]; let len = b[at + 1], p = at + 2;
  if (len & 0x80) { const k = len & 0x7f; if (k < 1 || k > 3 || p + k > b.length) no("der_len"); len = 0; for (let i = 0; i < k; i++) len = (len << 8) | b[p++]; }
  if (p + len > b.length) no("der_short");
  return { tag, start: p, end: p + len };
}
const oidBytes = (/** @type {string} */ s) => { const a = s.split(".").map(Number), out = [a[0] * 40 + a[1]]; for (const n of a.slice(2)) { const t = [n & 127]; for (let m = n >> 7; m; m >>= 7) t.unshift((m & 127) | 128); out.push(...t); } return Buffer.from(out); };

/** The 32 nonce bytes in a leaf certificate's App Attest extension (exactly one such extension): SEQUENCE { [1] { OCTET STRING } }. @param {Buffer} certDer */
export function nonceOf(certDer) {
  const cert = der(certDer, 0), tbs = der(certDer, cert.start);
  let p = tbs.start, ext = null;
  while (p < tbs.end) { const e = der(certDer, p); if (e.tag === 0xa3) ext = e; p = e.end; }
  if (!ext) no("no_extensions");
  const seq = der(certDer, ext.start), want = oidBytes(NONCE_OID);
  let found = null;
  for (let q = seq.start; q < seq.end;) {
    const one = der(certDer, q), oid = der(certDer, one.start);
    if (oid.tag === 6 && certDer.subarray(oid.start, oid.end).equals(want)) { if (found) no("two_nonces"); found = one; }
    q = one.end;
  }
  if (!found) no("no_nonce");
  let r = der(certDer, der(certDer, found.start).end);
  if (r.tag === 1) r = der(certDer, r.end);
  if (r.tag !== 4) no("bad_nonce_ext");
  const outer = der(certDer, r.start), tagged = der(certDer, outer.start), oct = der(certDer, tagged.start);
  if (outer.tag !== 0x30 || tagged.tag !== 0xa1 || oct.tag !== 4 || oct.end - oct.start !== 32) no("bad_nonce_ext");
  return certDer.subarray(oct.start, oct.end);
}

/**
 * Verify an attestation. @param {{ attestation: Buffer, keyId: Buffer, clientDataHash: Buffer, now: number, appIds: readonly string[], roots: crypto.X509Certificate[], allowDevelop: boolean }} o
 * @returns {{ spki: string, receipt: Buffer | null }} the attested App Attest public key (SPKI DER, base64) and the receipt; throws Refuse(reason)
 */
export function verifyAttestation({ attestation, keyId, clientDataHash, now, appIds, roots, allowDevelop }) {
  const top = cbor(attestation);
  if (!(top instanceof Map) || top.get("fmt") !== "apple-appattest") no("bad_format");
  const st = top.get("attStmt"), authData = top.get("authData");
  if (!(st instanceof Map) || !Buffer.isBuffer(authData)) no("bad_shape");
  const x5c = st.get("x5c");
  if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every(Buffer.isBuffer)) no("bad_chain");
  const receipt = st.get("receipt"), [leaf, inter] = x5c.map(d => new crypto.X509Certificate(d));
  const when = new Date(now);
  for (const c of [leaf, inter]) if (when < new Date(c.validFrom) || when > new Date(c.validTo)) no("cert_dates");
  const root = roots.find(r => inter.checkIssued(r) && inter.verify(r.publicKey));
  if (!root || when < new Date(root.validFrom) || when > new Date(root.validTo)) no("untrusted_root");
  if (!inter.ca || leaf.ca || !leaf.checkIssued(inter) || !leaf.verify(inter.publicKey)) no("bad_chain");
  // nonce = SHA256(authData || clientDataHash) must be the one in the leaf
  if (!crypto.timingSafeEqual(nonceOf(Buffer.from(leaf.raw)), sha256(Buffer.concat([authData, clientDataHash])))) no("bad_nonce");
  const spki = leaf.publicKey.export({ type: "spki", format: "der" }), point = spki.subarray(spki.length - 65);
  if (point.length !== 65 || point[0] !== 4 || !crypto.timingSafeEqual(sha256(point), keyId)) no("bad_key_id");
  if (authData.length < 55) no("short_authdata");
  const rp = authData.subarray(0, 32), count = authData.readUInt32BE(33), aaguid = authData.subarray(37, 53), credLen = authData.readUInt16BE(53);
  if (!appIds.some(id => crypto.timingSafeEqual(rp, sha256(id)))) no("bad_app");
  if (count !== 0) no("bad_counter");
  if (!aaguid.equals(AAGUID_PROD) && !(allowDevelop && aaguid.equals(AAGUID_DEV))) no("bad_environment");
  if (credLen !== keyId.length || authData.length < 55 + credLen || !authData.subarray(55, 55 + credLen).equals(keyId)) no("bad_credential");
  return { spki: Buffer.from(spki).toString("base64"), receipt: Buffer.isBuffer(receipt) ? receipt : null };
}

/**
 * Verify one assertion for a proof. @param {{ assertion: Buffer, clientDataHash: Buffer, spki: string, counter: number, appIds: readonly string[] }} o
 * @returns {{ counter: number }} the assertion's counter, strictly above `counter`; throws Refuse(reason)
 */
export function verifyAssertion({ assertion, clientDataHash, spki, counter, appIds }) {
  const top = cbor(assertion);
  if (!(top instanceof Map)) no("bad_shape");
  const sig = top.get("signature"), auth = top.get("authenticatorData");
  if (!Buffer.isBuffer(sig) || !Buffer.isBuffer(auth) || auth.length !== 37) no("bad_shape");
  if (!appIds.some(id => crypto.timingSafeEqual(auth.subarray(0, 32), sha256(id)))) no("bad_app");
  const n = auth.readUInt32BE(33);
  if (!(n > counter)) no("counter");
  const key = crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  if (!crypto.verify("sha256", sha256(Buffer.concat([auth, clientDataHash])), key, sig)) no("bad_signature");
  return { counter: n };
}

/** The verifier the sealing process plugs in as verifiers["apple-appattest"]. `dev` is the process's own devSwitch answer; only then may a test root, the development environment or extra app ids be used. */
export function appAttestVerifier({ dev = false, testRootPem = null, extraAppIds = /** @type {string[]} */ ([]), now = Date.now } = {}) {
  const roots = [new crypto.X509Certificate(APPLE_ROOT_PEM), ...(dev && testRootPem ? [new crypto.X509Certificate(testRootPem)] : [])];
  const appIds = [...APP_IDS, ...(dev ? extraAppIds : [])];
  const open = dev || APPATTEST_VERIFIED;
  return {
    appIds, dev, open,
    /** @returns {{ spki: string, receipt: Buffer | null } | null} null for any refusal, never a throw */
    enrol(/** @type {any} */ a, /** @type {string} */ spkiB64, /** @type {string} */ token) {
      try {
        if (!open || !a || typeof a.attestation !== "string" || typeof a.key_id !== "string") return null;
        return verifyAttestation({ attestation: Buffer.from(a.attestation, "base64"), keyId: Buffer.from(a.key_id, "base64"), clientDataHash: enrolClientData(token, spkiB64), now: now(), appIds, roots, allowDevelop: dev });
      } catch { return null; }
    },
    /** @returns {{ counter: number } | null} */
    assert(/** @type {any} */ assertion, /** @type {Buffer} */ clientDataHash, /** @type {string} */ spki, /** @type {number} */ counter) {
      try { if (!open || typeof assertion !== "string") return null; return verifyAssertion({ assertion: Buffer.from(assertion, "base64"), clientDataHash, spki, counter, appIds }); } catch { return null; }
    },
  };
}

/** At enrol or recover: the attestation vouches for the Secure Enclave key `spki`. `attested` comes only from the verifier; the signer class must be secure_enclave; the one-use token was spent before this; an App Attest key id already bound to another key is refused; the receipt is kept, never acted on. @returns {{ aa: any } | { refused: string }} */
export function bindAttestation(/** @type {any} */ verifier, /** @type {Map<string, any>} */ keys, /** @type {any} */ attestation, /** @type {string} */ spki, /** @type {string} */ signer, /** @type {string} */ token, /** @type {string} */ keyId) {
  if (!verifier || signer !== "secure_enclave") return { refused: "bad_attestation" };
  const r = verifier.enrol(attestation, spki, token);
  if (!r) return { refused: "bad_attestation" };
  const id = String(attestation.key_id);
  for (const [other, k] of keys) if (k.aa && k.aa.key_id === id && other !== keyId) return { refused: "aa_key_bound" };
  return { aa: { key_id: id, spki: r.spki, counter: 0, required: true, ...(r.receipt ? { receipt: r.receipt.toString("base64") } : {}) } };
}

/** B2 at proof time: the assertion over SHA256(proofBytes) with a counter strictly above the stored one; the new counter is persisted (write-ahead, `save`) before the proof is accepted, in one tick so two parallel proofs cannot both pass. @returns {string | null} the refusal */
export function assertProof(/** @type {any} */ verifier, /** @type {any} */ k, /** @type {any} */ proof, /** @type {Buffer} */ bytes, /** @type {() => void} */ save) {
  if (!verifier) return "bad_assertion";
  const a = verifier.assert(proof.assertion, sha256(bytes), k.aa.spki, k.aa.counter);
  if (!a) return proof.assertion === undefined ? "assertion_required" : "bad_assertion";
  const before = k.aa.counter; k.aa.counter = a.counter;
  try { save(); } catch { k.aa.counter = before; return "bad_assertion"; }
  return null;
}

/**
 * Is an environment developer switch honoured here? Exactly "1" AND not a packaged build. Self-contained (this process imports no kernel code beyond kernel/seal): it reads the build stamp
 * lib/build-kind.js as TEXT, the same rule as kernel/devbuild.js isPackaged (a missing or unreadable stamp, anything but "development", or a carried SHA256SUMS.sig means packaged);
 * kernel/seal/buildkind.test.js pins that this equals devbuild's answer for every stamp. `root` is for that test.
 * @param {string | undefined} value @param {string} [root]
 */
export function devSwitch(value, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")) {
  if (value !== "1") return false;
  let text = ""; try { text = fs.readFileSync(path.join(root, "lib", "build-kind.js"), "utf8"); } catch { return false; }
  return /export const BUILD_KIND = "development";/.test(text) && !fs.existsSync(path.join(root, "SHA256SUMS.sig"));
}

