// @ts-check
// One browse implementation for skills.browse, skills.list (member door), and skills.serve browse: role-scoped levels, drafts, harness chips, plugin declarations.

import { AIS, declared, hasCode, ackOf } from "../../lib/skill-library.js";
import { routePlugin } from "../../lib/skill-adapters.js";
import { fit } from "../../lib/harness-caps.js";

/** @param {any} membership */
export function roleOf(membership) {
  const r = membership && typeof membership.role === "string" ? membership.role : "";
  if (r === "owner" || r === "admin" || r === "member") return r;
  return membership ? "member" : "owner";
}

/** What each level allows for this role (view / draft / approve / install plugin). */
export function levelCaps(role) {
  const admin = role === "owner" || role === "admin";
  return {
    personal: { view: true, draft: true, approve: true, plugin: true },
    space: { view: true, draft: admin, approve: admin, plugin: admin },
    agent: { view: true, draft: true, approve: true, plugin: admin },
    project: { view: true, draft: true, approve: true, plugin: admin },
  };
}

/** Harnesses that receive this library row when materialised (all AIS for skills; plugins follow routePlugin). @param {any} row */
export function harnessesFor(row) {
  const capsBy = Object.fromEntries(AIS.map((h) => [h, null]));
  if (row && row.kind === "plugin") {
    let p; try { p = JSON.parse(String(row.body || "{}")); } catch { return [...AIS]; }
    const vendor = String(p.vendor || "anthropic");
    const routed = routePlugin(vendor, undefined, capsBy);
    const out = new Set([...(routed.native ? [routed.native] : []), ...routed.also, "codex"]);
    return [...out].filter((h) => AIS.includes(h)).sort();
  }
  const kept = [];
  for (const h of AIS) {
    const f = fit(row && row.needs, null, { harness: h, degrade: row && row.degrade });
    if (f.works !== false) kept.push(h);
  }
  return kept.length ? kept : [...AIS];
}

/** @param {any} shownRow @param {any} [libRow] */
export function enrichRow(shownRow, libRow) {
  const kind = libRow && libRow.kind ? libRow.kind : "skill";
  const base = { ...shownRow, kind, harnesses: harnessesFor(libRow || { kind, body: shownRow.text }) };
  if (kind === "plugin" && libRow && libRow.body) {
    try {
      const p = JSON.parse(String(libRow.body));
      base.declares = declared(p);
      if (hasCode(p)) base.ack = ackOf(p);
    } catch { /* not shown */ }
  }
  return base;
}

/**
 * @param {any} o
 * @param {{ level?: string, name?: string, scope?: string, state?: string, limit?: number, member?: boolean }} input
 * @param {{ person: string | null, role: string, chain: any }} who
 */
export async function runBrowse(o, input, who) {
  const caps = levelCaps(who.role);
  const level = input.level ? String(input.level) : undefined;
  if (input.name && level) {
    const versions = await o.versionsFor(level, { name: String(input.name), level, scope: input.scope, state: input.state });
    const filtered = versions.filter((/** @type {any} */ v) => o.maySeeVersion(who, v));
    return { versions: filtered, role: who.role, levels: caps };
  }
  const list = await o.visible({ level });
  const byId = o.approvedMap || new Map();
  const skills = list.slice(0, input.limit || 100).map((/** @type {any} */ s) => enrichRow(o.shown(s), byId.get(s.id) || s));
  const drafts = await o.draftsFor(who, level);
  return {
    skills,
    drafts,
    role: who.role,
    levels: caps,
    identityPersonal: o.identityPersonal(),
    can: {
      draft: Object.fromEntries(Object.entries(caps).map(([lv, c]) => [lv, c.draft])),
      approve: Object.fromEntries(Object.entries(caps).map(([lv, c]) => [lv, c.approve])),
      plugin: Object.fromEntries(Object.entries(caps).map(([lv, c]) => [lv, c.plugin])),
    },
  };
}
