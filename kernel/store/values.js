// kernel/store/values.js: the value kinds (contract 5.2) as validators. A store translates our kinds, so the reference
// store, the conformance suite and the gateway agree on what a valid value is. A sealed field never holds a value.
import { isNormalAddress } from "./normal.js";

const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strArr = (/** @type {any} */ v) => Array.isArray(v) && v.every(x => typeof x === "string");
export const isSealedRef = (/** @type {any} */ v) => isObj(v) && typeof v.sealed === "string" && typeof v.ref === "string" && typeof v.present === "boolean";
export const isSealedShape = (/** @type {any} */ v) => isObj(v) && typeof v.sealed === "string";
const instant = (/** @type {string} */ v) => { try { return new Date(v).toISOString(); } catch { return null; } };
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Returns an error string, or null when `v` is a valid value for `def`. @param {any} def @param {any} v */
export function checkValue(def, v) {
  if (v === null || v === undefined) return def.required ? `${def.name} is required` : null;
  switch (def.kind) {
    case "text": case "rich_text":
      if (typeof v !== "string") return `${def.name} must be text`;
      return def.normal === "address" && !isNormalAddress(v) ? `${def.name} must be a lower-cased email address or an E.164 phone number (+15551234567)` : null;
    case "number": return typeof v === "number" && Number.isFinite(v) ? null : `${def.name} must be a number`;
    case "money": return isObj(v) && Number.isFinite(v.amount) && typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) ? null : `${def.name} must be { amount, currency }`;
    case "boolean": return typeof v === "boolean" ? null : `${def.name} must be true or false`;
    case "date": return typeof v === "string" && ISO.test(v) ? null : `${def.name} must be an ISO date`;
    // an instant is written one way on every store, Date.toISOString(): a store that keeps an instant (Twenty) hands back that text, and the gateway compares what a store returned with what was asked
    case "datetime": return typeof v === "string" && instant(v) === v ? null : `${def.name} must be an exact UTC time, 2026-10-02T09:30:00.000Z (Date.toISOString())`;
    case "choice": case "stage": return typeof v === "string" && (!def.options || def.options.includes(v)) ? null : `${def.name} must be one of its options`;
    case "multi_choice": return strArr(v) && (!def.options || v.every((/** @type {string} */ x) => def.options.includes(x))) ? null : `${def.name} must be a list of its options`;
    case "rating": return Number.isInteger(v) && v >= 1 && v <= 5 ? null : `${def.name} must be 1 to 5`;
    case "url": return typeof v === "string" && /^https?:\/\//.test(v) ? null : `${def.name} must be a web address`;
    case "link": {
      if (!(isObj(v) && typeof v.urn === "string" && v.urn.startsWith("vyre://"))) return `${def.name} must be a reference`;
      // vyre://<space>/<type>/<id>: when the definition names the types a link may point at, the type segment must be one of them
      const to = def.to === undefined ? null : [].concat(def.to);
      return to && !to.includes(v.urn.split("/")[3]) ? `${def.name} must point at ${to.join(" or ")}` : null;
    }
    case "actor": return isObj(v) && isObj(v.actor) && typeof v.actor.id === "string" ? null : `${def.name} must be an actor`;
    case "file": return isObj(v) && typeof v.file === "string" && typeof v.name === "string" && Number.isFinite(v.bytes) ? null : `${def.name} must be a file`;
    case "address": return isObj(v) && Object.values(v).every(x => typeof x === "string") ? null : `${def.name} must be an address`;
    case "phones": case "emails": case "urls": return strArr(v) ? null : `${def.name} must be a list of text`;
    case "sealed": return isSealedRef(v) ? null : "sealed_value_refused";
    default: return `${def.name} has an unknown kind`;
  }
}
