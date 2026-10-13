// @ts-check
// member-scope (Google): the shared firm-key scope (lib/member-scope.js) with Google's derivation. See that file for the rules.
import { scopeFor as scopeWith, requireOwner, emailProblem } from "../../lib/member-scope.js";
import { forMember } from "./member-account.js";

export { requireOwner, emailProblem };

/** @param {{ kernel?: any, all: () => any[], memberOf: (id: string) => any }} d @param {any} meta */
export const scopeFor = (d, meta) => scopeWith({ ...d, derive: forMember }, meta);
