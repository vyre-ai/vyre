// @ts-check
// roles: the grants a join link gives when it names a custom role. The person is not known yet, so "only what they made" carries the marker `person:$me`, which the kernel fills in with the joiner's id
// when the invite is accepted (kernel/grants applyRole). The kernel checks the result exactly as it does for roles.assign; a role that was removed or never existed is refused in words here.
import { readRoles } from "./index.js";
import { expandRole } from "./definition.js";

/** @param {any} gateway @param {any} chain @param {string} space @param {string} id @returns {Promise<{ id: string, grants: any[] }>} */
export async function customForInvite(gateway, chain, space, id) {
  const c = (await readRoles(gateway, chain)).get(id);
  if (!c) throw Object.assign(new Error(`There is no role "${id}" in this Space. It may have been removed. Pick one from the role list (roles.list), then invite again.`), { code: "not_found" });
  const types = ((await gateway.definitions(chain)) || []).map((/** @type {any} */ t) => ({ name: t.name, fields: t.fields || [] }));
  return { id: c.role.id, grants: expandRole(c.role, { space, person: "$me", types }) };
}
