// @ts-check
// deck/ui/mock-ids: the ids and urns of the made-up world, in the kernel's formats (kernel/contracts/common.d.ts). Pure, deterministic, no clock and no random,
// so a test and a screenshot get the same id every time. Nothing here is the kernel's: when the real gateway mints ids, this file is only for the mock.
//
//   Uuid     "a time-prefixed UUID (v7 layout, v4 marker), lowercase canonical text": 48 bits of time, then the 4 marker, then the variant, then the rest.
//   SpaceId  "spc_" plus 12 base32 characters.
//   Urn      "vyre://<space>/<type>/<id>"; a task is the core type "task".
//   person   "per_" plus 26 base32 characters (an agent is its name, a service its module name).
//
// seeded("m1") is the one id the alias m1 always has; a record or task made later is minted from the clock and a counter.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Four 32-bit words from a string (a small public-domain mixing function; this is not security, only a spread). @param {string} s @returns {number[]} */
function words(s) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}
const hex8 = (/** @type {number} */ n) => n.toString(16).padStart(8, "0");

/** The first day of the made-up world, the time prefix every seeded id carries. */
export const SEED_MS = Date.UTC(2026, 8, 1);

/** A UUID in the kernel's layout. @param {number} ms @param {string} seed @returns {string} */
export function uuid(ms, seed) {
  const [a, b, c, d] = words(seed);
  const t = Math.floor(ms).toString(16).padStart(12, "0").slice(-12), x = hex8(a), y = hex8(b), z = hex8(c);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-4${x.slice(0, 3)}-${(8 + (d & 3)).toString(16)}${x.slice(3, 6)}-${y}${z.slice(0, 4)}`;
}

/** The id an alias ("m1", "k13") always has. @param {string} alias */
export const seeded = alias => uuid(SEED_MS, `seed:${alias}`);
/** A new id from the clock and a counter. @param {number} ms @param {number} n */
export const minted = (ms, n) => uuid(ms, `mint:${n}:${ms}`);

/** "per_" and 26 base32 characters, from an alias. @param {string} alias */
export function personId(alias) {
  const bits = [...words(`person:${alias}`), ...words(`person2:${alias}`)].map(w => w.toString(2).padStart(32, "0")).join("");
  let out = "";
  for (let i = 0; i < 26; i++) out += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `per_${out}`;
}

/** The two spaces of the made-up world, as SpaceIds. */
export const SPACE = Object.freeze({ mine: "spc_mineaaaaaaaa", harlow: "spc_harlowaaaaaa" });

/** The people and assistants of the made-up world, by the short name the lab and the tests use, as actor ids. */
export const WHO = Object.freeze({
  alex: personId("alex"), chris: personId("chris"),
  juno: "juno", kit: "kit", iris: "iris", rev: "rev", research: "research", intake: "intake", drafting: "drafting", vyre: "vyre",
});

/** @param {string} space @param {string} type @param {string} id */
export const urnOf = (space, type, id) => `vyre://${space}/${type}/${id}`;

/** @param {string} urn @returns {{ space: string, type: string, id: string, path: string } | null} */
export function parseUrn(urn) {
  const m = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/.exec(String(urn || ""));
  return m ? { space: m[1], type: m[2], id: m[3], path: m[4] || "" } : null;
}

/** The type of every seeded record alias and the space it lives in, so a test can name a record by its alias. "m1" is the Doe estate plan, "c1" Jane Doe. */
const ALIAS = /** @type {const} */ ([
  [/^c\d+$/, "contact", "harlow"], [/^m\d+$/, "matter", "harlow"], [/^tpl\d+$/, "template", "harlow"], [/^t\d+$/, "trip", "mine"],
]);
/** The urn of a seeded record, by its alias: "m1" is the Doe estate plan. Projects p1 and p2 are Harlow's, p3 and p4 are Mine. @param {string} alias */
export function aliasUrn(alias) {
  if (/^p\d+$/.test(alias)) return urnOf(Number(alias.slice(1)) <= 2 ? SPACE.harlow : SPACE.mine, "project", seeded(alias));
  for (const [re, type, space] of ALIAS) if (re.test(alias)) return urnOf(SPACE[space], type, seeded(alias));
  throw new Error(`No seeded record is called ${alias}.`);
}

/** A stand-in for the kernel's hashes (commit, prev, hash): 22 base64url characters from a string. Not a hash of anything real; the mock has no chain to verify. @param {string} s */
export function digest(s) {
  const bytes = words(s).flatMap(w => [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255]);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : "") + (i + 2 < bytes.length ? A[n & 63] : "");
  }
  return out;
}
