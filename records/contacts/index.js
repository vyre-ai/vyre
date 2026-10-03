// @ts-check
// The contacts block over one Space's gateway: contact-points and matching, roles, and the many-to-many between communications and contacts.
import { createPoints } from "./points.js";
import { createRoles } from "./roles.js";
import { createComms } from "./comms.js";

/** @param {{ space: string, records: any, types: () => Promise<readonly any[]>, defaultCountry?: string }} cfg `records` is kernel.records; `types` is the store's `types()` */
export function createContacts(cfg) {
  return { ...createPoints(cfg), ...createRoles(cfg), ...createComms(cfg) };
}
export { CONTACT_TYPES } from "./types.js";
export { extendType, mergeKitTypes } from "./merge.js";
export { roleTypes, roleLinkField, checkRoleType } from "./roles.js";
