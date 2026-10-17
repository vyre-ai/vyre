// @ts-check
// What the person is told they are signing with the phone's Face ID or fingerprint key (vyre.human), read from the bytes themselves (KP-3), the same rules the Mac's shell keeps
// (local/capsule/native/Sources/Host/SignSummary.swift) and the Windows shell's (native-win identity.rs). The caller's own caption is never shown, and bytes with no summary are not signed:
//   - an identity-list change: "vyre-chain-v1\n" and the op's JSON (add, remove, replace-code, recover, agree, genesis)
//   - a server ownership proof: "vyre-wink-pair-to-v1", the server's key, this device's id there, the ticket's tag (relay/client/finish.js pairToProofMessage), exactly
//   - the paired session start: "paired-start", this device's id, the server's challenge (core/presence/person.js pairedStart), exactly
//   - the relay sign-in: "vyre-presence-v1" for presence.person.start only (apps/app/src/auth/person.ts presenceMessage), exactly
//   - a yes-moment proof: the module builds those bytes itself from a card whose fields it has checked against the card's hash (presence-proof.js proofBody); its words come from the card's own op and fields
// Pure, so Node tests it with the byte vectors the Mac and Windows tests pin.

const dec = new TextDecoder("utf-8", { fatal: true });

/** No control, format (bidi overrides such as U+202E, zero widths such as U+200B, isolates U+2066 to U+2069) or line and paragraph separator character: the plainName set. */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A label as the person reads it: nothing that is not shown as itself (UNSHOWN), trimmed, cut at `max` with "...". @param {unknown} s @param {number} [max] */
export function clean(s, max = 40) {
  const t = (typeof s === "string" ? s : "").replace(UNSHOWN, "").trim();
  return Array.from(t).length > max ? Array.from(t).slice(0, max).join("") + "..." : t;
}

/** @param {any} e */
const nameOf = e => { const l = clean(e && e.label) || clean(e && e.subject); return l || "unnamed"; };

/** @param {string} body @returns {string | null} */
function chain(body) {
  /** @type {any} */ let op;
  try { op = JSON.parse(body); } catch { return null; }
  if (!op || typeof op !== "object" || typeof op.type !== "string") return null;
  const e = op.entry && typeof op.entry === "object" ? op.entry : null;
  switch (op.type) {
    case "add":
      if (!e || typeof e.kind !== "string") return null;
      if (e.kind === "device") return `Add a device: ${nameOf(e)}`;
      if (e.kind === "contact") return `Add a recovery contact: ${nameOf(e)}`;
      if (e.kind === "code") return "Add a recovery code";
      if (e.kind === "owner") return `Make ${nameOf(e)} an owner`;
      return null;
    case "remove": return typeof op.target === "string" && op.target ? `Remove a sign-in (${clean(op.target, 12)})` : null;
    case "replace-code": return e && e.kind === "code" ? "Replace your recovery code" : null;
    case "recover": return e && e.kind === "device" ? `Recover your name onto a new device: ${nameOf(e)}` : null;
    case "agree": return typeof op.target === "string" ? "Add a sharing key to this device" : null;
    case "genesis": return e ? `Start an identity with this device: ${nameOf(e)}` : null;
    default: return null;
  }
}

/** @param {number} n */
const B64U = n => new RegExp(`^[A-Za-z0-9_-]{${n}}$`);
const DEVICE = /^[a-z2-7]{16}$/, BOX = B64U(43), TAG = /^[0-9a-f]{24}$/, CHALLENGE = B64U(32), HASH = B64U(43), TS = /^[0-9]{1,16}$/, NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The words for `message`, or null when the phone cannot read it (then it is not signed).
 * @param {Uint8Array} message @returns {string | null}
 */
export function summaryOf(message) {
  /** @type {string} */ let text;
  try { text = dec.decode(message); } catch { return null; }
  if (text.startsWith("vyre-chain-v1\n")) return chain(text.slice("vyre-chain-v1\n".length));
  const l = text.split("\n");
  if (l[0] === "vyre-wink-pair-to-v1") return l.length === 4 && BOX.test(l[1]) && DEVICE.test(l[2]) && TAG.test(l[3]) ? "Make the server you are pairing yours" : null;
  if (l[0] === "paired-start") return l.length === 3 && DEVICE.test(l[1]) && CHALLENGE.test(l[2]) ? "Sign in to your server" : null;
  if (l[0] === "vyre-presence-v1") return l.length === 5 && l[1] === "presence.person.start" && HASH.test(l[2]) && TS.test(l[3]) && NONCE.test(l[4]) ? "Sign in to your home" : null;
  return null;
}

/**
 * The words for a yes-moment proof the module signs, from the card's op and fields (presence-proof.js proofBody has already checked they hash to the card's payload_hash): the act, then up to six
 * fields, as the Mac's shell writes them.
 * @param {string} op @param {Record<string, unknown>} fields @returns {string}
 */
export function proofSummary(op, fields) {
  const lines = Object.keys(fields || {}).sort().slice(0, 6).map(k => {
    const v = fields[k];
    const said = typeof v === "string" ? clean(v, 60) : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "yes" : "no") : "...";
    return `${clean(k, 24)}: ${said}`;
  });
  return [`Approve: ${clean(String(op || "").replace(/_/g, " "), 60)}`, ...lines].join("\n");
}

/** The refusal for bytes with no summary: the same words the Mac and Windows shells say. */
export const UNREADABLE = "Vyre cannot tell what this would sign, so it did not.";
