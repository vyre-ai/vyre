// @ts-check
// Roles on a record: what a person or a company is to the Space, each role with its own stage (a Lead who is Talking, a Client who is Active). The kernel keeps a role as a record of a role type that points at its
// holder (records.roles lists them, records.holders lists who has one). This file adds the plain calls the Records screens use:
//   records.role.set { urn, role, stage? }   put a role on a record, or move the one it has to another stage
//   records.roles.summary { urn? }           for a record: its roles as short labels; for the Space: how many hold each role, by stage

const DAY = 86_400_000;
const STRIP = / role( \(company\))?$/;

/** What the screens call a role type. @param {any} t */
export const roleLabel = (t) => String(t.role_label || String(t.label || t.name).replace(STRIP, ""));

/** A role as a short label with its stage and colour, from the type and the role row the kernel answered. @param {any} t @param {{ role: string, stage?: string, current: boolean, record: any }} h */
export function labelled(t, h) {
  const colors = (t.option_colors && t.option_colors.stage) || {};
  return { role: h.role, label: roleLabel(t), ...(h.stage !== undefined ? { stage: h.stage } : {}), current: h.current, color: (h.stage !== undefined && colors[h.stage]) || t.color || null, id: h.record.id, urn: h.record.urn, since: (h.record.data && h.record.data.since) || null };
}

/** The line a list shows for a record's roles: current ones first, "Lead (New), Client (Active)"; ended ones are left out. @param {{ label: string, stage?: string, current: boolean }[]} roles */
export function lineOf(roles) {
  return roles.filter((r) => r.current).map((r) => (r.stage ? `${r.label} (${r.stage})` : r.label)).join(", ");
}

/** How many hold a role, by stage, for current holders. @param {{ stage?: string, current: boolean }[]} holders */
export function countsOf(holders) {
  /** @type {Record<string, number>} */ const by = {};
  let current = 0;
  for (const h of holders) { if (!h.current) continue; current++; if (h.stage !== undefined) by[h.stage] = (by[h.stage] || 0) + 1; }
  return { current, ended: holders.length - current, by_stage: by };
}

/** The stage a new role starts in: the one asked for, else the type's first. Throws a plain sentence. @param {any} t @param {string | undefined} asked */
export function startStage(t, asked) {
  const sf = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
  if (!sf) { if (asked !== undefined) throw new Error(`${roleLabel(t)} has no stages.`); return undefined; }
  const options = sf.options || [];
  if (asked === undefined) return options[0];
  if (!options.includes(asked)) throw new Error(`${roleLabel(t)} has no stage called ${asked}. Its stages are: ${options.join(", ")}.`);
  return asked;
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerRoles({ tool, obj, str, refuse, parseUrn }) {
  const roleTypes = async (/** @type {any} */ d) => ((await d.gateway.definitions(d.chain)) || []).filter((/** @type {any} */ t) => t.role && typeof t.role.link === "string");
  const byUrn = (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space });

  tool("records.role.set", "Put a role on a person or a company, or move the one it has to another stage: { urn, role, stage? }. `role` is a role type (records.roles.summary lists them). A record can hold several roles, each with its own stage; a new role starts in its first stage unless you name one. -> { role: { role, label, stage, current, id, urn } }.",
    obj({ space: str, urn: str, role: str, stage: str, since: str }, ["urn", "role"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      const t = (await roleTypes(d)).find((/** @type {any} */ x) => x.name === i.role);
      if (!t) throw refuse(`${i.role} is not a role. records.roles.summary lists the roles this Space has.`, "not_found");
      const link = (t.fields || []).find((/** @type {any} */ f) => f.name === t.role.link);
      if (link && link.to && link.to !== u.type) throw refuse(`${roleLabel(t)} is held by a ${link.to}, not a ${u.type}.`, "bad_input");
      if (!(await d.gateway.records.get(d.chain, u.type, u.id))) throw refuse(`${i.urn} is not here, or you may not read it. Pick a record you can see in Records.`, "not_found");
      let stage; try { stage = startStage(t, i.stage); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      const sf = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
      const have = (await d.gateway.records.roles(d.chain, String(i.urn))).find((/** @type {any} */ h) => h.role === t.name && h.current);
      if (have) {
        if (stage === undefined || have.stage === stage) return { role: labelled(t, have) };
        const rec = await d.gateway.records.update(d.chain, t.name, have.record.id, { [/** @type {any} */ (sf).name]: stage }, have.record.version);
        return { role: labelled(t, { ...have, stage, record: rec }) };
      }
      const data = { [t.role.link]: { urn: String(i.urn) }, ...(sf && stage !== undefined ? { [sf.name]: stage } : {}), ...(i.since ? { since: String(i.since) } : {}) };
      const rec = await d.gateway.records.create(d.chain, t.name, data);
      return { role: labelled(t, { role: t.name, stage, current: true, record: rec }) };
    }, byUrn);

  tool("records.roles.summary", "Roles at a glance. With { urn }: that record's roles, current first, each with its label, stage and colour, and `line`, the short text a list shows (\"Lead (New), Client (Active)\"). Without: every role this Space has, with how many hold it by stage. -> { roles, line } or { roles: [{ role, label, color, stages, current, ended, by_stage }] }.",
    obj({ space: str, urn: str }), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const types = await roleTypes(d);
      if (i.urn) {
        parseUrn(i.urn);
        const held = await d.gateway.records.roles(d.chain, String(i.urn));
        const roles = held.map((/** @type {any} */ h) => labelled(types.find((/** @type {any} */ t) => t.name === h.role) || { name: h.role, label: h.role }, h));
        return { roles, line: lineOf(roles) };
      }
      const out = [];
      for (const t of types) {
        const sf = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
        /** @type {any[]} */ const rows = [];
        let cursor;
        for (let pages = 0; pages < 10; pages++) {
          const r = await d.gateway.records.holders(d.chain, { role: t.name, include_ended: true, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
          rows.push(...r.rows);
          if (!r.next_cursor) break;
          cursor = r.next_cursor;
        }
        out.push({ role: t.name, label: roleLabel(t), color: t.color || null, stages: sf ? sf.options || [] : [], ...countsOf(rows) });
      }
      return { roles: out };
    }, (/** @type {any} */ i) => (i.urn ? { space: parseUrn(i.urn).space } : i));
}
