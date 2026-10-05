// Generates lib/vectors/keywrap.json: a fixed agree key, a fixed ephemeral key and iv, one wrap of a known key, with every intermediate value, so a native or WebCrypto implementation of unwrap can be checked
// byte for byte. Run once; the file is committed and lib/vectors/keywrap-vectors.test.js checks it against lib/keywrap.js.
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const b64 = b => Buffer.from(b).toString("base64url");
const det = label => crypto.createHash("sha256").update(`vyre-vector:${label}`).digest();           // deterministic 32 bytes
const keyFrom = (label) => { const e = crypto.createECDH("prime256v1"); e.setPrivateKey(det(label)); const pub = e.getPublicKey(); return { e, pub, d: det(label) }; };
const jwkOf = (k) => ({ kty: "EC", crv: "P-256", x: b64(k.pub.subarray(1, 33)), y: b64(k.pub.subarray(33, 65)), d: b64(k.d) });
const agree = keyFrom("agree-key"), eph = keyFrom("ephemeral");
const holderOf = jwk => crypto.createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("hex").slice(0, 16);
const shared = eph.e.computeSecret(agree.pub);                                                         // what native `agree(epk)` returns: the 32-byte X coordinate
const kek = Buffer.from(crypto.hkdfSync("sha256", shared, eph.pub, Buffer.from("vyre-identity-wrap-v1"), 32));
const key = det("the-key-being-wrapped");
const iv = det("iv").subarray(0, 12);
const aad = "ring:chat_vector01:1";
const c = crypto.createCipheriv("aes-256-gcm", kek, iv); c.setAAD(Buffer.from(aad, "utf8"));
const ct = Buffer.concat([c.update(key), c.final()]); const tag = c.getAuthTag();
const out = {
  note: "Agree key (P-256). `agree(epk)` = ECDH shared secret (32-byte X). kek = HKDF-SHA256(ikm = shared, salt = epk, info = 'vyre-identity-wrap-v1', 32). AES-256-GCM, 12-byte iv, 16-byte tag, aad as given. All binary values base64url.",
  agree_private_jwk: jwkOf(agree), agree_public_jwk: (({ d, ...p }) => p)(jwkOf(agree)), holder: holderOf(jwkOf(agree)),
  wrap: { v: 1, epk: b64(eph.pub), iv: b64(iv), ct: b64(ct), tag: b64(tag) }, aad, shared: b64(shared), kek: b64(kek), plaintext_key: b64(key),
};
fs.writeFileSync(fileURLToPath(new URL("./keywrap.json", import.meta.url)), JSON.stringify(out, null, 1) + "\n");
console.log("written");
