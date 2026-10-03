// @ts-check
// Roles: what a contact or an organization is to the Space (prospect, client, past client, ambassador). A role is a record type marked
// `role: { subject: ["contact", ...] }` with one required link field that points at its subject. A contact can hold many roles, over time; each is its own record.
// The two questions the Deck, the Flows and the assistants ask are answered here, through the gateway's own query and get, so each read is authorized and
// logged like any other and a row the chain may not read is simply not in the answer:
//   rolesOf(chain, subject)                 "the roles of this contact"   (one indexed lookup per role type that can point at that kind of subject)
//   holders(chain, "client", { stage })     "the contacts holding role X at stage Y"  (one indexed lookup of the stage, then the subjects)

const fail = (/** @type {string} */ message, code = "invalid") => Object.assign(new Error(message), { code });
const SUBJECT_LIMIT = 200;

/** The name of the link field that points at the subject, or throws when the type is not a well-formed role. @param {any} def */
export function roleLinkField(def) {
  const role = def.role;
  if (!role || !Array.isArray(role.subject) || !role.subject.length) throw fail(`${def.name}: a role needs role.subject, the types it may point at`);
  const subjects = new Set(role.subject);
  const fits = (/** @type {any} */ f) => f.kind === "link" && f.to !== undefined && [].concat(f.to).every((t) => subjects.has(t));
  if (role.field !== undefined) {
    const f = def.fields.find((/** @type {any} */ x) => x.name === role.field);
    if (!f || !fits(f)) throw fail(`${def.name}: role.field "${role.field}" must be a link whose targets are ${[...subjects].join(" or ")}`);
    if (!f.required) throw fail(`${def.name}: the link ${f.name} must be required, so a role always has someone it is a role of`);
    return f.name;
  }
  const candidates = def.fields.filter((/** @type {any} */ f) => fits(f) && f.required);
  if (candidates.length !== 1) throw fail(`${def.name}: a role has exactly one required link to ${[...subjects].join(" or ")}${candidates.length ? ` (found ${candidates.map((/** @type {any} */ f) => f.name).join(", ")}; name one with role.field)` : ""}`);
  return candidates[0].name;
}

/** Refuse a malformed role type before it is defined. Does nothing for a type that is not a role. @param {any} def */
export function checkRoleType(def) { if (def.role) roleLinkField(def); }

/** The role types among these definitions, each with the field that points at its subject and its stage field. @param {readonly any[]} defs */
export function roleTypes(defs) {
  /** @type {{ type: string, label: string, subject: string[], field: string, stage: string | null }[]} */ const out = [];
  for (const d of defs) {
    if (!d.role) continue;
    let field; try { field = roleLinkField(d); } catch { continue; } // a malformed one is not a role until it is fixed
    out.push({ type: d.name, label: d.label ?? d.name, subject: [...d.role.subject], field, stage: d.fields.find((/** @type {any} */ f) => f.kind === "stage")?.name ?? null });
  }
  return out;
}

/**
 * @param {{ space: string, records: { query(chain: any, type: string, spec: any): Promise<any>, get(chain: any, type: string, id: string): Promise<any> }, types: () => Promise<readonly any[]> }} cfg
 * `records` is the gateway's record calls (kernel.records); `types` reads the Space's definitions (the store's `types()`).
 */
export function createRoles(cfg) {
  const urnOf = (/** @type {any} */ s) => (typeof s === "string" ? s : s.urn ?? `vyre://${cfg.space}/${s.type}/${s.id}`);
  const typeOfUrn = (/** @type {string} */ u) => u.split("/")[3];

  /** Every role record this subject holds or has held, newest change first. Each is `{ role, label, id, urn, stage, record }`. @param {any} chain @param {string | { urn: string } | { type: string, id: string }} subject */
  async function rolesOf(chain, subject, opts = {}) {
    const u = urnOf(subject), kind = typeOfUrn(u);
    const out = [];
    for (const rt of roleTypes(await cfg.types())) {
      if (!rt.subject.includes(kind)) continue;
      let cursor;
      for (let guard = 0; guard < 20; guard++) {
        const p = await cfg.records.query(chain, rt.type, { filter: { field: rt.field, op: "eq", value: { urn: u } }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        for (const r of p.rows) out.push({ role: rt.type, label: rt.label, id: r.id, urn: r.urn, stage: rt.stage ? r.data[rt.stage] ?? null : null, record: r });
        cursor = p.next_cursor;
        if (!cursor || out.length >= (opts.limit ?? SUBJECT_LIMIT)) break;
      }
    }
    return out.sort((a, b) => (b.record.updated_at - a.record.updated_at) || (a.urn < b.urn ? -1 : 1));
  }

  /**
   * The subjects holding a role, one row per role record: `{ role: { id, urn, stage, record }, subject: { urn, record } }`. `stage` narrows to one stage; `where` is any further
   * filter on the role type. A subject this chain cannot read is left out. @param {any} chain @param {string} roleType
   * @param {{ stage?: string, where?: any, limit?: number, cursor?: string }} [opts]
   */
  async function holders(chain, roleType, opts = {}) {
    const rt = roleTypes(await cfg.types()).find((x) => x.type === roleType);
    if (!rt) throw fail(`${roleType} is not a role type`, "unknown_type");
    if (opts.stage !== undefined && !rt.stage) throw fail(`${roleType} has no stages`);
    const parts = [];
    if (opts.stage !== undefined) parts.push({ field: /** @type {string} */ (rt.stage), op: "eq", value: opts.stage });
    if (opts.where) parts.push(opts.where);
    const p = await cfg.records.query(chain, roleType, { ...(parts.length ? { filter: parts.length === 1 ? parts[0] : { and: parts } } : {}), sort: [{ field: "created_at", dir: "asc" }], page: { limit: Math.min(opts.limit ?? 50, 200), ...(opts.cursor ? { cursor: opts.cursor } : {}) } });
    /** @type {Map<string, any>} */ const seen = new Map();
    const rows = [];
    for (const r of p.rows) {
      const link = r.data[rt.field];
      if (!link || typeof link.urn !== "string") continue;
      if (!seen.has(link.urn)) { const [, , , type, id] = link.urn.split("/"); seen.set(link.urn, await cfg.records.get(chain, type, id)); }
      const subject = seen.get(link.urn);
      if (subject) rows.push({ role: { id: r.id, urn: r.urn, stage: rt.stage ? r.data[rt.stage] ?? null : null, record: r }, subject: { urn: link.urn, record: subject } });
    }
    return { rows, ...(p.next_cursor ? { next_cursor: p.next_cursor } : {}) };
  }

  return { rolesOf, holders, roleTypes: async () => roleTypes(await cfg.types()) };
}
