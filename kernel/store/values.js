// kernel/store/values.js: the value kinds (contract 5.2) as validators. A store translates our kinds, so the reference
// store, the conformance suite and the gateway agree on what a valid value is. A sealed field never holds a value.
const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strArr = (/** @type {any} */ v) => Array.isArray(v) && v.every(x => typeof x === "string");
export const isSealedRef = (/** @type {any} */ v) => isObj(v) && typeof v.sealed === "string" && typeof v.ref === "string" && typeof v.present === "boolean";
export const isSealedShape = (/** @type {any} */ v) => isObj(v) && typeof v.sealed === "string";
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** An IANA zone name the runtime knows. @param {string} z */
export function validZone(z) { try { new Intl.DateTimeFormat("en", { timeZone: z }); return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(z) && z.length < 64; } catch { return false; } }

/** Returns an error string, or null when `v` is a valid value for `def`. @param {any} def @param {any} v */
export function checkValue(def, v) {
  if (v === null || v === undefined) return def.required ? `${def.name} is required` : null;
  switch (def.kind) {
    case "text": if (typeof v === "string" && def.format === "time_zone" && !validZone(v)) return `${def.name} must be a time zone such as America/Los_Angeles`; return typeof v === "string" ? null : `${def.name} must be text`;
    case "rich_text": return typeof v === "string" ? null : `${def.name} must be text`;
    case "number": return typeof v === "number" && Number.isFinite(v) ? null : `${def.name} must be a number`;
    case "money": return isObj(v) && Number.isFinite(v.amount) && typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) ? null : `${def.name} must be { amount, currency }`;
    case "boolean": return typeof v === "boolean" ? null : `${def.name} must be true or false`;
    case "date": case "datetime": return typeof v === "string" && ISO.test(v) ? null : `${def.name} must be an ISO date`;
    case "choice": case "stage": return typeof v === "string" && (!def.options || def.options.includes(v)) ? null : `${def.name} must be one of its options`;
    case "multi_choice": return strArr(v) && (!def.options || v.every((/** @type {string} */ x) => def.options.includes(x))) ? null : `${def.name} must be a list of its options`;
    case "rating": return Number.isInteger(v) && v >= 1 && v <= 5 ? null : `${def.name} must be 1 to 5`;
    case "url": return typeof v === "string" && /^https?:\/\//.test(v) ? null : `${def.name} must be a web address`;
    case "link": return isObj(v) && typeof v.urn === "string" && v.urn.startsWith("vyre://") ? null : `${def.name} must be a reference`;
    case "actor": return isObj(v) && isObj(v.actor) && typeof v.actor.id === "string" ? null : `${def.name} must be an actor`;
    case "file": return isObj(v) && typeof v.file === "string" && typeof v.name === "string" && Number.isFinite(v.bytes) ? null : `${def.name} must be a file`;
    case "address": return isObj(v) && Object.values(v).every(x => typeof x === "string") ? null : `${def.name} must be an address`;
    case "phones": case "emails": case "urls": return strArr(v) ? null : `${def.name} must be a list of text`;
    case "sealed": return isSealedRef(v) ? null : "sealed_value_refused";
    default: return `${def.name} has an unknown kind`;
  }
}
