// @ts-check
// A software WebAuthn authenticator for tests: what navigator.credentials.create and .get give back, with the P-256 key in this process. Shared by the passkey tests and the pairing tests.
import assert from "node:assert/strict";
import crypto from "node:crypto";

const NORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export const cborBytes = (/** @type {Uint8Array} */ b) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
export const cborText = (/** @type {string} */ s) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
function head(/** @type {number} */ major, /** @type {number} */ n) { return n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]); }
export const cborInt = (/** @type {number} */ n) => (n >= 0 ? head(0, n) : head(1, -1 - n));
export const cborMap = (/** @type {Buffer[][]} */ pairs) => Buffer.concat([head(5, pairs.length), ...pairs.flat()]);

/** @param {{ rp?: string, flags?: number, highS?: boolean, refuse?: boolean, createRp?: string }} [o] */
export function authenticator(o = {}) {
  const rp = o.rp ?? "app.vyre.run";
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(/** @type {string} */ (jwk.x), "base64url"), y = Buffer.from(/** @type {string} */ (jwk.y), "base64url");
  const credentialId = crypto.randomBytes(16);
  const rpHash = (/** @type {string} */ r) => crypto.createHash("sha256").update(r).digest();
  const seen = { creates: 0, gets: 0 };
  return {
    seen, credentialId, rp, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    async create(/** @type {any} */ opts) {
      seen.creates++;
      if (o.refuse) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      assert.equal(opts.publicKey.rp.id, rp);
      assert.equal(opts.publicKey.authenticatorSelection.userVerification, "required", "the passkey is made with user verification");
      assert.deepEqual(opts.publicKey.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
      const cose = cborMap([[cborInt(1), cborInt(2)], [cborInt(3), cborInt(-7)], [cborInt(-1), cborInt(1)], [cborInt(-2), cborBytes(x)], [cborInt(-3), cborBytes(y)]]);
      const authData = Buffer.concat([rpHash(o.createRp ?? rp), Buffer.from([o.flags ?? 0x45]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, cose]);
      const attestationObject = cborMap([[cborText("fmt"), cborText("none")], [cborText("attStmt"), cborMap([])], [cborText("authData"), cborBytes(authData)]]);
      return { response: { attestationObject: new Uint8Array(attestationObject) } };
    },
    async get(/** @type {any} */ opts) {
      seen.gets++;
      if (o.refuse) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      assert.equal(opts.publicKey.rpId, rp);
      assert.equal(opts.publicKey.userVerification, "required");
      assert.deepEqual(Buffer.from(opts.publicKey.allowCredentials[0].id), credentialId);
      const authenticatorData = Buffer.concat([rpHash(rp), Buffer.from([0x05]), Buffer.from([0, 0, 0, seen.gets])]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(opts.publicKey.challenge).toString("base64url"), origin: `https://${rp}`, crossOrigin: false }));
      let signature = crypto.sign("sha256", Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]), privateKey);
      if (o.highS) signature = flipS(signature);
      return { response: { authenticatorData: new Uint8Array(authenticatorData), clientDataJSON: new Uint8Array(clientDataJSON), signature: new Uint8Array(signature) } };
    },
  };
}
/** The high-s twin of a DER ECDSA signature (an authenticator may return either). @param {Buffer} der */
function flipS(der) {
  const rl = der[3], r = der.subarray(4, 4 + rl), sl = der[5 + rl], s = der.subarray(6 + rl, 6 + rl + sl);
  let v = 0n; for (const b of s) v = (v << 8n) | BigInt(b);
  let t = NORDER - v; const out = []; while (t > 0n) { out.unshift(Number(t & 255n)); t >>= 8n; }
  if (out[0] & 0x80) out.unshift(0);
  const body = [0x02, rl, ...r, 0x02, out.length, ...out];
  return Buffer.from([0x30, body.length, ...body]);
}

