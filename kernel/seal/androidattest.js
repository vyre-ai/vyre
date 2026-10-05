// @ts-check
// kernel/seal/androidattest.js: the Android Keystore key attestation verifier (node: built-ins only, like the rest of kernel/seal). An Android app makes its presence key in the Keystore (StrongBox or the TEE), asks for
// an attestation with the challenge set to clientDataHash, and gets back a certificate chain (leaf first) whose leaf carries the key description extension. Every check is OFFLINE against Google's pinned attestation roots:
// the chain verifies to a pinned root, the leaf's public key is the key being enrolled, the challenge is the hash that names this enrolment, the key was GENERATED in secure hardware (security level TEE or StrongBox),
// the device is locked and booted verified, and the app is one of the pinned application ids. Revocation is a separate, async step (notRevoked): Google's attestation status list, fetched and cached for an hour; a list that cannot be fetched or read fails closed.
// The exact encoding of a real leaf (field order, tag numbers) is checked against Google's documented schema, not against real device bytes: release acceptance is closed by ANDROID_ATTEST_VERIFIED until a real
// attestation fixture passes (the same shape as APPATTEST_VERIFIED, AA-3).
import crypto from "node:crypto";

/** Release builds accept `android-key` only when this is true; it is flipped in the commit that adds a sanitized real attestation chain as a fixture with a test that verifies it. */
export const ANDROID_ATTEST_VERIFIED = false;
/** The apps that may enrol: package name and the SHA-256 (hex) of the signing certificate, pinned in code, never read from a home's config. Empty until native-core gives the real one. */
export const ANDROID_APP_IDS = Object.freeze(/** @type {{ pkg: string, cert: string }[]} */ ([]));
/**
 * Google's Android key attestation roots, as published on https://developer.android.com/privacy-and-security/security-key-attestation (fetched 5 Oct 2026): the RSA roots of 2019 and 2021 and the ECDSA root of 2025.
 * The 2016 RSA root (valid to 24 May 2026) has expired and is not pinned. Each is pinned by value and by the SHA-256 of its DER (a test asserts it).
 */
export const GOOGLE_ROOT_SHA256 = Object.freeze([
  "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc",
  "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0",
  "1ef1a04b8ba58ab94589ac498c8982a783f24ea7307e0159a0c3a73b377d87cc",
  "ab6641178a36e179aa0c1cdddf9a16eb45fa20943e2b8cd7c7c05c26cf8b487a",
]);
export const GOOGLE_ROOTS_PEM = Object.freeze([
`-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----
`,
`-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----
`,
`-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJANUP8luj8tazMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMTkxMTIyMjAzNzU4WhcNMzQxMTE4MjAz
NzU4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQBOMaBc8oumXb2voc7XCWnu
XKhBBK3e2KMGz39t7lA3XXRe2ZLLAkLM5y3J7tURkf5a1SutfdOyXAmeE6SRo83U
h6WszodmMkxK5GM4JGrnt4pBisu5igXEydaW7qq2CdC6DOGjG+mEkN8/TA6p3cno
L/sPyz6evdjLlSeJ8rFBH6xWyIZCbrcpYEJzXaUOEaxxXxgYz5/cTiVKN2M1G2ok
QBUIYSY6bjEL4aUN5cfo7ogP3UvliEo3Eo0YgwuzR2v0KR6C1cZqZJSTnghIC/vA
D32KdNQ+c3N+vl2OTsUVMC1GiWkngNx1OO1+kXW+YTnnTUOtOIswUP/Vqd5SYgAI
mMAfY8U9/iIgkQj6T2W6FsScy94IN9fFhE1UtzmLoBIuUFsVXJMTz+Jucth+IqoW
Fua9v1R93/k98p41pjtFX+H8DslVgfP097vju4KDlqN64xV1grw3ZLl4CiOe/A91
oeLm2UHOq6wn3esB4r2EIQKb6jTVGu5sYCcdWpXr0AUVqcABPdgL+H7qJguBw09o
jm6xNIrw2OocrDKsudk/okr/AwqEyPKw9WnMlQgLIKw1rODG2NvU9oR3GVGdMkUB
ZutL8VuFkERQGt6vQ2OCw0sV47VMkuYbacK/xyZFiRcrPJPb41zgbQj9XAEyLKCH
ex0SdDrx+tWUDqG8At2JHA==
-----END CERTIFICATE-----
`,
`-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAMNrfES5rhgxMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjExMTE3MjMxMDQyWhcNMzYxMTEzMjMx
MDQyWjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQBTNNZe5cuf8oiq+jV0itTG
zWVhSTjOBEk2FQvh11J3o3lna0o7rd8RFHnN00q4hi6TapFhh4qaw/iG6Xg+xOan
63niLWIC5GOPFgPeYXM9+nBb3zZzC8ABypYuCusWCmt6Tn3+Pjbz3MTVhRGXuT/T
QH4KGFY4PhvzAyXwdjTOCXID+aHud4RLcSySr0Fq/L+R8TWalvM1wJJPhyRjqRCJ
erGtfBagiALzvhnmY7U1qFcS0NCnKjoO7oFedKdWlZz0YAfu3aGCJd4KHT0MsGiL
Zez9WP81xYSrKMNEsDK+zK5fVzw6jA7cxmpXcARTnmAuGUeI7VVDhDzKeVOctf3a
0qQLwC+d0+xrETZ4r2fRGNw2YEs2W8Qj6oDcfPvq9JySe7pJ6wcHnl5EZ0lwc4xH
7Y4Dx9RA1JlfooLMw3tOdJZH0enxPXaydfAD3YifeZpFaUzicHeLzVJLt9dvGB0b
HQLE4+EqKFgOZv2EoP686DQqbVS1u+9k0p2xbMA105TBIk7npraa8VM0fnrRKi7w
lZKwdH+aNAyhbXRW9xsnODJ+g8eF452zvbiKKngEKirK5LGieoXBX7tZ9D1GNBH2
Ob3bKOwwIWdEFle/YF/h6zWgdeoaNGDqVBrLr2+0DtWoiB1aDEjLWl9FmyIUyUm7
mD/vFDkzF+wm7cyWpQpCVQ==
-----END CERTIFICATE-----
`,
]);
/** Google's attestation status list: the serial numbers of revoked attestation certificates. */
export const GOOGLE_STATUS_URL = "https://android.googleapis.com/attestation/status";
const STATUS_TTL_MS = 3_600_000;
/** A serial as the list spells it: lowercase hex without leading zeros. @param {string} hex */
const serialKey = hex => String(hex).toLowerCase().replace(/^0+/, "") || "0";
const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const sha256 = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest();

class Refuse extends Error {}
const no = (/** @type {string} */ why) => { throw new Refuse(why); };

/** One DER element at `at`: { tag, start, end } with every length checked. @param {Buffer} b @param {number} at */
function der(b, at) {
  if (at + 2 > b.length) no("der_short");
  const tag = b[at]; let len = b[at + 1], p = at + 2;
  if (len & 0x80) { const k = len & 0x7f; if (k < 1 || k > 3 || p + k > b.length) no("der_len"); len = 0; for (let i = 0; i < k; i++) len = (len << 8) | b[p++]; }
  if (p + len > b.length) no("der_short");
  return { tag, start: p, end: p + len };
}
/** The children of a constructed element. @param {Buffer} b @param {{ start: number, end: number }} e */
function kids(b, e) { const out = []; for (let p = e.start; p < e.end;) { const c = der(b, p); out.push(c); p = c.end; } return out; }
/** A small non-negative INTEGER or ENUMERATED. @param {Buffer} b @param {{ tag: number, start: number, end: number }} e */
function int(b, e) { if ((e.tag !== 2 && e.tag !== 10) || e.end - e.start < 1 || e.end - e.start > 4) no("bad_int"); let n = 0; for (let i = e.start; i < e.end; i++) n = (n * 256) + b[i]; return n; }
const oidBytes = (/** @type {string} */ s) => { const a = s.split(".").map(Number), o = [a[0] * 40 + a[1]]; for (const n of a.slice(2)) { const t = [n & 127]; for (let m = n >>> 7; m; m >>>= 7) t.unshift((m & 127) | 128); o.push(...t); } return Buffer.from(o); };

/** The key description extension's value (the OCTET STRING's content) of a certificate. @param {Buffer} certDer */
function keyDescriptionOf(certDer) {
  const cert = der(certDer, 0), tbs = der(certDer, cert.start);
  let ext = null;
  for (const e of kids(certDer, tbs)) if (e.tag === 0xa3) ext = e;
  if (!ext) no("no_extensions");
  const want = oidBytes(KEY_DESCRIPTION_OID);
  let found = null;
  for (const one of kids(certDer, der(certDer, ext.start))) {
    const parts = kids(certDer, one);
    if (parts[0] && parts[0].tag === 6 && certDer.subarray(parts[0].start, parts[0].end).equals(want)) { if (found) no("two_descriptions"); found = parts[parts.length - 1]; }
  }
  if (!found || found.tag !== 4) no("no_description");
  return certDer.subarray(found.start, found.end);
}

/** An AuthorizationList: the explicit-tagged fields by number. @param {Buffer} b @param {{ start: number, end: number }} seq @returns {Map<number, { start: number, end: number, tag: number }>} */
function authList(b, seq) {
  const m = new Map();
  // tags above 30 use the long form; read each field's tag number from its identifier octets
  for (let p = seq.start; p < seq.end;) {
    let q = p; const first = b[q++];
    if ((first & 0xe0) !== 0xa0) no("bad_auth_tag"); // context-specific, constructed
    let num = first & 31;
    if (num === 31) { num = 0; for (let i = 0; i < 3; i++) { const x = b[q++]; num = (num << 7) | (x & 127); if (!(x & 128)) break; } }
    let len = b[q++];
    if (len & 0x80) { const k = len & 0x7f; if (k < 1 || k > 3) no("der_len"); len = 0; for (let i = 0; i < k; i++) len = (len << 8) | b[q++]; }
    if (q + len > seq.end) no("der_short");
    const inner = der(b, q);
    m.set(num, { tag: inner.tag, start: inner.start, end: inner.end });
    p = q + len;
  }
  return m;
}

/**
 * What a key description says, as the fields this verifier checks. @param {Buffer} d the extension's content
 * @returns {{ attestationVersion: number, attestationSecurityLevel: number, keymasterSecurityLevel: number, challenge: Buffer, tee: Map<number, any>, software: Map<number, any>, d: Buffer }}
 */
export function parseKeyDescription(d) {
  const top = der(d, 0);
  if (top.tag !== 0x30 || top.end !== d.length) no("bad_description");
  const f = kids(d, top);
  if (f.length < 8) no("short_description");
  const challenge = f[4];
  if (challenge.tag !== 4) no("bad_challenge");
  if (f[6].tag !== 0x30 || f[7].tag !== 0x30) no("bad_lists");
  return { attestationVersion: int(d, f[0]), attestationSecurityLevel: int(d, f[1]), keymasterSecurityLevel: int(d, f[3]), challenge: d.subarray(challenge.start, challenge.end), software: authList(d, f[6]), tee: authList(d, f[7]), d };
}

/** The (package, certificate digest) pairs of an attestationApplicationId. @param {Buffer} d @param {{ start: number, end: number }} octet */
function appIdsOf(d, octet) {
  const seq = der(d, octet.start);
  if (seq.tag !== 0x30) no("bad_app_id");
  const [pkgs, digests] = kids(d, seq);
  if (!pkgs || !digests || pkgs.tag !== 0x31 || digests.tag !== 0x31) no("bad_app_id");
  const names = kids(d, pkgs).map(p => { const parts = kids(d, p); if (!parts[0] || parts[0].tag !== 4) no("bad_app_id"); return d.subarray(parts[0].start, parts[0].end).toString("utf8"); });
  const certs = kids(d, digests).map(c => { if (c.tag !== 4) no("bad_app_id"); return d.subarray(c.start, c.end).toString("hex"); });
  return { names, certs };
}

/**
 * Verify a Keystore attestation chain. @param {{ chain: Buffer[], clientDataHash: Buffer, point: Buffer, now: number, appIds: readonly { pkg: string, cert: string }[], roots: crypto.X509Certificate[] }} o
 * @returns {{ level: "tee" | "strongbox" }} throws Refuse(reason)
 */
export function verifyAttestation({ chain, clientDataHash, point, now, appIds, roots }) {
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > 6 || !chain.every(Buffer.isBuffer)) no("bad_chain");
  const certs = chain.map(d => new crypto.X509Certificate(d)), when = new Date(now);
  for (const c of certs) if (when < new Date(c.validFrom) || when > new Date(c.validTo)) no("cert_dates");
  for (let i = 0; i < certs.length - 1; i++) { if (!certs[i].checkIssued(certs[i + 1]) || !certs[i].verify(certs[i + 1].publicKey)) no("bad_chain"); if (i > 0 && !certs[i].ca) no("bad_chain"); }
  const top = certs[certs.length - 1];
  const root = roots.find(r => r.raw.equals(top.raw));
  if (!root || !top.verify(top.publicKey)) no("untrusted_root");
  const leaf = certs[0];
  if (leaf.ca) no("bad_chain");
  const spki = leaf.publicKey.export({ type: "spki", format: "der" });
  if (leaf.publicKey.asymmetricKeyType !== "ec" || leaf.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !spki.subarray(spki.length - 65).equals(point)) no("bad_key");
  const kd = parseKeyDescription(keyDescriptionOf(Buffer.from(leaf.raw)));
  if (kd.challenge.length !== 32 || !crypto.timingSafeEqual(kd.challenge, clientDataHash)) no("bad_challenge");
  if (kd.attestationVersion < 3) no("old_attestation");
  if (kd.attestationSecurityLevel < 1 || kd.keymasterSecurityLevel < 1) no("not_hardware");
  // hardware-enforced: made in the device (origin GENERATED = 0), an EC key (algorithm 3), the device locked and booted verified (rootOfTrust, tag 704: verifiedBootKey, deviceLocked, verifiedBootState = 0)
  const origin = kd.tee.get(702);
  if (!origin || int(kd.d, origin) !== 0 || kd.software.has(702)) no("not_generated");
  const algorithm = kd.tee.get(2);
  if (!algorithm || int(kd.d, algorithm) !== 3) no("bad_algorithm");
  const rot = kd.tee.get(704);
  if (!rot || rot.tag !== 0x30) no("no_root_of_trust");
  const r = kids(kd.d, rot);
  if (r.length < 3 || r[1].tag !== 1 || kd.d[r[1].start] !== 0xff || int(kd.d, r[2]) !== 0) no("not_verified_boot");
  // the app: the application id is enforced by the framework (software list, tag 709)
  const appField = kd.software.get(709) || kd.tee.get(709);
  if (!appField || appField.tag !== 4) no("no_app");
  const app = appIdsOf(kd.d, appField);
  if (!appIds.some(a => app.names.length === 1 && app.names[0] === a.pkg && app.certs.includes(a.cert.toLowerCase()))) no("bad_app");
  return { level: kd.attestationSecurityLevel === 2 ? "strongbox" : "tee" };
}

/**
 * The verifier an entry proof plugs in. `dev` allows extra roots and app ids (tests, a development build) and opens the verifier without the release flag.
 * @param {{ dev?: boolean, testRootsPem?: string[], extraAppIds?: { pkg: string, cert: string }[], now?: () => number }} [o]
 */
export function androidAttestVerifier({ dev = false, testRootsPem = [], extraAppIds = [], now = Date.now, fetchStatus = /** @type {null | (() => Promise<any>)} */ (null) } = {}) {
  const roots = [...GOOGLE_ROOTS_PEM, ...(dev ? testRootsPem : [])].map(p => new crypto.X509Certificate(p));
  const appIds = [...ANDROID_APP_IDS, ...(dev ? extraAppIds : [])];
  const open = dev || ANDROID_ATTEST_VERIFIED;
  /** @type {{ at: number, revoked: Set<string> } | null} */
  let status = null;
  const getStatus = async () => {
    if (status && now() - status.at < STATUS_TTL_MS) return status.revoked;
    const body = fetchStatus ? await fetchStatus() : await (await fetch(GOOGLE_STATUS_URL, { signal: AbortSignal.timeout(5000) })).json();
    const entries = body && typeof body === "object" ? body.entries : null;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Refuse("bad_status");
    status = { at: now(), revoked: new Set(Object.keys(entries).map(serialKey)) };
    return status.revoked;
  };
  return {
    appIds, dev, open,
    /**
     * Is any certificate of the chain on Google's revocation list? True means revoked, or the list could not be fetched or read (fail closed: a chain nobody could check proves nothing).
     * @param {any} a {chain: base64 DER certs} @returns {Promise<boolean>}
     */
    async revoked(a) {
      try {
        const revoked = await getStatus();
        return a.chain.some((/** @type {string} */ c) => revoked.has(serialKey(new crypto.X509Certificate(Buffer.from(c, "base64")).serialNumber)));
      } catch { return true; }
    },
    /** @param {any} a {chain: base64 DER certs, leaf first} @param {Buffer} point the raw 65-byte key being proved @param {Buffer} clientDataHash @returns {{ level: "tee" | "strongbox" } | null} null for any refusal, never a throw */
    check(a, point, clientDataHash) {
      try {
        if (!open || !a || !Array.isArray(a.chain)) return null;
        return verifyAttestation({ chain: a.chain.map((/** @type {any} */ c) => (typeof c === "string" ? Buffer.from(c, "base64") : Buffer.alloc(0))), clientDataHash, point, now: now(), appIds, roots });
      } catch { return null; }
    },
  };
}
