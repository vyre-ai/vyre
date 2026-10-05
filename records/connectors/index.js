// @ts-check
// The connectors this build ships as declarations. A new service is one more entry here (or a declaration a person or @Engineer writes and installs), never new engine code.
import stripe from "./stripe/declaration.js";
import gmail from "./gmail/declaration.js";
import googleCalendar from "./google-calendar/declaration.js";

/** @type {Readonly<Record<string, import("./format.js").Declaration>>} */
export const DECLARATIONS = Object.freeze({ [stripe.id]: stripe, [gmail.id]: gmail, [googleCalendar.id]: googleCalendar });
export const declared = (/** @type {string} */ id) => DECLARATIONS[id] || null;
export { defineConnector, buildRequest, parseResponse, toCredentialConfig, serviceOf, opFor, readbackRequest, compareReadback, checkDeclaration } from "./format.js";
