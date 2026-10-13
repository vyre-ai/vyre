// @ts-check
// roles: reading the Space's custom roles (def-role records). Shared by the roles tools, the invite and the door, so it lives in lib.
export const ROLE_TYPE = "def-role";
const TYPE = ROLE_TYPE;

/** Read the Space's custom roles. @returns {Promise<Map<string, { row: string, version: number, role: any }>>} */
export async function readRoles(/** @type {any} */ gw, /** @type {any} */ chain) {
  const out = new Map();
  let r;
  try { r = await gw.records.query(chain, TYPE, { page: { limit: 500 } }); } catch (/** @type {any} */ e) { if (e && (e.code === "unknown_type" || e.code === "not_found")) return out; throw e; }
  for (const x of r.rows || []) {
    let body; try { body = JSON.parse(String(x.data && x.data.body)); } catch { continue; }
    if (body && body.v === 1 && body.custom === true && typeof body.role === "object") out.set(String(body.role.id), { row: x.id, version: x.version, role: body.role });
  }
  return out;
}
