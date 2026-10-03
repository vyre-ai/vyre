// kernel/store/normal.js: the normal form of an address a person is reached at. Pure, no state. A contact-point holds exactly this form, so one
// unique value per address stops a second record for the same person (team/0.3/DESIGN-contacts-comms.md). The store checks it (`normal: "address"`);
// writers get there with `normalizeAddress`.

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** True when `v` is already in normal form: a lower-cased email address or an E.164 phone number. @param {any} v */
export const isNormalAddress = (v) => typeof v === "string" && ((v === v.toLowerCase() && EMAIL.test(v)) || E164.test(v));

/** `Jane Doe <Jane@Example.com>` or ` jane@example.com ` -> `jane@example.com`, or null. @param {any} raw */
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const angled = /<([^<>]+)>\s*$/.exec(raw);
  const v = (angled ? angled[1] : raw).trim().toLowerCase();
  return EMAIL.test(v) ? v : null;
}

/**
 * A phone number as E.164, or null. A number without a country code takes `defaultCountry` (digits, "1" unless told otherwise); a leading 00 means +.
 * Extensions and letters are not numbers: they are refused rather than guessed. @param {any} raw @param {{ defaultCountry?: string }} [opts]
 */
export function normalizePhone(raw, opts = {}) {
  if (typeof raw !== "string" || /[a-z]/i.test(raw.replace(/^\s*tel:/i, ""))) return null;
  const s = raw.replace(/^\s*tel:/i, "").trim();
  const digits = s.replace(/\D/g, "");
  let out;
  if (s.startsWith("+")) out = `+${digits}`;
  else if (digits.startsWith("00")) out = `+${digits.slice(2)}`;
  else {
    const cc = (opts.defaultCountry ?? "1").replace(/\D/g, "");
    if (cc === "1" && digits.length === 11 && digits.startsWith("1")) out = `+${digits}`;
    else if (cc === "1" && digits.length === 10) out = `+1${digits}`;
    else if (cc !== "1" && digits.length >= 6 && digits.length <= 14 && !digits.startsWith("0")) out = `+${cc}${digits}`;
    else if (cc !== "1" && digits.startsWith("0") && digits.length >= 7 && digits.length <= 14) out = `+${cc}${digits.replace(/^0+/, "")}`;
    else return null;
  }
  return E164.test(out) ? out : null;
}

/** The normal form of whatever address this is, with its kind, or null. @param {any} raw @param {{ defaultCountry?: string }} [opts] @returns {{ kind: "email" | "phone", value: string } | null} */
export function normalizeAddress(raw, opts = {}) {
  if (typeof raw !== "string") return null;
  const e = normalizeEmail(raw);
  if (e) return { kind: "email", value: e };
  const p = normalizePhone(raw, opts);
  return p ? { kind: "phone", value: p } : null;
}
