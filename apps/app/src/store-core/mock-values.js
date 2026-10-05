// @ts-check
// deck/ui/mock-values: the kernel's FieldValue shapes (kernel/contracts/fields.d.ts) as small constructors, for the made-up world's records. Plain data, no clock.
import { seeded } from "./mock-ids.js";

/** @typedef {import("./contracts.js").Money} Money */
/** @typedef {import("./contracts.js").Address} Address */
/** @typedef {import("./contracts.js").Actor} Actor */

/** @param {number} amount @param {string} [currency] @returns {Money} */
export const money = (amount, currency = "USD") => ({ amount, currency });
/** A reference to another record (a ref or a link field). @param {string} urn */
export const ref = urn => ({ urn });
/** An actor value. @param {Actor} actor */
export const actorValue = actor => ({ actor });
/** @param {string} line1 @param {string} [city] @param {string} [region] @param {string} [postal] @param {string} [country] @returns {Address} */
export const addr = (line1, city, region, postal, country) => /** @type {Address} */ ({ ...(line1 ? { line1 } : {}), ...(city ? { city } : {}), ...(region ? { region } : {}), ...(postal ? { postal } : {}), ...(country ? { country } : {}) });
/** A file value: a stable key, the name, and a size the made-up world gives it. @param {string} name */
export const file = name => ({ file: `file:${seeded(name).slice(0, 18)}`, name, bytes: 20_000 + (name.length * 1873) % 90_000 });
