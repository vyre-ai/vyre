// @ts-check
// lib/project-id: the one canonical shape of a project id, as a pure library (ADR 0033, section
// 3). No feature state: nothing here reads config, the store or another module.
//
// A project has one id: the marker's slug (core/projects/markers.js). Everything else that
// names a project derives from it rather than growing its own shape:
//   - memory's rooms are keyed on this slug directly (core/memory/curator.js refreshRooms);
//   - a teammate's agent name is `<role>-<project>`, where `<project>` must be this slug
//     (core/team, ADR 0031) — teammates validated that against its own copy of this regex before
//     this lib existed; it should import SLUG_RE from here instead;
//   - a vault grant's `project` column (ADR 0031 section 12, queued) names this same slug.
//
// Import this instead of re-deriving the shape: any part may import a lib (boundaries test).

/** The exact charset `slugify` below can produce: lowercase letters, digits and single hyphens,
 * neither leading nor trailing. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A name, folder or anything else turned into the canonical shape. Matches
 * core/projects/markers.js's own slugify exactly: this lib is that function's home, and markers.js
 * re-exports it so existing callers (`M.slugify`) keep working unchanged. */
export function slugify(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Whether a value is already in the canonical shape — the check every other part should run on
 * a project id it did not just get from `projects.list` or `projects.of`, instead of writing its
 * own regex (teammates' core/team/index.js SLUG constant is the case this replaces). */
export function isProjectId(v) {
  return typeof v === "string" && v.length > 0 && SLUG_RE.test(v);
}

/** A Project record's id: the v4 uuid the kernel minted (kernel/core/ids.js). The id never changes, which is why a teammate's rows hold it and not the short name. */
const RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a value is a Project record id. @param {unknown} v */
export const isProjectRecordId = v => typeof v === "string" && RECORD_ID_RE.test(v);

/**
 * The Project record id a reference names: the id itself, or the record's address (`vyre://<space>/project/<id>`). Null for anything else, a short name included:
 * a caller that holds only a short name asks `work.project.ref` for the id first.
 * @param {unknown} ref @returns {string | null}
 */
export function projectRecordIdOf(ref) {
  if (typeof ref !== "string") return null;
  if (isProjectRecordId(ref)) return ref;
  const m = /^vyre:\/\/[^/]+\/project\/([^/]+)$/.exec(ref);
  return m && isProjectRecordId(m[1]) ? m[1] : null;
}
